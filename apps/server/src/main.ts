import { BunHttpServer, BunRuntime, BunFileSystem, BunServices } from "@effect/platform-bun"
import { GentTracerLive } from "@gent/core/runtime/tracer.js"
import { GentLogger, GentLogLevel } from "@gent/core/runtime/logger.js"
import { HttpRouter } from "effect/unstable/http"
import { Config, Deferred, Effect, Layer, Option, Context } from "effect"
import * as os from "node:os"
import { seedDebugSession } from "@gent/core/debug/session.js"
import { startDebugScenario } from "./debug/scenario.js"
import { createDependencies } from "@gent/core/server/dependencies.js"
import { AppServicesLive } from "@gent/core/server/index.js"
import { ConnectionTracker } from "@gent/core/server/connection-tracker.js"
import { ServerIdentity } from "@gent/core/server/server-identity.js"
import { resolveBuildFingerprint } from "@gent/core/server/build-fingerprint.js"
import { buildServerRoutes } from "@gent/core/server/server-routes.js"

const joinPath = (...parts: readonly string[]) => parts.join("/").replace(/\/+/g, "/")

const resolveProviderMode = (value: string | undefined) => {
  if (value === "debug-scripted") return "debug-scripted" as const
  if (value === "debug-failing") return "debug-failing" as const
  if (value === "debug-slow") return "debug-slow" as const
  return "live" as const
}

const resolveScheduledJobCommand = (): readonly [string, ...ReadonlyArray<string>] | undefined => {
  const runtimePath = process.execPath
  if (!runtimePath.includes("bun")) return undefined
  const cliEntryUrl = new URL("../../tui/src/main.tsx", import.meta.url)
  return [runtimePath, cliEntryUrl.pathname]
}

const resolveRuntimeConfig = Effect.gen(function* () {
  const portRaw = yield* Config.option(Config.string("GENT_PORT"))
  const cwdOpt = yield* Config.option(Config.string("GENT_CWD"))
  const homeOpt = yield* Config.option(Config.string("HOME"))
  const dataDirOpt = yield* Config.option(Config.string("GENT_DATA_DIR"))
  const dbPathOpt = yield* Config.option(Config.string("GENT_DB_PATH"))
  const authFilePathOpt = yield* Config.option(Config.string("GENT_AUTH_FILE_PATH"))
  const authKeyPathOpt = yield* Config.option(Config.string("GENT_AUTH_KEY_PATH"))
  const persistenceOpt = yield* Config.option(Config.string("GENT_PERSISTENCE_MODE"))
  const providerOpt = yield* Config.option(Config.string("GENT_PROVIDER_MODE"))
  const serverModeOpt = yield* Config.option(Config.string("GENT_SERVER_MODE"))
  const debugModeOpt = yield* Config.option(Config.string("GENT_DEBUG_MODE"))
  const shellOpt = yield* Config.option(Config.string("SHELL"))
  const serverIdOpt = yield* Config.option(Config.string("GENT_SERVER_ID"))
  const idleTimeoutOpt = yield* Config.option(Config.string("GENT_IDLE_TIMEOUT_MS"))
  const sharedServerUrlOpt = yield* Config.option(Config.string("GENT_SHARED_SERVER_URL"))

  const home = Option.getOrElse(homeOpt, () => os.homedir())
  const dataDir = Option.getOrElse(dataDirOpt, () => joinPath(home, ".gent"))
  const parsedPort = Number(Option.getOrElse(portRaw, () => "3000"))

  return {
    port: Number.isFinite(parsedPort) ? parsedPort : 3000,
    cwd: Option.getOrElse(cwdOpt, () => process.cwd()),
    home,
    dataDir,
    dbPath: Option.getOrElse(dbPathOpt, () => joinPath(dataDir, "data.db")),
    authFilePath: Option.getOrUndefined(authFilePathOpt),
    authKeyPath: Option.getOrUndefined(authKeyPathOpt),
    persistenceMode:
      Option.getOrUndefined(persistenceOpt) === "memory" ? ("memory" as const) : ("disk" as const),
    providerMode: resolveProviderMode(Option.getOrUndefined(providerOpt)),
    isWorker: Option.getOrUndefined(serverModeOpt) === "worker",
    isDebug: Option.getOrUndefined(debugModeOpt) === "1",
    shell: Option.getOrUndefined(shellOpt),
    serverId: Option.getOrElse(serverIdOpt, () => Bun.randomUUIDv7()),
    idleTimeoutMs: Number(Option.getOrElse(idleTimeoutOpt, () => "30000")),
    sharedServerUrl: Option.getOrUndefined(sharedServerUrlOpt),
  }
})

// Platform layer for Storage
const PlatformLayer = Layer.merge(BunFileSystem.layer, BunServices.layer)

const program = Effect.scoped(
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const config = yield* resolveRuntimeConfig

    // Dependencies layer
    // Shared server URL: either passed via env or derived from this server's port
    const sharedServerUrl =
      config.sharedServerUrl ??
      (config.isWorker ? `http://localhost:${config.port}/rpc` : undefined)

    const depsLive = createDependencies({
      cwd: config.cwd,
      home: config.home,
      platform: process.platform,
      shell: config.shell,
      osVersion: os.release(),
      dbPath: config.dbPath,
      authFilePath: config.authFilePath,
      authKeyPath: config.authKeyPath,
      persistenceMode: config.persistenceMode,
      providerMode: config.providerMode,
      scheduledJobCommand: resolveScheduledJobCommand(),
      sharedServerUrl,
    }).pipe(
      Layer.provide(PlatformLayer),
      Layer.provide(GentLogger),
      Layer.provide(GentLogLevel),
      Layer.provide(GentTracerLive),
    )

    const buildFingerprint = yield* resolveBuildFingerprint
    // @effect-diagnostics-next-line globalDateInEffect:off
    const startedAt = Date.now()

    // Connection tracker for idle shutdown
    const connectionTrackerCtx = yield* Layer.buildWithScope(ConnectionTracker.Live, scope)
    const connectionTracker = Context.get(connectionTrackerCtx, ConnectionTracker)

    // Server identity
    const serverIdentityLive = ServerIdentity.Live({
      serverId: config.serverId,
      pid: process.pid,
      hostname: os.hostname(),
      dbPath: config.dbPath,
      buildFingerprint,
      startedAt,
    })

    const depsServices = yield* Layer.buildWithScope(depsLive, scope)
    const appServices = yield* Layer.buildWithScope(
      AppServicesLive.pipe(Layer.provide(Layer.succeedContext(depsServices))),
      scope,
    )
    const coreServices = Context.merge(
      Context.merge(depsServices, appServices),
      connectionTrackerCtx,
    )
    const serverIdentityCtx = yield* Layer.buildWithScope(serverIdentityLive, scope)
    const allServices = Context.merge(coreServices, serverIdentityCtx)
    const coreServicesLive = Layer.succeedContext(allServices)

    // Build all HTTP routes (RPC, REST, docs, identity)
    const AllRoutes = buildServerRoutes(coreServicesLive, {
      identity: {
        serverId: config.serverId,
        pid: process.pid,
        hostname: os.hostname(),
        dbPath: config.dbPath,
        buildFingerprint,
      },
    })

    // Server
    const HttpServerLive = HttpRouter.serve(AllRoutes).pipe(
      Layer.provide(BunHttpServer.layer({ port: config.port, idleTimeout: 0 })),
      Layer.provide(coreServicesLive),
      Layer.provide(BunFileSystem.layer),
    )

    const baseUrl = `http://localhost:${config.port}`
    if (config.isWorker && config.isDebug) {
      const seeded = yield* seedDebugSession(config.cwd).pipe(Effect.provide(coreServices))
      yield* Effect.forkScoped(
        startDebugScenario({
          sessionId: seeded.sessionId,
          branchId: seeded.branchId,
          cwd: config.cwd,
        }).pipe(Effect.provide(coreServices)),
      )
    }
    yield* Layer.buildWithScope(HttpServerLive, scope)

    // stdout messages parsed by supervisor — must stay as console.log
    if (config.isWorker) {
      // @effect-diagnostics-next-line globalConsoleInEffect:off
      console.log(`GENT_WORKER_READY ${baseUrl}`)
    } else {
      // @effect-diagnostics-next-line globalConsoleInEffect:off
      console.log(`Gent server ready on ${baseUrl}`)
      // @effect-diagnostics-next-line globalConsoleInEffect:off
      console.log(`Swagger UI: ${baseUrl}/docs`)
    }

    // Idle shutdown: worker mode waits for idle, standalone runs forever
    if (config.isWorker) {
      const idleTimeoutMs = Number.isFinite(config.idleTimeoutMs) ? config.idleTimeoutMs : 30_000
      const shutdownDeferred = yield* Deferred.make<void>()

      // Idle watcher fiber — polls connection count every second
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          let idleStartMs: number | undefined

          while (true) {
            yield* Effect.sleep("1 second")
            const count = yield* connectionTracker.count()

            if (count === 0) {
              // @effect-diagnostics-next-line globalDateInEffect:off
              if (idleStartMs === undefined) idleStartMs = Date.now()
              // @effect-diagnostics-next-line globalDateInEffect:off
              if (Date.now() - idleStartMs >= idleTimeoutMs) {
                // Final liveness check before shutdown
                const finalCount = yield* connectionTracker.count()
                if (finalCount === 0) {
                  // @effect-diagnostics-next-line globalDateInEffect:off
                  yield* Effect.logInfo("idle-shutdown.triggered").pipe(
                    Effect.annotateLogs({ idleMs: Date.now() - idleStartMs }),
                  )
                  yield* Deferred.succeed(shutdownDeferred, void 0)
                  return
                }
                // Client connected during final check — reset
                idleStartMs = undefined
              }
            } else {
              idleStartMs = undefined
            }
          }
        }),
      )

      return yield* Deferred.await(shutdownDeferred)
    }

    return yield* Effect.never
  }),
)

// @effect-diagnostics-next-line strictEffectProvide:off
BunRuntime.runMain(program.pipe(Effect.provide(BunFileSystem.layer)))
