import { BunHttpServer, BunRuntime, BunFileSystem, BunServices } from "@effect/platform-bun"
import { GentPlatform } from "@gent/core-internal/runtime/gent-platform.js"
import { BunGentPlatformLive } from "@gent/core-internal/runtime/gent-platform-bun.js"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { Clock, Config, Deferred, Effect, Layer, Option, Context } from "effect"
import { seedDebugSession } from "@gent/core-internal/debug/session.js"
import { startDebugScenario } from "./debug/scenario.js"
import { BuiltinExtensions } from "@gent/extensions"
import { resolveBuildFingerprint } from "@gent/core-internal/server/build-fingerprint.js"
import { buildServerRoot } from "@gent/core-internal/server/server-root.js"

const joinPath = (...parts: readonly string[]) => parts.join("/").replace(/\/+/g, "/")

const resolveProviderMode = (value: string | undefined) => {
  if (value === "debug-scripted") return "debug-scripted" as const
  if (value === "debug-failing") return "debug-failing" as const
  if (value === "debug-slow") return "debug-slow" as const
  return "live" as const
}

const resolveScheduledJobCommand = (
  runtimePath: string,
): readonly [string, ...ReadonlyArray<string>] | undefined => {
  if (!runtimePath.includes("bun")) return undefined
  const cliEntryUrl = new URL("../../tui/src/main.tsx", import.meta.url)
  return [runtimePath, cliEntryUrl.pathname]
}

const resolveRuntimeConfig = Effect.gen(function* () {
  const platform = yield* GentPlatform
  const osInfo = yield* platform.osInfo
  const pid = yield* platform.pid
  const execPath = yield* platform.execPath
  const homeDefault = yield* platform.homeDirectory
  const portRaw = yield* Config.option(Config.string("GENT_PORT"))
  const cwdOpt = yield* Config.option(Config.string("GENT_CWD"))
  const homeOpt = yield* Config.option(Config.string("HOME"))
  const dataDirOpt = yield* Config.option(Config.string("GENT_DATA_DIR"))
  const dbPathOpt = yield* Config.option(Config.string("GENT_DB_PATH"))
  const authDirectoryOpt = yield* Config.option(Config.string("GENT_AUTH_DIRECTORY"))
  const persistenceOpt = yield* Config.option(Config.string("GENT_PERSISTENCE_MODE"))
  const providerOpt = yield* Config.option(Config.string("GENT_PROVIDER_MODE"))
  const serverModeOpt = yield* Config.option(Config.string("GENT_SERVER_MODE"))
  const debugModeOpt = yield* Config.option(Config.string("GENT_DEBUG_MODE"))
  const shellOpt = yield* Config.option(Config.string("SHELL"))
  const serverIdOpt = yield* Config.option(Config.string("GENT_SERVER_ID"))
  const serverId = yield* Option.match(serverIdOpt, {
    onNone: () => platform.randomId,
    onSome: Effect.succeed,
  })
  const idleTimeoutOpt = yield* Config.option(Config.string("GENT_IDLE_TIMEOUT_MS"))
  const sharedServerUrlOpt = yield* Config.option(Config.string("GENT_SHARED_SERVER_URL"))

  const home = Option.getOrElse(homeOpt, () => homeDefault)
  const dataDir = Option.getOrElse(dataDirOpt, () => joinPath(home, ".gent"))
  const parsedPort = Number(Option.getOrElse(portRaw, () => "3000"))

  return {
    port: Number.isFinite(parsedPort) ? parsedPort : 3000,
    cwd: Option.getOrElse(cwdOpt, () => process.cwd()),
    home,
    dataDir,
    dbPath: Option.getOrElse(dbPathOpt, () => joinPath(dataDir, "data.db")),
    authDirectory: Option.getOrUndefined(authDirectoryOpt),
    platform: osInfo.platform,
    osVersion: osInfo.release,
    hostname: osInfo.hostname,
    pid,
    scheduledJobCommand: resolveScheduledJobCommand(execPath),
    persistenceMode:
      Option.getOrUndefined(persistenceOpt) === "memory" ? ("memory" as const) : ("disk" as const),
    providerMode: resolveProviderMode(Option.getOrUndefined(providerOpt)),
    isManaged: Option.getOrUndefined(serverModeOpt) === "shared",
    isDebug: Option.getOrUndefined(debugModeOpt) === "1",
    shell: Option.getOrUndefined(shellOpt),
    serverId,
    idleTimeoutMs: Number(Option.getOrElse(idleTimeoutOpt, () => "30000")),
    sharedServerUrl: Option.getOrUndefined(sharedServerUrlOpt),
  }
})

// Platform layer for Storage
const PlatformLayer = Layer.mergeAll(BunFileSystem.layer, BunServices.layer, BunGentPlatformLive)

const program = Effect.scoped(
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const config = yield* resolveRuntimeConfig
    const httpServerCtx = yield* Layer.buildWithScope(
      BunHttpServer.layer({ port: config.port, idleTimeout: 0 }),
      scope,
    )
    const httpServer = Context.get(httpServerCtx, HttpServer.HttpServer)
    const boundPort =
      httpServer.address._tag === "TcpAddress" ? httpServer.address.port : config.port
    const baseUrl = `http://localhost:${boundPort}`

    const sharedServerUrl =
      config.sharedServerUrl ?? (config.isManaged ? `${baseUrl}/rpc` : undefined)
    const buildFingerprint = yield* resolveBuildFingerprint
    const startedAt = yield* Clock.currentTimeMillis

    const serverRoot = yield* buildServerRoot({
      dependencies: {
        cwd: config.cwd,
        home: config.home,
        platform: config.platform,
        shell: config.shell,
        osVersion: config.osVersion,
        dbPath: config.dbPath,
        authDirectory: config.authDirectory,
        persistenceMode: config.persistenceMode,
        providerMode: config.providerMode,
        scheduledJobCommand: config.scheduledJobCommand,
        sharedServerUrl,
        extensions: BuiltinExtensions,
      },
      identity: {
        serverId: config.serverId,
        pid: config.pid,
        hostname: config.hostname,
        dbPath: config.dbPath,
        buildFingerprint,
        startedAt,
      },
    })

    const HttpServerLive = HttpRouter.serve(serverRoot.httpRoutes).pipe(
      Layer.provide(Layer.succeedContext(httpServerCtx)),
      Layer.provide(serverRoot.coreServicesLive),
      Layer.provide(BunFileSystem.layer),
    )

    if (config.isManaged && config.isDebug) {
      const seeded = yield* Effect.provideContext(
        seedDebugSession(config.cwd),
        serverRoot.coreServices,
      )
      yield* Effect.forkScoped(
        Effect.provideContext(
          startDebugScenario({
            sessionId: seeded.sessionId,
            branchId: seeded.branchId,
            cwd: config.cwd,
          }),
          serverRoot.coreServices,
        ),
      )
    }
    yield* Layer.buildWithScope(HttpServerLive, scope)

    // stdout messages parsed by process fixtures — must stay as console.log
    if (config.isManaged) {
      // @effect-diagnostics-next-line globalConsoleInEffect:off
      console.log(`GENT_SERVER_READY ${baseUrl}`)
    } else {
      // @effect-diagnostics-next-line globalConsoleInEffect:off
      console.log(`Gent server ready on ${baseUrl}`)
    }

    // Idle shutdown: managed shared-server mode waits for idle, standalone runs forever.
    if (config.isManaged) {
      const idleTimeoutMs = Number.isFinite(config.idleTimeoutMs) ? config.idleTimeoutMs : 30_000
      const idleCheckIntervalMs = Math.max(50, Math.min(250, Math.floor(idleTimeoutMs / 4)))
      const shutdownDeferred = yield* Deferred.make<void>()

      // Idle watcher fiber — poll faster than the timeout so short-lived test workers exit promptly.
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          let idleStartMs: number | undefined

          while (true) {
            yield* Effect.sleep(`${idleCheckIntervalMs} millis`)
            const count = yield* serverRoot.connectionTracker.count()

            if (count === 0) {
              if (idleStartMs === undefined) idleStartMs = yield* Clock.currentTimeMillis
              if ((yield* Clock.currentTimeMillis) - idleStartMs >= idleTimeoutMs) {
                // Final liveness check before shutdown
                const finalCount = yield* serverRoot.connectionTracker.count()
                if (finalCount === 0) {
                  yield* Effect.logInfo("idle-shutdown.triggered").pipe(
                    Effect.annotateLogs({ idleMs: (yield* Clock.currentTimeMillis) - idleStartMs }),
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
BunRuntime.runMain(program.pipe(Effect.provide(PlatformLayer)))
