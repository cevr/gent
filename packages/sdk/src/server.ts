/**
 * Gent server primitive — resolves or starts a server, always has a URL.
 *
 * Two server topologies:
 * - owned: in-process handler context + HTTP listener (primary client gets direct RPC)
 * - attached: existing server found via registry (client connects via WS)
 */

import { BunHttpServer, BunFileSystem, BunServices } from "@effect/platform-bun"
import { FetchHttpClient, Headers, HttpClient, HttpRouter, HttpServer } from "effect/unstable/http"
import {
  Clock,
  Config,
  Context,
  Deferred,
  Effect,
  Layer,
  Match,
  Option,
  Predicate,
  Schema,
} from "effect"
import type { Scope } from "effect"
// @effect-diagnostics nodeBuiltinImport:off — server primitive owns filesystem path resolution
import { resolve as pathResolve, join as pathJoin } from "node:path"

import { BuiltinExtensions, CellBranchTools } from "@gent/extensions"
import type { BranchToolFeature } from "@gent/core-internal/runtime/agent/branch-tool-feature.js"
import type { GentExtension } from "@gent/core/extensions/api"
import type { RpcHandlersLive } from "@gent/core-internal/server/rpc-handlers.js"
import { seedDebugSession } from "./debug-session.js"
import {
  provideWorkspaceIdHeader,
  workspaceHeadersForCwd,
  workspaceIdForCwd,
  type WorkspaceHeaders,
} from "@gent/core-internal/server/workspace-rpc.js"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model.js"
import type { LanguageModel } from "effect/unstable/ai"
import { BuildFingerprint } from "./build-fingerprint.js"
import { GentObservability } from "./logger.js"
import { GentConnectionError } from "@gent/core/protocol"
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
import { buildServerRoot, StateLocation } from "@gent/core-internal/server/server-root.js"
// ── Types ──

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Layer output helper intentionally ignores empty error/context channels
type LayerOutput<T> = T extends Layer.Layer<infer A, infer _E, infer _R> ? A : never
type BuiltRpcHandlers = LayerOutput<typeof RpcHandlersLive>

export const StateSpec = Schema.Union([
  Schema.TaggedStruct("Sqlite", {
    home: Schema.optional(Schema.String),
    dbPath: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct("Memory", {}),
]).pipe(Schema.toTaggedUnion("_tag"))
export type StateSpec = Schema.Schema.Type<typeof StateSpec>

export const ProviderSpec = Schema.Union([
  Schema.TaggedStruct("Live", {}),
  Schema.TaggedStruct("Mock", {
    /** Finish every step having produced nothing — drives the unanswered turn. */
    empty: Schema.optional(Schema.Boolean),
  }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type ProviderSpec = Schema.Schema.Type<typeof ProviderSpec>

/**
 * Shut the owned server down once no client has been connected for
 * `idleMs`. A managed shared server uses this so short-lived workers stop
 * paying for an idle process; a standalone server omits it and runs forever.
 */
export interface IdleShutdownSpec {
  readonly idleMs: number
}

/**
 * Every launch value the standalone server reads from its environment.
 *
 * Each field stops the process at startup rather than letting a wrong value
 * run: `GENT_IDLE_TIMEOUT_MS=-1` would otherwise shut the server down on its
 * first poll, and a misspelled `GENT_PROVIDER_MODE` would quietly bill a live
 * provider for what the caller asked to run scripted. An unset variable takes
 * its default; a present but invalid one fails.
 *
 * This lives beside `GentServerOptions` because that is the surface it guards.
 * A launcher reads strings from its environment; this is where they become
 * values `Gent.server` accepts.
 */
export const LaunchConfig = Config.all({
  port: Config.port("GENT_PORT").pipe(Config.withDefault(3000)),
  serverMode: Config.literals(["standalone", "shared"], "GENT_SERVER_MODE").pipe(
    Config.withDefault("standalone"),
  ),
  persistenceMode: Config.literals(["sqlite", "memory"], "GENT_PERSISTENCE_MODE").pipe(
    Config.withDefault("sqlite"),
  ),
  providerMode: Config.literals(["live", "debug-scripted"], "GENT_PROVIDER_MODE").pipe(
    Config.withDefault("live"),
  ),
  // An idle window of no length stops the server at once, so zero fails too.
  idleTimeoutMs: Config.schema(
    Schema.Int.check(Schema.isGreaterThan(0)),
    "GENT_IDLE_TIMEOUT_MS",
  ).pipe(Config.withDefault(30_000)),
  home: Config.option(Config.string("HOME")),
  dataDir: Config.option(Config.string("GENT_DATA_DIR")),
  authDirectory: Config.option(Config.string("GENT_AUTH_DIRECTORY")),
  shell: Config.option(Config.string("SHELL")),
})

export interface GentServerOptions {
  readonly cwd: string
  /** Extension declarations for this server. Defaults to the builtins. */
  readonly extensions?: ReadonlyArray<GentExtension>
  /**
   * The branch-tool feature these extensions run on -- storage plus the
   * per-branch kernel. A server naming its own `extensions` names this too;
   * a tool surface whose feature is missing fails on first use.
   */
  readonly branchTools?: BranchToolFeature<never>
  readonly state?: StateSpec
  readonly provider?: ProviderSpec
  readonly authDirectory?: string
  /** Seed storage with a debug session on startup. */
  readonly debug?: boolean
  /**
   * Bind this TCP port instead of an ephemeral one. A fixed port also opts
   * out of the shared-server registry: the caller already named the address
   * its clients use, so there is nothing to discover.
   */
  readonly port?: number
  /** Server identity to publish instead of a freshly minted one. */
  readonly serverId?: string
  /** Login shell for extension process launches. */
  readonly shell?: string
  /**
   * Stop the owned server after this much client-free time. Both kinds of
   * client count: a WebSocket connection, and an in-process `Gent.client`
   * for as long as its scope is open.
   */
  readonly idleShutdown?: IdleShutdownSpec
}

/** Public opaque server handle. */
export const GentServer = Schema.Union([
  Schema.TaggedStruct("Owned", {
    url: Schema.String,
    workspaceId: Schema.String,
  }),
  Schema.TaggedStruct("Attached", {
    url: Schema.String,
    workspaceId: Schema.String,
  }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type GentServer = Schema.Schema.Type<typeof GentServer>

// ── Internal state for owned servers ──

interface OwnedServerInternal {
  readonly handlerContext: Context.Context<BuiltRpcHandlers>
  readonly port: number
  readonly serverId: string
  readonly headers: WorkspaceHeaders
  /**
   * Completes when this server decides to stop. An `idleShutdown` server
   * completes it after the idle window; every other server never completes,
   * so awaiting it keeps a launcher process alive.
   */
  readonly awaitShutdown: Effect.Effect<void>
  /**
   * Counts an in-process client for as long as its scope is open. Idle
   * shutdown watches the connection count, and an in-process client opens no
   * transport connection, so without this a server could stop itself while a
   * `Gent.client(server)` was still holding it.
   */
  readonly trackInProcessClient: Effect.Effect<void, never, Scope.Scope>
}

/** WeakMap keyed by GentServer object identity — keeps handler context private */
const ownedInternals = new WeakMap<GentServer, OwnedServerInternal>()

/** @internal — used by Gent.client to access owned server handler context */
export const getOwnedInternal = (server: GentServer): Option.Option<OwnedServerInternal> =>
  Option.fromNullishOr(ownedInternals.get(server))

/**
 * Block until this server decides to stop. An `idleShutdown` server returns
 * after its idle window; every other server blocks forever. A launcher
 * process awaits this as its last act.
 */
export const awaitServerShutdown = (server: GentServer): Effect.Effect<void> =>
  Option.match(getOwnedInternal(server), {
    onNone: () => Effect.never,
    onSome: (internal) => internal.awaitShutdown,
  })

// ── Factories ──

export const state = {
  sqlite: (options?: { readonly home?: string; readonly dbPath?: string }): StateSpec =>
    StateSpec.cases.Sqlite.make(options ?? {}),
  memory: (): StateSpec => StateSpec.cases.Memory.make({}),
}

export const provider = {
  live: (): ProviderSpec => ProviderSpec.cases.Live.make({}),
  mock: (options?: { readonly empty?: boolean }): ProviderSpec =>
    ProviderSpec.cases.Mock.make(options ?? {}),
}

// ── Language model layer from spec ──

/** Build a self-contained language model layer from spec. For "live", returns undefined
 *  (let createDependencies build its own from auth deps). */
const resolveLanguageModelLayer = (
  spec: ProviderSpec,
): Option.Option<Layer.Layer<LanguageModel.LanguageModel, never, never>> =>
  Match.value(spec).pipe(
    Match.tagsExhaustive({
      Live: () => Option.none(),
      Mock: (mockSpec) => {
        if (mockSpec.empty === true) return Option.some(LanguageModelLayers.empty)
        return Option.some(LanguageModelLayers.debug())
      },
    }),
  )

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

const resolveHome = (stateSpec: StateSpec, homeDirectory: string): string =>
  Match.value(stateSpec).pipe(
    Match.tagsExhaustive({
      Memory: () => Option.none<string>(),
      Sqlite: (sqliteSpec) => Option.fromNullishOr(sqliteSpec.home),
    }),
    Option.getOrElse(() => homeDirectory),
  )

const resolveDbPath = (home: string, stateSpec: StateSpec): string => {
  if (stateSpec._tag === "Sqlite") {
    const dbPath = Option.fromNullishOr(stateSpec.dbPath)
    if (Option.isSome(dbPath)) return pathResolve(dbPath.value)
  }
  const dataDir = pathJoin(home, ".gent")
  return pathResolve(pathJoin(dataDir, "data.db"))
}

/**
 * Poll the connection tracker and complete `shutdown` once the server has
 * been client-free for `idleMs`. Polls faster than the window so a
 * short-lived worker exits promptly, and re-checks the count immediately
 * before completing so a client that connects inside the last tick wins.
 */
const runIdleWatcher = (options: {
  readonly idleMs: number
  readonly connectionCount: Effect.Effect<number>
  readonly shutdown: Deferred.Deferred<void>
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const intervalMs = Math.max(50, Math.min(250, Math.floor(options.idleMs / 4)))
    let idleStartMs = Option.none<number>()

    const loop: Effect.Effect<void> = Effect.gen(function* () {
      // gent/no-sleep: idle shutdown observes live client connections on the real clock
      yield* Effect.sleep(`${intervalMs} millis`)
      const count = yield* options.connectionCount
      if (count > 0) {
        idleStartMs = Option.none()
        return yield* loop
      }
      const now = yield* Clock.currentTimeMillis
      const idleStart = Option.getOrElse(idleStartMs, () => now)
      idleStartMs = Option.some(idleStart)
      if (now - idleStart < options.idleMs) return yield* loop
      // A client can connect between the window closing and this check.
      const finalCount = yield* options.connectionCount
      if (finalCount > 0) {
        idleStartMs = Option.none()
        return yield* loop
      }
      yield* Effect.logInfo("idle-shutdown.triggered").pipe(
        Effect.annotateLogs({ idleMs: now - idleStart }),
      )
      yield* Deferred.succeed(options.shutdown, void 0)
    })

    return yield* loop
  })

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
      const requestedPort = Option.getOrElse(Option.fromNullishOr(options.port), () => 0)
      const httpServerCtx = yield* Layer.buildWithScope(
        BunHttpServer.layer({ port: requestedPort, idleTimeout: 0 }),
        scope,
      ).pipe(
        Effect.mapError(
          (error) =>
            new GentConnectionError({ message: `server listener failed: ${String(error)}` }),
        ),
      )
      const httpServer = Context.get(httpServerCtx, HttpServer.HttpServer)
      const port = Match.value(httpServer.address).pipe(
        Match.tag("TcpAddress", (address) => address.port),
        Match.orElse(() => 0),
      )
      if (port === 0) {
        return yield* new GentConnectionError({
          message: "server listener did not bind a concrete TCP port",
        })
      }
      const url = `http://127.0.0.1:${port}/rpc`
      const workspaceHeaders = workspaceHeadersForCwd(options.cwd)
      const home = resolveHome(stateSpec, homeDirectory)
      const serverId = yield* Option.match(Option.fromNullishOr(options.serverId), {
        onNone: () => platform.randomId,
        onSome: Effect.succeed,
      })
      const buildFingerprint = yield* (yield* BuildFingerprint).resolved

      const languageModelLayer = resolveLanguageModelLayer(providerSpec)
      const dbPath = Match.value(stateSpec).pipe(
        Match.tagsExhaustive({
          Memory: () => Option.none<string>(),
          Sqlite: (sqliteSpec) => Option.some(resolveDbPath(home, sqliteSpec)),
        }),
      )
      const serverRoot = yield* buildServerRoot({
        observability: GentObservability(options.cwd),
        dependencies: {
          cwd: options.cwd,
          home,
          platform: osInfo.platform,
          osVersion: osInfo.release,
          shell: options.shell,
          authDirectory: options.authDirectory,
          state: Option.match(dbPath, {
            onNone: () => StateLocation.cases.Memory.make({}),
            onSome: (path) => StateLocation.cases.Disk.make({ dbPath: path }),
          }),
          extensions: options.extensions ?? BuiltinExtensions,
          branchTools: options.branchTools ?? CellBranchTools,
          languageModelLayerOverride: Option.getOrUndefined(languageModelLayer),
        },
        identity: {
          serverId,
          pid,
          hostname: osInfo.hostname,
          dbPath: Option.getOrElse(dbPath, () => ":memory:"),
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
          provideWorkspaceIdHeader(Headers.fromInput(workspaceHeaders)),
          Effect.provideContext(serverRoot.coreServices),
          Effect.catchEager((error) =>
            Effect.logWarning("Debug session seeding failed").pipe(
              Effect.annotateLogs({ error: String(error) }),
            ),
          ),
        )
      }

      const idleSpec = Option.fromNullishOr(options.idleShutdown)
      let awaitShutdown: Effect.Effect<void> = Effect.never
      if (Option.isSome(idleSpec)) {
        const shutdown = yield* Deferred.make<void>()
        yield* Effect.forkScoped(
          runIdleWatcher({
            idleMs: idleSpec.value.idleMs,
            connectionCount: serverRoot.connectionTracker.count,
            shutdown,
          }),
        )
        awaitShutdown = Deferred.await(shutdown)
      }

      const server: GentServer = GentServer.cases.Owned.make({
        url,
        workspaceId: workspaceIdForCwd(options.cwd),
      })
      // An in-process client opens no socket, so it registers here instead.
      // The count drops again when the client's own scope closes.
      const tracker = serverRoot.connectionTracker
      const trackInProcessClient = Effect.acquireRelease(tracker.increment, () => tracker.decrement)

      ownedInternals.set(server, {
        handlerContext: serverRoot.rpcHandlersContext,
        port,
        serverId,
        headers: workspaceHeaders,
        awaitShutdown,
        trackInProcessClient,
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
    const identity = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        serverId: Schema.String,
        pid: Schema.Finite,
        hostname: Schema.String,
        dbPath: Schema.String,
        buildFingerprint: Schema.String,
      }),
    )(yield* response.json)
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

    // Memory state has nothing to share; a fixed port is already the address
    // the caller hands its clients. Both are owned outright, no registry.
    if (stateSpec._tag === "Memory" || Predicate.isNotNullish(options.port)) {
      return yield* buildOwnedServer(options, stateSpec, providerSpec)
    }

    // SQLite state: shared-server aware
    const platform = yield* GentPlatform
    const home = resolveHome(stateSpec, yield* platform.homeDirectory)
    const dbPath = resolveDbPath(home, stateSpec)
    const fingerprint = yield* (yield* BuildFingerprint).local
    const osInfo = yield* platform.osInfo
    const pid = yield* platform.pid

    // Check the single shared server lock.
    const existingOption = Option.fromNullishOr(yield* readServerLock(home))
    if (Option.isSome(existingOption)) {
      const existing = existingOption.value
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
          return GentServer.cases.Attached.make({
            url: existing.rpcUrl,
            workspaceId: workspaceIdForCwd(options.cwd),
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
    const internalOption = getOwnedInternal(server)
    if (Option.isSome(internalOption)) {
      const internal = internalOption.value
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
