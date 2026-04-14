import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import type { Context, Scope } from "effect"
// @effect-diagnostics nodeBuiltinImport:off
import { resolve as pathResolve, join as pathJoin } from "node:path"
import { RpcClient, RpcTest, RpcSerialization } from "effect/unstable/rpc"
import type { RpcGroup } from "effect/unstable/rpc"
import { Socket } from "effect/unstable/socket"
import * as os from "node:os"
import { GentRpcs, type GentRpcsClient } from "@gent/core/server/rpcs.js"
import { RpcHandlersLive } from "@gent/core/server/rpc-handlers.js"
import { createDependencies, type DependenciesConfig } from "@gent/core/server/dependencies.js"
import { AppServicesLive } from "@gent/core/server/index.js"
import { GentLogger, GentLogLevel } from "@gent/core/runtime/logger.js"
import { GentTracerLive } from "@gent/core/runtime/tracer.js"
import {
  GentConnectionError,
  type ConnectionState,
  type GentLifecycle,
  type MessageInfoReadonly,
  type SteerCommand,
  type SessionInfo,
  type BranchInfo,
  type BranchTreeNode,
  type SessionSnapshot,
  type SessionRuntime,
  type SessionTreeNode,
  type CreateSessionResult,
  type ExtensionHealthSnapshot,
} from "@gent/core/server/transport-contract.js"
import type { GentRpcError } from "@gent/core/server/errors.js"
import { stringifyOutput, summarizeOutput } from "@gent/core/domain/tool-output.js"
import type { AuthProviderInfo } from "@gent/core/domain/auth-guard.js"
import type { PermissionRule } from "@gent/core/domain/permission.js"
import type { AuthAuthorization, AuthMethod } from "@gent/core/domain/auth-method.js"
import type { SessionId, BranchId, MessageId } from "@gent/core/domain/ids.js"
import type {
  MessagePart,
  TextPart,
  ReasoningPart,
  ToolCallPart,
  ToolResultPart,
} from "@gent/core/domain/message.js"
import type { QueueEntryInfo, QueueSnapshot } from "@gent/core/domain/queue.js"
import { startWorkerSupervisor, waitForWorkerRunning, type WorkerSupervisor } from "./supervisor.js"
import {
  readRegistryEntry,
  validateRegistryEntry,
  writeRegistryEntry,
  removeRegistryEntry,
  ServerRegistryEntry,
  withLock,
  computeLocalFingerprint,
} from "./server-registry.js"
import { startLocalSupervisor } from "./local-supervisor.js"
import {
  makeNamespacedClient,
  type GentNamespacedClient,
  type GentRuntime,
} from "./namespaced-client.js"

export type {
  MessagePart,
  TextPart,
  ReasoningPart,
  ToolCallPart,
  ToolResultPart,
  PermissionRule,
  AuthProviderInfo,
  AuthAuthorization,
  AuthMethod,
  SessionId,
  BranchId,
  MessageId,
  QueueEntryInfo,
  QueueSnapshot,
}
export type {
  GentLifecycle,
  ConnectionState,
  MessageInfoReadonly,
  SteerCommand,
  SessionInfo,
  BranchInfo,
  BranchTreeNode,
  SessionSnapshot,
  SessionRuntime,
  SessionTreeNode,
  CreateSessionResult,
  ExtensionHealthSnapshot,
}
export { GentConnectionError }
export type { GentNamespacedClient, GentRuntime }

// Re-export RPC types
export type { GentRpcsClient, GentRpcError }

// RPC client type alias
export type GentRpcClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof GentRpcs>>

// ---------------------------------------------------------------------------
// Utility functions (unchanged)
// ---------------------------------------------------------------------------

export function extractText(parts: readonly MessagePart[]): string {
  return parts
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.text)
    .join("")
}

export function extractReasoning(parts: readonly MessagePart[]): string {
  return parts
    .filter((p): p is ReasoningPart => p.type === "reasoning")
    .map((p) => p.text)
    .join("")
}

export interface ImageInfo {
  mediaType: string
}

export function extractImages(parts: readonly MessagePart[]): ImageInfo[] {
  return parts
    .filter((p): p is ImagePart => p.type === "image")
    .map((p) => ({ mediaType: p.mediaType ?? "image" }))
}

type ImagePart = { type: "image"; image: string; mediaType?: string }

export interface ExtractedToolCall {
  id: string
  toolName: string
  status: "running" | "completed" | "error"
  input: unknown | undefined
  summary: string | undefined
  output: string | undefined
}

export function extractToolCalls(parts: readonly MessagePart[]): ExtractedToolCall[] {
  return parts
    .filter((p): p is ToolCallPart => p.type === "tool-call")
    .map((tc) => ({
      id: tc.toolCallId,
      toolName: tc.toolName,
      status: "completed" as const,
      input: tc.input,
      summary: undefined,
      output: undefined,
    }))
}

export function buildToolResultMap(
  messages: readonly MessageInfoReadonly[],
): Map<string, { summary: string; output: string; isError: boolean }> {
  const resultMap = new Map<string, { summary: string; output: string; isError: boolean }>()

  for (const msg of messages) {
    if (msg.role === "tool") {
      for (const part of msg.parts) {
        if (part.type === "tool-result") {
          const result = part as ToolResultPart
          resultMap.set(result.toolCallId, {
            summary: summarizeOutput(result.output),
            output: stringifyOutput(result.output.value),
            isError: result.output.type === "error-json",
          })
        }
      }
    }
  }

  return resultMap
}

export function extractToolCallsWithResults(
  parts: readonly MessagePart[],
  resultMap: Map<string, { summary: string; output: string; isError: boolean }>,
): ExtractedToolCall[] {
  return parts
    .filter((p): p is ToolCallPart => p.type === "tool-call")
    .map((tc) => {
      const result = resultMap.get(tc.toolCallId)
      let status: ExtractedToolCall["status"] = "running"
      if (result !== undefined) status = result.isError ? "error" : "completed"
      return {
        id: tc.toolCallId,
        toolName: tc.toolName,
        status,
        input: tc.input,
        summary: result?.summary,
        output: result?.output,
      }
    })
}

// ---------------------------------------------------------------------------
// Internal: build runtime from captured services + lifecycle
// ---------------------------------------------------------------------------

function makeRuntime(services: Context.Context<unknown>, lifecycle: GentLifecycle): GentRuntime {
  return {
    cast: (effect) => {
      Effect.runForkWith(services)(effect)
    },
    fork: (effect) => Effect.runForkWith(services)(effect),
    run: (effect) => Effect.runPromiseWith(services)(effect),
    lifecycle,
  }
}

// ---------------------------------------------------------------------------
// Static lifecycle for non-supervised connections
// ---------------------------------------------------------------------------

const staticLifecycle = (state: ConnectionState): GentLifecycle => ({
  getState: () => state,
  subscribe: (listener) => {
    listener(state)
    return () => {}
  },
  restart: Effect.fail(
    new GentConnectionError({ message: "restart not supported on this transport" }),
  ),
  waitForReady: Effect.void,
})

// ---------------------------------------------------------------------------
// Supervisor → GentLifecycle adapter
// ---------------------------------------------------------------------------

const supervisorLifecycle = (supervisor: WorkerSupervisor): GentLifecycle => ({
  getState: () => {
    const s = supervisor.getState()
    switch (s._tag) {
      case "starting":
        return { _tag: "connecting" }
      case "running":
        return { _tag: "connected", pid: s.pid, generation: s.restartCount }
      case "restarting":
        return { _tag: "reconnecting", attempt: s.restartCount, generation: s.restartCount }
      case "stopped":
        return { _tag: "disconnected", reason: "stopped" }
      case "failed":
        return { _tag: "disconnected", reason: s.message }
    }
  },
  subscribe: (listener) =>
    supervisor.subscribe((s) => {
      switch (s._tag) {
        case "starting":
          return listener({ _tag: "connecting" })
        case "running":
          return listener({ _tag: "connected", pid: s.pid, generation: s.restartCount })
        case "restarting":
          return listener({
            _tag: "reconnecting",
            attempt: s.restartCount,
            generation: s.restartCount,
          })
        case "stopped":
          return listener({ _tag: "disconnected", reason: "stopped" })
        case "failed":
          return listener({ _tag: "disconnected", reason: s.message })
      }
    }),
  restart: supervisor.restart.pipe(
    Effect.mapError((e) => new GentConnectionError({ message: e.message })),
  ),
  // waitForWorkerRunning fails on "stopped" and "failed" to unblock waiting fibers.
  // Swallow here so the GentLifecycle.waitForReady: Effect<void> contract holds.
  // runWithReconnect callers handle retry/backoff on their own.
  waitForReady: waitForWorkerRunning(supervisor).pipe(Effect.catchEager(() => Effect.void)),
})

// ---------------------------------------------------------------------------
// WebSocket transport (internal)
// ---------------------------------------------------------------------------

const toWsUrl = (httpUrl: string): string => httpUrl.replace(/^http(s?):\/\//, "ws$1://")

const WsTransport = (url: string): Layer.Layer<RpcClient.Protocol> =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(
      Socket.layerWebSocket(toWsUrl(url)).pipe(
        Layer.tapCause((cause) =>
          Effect.logWarning("ws.client.error").pipe(
            Effect.annotateLogs({ url, error: String(cause) }),
          ),
        ),
      ),
    ),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
    Layer.provide(RpcSerialization.layerJson),
  )

// ---------------------------------------------------------------------------
// RPC client assembly (internal)
// ---------------------------------------------------------------------------

const makeRpcClient: Effect.Effect<GentRpcClient, never, RpcClient.Protocol | Scope.Scope> =
  Effect.gen(function* () {
    const rpcClient = yield* RpcClient.make(GentRpcs)
    // SAFETY: RpcClient.make returns RpcClientError in error types, but GentRpcs
    // defines GentRpcError as the error schema. The cast narrows to our specific error type.
    return rpcClient as unknown as GentRpcClient
  })

// ---------------------------------------------------------------------------
// Gent — unified client constructors
// ---------------------------------------------------------------------------

export interface GentSpawnOptions {
  readonly cwd: string
  readonly env?: Record<string, string | undefined>
  readonly startupTimeoutMs?: number
  readonly mode?: "default" | "debug"
  /** Enable shared server mode (default: true). When true, checks the server
   *  registry before spawning a new server — reuses existing if valid. */
  readonly shared?: boolean
  /** Database path. Used as the registry key for shared mode. */
  readonly dbPath?: string
  /** Home directory for registry files. Defaults to os.homedir(). */
  readonly home?: string
}

export interface GentConnectOptions {
  readonly url: string
}

export interface GentLocalOptions {
  readonly cwd: string
  readonly home?: string
  readonly dataDir?: string
  readonly platform?: string
  readonly shell?: string
  readonly osVersion?: string
  readonly dbPath?: string
  readonly authFilePath?: string
  readonly authKeyPath?: string
  readonly persistenceMode?: DependenciesConfig["persistenceMode"]
  readonly providerMode?: DependenciesConfig["providerMode"]
  readonly disabledExtensions?: DependenciesConfig["disabledExtensions"]
  readonly scheduledJobCommand?: DependenciesConfig["scheduledJobCommand"]
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type LayerContext<T> = T extends Layer.Layer<infer _A, infer _E, infer R> ? R : never
export type RpcHandlersContext = LayerContext<typeof RpcHandlersLive>

export interface GentClientBundle {
  readonly client: GentNamespacedClient
  readonly runtime: GentRuntime
}

const toConnectionError = (error: unknown) =>
  new GentConnectionError({
    message:
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { readonly message: unknown }).message)
        : String(error),
  })

const LocalPlatformLayer = Layer.merge(BunServices.layer, BunFileSystem.layer)

const resolveLocalDependenciesConfig = (options: GentLocalOptions): DependenciesConfig => {
  const home = options.home ?? os.homedir()
  const dataDir = options.dataDir ?? `${home}/.gent`

  const config: DependenciesConfig = {
    cwd: options.cwd,
    home,
    platform: options.platform ?? process.platform,
    osVersion: options.osVersion ?? os.release(),
    dbPath: options.dbPath ?? `${dataDir}/data.db`,
    persistenceMode: options.persistenceMode ?? "disk",
    providerMode: options.providerMode ?? "live",
    disabledExtensions: options.disabledExtensions,
  }

  if (options.shell !== undefined) config.shell = options.shell
  if (options.authFilePath !== undefined) config.authFilePath = options.authFilePath
  if (options.authKeyPath !== undefined) config.authKeyPath = options.authKeyPath
  if (options.scheduledJobCommand !== undefined) {
    config.scheduledJobCommand = options.scheduledJobCommand
  }

  return config
}

/** Resolve the canonical DB path for registry keying. */
const resolveDbPath = (options: GentSpawnOptions): string => {
  const home = options.home ?? os.homedir()
  if (options.dbPath !== undefined) return pathResolve(options.dbPath)
  const dataDir = pathJoin(home, ".gent")
  return pathResolve(pathJoin(dataDir, "data.db"))
}

/** Spawn a new server, write registry entry, connect. */
const spawnAndRegister = (
  options: GentSpawnOptions,
  home: string,
  dbPath: string,
  fingerprint: string,
): Effect.Effect<GentClientBundle, GentConnectionError, Scope.Scope> =>
  Effect.gen(function* () {
    const serverId = Bun.randomUUIDv7()
    const supervisor = yield* startWorkerSupervisor({
      ...options,
      shared: true,
      env: {
        ...options.env,
        GENT_SERVER_ID: serverId,
        GENT_BUILD_FINGERPRINT: fingerprint,
        GENT_DB_PATH: dbPath,
      },
    }).pipe(Effect.mapError((e) => new GentConnectionError({ message: e.message })))

    // Write registry entry
    const pid = supervisor.pid()
    if (pid !== null) {
      writeRegistryEntry(
        home,
        new ServerRegistryEntry({
          serverId,
          pid,
          hostname: os.hostname(),
          rpcUrl: supervisor.url,
          dbPath,
          buildFingerprint: fingerprint,
          startedAt: Date.now(),
        }),
      )
    }

    // Connect to the new server
    const scope = yield* Effect.scope
    const transport = yield* Layer.buildWithScope(WsTransport(supervisor.url), scope)
    const rpcClient = yield* makeRpcClient.pipe(Effect.provide(transport))
    const services = yield* Effect.context<never>()

    // Clean up registry on scope close
    yield* Effect.addFinalizer(() => Effect.sync(() => removeRegistryEntry(home, dbPath, serverId)))

    return {
      client: makeNamespacedClient(rpcClient),
      runtime: makeRuntime(services as Context.Context<unknown>, supervisorLifecycle(supervisor)),
    }
  })

export const Gent = {
  /** Spawn or reuse a shared server, or spawn an isolated one. */
  spawn: (
    options: GentSpawnOptions,
  ): Effect.Effect<GentClientBundle, GentConnectionError, Scope.Scope> =>
    Effect.gen(function* () {
      const shared = options.shared ?? true
      if (!shared) {
        // Isolated mode — always start a new server
        const supervisor = yield* startWorkerSupervisor(options).pipe(
          Effect.mapError((e) => new GentConnectionError({ message: e.message })),
        )
        const scope = yield* Effect.scope
        const transport = yield* Layer.buildWithScope(WsTransport(supervisor.url), scope)
        const rpcClient = yield* makeRpcClient.pipe(Effect.provide(transport))
        const services = yield* Effect.context<never>()
        return {
          client: makeNamespacedClient(rpcClient),
          runtime: makeRuntime(
            services as Context.Context<unknown>,
            supervisorLifecycle(supervisor),
          ),
        }
      }

      // Shared mode — registry-aware
      const home = options.home ?? os.homedir()
      const dbPath = resolveDbPath(options)
      const fingerprint = computeLocalFingerprint()

      // Check existing registry entry
      const existing = readRegistryEntry(home, dbPath)
      if (existing !== undefined) {
        const validation = validateRegistryEntry(existing)
        if (validation.valid) {
          // Check fingerprint match
          if (existing.buildFingerprint === fingerprint) {
            // Reuse existing server
            return yield* Gent.connect({ url: existing.rpcUrl }).pipe(
              Effect.catchEager(() =>
                // Connection failed — stale entry, fall through to start new
                spawnAndRegister(options, home, dbPath, fingerprint),
              ),
            )
          }
          // Stale fingerprint — SIGTERM the old server and start new
          try {
            process.kill(existing.pid, "SIGTERM")
          } catch {
            // Already dead
          }
          removeRegistryEntry(home, dbPath, existing.serverId)
        } else {
          // Dead/invalid — clean up
          removeRegistryEntry(home, dbPath, existing.serverId)
        }
      }

      // Acquire lock, start server, write registry
      return yield* withLock(
        home,
        dbPath,
        spawnAndRegister(options, home, dbPath, fingerprint),
      ).pipe(
        Effect.catchEager((lockErr) => {
          // Lock contention — another process is starting. Retry registry check.
          const retryEntry = readRegistryEntry(home, dbPath)
          if (retryEntry !== undefined && validateRegistryEntry(retryEntry).valid) {
            return Gent.connect({ url: retryEntry.rpcUrl })
          }
          return Effect.fail(
            new GentConnectionError({
              message: `Failed to acquire server lock: ${String(lockErr)}`,
            }),
          )
        }),
      )
    }),

  /** Connect to an already-running server */
  connect: (
    options: GentConnectOptions,
  ): Effect.Effect<GentClientBundle, GentConnectionError, Scope.Scope> =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const transport = yield* Layer.buildWithScope(WsTransport(options.url), scope)
      const rpcClient = yield* makeRpcClient.pipe(Effect.provide(transport))
      const services = yield* Effect.context<never>()
      return {
        client: makeNamespacedClient(rpcClient),
        runtime: makeRuntime(
          services as Context.Context<unknown>,
          staticLifecycle({ _tag: "connected", generation: 0 }),
        ),
      }
    }),

  /** Run the live server dependency graph in-process. */
  local: (
    options: GentLocalOptions,
  ): Effect.Effect<GentClientBundle, GentConnectionError, Scope.Scope> =>
    Effect.gen(function* () {
      const depsLive = createDependencies(resolveLocalDependenciesConfig(options)).pipe(
        Layer.provide(LocalPlatformLayer),
        Layer.provide(GentLogger),
        Layer.provide(GentLogLevel),
        Layer.provide(GentTracerLive),
      )

      const supervisor = yield* startLocalSupervisor(
        (scope) =>
          Effect.gen(function* () {
            const handlersContext = yield* Layer.buildWithScope(
              Layer.provide(
                Layer.provide(RpcHandlersLive, Layer.provideMerge(AppServicesLive, depsLive)),
                LocalPlatformLayer,
              ),
              scope,
            )

            return yield* RpcTest.makeClient(GentRpcs).pipe(
              Effect.provide(handlersContext),
            ) as Effect.Effect<GentRpcClient>
          }),
        toConnectionError,
      )
      const services = yield* Effect.context<never>()
      return {
        client: supervisor.client,
        runtime: makeRuntime(services as Context.Context<unknown>, supervisor.lifecycle),
      }
    }),

  /** In-process client for tests and embedding. Fast, less isolation than spawn. */
  test: <E, R>(
    handlersLayer: Layer.Layer<RpcHandlersContext, E, R>,
  ): Effect.Effect<GentClientBundle, E, R | Scope.Scope> =>
    Effect.gen(function* () {
      const context = yield* Layer.build(Layer.provide(RpcHandlersLive, handlersLayer))
      const rpcClient = yield* RpcTest.makeClient(GentRpcs).pipe(
        Effect.provide(context),
      ) as Effect.Effect<GentRpcClient>
      const services = yield* Effect.context<never>()
      return {
        client: makeNamespacedClient(rpcClient),
        runtime: makeRuntime(
          services as Context.Context<unknown>,
          staticLifecycle({ _tag: "connected", generation: 0 }),
        ),
      }
    }),
} as const
