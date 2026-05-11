/**
 * Gent server primitive — resolves or starts a server, always has a URL.
 *
 * Two server topologies:
 * - owned: in-process handler context + HTTP listener (primary client gets direct RPC)
 * - attached: existing server found via registry (client connects via WS)
 */

import { BunHttpServer, BunFileSystem, BunServices } from "@effect/platform-bun"
import { FetchHttpClient, HttpClient, HttpRouter, HttpServer } from "effect/unstable/http"
import { Clock, Effect, Layer, Context, Schema } from "effect"
import { TaggedEnumClass } from "@gent/core-internal/domain/schema-tagged-enum-class.js"
import type { Scope } from "effect"
// @effect-diagnostics nodeBuiltinImport:off — server primitive owns filesystem path resolution
import { resolve as pathResolve, join as pathJoin } from "node:path"

import { BuiltinExtensions } from "@gent/extensions"
import type { RpcHandlersLive } from "@gent/core-internal/server/rpc-handlers.js"
import { seedDebugSession } from "@gent/core-internal/debug/session.js"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model.js"
import type { LanguageModel } from "effect/unstable/ai"
import { BuildFingerprint } from "@gent/core-internal/server/build-fingerprint.js"
import { GentConnectionError } from "@gent/core-internal/server/transport-contract.js"
import { workspaceHeadersForCwd, type WorkspaceHeaders } from "./transport-headers.js"
import {
  readServerLock,
  validateServerLockEntry,
  writeServerLock,
  removeServerLock,
  ServerLockEntry,
  serverLockIdentityOf,
  signalIfIdentityOwned,
} from "./server-lock.js"
import { GentPlatform } from "@gent/core-internal/runtime/gent-platform.js"
import { BunGentPlatformLive } from "@gent/core-internal/runtime/gent-platform-bun.js"
import { buildServerRoot } from "@gent/core-internal/server/server-root.js"
// ── Types ──

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Layer output helper intentionally ignores empty error/context channels
type LayerOutput<T> = T extends Layer.Layer<infer A, infer _E, infer _R> ? A : never
type BuiltRpcHandlers = LayerOutput<typeof RpcHandlersLive>

export const StateSpec = TaggedEnumClass("StateSpec", {
  Sqlite: TaggedEnumClass.variant("sqlite", {
    home: Schema.optional(Schema.String),
    dbPath: Schema.optional(Schema.String),
  }),
  Memory: TaggedEnumClass.variant("memory", {}),
})
export type StateSpec = Schema.Schema.Type<typeof StateSpec>

export const ProviderSpec = TaggedEnumClass("ProviderSpec", {
  Live: TaggedEnumClass.variant("live", {}),
  Mock: TaggedEnumClass.variant("mock", {
    delayMs: Schema.optional(Schema.Number),
    failing: Schema.optional(Schema.Boolean),
    retries: Schema.optional(Schema.Boolean),
  }),
})
export type ProviderSpec = Schema.Schema.Type<typeof ProviderSpec>

export interface GentServerOptions {
  readonly cwd: string
  readonly state?: StateSpec
  readonly provider?: ProviderSpec
  readonly env?: Record<string, string | undefined>
  readonly authDirectory?: string
  /** Seed storage with a debug session on startup. */
  readonly debug?: boolean
}

/** Public opaque server handle. */
export const GentServer = TaggedEnumClass("GentServer", {
  Owned: TaggedEnumClass.variant("owned", {
    url: Schema.String,
    workspaceId: Schema.String,
  }),
  Attached: TaggedEnumClass.variant("attached", {
    url: Schema.String,
    workspaceId: Schema.String,
  }),
})
export type GentServer = Schema.Schema.Type<typeof GentServer>

// ── Internal state for owned servers ──

interface OwnedServerInternal {
  readonly handlerContext: Context.Context<BuiltRpcHandlers>
  readonly port: number
  readonly serverId: string
  readonly headers: WorkspaceHeaders
}

/** WeakMap keyed by GentServer object identity — keeps handler context private */
const ownedInternals = new WeakMap<GentServer, OwnedServerInternal>()

/** @internal — used by Gent.client to access owned server handler context */
export const getOwnedInternal = (server: GentServer): OwnedServerInternal | undefined =>
  ownedInternals.get(server)

// ── Factories ──

export const state = {
  sqlite: (options?: { readonly home?: string; readonly dbPath?: string }): StateSpec =>
    StateSpec.Sqlite.make({
      ...(options?.home !== undefined ? { home: options.home } : {}),
      ...(options?.dbPath !== undefined ? { dbPath: options.dbPath } : {}),
    }),
  memory: (): StateSpec => StateSpec.Memory.make({}),
} as const

export const provider = {
  live: (): ProviderSpec => ProviderSpec.Live.make({}),
  mock: (options?: {
    readonly delayMs?: number
    readonly failing?: boolean
    readonly retries?: boolean
  }): ProviderSpec => ProviderSpec.Mock.make({ ...(options ?? {}) }),
} as const

// ── Language model layer from spec ──

/** Build a self-contained language model layer from spec. For "live", returns undefined
 *  (let createDependencies build its own from auth deps). */
const resolveLanguageModelLayer = (
  spec: ProviderSpec,
): Layer.Layer<LanguageModel.LanguageModel, never, never> | undefined => {
  if (spec._tag === "live") return undefined
  if (spec.failing === true) return LanguageModelLayers.failing
  return LanguageModelLayers.debug({
    delayMs: spec.delayMs,
    retries: spec.retries,
  })
}

// ── Platform layers ──

const PlatformBaseLayer = Layer.mergeAll(
  BunServices.layer,
  BunFileSystem.layer,
  BunGentPlatformLive,
)
const LocalPlatformLayer = Layer.merge(
  PlatformBaseLayer,
  BuildFingerprint.Live.pipe(Layer.provide(PlatformBaseLayer)),
)

// ── Helpers ──

const resolveHome = (
  options: GentServerOptions,
  stateSpec: StateSpec,
  homeDirectory: string,
): string =>
  (stateSpec._tag === "sqlite" ? stateSpec.home : undefined) ??
  options.env?.["HOME"] ??
  homeDirectory

const resolveDbPath = (home: string, stateSpec: StateSpec): string => {
  if (stateSpec._tag === "sqlite" && stateSpec.dbPath !== undefined)
    return pathResolve(stateSpec.dbPath)
  const dataDir = pathJoin(home, ".gent")
  return pathResolve(pathJoin(dataDir, "data.db"))
}

// ── Build owned server (in-process + HTTP listener) ──

const buildOwnedServer = (
  options: GentServerOptions,
  stateSpec: StateSpec,
  providerSpec: ProviderSpec,
): Effect.Effect<GentServer, GentConnectionError, Scope.Scope> =>
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.provide(
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const platform = yield* GentPlatform
      const osInfo = yield* platform.osInfo
      const pid = yield* platform.pid
      const homeDirectory = yield* platform.homeDirectory
      const httpServerCtx = yield* Layer.buildWithScope(
        BunHttpServer.layer({ port: 0, idleTimeout: 0 }),
        scope,
      ).pipe(
        Effect.mapError(
          (error) =>
            new GentConnectionError({ message: `server listener failed: ${String(error)}` }),
        ),
      )
      const httpServer = Context.get(httpServerCtx, HttpServer.HttpServer)
      const port = httpServer.address._tag === "TcpAddress" ? httpServer.address.port : 0
      if (port === 0) {
        return yield* new GentConnectionError({
          message: "server listener did not bind a concrete TCP port",
        })
      }
      const url = `http://127.0.0.1:${port}/rpc`
      const workspaceHeaders = workspaceHeadersForCwd(options.cwd)
      const home = resolveHome(options, stateSpec, homeDirectory)
      const serverId = yield* platform.randomId
      const buildFingerprint = yield* (yield* BuildFingerprint).resolved

      const languageModelLayer = resolveLanguageModelLayer(providerSpec)
      const dbPath = stateSpec._tag === "sqlite" ? resolveDbPath(home, stateSpec) : undefined
      const serverRoot = yield* buildServerRoot({
        dependencies: {
          cwd: options.cwd,
          home,
          platform: osInfo.platform,
          osVersion: osInfo.release,
          dbPath,
          ...(options.authDirectory !== undefined ? { authDirectory: options.authDirectory } : {}),
          persistenceMode: stateSpec._tag === "memory" ? "memory" : "disk",
          sharedServerUrl: url,
          extensions: BuiltinExtensions,
          ...(languageModelLayer !== undefined
            ? { languageModelLayerOverride: languageModelLayer }
            : {}),
        },
        identity: {
          serverId,
          pid,
          hostname: osInfo.hostname,
          dbPath: dbPath ?? ":memory:",
          buildFingerprint,
        },
      }).pipe(
        Effect.mapError(
          (error) => new GentConnectionError({ message: `server root failed: ${String(error)}` }),
        ),
      )

      const HttpServerLive = HttpRouter.serve(serverRoot.httpRoutes).pipe(
        Layer.provide(Layer.succeedContext(httpServerCtx)),
        Layer.provide(serverRoot.coreServicesLive),
        Layer.provide(LocalPlatformLayer),
      )

      yield* Layer.buildWithScope(HttpServerLive, scope).pipe(Effect.orDie)

      // Seed debug session if requested
      if (options.debug === true) {
        yield* seedDebugSession(options.cwd).pipe(
          // @effect-diagnostics-next-line strictEffectProvide:off
          Effect.provide(serverRoot.coreServicesLive),
          Effect.catchEager(() => Effect.void),
        )
      }

      const server: GentServer = GentServer.Owned.make({
        url,
        workspaceId: workspaceHeaders["x-gent-workspace-id"],
      })
      ownedInternals.set(server, {
        handlerContext: serverRoot.rpcHandlersContext,
        port,
        serverId,
        headers: workspaceHeaders,
      })

      return server
    }),
    LocalPlatformLayer,
  )

// ── Probe an existing server via identity endpoint ──

const probeServer = (
  rpcUrl: string,
  expected: ReturnType<typeof serverLockIdentityOf>,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const baseUrl = rpcUrl.replace("/rpc", "")
    const response = yield* http.get(`${baseUrl}/_gent/identity`).pipe(Effect.timeout(3000))
    if (response.status >= 400) return false
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- platform boundary validates foreign runtime shape before use
    const identity = (yield* response.json) as Partial<ReturnType<typeof serverLockIdentityOf>>
    // Server id/db/build prove endpoint identity; pid/host prove signal ownership.
    // All fields must match before attach or SIGTERM.
    return (
      identity.serverId === expected.serverId &&
      identity.pid === expected.pid &&
      identity.hostname === expected.hostname &&
      identity.dbPath === expected.dbPath &&
      identity.buildFingerprint === expected.buildFingerprint
    )
  }).pipe(
    // @effect-diagnostics-next-line strictEffectProvide:off self-contained probe, no scope lifetime
    Effect.provide(FetchHttpClient.layer),
    Effect.catchEager(() => Effect.succeed(false)),
  )

/**
 * Probe a server lock entry's `/_gent/identity` endpoint and confirm every
 * identity field matches. Shared with `server stop` paths (TUI/CLI) so
 * PID-reuse after a crash never signals an unrelated process.
 */
export const probeServerLockEntryIdentity = (entry: ServerLockEntry): Effect.Effect<boolean> =>
  probeServer(entry.rpcUrl, serverLockIdentityOf(entry))

// ── Main server resolver ──

export const resolveServer = (
  options: GentServerOptions,
): Effect.Effect<GentServer, GentConnectionError, Scope.Scope> =>
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.provide(resolveServerInternal(options), LocalPlatformLayer)

const resolveServerInternal = (
  options: GentServerOptions,
): Effect.Effect<
  GentServer,
  GentConnectionError,
  Scope.Scope | LayerOutput<typeof LocalPlatformLayer>
> =>
  Effect.gen(function* () {
    const stateSpec = options.state ?? state.sqlite()
    const providerSpec = options.provider ?? provider.live()

    // Memory state: always owned, no registry
    if (stateSpec._tag === "memory") {
      return yield* buildOwnedServer(options, stateSpec, providerSpec)
    }

    // SQLite state: shared-server aware
    const platform = yield* GentPlatform
    const home = resolveHome(options, stateSpec, yield* platform.homeDirectory)
    const dbPath = resolveDbPath(home, stateSpec)
    const fingerprint = yield* (yield* BuildFingerprint).local
    const osInfo = yield* platform.osInfo
    const pid = yield* platform.pid

    // Check the single shared server lock.
    const existing = yield* readServerLock(home)
    if (existing !== undefined) {
      const validation = yield* validateServerLockEntry(existing)
      if (validation.valid && existing.buildFingerprint === fingerprint) {
        // Probe the server before trusting — verify serverId, dbPath, fingerprint
        const alive = yield* probeServer(existing.rpcUrl, {
          serverId: existing.serverId,
          pid: existing.pid,
          hostname: existing.hostname,
          dbPath: existing.dbPath,
          buildFingerprint: fingerprint,
        })
        if (alive) {
          return GentServer.Attached.make({
            url: existing.rpcUrl,
            workspaceId: workspaceHeadersForCwd(options.cwd)["x-gent-workspace-id"],
          })
        }
      }
      // Stale — only signal when the live process proves it owns this server identity.
      if (validation.valid) {
        yield* signalIfIdentityOwned(existing, probeServerLockEntryIdentity)
      }
      yield* removeServerLock(home, existing.serverId)
    }

    const server = yield* buildOwnedServer(options, stateSpec, providerSpec)
    const internal = getOwnedInternal(server)
    if (internal !== undefined) {
      yield* writeServerLock(
        home,
        new ServerLockEntry({
          serverId: internal.serverId,
          pid,
          hostname: osInfo.hostname,
          rpcUrl: server.url,
          dbPath,
          buildFingerprint: fingerprint,
          startedAt: yield* Clock.currentTimeMillis,
        }),
      )
      // Clean up the shared server lock on scope close.
      yield* Effect.addFinalizer(() =>
        removeServerLock(home, internal.serverId).pipe(Effect.ignore),
      )
    }
    return server
  })
