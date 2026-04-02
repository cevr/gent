import { Effect, Layer } from "effect"
import type { Fiber, ServiceMap, Scope } from "effect"
import { RpcClient, RpcTest, RpcSerialization } from "effect/unstable/rpc"
import type { RpcGroup } from "effect/unstable/rpc"
import { Socket } from "effect/unstable/socket"
import { GentRpcs, type GentRpcsClient } from "@gent/core/server/rpcs.js"
import { RpcHandlersLive } from "@gent/core/server/rpc-handlers.js"
import {
  GentConnectionError,
  type ConnectionState,
  type GentLifecycle,
  type SkillInfo,
  type SkillContent,
  type MessageInfoReadonly,
  type SteerCommand,
  type SessionInfo,
  type BranchInfo,
  type BranchTreeNode,
  type SessionSnapshot,
  type SessionRuntime,
  type SessionTreeNode,
  type CreateSessionResult,
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
import type { SkillScope } from "@gent/core/domain/skills.js"
import { startWorkerSupervisor, waitForWorkerRunning, type WorkerSupervisor } from "./supervisor.js"
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
  SkillInfo,
  SkillContent,
  MessageInfoReadonly,
  SteerCommand,
  SessionInfo,
  BranchInfo,
  BranchTreeNode,
  SessionSnapshot,
  SessionRuntime,
  SessionTreeNode,
  CreateSessionResult,
}
export { GentConnectionError }
export type { GentNamespacedClient, GentRuntime }

// Re-export RPC types
export type { GentRpcsClient, GentRpcError }
export type { SkillScope }

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

function makeRuntime(
  services: ServiceMap.ServiceMap<unknown>,
  lifecycle: GentLifecycle,
): GentRuntime {
  return {
    // @effect-diagnostics-next-line *:off
    cast: (effect) => {
      // @effect-diagnostics-next-line *:off
      Effect.runForkWith(services)(effect)
    },
    // @effect-diagnostics-next-line *:off
    fork: (effect) => {
      // @effect-diagnostics-next-line *:off
      const fiber = Effect.runForkWith(services)(effect)
      return fiber as Fiber.Fiber<unknown, unknown> as never
    },
    // @effect-diagnostics-next-line *:off
    run: (effect) => Effect.runPromiseWith(services)(effect) as never,
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
}

export interface GentConnectOptions {
  readonly url: string
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type LayerContext<T> = T extends Layer.Layer<infer _A, infer _E, infer R> ? R : never
export type RpcHandlersContext = LayerContext<typeof RpcHandlersLive>

export interface GentClientBundle {
  readonly client: GentNamespacedClient
  readonly runtime: GentRuntime
}

export const Gent = {
  /** Spawn a supervised child process server and connect to it */
  spawn: (
    options: GentSpawnOptions,
  ): Effect.Effect<GentClientBundle, GentConnectionError, Scope.Scope> =>
    Effect.gen(function* () {
      const supervisor = yield* startWorkerSupervisor(options).pipe(
        Effect.mapError((e) => new GentConnectionError({ message: e.message })),
      )
      const scope = yield* Effect.scope
      const transport = yield* Layer.buildWithScope(WsTransport(supervisor.url), scope)
      const rpcClient = yield* makeRpcClient.pipe(Effect.provide(transport))
      const services = yield* Effect.services<never>()
      return {
        client: makeNamespacedClient(rpcClient),
        runtime: makeRuntime(
          services as ServiceMap.ServiceMap<unknown>,
          supervisorLifecycle(supervisor),
        ),
      }
    }),

  /** Connect to an already-running server */
  connect: (
    options: GentConnectOptions,
  ): Effect.Effect<GentClientBundle, GentConnectionError, Scope.Scope> =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const transport = yield* Layer.buildWithScope(WsTransport(options.url), scope)
      const rpcClient = yield* makeRpcClient.pipe(Effect.provide(transport))
      const services = yield* Effect.services<never>()
      return {
        client: makeNamespacedClient(rpcClient),
        runtime: makeRuntime(
          services as ServiceMap.ServiceMap<unknown>,
          staticLifecycle({ _tag: "connected", generation: 0 }),
        ),
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
      const services = yield* Effect.services<never>()
      return {
        client: makeNamespacedClient(rpcClient),
        runtime: makeRuntime(
          services as ServiceMap.ServiceMap<unknown>,
          staticLifecycle({ _tag: "connected", generation: 0 }),
        ),
      }
    }),
} as const
