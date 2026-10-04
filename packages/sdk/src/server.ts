import { Clock, Context, Effect, Layer, Match, Option, Predicate, type Scope } from "effect"
import { GentConnectionError } from "@gent/core/protocol"
import {
  GentPlatform,
  RpcHandlersLive,
  provideWorkspaceIdHeader,
  workspaceHeadersForCwd,
  workspaceIdForCwd,
  buildServerRoutes,
  createDependencies,
  ModelRegistry,
  ModelResolver,
  ScriptedLanguageModel,
  StateLocation,
} from "@gent/core/host"
import { BunHttpServer } from "@effect/platform-bun"
import { Headers, HttpRouter, HttpServer } from "effect/http"
import { BuiltinExtensionModules, BuiltinExtensions, CellBranchTools } from "@gent/extensions"
import type { LanguageModel } from "effect/ai"
import { GentLogLevel, GentObservability } from "./logger.js"
import {
  dataPaths,
  GentServer,
  type GentServerOptions,
  type LocalPlatform,
  ownedHandlers,
  type ProviderSpec,
  resolveHome,
  ServerLockEntry,
  serverLockFile,
  type StateSpec,
} from "./discovery.js"

// ── server root ─────────────────────────────────────────────────────────────

/**
 * The server this process builds: the server stack (the shipped extensions,
 * the dependency graph, the HTTP listener) composed under the caller's scope.
 * `resolveServer` (`discovery.ts`) imports this module only when it builds a
 * server, so a launch that attaches never evaluates the stack.
 */

/** A server this process built, and the id its lock entry and identity name. */
interface OwnedServer {
  readonly server: GentServer
  readonly serverId: string
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
        if (mockSpec.empty === true) return Option.some(ScriptedLanguageModel.empty)
        return Option.some(ScriptedLanguageModel.debug())
      },
    }),
  )

// ── Build owned server (in-process + HTTP listener) ──

/**
 * The one address the listener binds and clients dial. The RPC has no auth and
 * runs bash, so no other machine may reach it: a remote client tunnels in
 * (`ssh -L`). Bun binds every interface when no hostname is given.
 */
const LISTEN_HOST = "127.0.0.1"

export const buildOwnedServer = (
  options: GentServerOptions,
  stateSpec: StateSpec,
  providerSpec: ProviderSpec,
  fingerprint: string,
): Effect.Effect<OwnedServer, GentConnectionError, Scope.Scope | LocalPlatform> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const platform = yield* GentPlatform
    const osInfo = yield* platform.osInfo
    const pid = yield* platform.pid
    const homeDirectory = yield* platform.homeDirectory
    const requestedPort = Option.getOrElse(Option.fromNullishOr(options.port), () => 0)
    const httpServerCtx = yield* Layer.buildWithScope(
      BunHttpServer.layer({ hostname: LISTEN_HOST, port: requestedPort, idleTimeout: 0 }),
      scope,
    ).pipe(
      Effect.mapError(
        (error) => new GentConnectionError({ message: `server listener failed: ${String(error)}` }),
      ),
    )
    const httpServer = Context.get(httpServerCtx, HttpServer.HttpServer)
    const port = Match.value(httpServer.address).pipe(
      Match.tag("InetAddressV4", "InetAddressV6", (address) => address.port),
      Match.orElse(() => 0),
    )
    if (port === 0) {
      return yield* new GentConnectionError({
        message: "server listener did not bind a concrete TCP port",
      })
    }
    const url = `http://${LISTEN_HOST}:${port}/rpc`
    const workspaceHeaders = workspaceHeadersForCwd(options.cwd)
    const home = resolveHome(stateSpec, homeDirectory)
    const serverId = yield* platform.randomId

    const languageModelLayer = resolveLanguageModelLayer(providerSpec)
    // The database sits in the data directory beside the server lock and the
    // logs, where `gent doctor` and `gent storage reset` look.
    const paths = yield* dataPaths(home)
    const dbPath = Match.value(stateSpec).pipe(
      Match.tagsExhaustive({
        Memory: () => Option.none<string>(),
        Sqlite: () => Option.some(paths.dbPath),
      }),
    )
    const logLevel = yield* GentLogLevel.pipe(
      Effect.mapError(
        (error) => new GentConnectionError({ message: `invalid GENT_LOG_LEVEL: ${error.message}` }),
      ),
    )
    // A user extension imports the same effect modules the shipped ones do.
    yield* platform.bindModules(BuiltinExtensionModules)
    const observability = GentObservability(options.cwd, logLevel, paths.logDir)
    const coreServices = yield* Layer.buildWithScope(
      createDependencies({
        cwd: options.cwd,
        // One broken user extension is reported, not fatal: the rest of the profile runs.
        failOnExtensionFailure: false,
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
        // A scripted model needs no catalog: a model the catalog does not
        // list (none stored, models.dev unreachable) still runs.
        overrides: {
          modelResolverLayer: Option.getOrUndefined(
            Option.map(languageModelLayer, ModelResolver.fromLanguageModel),
          ),
          modelRegistryLayer: Option.getOrUndefined(
            Option.map(languageModelLayer, () => ModelRegistry.Scripted),
          ),
        },
      }).pipe(Layer.provide(observability)),
      scope,
    ).pipe(
      Effect.mapError(
        (error) => new GentConnectionError({ message: `server root failed: ${String(error)}` }),
      ),
    )
    const coreServicesLive = Layer.succeedContext(coreServices)
    const rpcHandlersContext = yield* Layer.buildWithScope(
      Layer.provide(RpcHandlersLive, coreServicesLive),
      scope,
    )
    const httpRoutes = buildServerRoutes(coreServicesLive, {
      identity: {
        serverId,
        pid,
        hostname: osInfo.hostname,
        dbPath: Option.getOrElse(dbPath, () => ":memory:"),
        buildFingerprint: fingerprint,
      },
    })

    const HttpServerLive = HttpRouter.serve(httpRoutes).pipe(
      Layer.provide(Layer.succeedContext(httpServerCtx)),
      Layer.provide(coreServicesLive),
    )

    yield* Layer.buildWithScope(HttpServerLive, scope).pipe(Effect.orDie)

    if (Predicate.isNotUndefined(options.seed)) {
      yield* options.seed.pipe(
        provideWorkspaceIdHeader(Headers.fromInput(workspaceHeaders)),
        // The SDK builds these headers from `cwd`; a rejected header is a bug.
        Effect.orDie,
        Effect.provideContext(coreServices),
      )
    }

    const server: GentServer = GentServer.cases.Owned.make({
      url,
      workspaceId: workspaceIdForCwd(options.cwd),
    })
    ownedHandlers.set(server, rpcHandlersContext)

    return { server, serverId }
  })

/**
 * Start the server that owns the database. The caller holds the server lock in
 * this scope (`serverLock.hold`), which removed the entry of any server gone.
 */
export const startOwnedServer = (
  options: GentServerOptions,
  stateSpec: StateSpec,
  providerSpec: ProviderSpec,
  home: string,
  dbPath: string,
  fingerprint: string,
): Effect.Effect<GentServer, GentConnectionError, Scope.Scope | LocalPlatform> =>
  Effect.gen(function* () {
    const platform = yield* GentPlatform
    const osInfo = yield* platform.osInfo
    const pid = yield* platform.pid
    const { server, serverId } = yield* buildOwnedServer(
      options,
      stateSpec,
      providerSpec,
      fingerprint,
    )
    yield* serverLockFile.write(
      home,
      new ServerLockEntry({
        serverId,
        pid,
        hostname: osInfo.hostname,
        rpcUrl: server.url,
        dbPath,
        buildFingerprint: fingerprint,
        startedAt: yield* Clock.currentTimeMillis,
      }),
    )
    // The entry goes before the kernel lock is released: finalizers run in reverse.
    yield* Effect.addFinalizer(() => serverLockFile.remove(home))
    return server
  })
