/**
 * Gent server primitive — resolves or starts a server, always has a URL.
 *
 * Two server topologies:
 * - owned: in-process handler context + HTTP listener (primary client gets direct RPC)
 * - attached: existing server found via registry (client connects via WS)
 */

import { BunHttpServer, BunFileSystem, BunServices } from "@effect/platform-bun"
import { FetchHttpClient, HttpClient, HttpRouter } from "effect/unstable/http"
import { Clock, Effect, Layer, Context, Schema } from "effect"
import { TaggedEnumClass } from "@gent/core/domain/schema-tagged-enum-class.js"
import type { Scope } from "effect"
// @effect-diagnostics nodeBuiltinImport:off — server primitive owns filesystem path resolution
import { resolve as pathResolve, join as pathJoin } from "node:path"
// @effect-diagnostics nodeBuiltinImport:off — server primitive reads process host metadata
import * as os from "node:os"

import { createDependencies } from "@gent/core/server/dependencies.js"
import { BuiltinExtensions } from "@gent/extensions/index.js"
import { AppServicesLive } from "@gent/core/server/index.js"
import { GentLogger, GentLogLevel } from "@gent/core/runtime/logger.js"
import { GentTracerLive } from "@gent/core/runtime/tracer.js"
import { ConnectionTracker } from "@gent/core/server/connection-tracker.js"
import { ServerIdentity } from "@gent/core/server/server-identity.js"
import { buildServerRoutes } from "@gent/core/server/server-routes.js"
import { RpcHandlersLive } from "@gent/core/server/rpc-handlers.js"
import { seedDebugSession } from "@gent/core/debug/session.js"
import { LanguageModelLayers } from "@gent/core/test-utils/language-model.js"
import type { LanguageModel } from "effect/unstable/ai"
import { resolveBuildFingerprint } from "@gent/core/server/build-fingerprint.js"
import { GentConnectionError } from "@gent/core/server/transport-contract.js"
import {
  readRegistryEntry,
  validateRegistryEntry,
  writeRegistryEntry,
  removeRegistryEntry,
  ServerRegistryEntry,
  withLock,
  computeLocalFingerprint,
  registryIdentityOf,
  signalIfIdentityOwned,
} from "./server-registry.js"
import { findOpenPort } from "./supervisor.js"
import { GentPlatform } from "@gent/core/runtime/gent-platform.js"
import { BunGentPlatformLive } from "@gent/core/runtime/gent-platform-bun.js"
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
  }),
  Attached: TaggedEnumClass.variant("attached", {
    url: Schema.String,
  }),
})
export type GentServer = Schema.Schema.Type<typeof GentServer>

// ── Internal state for owned servers ──

interface OwnedServerInternal {
  readonly handlerContext: Context.Context<BuiltRpcHandlers>
  readonly port: number
  readonly serverId: string
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

const LocalPlatformLayer = Layer.mergeAll(
  BunServices.layer,
  BunFileSystem.layer,
  BunGentPlatformLive,
)

// ── Helpers ──

const resolveHome = (options: GentServerOptions, stateSpec: StateSpec): string =>
  (stateSpec._tag === "sqlite" ? stateSpec.home : undefined) ??
  options.env?.["HOME"] ??
  os.homedir()

const resolveDbPath = (options: GentServerOptions, stateSpec: StateSpec): string => {
  const home = resolveHome(options, stateSpec)
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
      const port = yield* Effect.promise(findOpenPort).pipe(
        Effect.mapError(
          (error) =>
            new GentConnectionError({ message: `port allocation failed: ${String(error)}` }),
        ),
      )
      const url = `http://127.0.0.1:${port}/rpc`
      const home = resolveHome(options, stateSpec)
      const serverId = yield* platform.randomId
      const buildFingerprint = yield* resolveBuildFingerprint.pipe(
        // @effect-diagnostics-next-line strictEffectProvide:off
        Effect.provide(BunServices.layer),
      )

      // Build language model layer (undefined = let createDependencies resolve from auth deps)
      const languageModelLayer = resolveLanguageModelLayer(providerSpec)

      // Build dependency config
      const dbPath = stateSpec._tag === "sqlite" ? resolveDbPath(options, stateSpec) : undefined
      const depsLive = createDependencies({
        cwd: options.cwd,
        home,
        platform: process.platform,
        osVersion: os.release(),
        dbPath,
        ...(options.authDirectory !== undefined ? { authDirectory: options.authDirectory } : {}),
        persistenceMode: stateSpec._tag === "memory" ? "memory" : "disk",
        sharedServerUrl: url,
        extensions: BuiltinExtensions,
        ...(languageModelLayer !== undefined
          ? { languageModelLayerOverride: languageModelLayer }
          : {}),
      }).pipe(
        Layer.provide(LocalPlatformLayer),
        Layer.provide(GentLogger),
        Layer.provide(GentLogLevel),
        Layer.provide(GentTracerLive),
      )

      // Connection tracker
      const connectionTrackerCtx = yield* Layer.buildWithScope(ConnectionTracker.Live, scope).pipe(
        Effect.orDie,
      )

      // Server identity
      const serverIdentityLive = ServerIdentity.Live({
        serverId,
        pid: process.pid,
        hostname: os.hostname(),
        dbPath: dbPath ?? ":memory:",
        buildFingerprint,
        startedAt: yield* Clock.currentTimeMillis,
      })

      // Build full service context
      const depsServices = yield* Layer.buildWithScope(depsLive, scope).pipe(Effect.orDie)
      const appServices = yield* Layer.buildWithScope(
        AppServicesLive.pipe(Layer.provide(Layer.succeedContext(depsServices))),
        scope,
      ).pipe(Effect.orDie)
      const coreServices = Context.merge(
        Context.merge(depsServices, appServices),
        connectionTrackerCtx,
      )
      const serverIdentityCtx = yield* Layer.buildWithScope(serverIdentityLive, scope).pipe(
        Effect.orDie,
      )
      const allServices = Context.merge(coreServices, serverIdentityCtx)
      const coreServicesLive = Layer.succeedContext(allServices)

      // Build HTTP routes and start listener
      const AllRoutes = buildServerRoutes(coreServicesLive, {
        identity: {
          serverId,
          pid: process.pid,
          hostname: os.hostname(),
          dbPath: dbPath ?? ":memory:",
          buildFingerprint,
        },
      })

      const HttpServerLive = HttpRouter.serve(AllRoutes).pipe(
        Layer.provide(BunHttpServer.layer({ port, idleTimeout: 0 })),
        Layer.provide(coreServicesLive),
        Layer.provide(LocalPlatformLayer),
      )

      yield* Layer.buildWithScope(HttpServerLive, scope).pipe(Effect.orDie)

      // Seed debug session if requested
      if (options.debug === true) {
        yield* seedDebugSession(options.cwd).pipe(
          // @effect-diagnostics-next-line strictEffectProvide:off
          Effect.provide(coreServicesLive),
          Effect.catchEager(() => Effect.void),
        )
      }

      // Build RPC handler context for direct in-process client
      const handlersContext = yield* Layer.buildWithScope(
        Layer.provide(RpcHandlersLive, coreServicesLive),
        scope,
      ).pipe(Effect.orDie)

      const server: GentServer = GentServer.Owned.make({ url })
      ownedInternals.set(server, {
        handlerContext: handlersContext,
        port,
        serverId,
      })

      return server
    }),
    Layer.merge(BunFileSystem.layer, BunGentPlatformLive),
  )

// ── Probe an existing server via identity endpoint ──

const probeServer = (
  rpcUrl: string,
  expected: ReturnType<typeof registryIdentityOf>,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const baseUrl = rpcUrl.replace("/rpc", "")
    const response = yield* http.get(`${baseUrl}/_gent/identity`).pipe(Effect.timeout(3000))
    if (response.status >= 400) return false
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- platform boundary validates foreign runtime shape before use
    const identity = (yield* response.json) as Partial<ReturnType<typeof registryIdentityOf>>
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
 * Probe a registry entry's `/_gent/identity` endpoint and confirm every
 * identity field matches. Shared with `server stop` paths (TUI/CLI) so
 * PID-reuse after a crash never signals an unrelated process.
 */
export const probeRegistryEntryIdentity = (entry: ServerRegistryEntry): Effect.Effect<boolean> =>
  probeServer(entry.rpcUrl, registryIdentityOf(entry))

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

    // SQLite state: registry-aware
    const home = resolveHome(options, stateSpec)
    const dbPath = resolveDbPath(options, stateSpec)
    const fingerprint = yield* computeLocalFingerprint

    // Check existing registry entry
    const existing = yield* readRegistryEntry(home, dbPath)
    if (existing !== undefined) {
      const validation = validateRegistryEntry(existing)
      if (validation.valid && existing.buildFingerprint === fingerprint) {
        // Probe the server before trusting — verify serverId, dbPath, fingerprint
        const alive = yield* probeServer(existing.rpcUrl, {
          serverId: existing.serverId,
          pid: existing.pid,
          hostname: existing.hostname,
          dbPath,
          buildFingerprint: fingerprint,
        })
        if (alive) {
          return GentServer.Attached.make({ url: existing.rpcUrl })
        }
      }
      // Stale — only signal when the live process proves it owns this registry identity.
      if (validation.valid) {
        yield* signalIfIdentityOwned(existing, probeRegistryEntryIdentity)
      }
      yield* removeRegistryEntry(home, dbPath, existing.serverId)
    }

    // Acquire lock, build owned server, write registry
    return yield* withLock(
      home,
      dbPath,
      Effect.gen(function* () {
        const server = yield* buildOwnedServer(options, stateSpec, providerSpec)
        const internal = getOwnedInternal(server)
        if (internal !== undefined) {
          yield* writeRegistryEntry(
            home,
            new ServerRegistryEntry({
              serverId: internal.serverId,
              pid: process.pid,
              hostname: os.hostname(),
              rpcUrl: server.url,
              dbPath,
              buildFingerprint: fingerprint,
              startedAt: yield* Clock.currentTimeMillis,
            }),
          )
          // Clean up registry on scope close
          yield* Effect.addFinalizer(() =>
            removeRegistryEntry(home, dbPath, internal.serverId).pipe(Effect.ignore),
          )
        }
        return server
      }),
    ).pipe(
      Effect.catchTag("LockAcquireError", (lockErr) =>
        // Lock contention — another process started. Retry registry with probe.
        Effect.gen(function* () {
          const retryEntry = yield* readRegistryEntry(home, dbPath)
          if (retryEntry !== undefined && validateRegistryEntry(retryEntry).valid) {
            const alive = yield* probeServer(retryEntry.rpcUrl, {
              serverId: retryEntry.serverId,
              pid: retryEntry.pid,
              hostname: retryEntry.hostname,
              dbPath,
              buildFingerprint: fingerprint,
            })
            if (alive) {
              return GentServer.Attached.make({ url: retryEntry.rpcUrl })
            }
            return yield* new GentConnectionError({
              message: "Lock contention: new server did not pass identity probe",
            })
          }
          return yield* new GentConnectionError({
            message: `Failed to acquire server lock: ${String(lockErr)}`,
          })
        }),
      ),
    )
  })
