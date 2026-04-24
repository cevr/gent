/**
 * Gent server primitive — resolves or starts a server, always has a URL.
 *
 * Two server topologies:
 * - owned: in-process handler context + HTTP listener (primary client gets direct RPC)
 * - attached: existing server found via registry (client connects via WS)
 */

import { BunHttpServer, BunFileSystem, BunServices } from "@effect/platform-bun"
import { FetchHttpClient, HttpClient, HttpRouter } from "effect/unstable/http"
import { Clock, Effect, Layer, Context } from "effect"
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
import { Provider } from "@gent/core/providers/provider.js"
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
  canSignalRegistryEntry,
} from "./server-registry.js"
import { findOpenPort } from "./supervisor.js"
// ── Types ──

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Layer output helper intentionally ignores empty error/context channels
type LayerOutput<T> = T extends Layer.Layer<infer A, infer _E, infer _R> ? A : never
type BuiltRpcHandlers = LayerOutput<typeof RpcHandlersLive>

export type StateSpec =
  | { readonly _tag: "sqlite"; readonly home?: string; readonly dbPath?: string }
  | { readonly _tag: "memory" }

export type ProviderSpec =
  | { readonly _tag: "live" }
  | {
      readonly _tag: "mock"
      readonly delayMs?: number
      readonly failing?: boolean
      readonly retries?: boolean
    }

export interface GentServerOptions {
  readonly cwd: string
  readonly state?: StateSpec
  readonly provider?: ProviderSpec
  readonly env?: Record<string, string | undefined>
  readonly authFilePath?: string
  readonly authKeyPath?: string
  /** Seed storage with a debug session on startup. */
  readonly debug?: boolean
}

/** Public opaque server handle. */
export type GentServer =
  | { readonly _tag: "owned"; readonly url: string }
  | { readonly _tag: "attached"; readonly url: string }

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
  sqlite: (options?: { readonly home?: string; readonly dbPath?: string }): StateSpec => ({
    _tag: "sqlite",
    ...(options?.home !== undefined ? { home: options.home } : {}),
    ...(options?.dbPath !== undefined ? { dbPath: options.dbPath } : {}),
  }),
  memory: (): StateSpec => ({ _tag: "memory" }),
} as const

export const provider = {
  live: (): ProviderSpec => ({ _tag: "live" }),
  mock: (options?: {
    readonly delayMs?: number
    readonly failing?: boolean
    readonly retries?: boolean
  }): ProviderSpec => ({
    _tag: "mock",
    ...(options ?? {}),
  }),
} as const

// ── Provider layer from spec ──

/** Build a self-contained provider layer from spec. For "live", returns undefined
 *  (let createDependencies build its own from auth deps). */
const resolveProviderLayer = (
  spec: ProviderSpec,
): Layer.Layer<Provider, never, never> | undefined => {
  if (spec._tag === "live") return undefined
  if (spec.failing === true) return Provider.Failing
  return Provider.Debug({
    delayMs: spec.delayMs,
    retries: spec.retries,
  })
}

// ── Platform layers ──

const LocalPlatformLayer = Layer.merge(BunServices.layer, BunFileSystem.layer)

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
      const port = yield* Effect.promise(findOpenPort).pipe(
        Effect.mapError(
          (error) =>
            new GentConnectionError({ message: `port allocation failed: ${String(error)}` }),
        ),
      )
      const url = `http://127.0.0.1:${port}/rpc`
      const home = resolveHome(options, stateSpec)
      const serverId = Bun.randomUUIDv7()
      const buildFingerprint = yield* Effect.provide(resolveBuildFingerprint, BunServices.layer)

      // Build provider layer (undefined = let createDependencies resolve from auth deps)
      const providerLayer = resolveProviderLayer(providerSpec)

      // Build dependency config
      const dbPath = stateSpec._tag === "sqlite" ? resolveDbPath(options, stateSpec) : undefined
      const depsLive = createDependencies({
        cwd: options.cwd,
        home,
        platform: process.platform,
        osVersion: os.release(),
        dbPath,
        ...(options.authFilePath !== undefined ? { authFilePath: options.authFilePath } : {}),
        ...(options.authKeyPath !== undefined ? { authKeyPath: options.authKeyPath } : {}),
        persistenceMode: stateSpec._tag === "memory" ? "memory" : "disk",
        sharedServerUrl: url,
        extensions: BuiltinExtensions,
        ...(providerLayer !== undefined ? { providerLayerOverride: providerLayer } : {}),
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
        // @effect-diagnostics-next-line strictEffectProvide:off
        yield* seedDebugSession(options.cwd).pipe(
          Effect.provide(coreServicesLive),
          Effect.catchEager(() => Effect.void),
        )
      }

      // Build RPC handler context for direct in-process client
      const handlersContext = yield* Layer.buildWithScope(
        Layer.provide(RpcHandlersLive, coreServicesLive),
        scope,
      ).pipe(Effect.orDie)

      const server: GentServer = { _tag: "owned", url }
      ownedInternals.set(server, {
        handlerContext: handlersContext,
        port,
        serverId,
      })

      return server
    }),
    BunFileSystem.layer,
  )

// ── Probe an existing server via identity endpoint ──

const probeServer = (
  rpcUrl: string,
  expected: { serverId: string; dbPath: string; buildFingerprint: string },
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const baseUrl = rpcUrl.replace("/rpc", "")
    const response = yield* http.get(`${baseUrl}/_gent/identity`).pipe(Effect.timeout(3000))
    if (response.status >= 400) return false
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- platform boundary validates foreign runtime shape before use
    const identity = (yield* response.json) as {
      serverId?: string
      dbPath?: string
      buildFingerprint?: string
    }
    return (
      identity.serverId === expected.serverId &&
      identity.dbPath === expected.dbPath &&
      identity.buildFingerprint === expected.buildFingerprint
    )
  }).pipe(
    // @effect-diagnostics-next-line strictEffectProvide:off self-contained probe, no scope lifetime
    Effect.provide(FetchHttpClient.layer),
    Effect.catchEager(() => Effect.succeed(false)),
  )

// ── Main server resolver ──

export const resolveServer = (
  options: GentServerOptions,
): Effect.Effect<GentServer, GentConnectionError, Scope.Scope> =>
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
    // @effect-diagnostics-next-line strictEffectProvide:off platform services for fingerprint computation
    const fingerprint = yield* Effect.provide(computeLocalFingerprint, BunServices.layer)

    // Check existing registry entry
    const existing = readRegistryEntry(home, dbPath)
    if (existing !== undefined) {
      const validation = validateRegistryEntry(existing)
      if (validation.valid && existing.buildFingerprint === fingerprint) {
        // Probe the server before trusting — verify serverId, dbPath, fingerprint
        const alive = yield* probeServer(existing.rpcUrl, {
          serverId: existing.serverId,
          dbPath,
          buildFingerprint: fingerprint,
        })
        if (alive) {
          return { _tag: "attached" as const, url: existing.rpcUrl }
        }
      }
      // Stale — only signal when the live process proves it owns this registry identity.
      const ownsRegistryIdentity = validation.valid
        ? yield* probeServer(existing.rpcUrl, registryIdentityOf(existing))
        : false
      if (ownsRegistryIdentity && canSignalRegistryEntry(existing)) {
        yield* Effect.try({
          try: () => process.kill(existing.pid, "SIGTERM"),
          catch: () => undefined,
        }).pipe(Effect.ignore)
      }
      removeRegistryEntry(home, dbPath, existing.serverId)
    }

    // Acquire lock, build owned server, write registry
    return yield* withLock(
      home,
      dbPath,
      Effect.gen(function* () {
        const server = yield* buildOwnedServer(options, stateSpec, providerSpec)
        const internal = getOwnedInternal(server)
        if (internal !== undefined) {
          writeRegistryEntry(
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
            Effect.sync(() => removeRegistryEntry(home, dbPath, internal.serverId)),
          )
        }
        return server
      }),
    ).pipe(
      Effect.catchEager((lockErr) => {
        // Lock contention — another process started. Retry registry with probe.
        const retryEntry = readRegistryEntry(home, dbPath)
        if (retryEntry !== undefined && validateRegistryEntry(retryEntry).valid) {
          return probeServer(retryEntry.rpcUrl, {
            serverId: retryEntry.serverId,
            dbPath,
            buildFingerprint: fingerprint,
          }).pipe(
            Effect.flatMap((alive) =>
              alive
                ? Effect.succeed({ _tag: "attached" as const, url: retryEntry.rpcUrl })
                : Effect.fail(
                    new GentConnectionError({
                      message: "Lock contention: new server did not pass identity probe",
                    }),
                  ),
            ),
          )
        }
        return Effect.fail(
          new GentConnectionError({
            message: `Failed to acquire server lock: ${String(lockErr)}`,
          }),
        )
      }),
    )
  })
