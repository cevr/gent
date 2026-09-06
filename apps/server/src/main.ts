import { BunHttpServer, BunRuntime, BunFileSystem, BunServices } from "@effect/platform-bun"
import { GentPlatform } from "@gent/core-internal/runtime/gent-platform.js"
import { BunGentPlatformLive } from "@gent/core-internal/runtime/gent-platform-bun.js"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { Clock, Config, Console, Context, Deferred, Effect, Layer, Option } from "effect"
import { seedDebugSession } from "@gent/core-internal/debug/session.js"
import { startDebugScenario } from "./debug/scenario.js"
import { BuiltinExtensions } from "@gent/extensions"
import { BuildFingerprint } from "@gent/core-internal/server/build-fingerprint.js"
import { buildServerRoot } from "@gent/core-internal/server/server-root.js"

const joinPath = (...parts: readonly string[]) => parts.join("/").replace(/\/+/g, "/")

type ProviderMode = "debug-scripted" | "debug-failing" | "debug-slow" | "live"

const resolveProviderMode = (value: Option.Option<string>): ProviderMode => {
  if (Option.contains(value, "debug-scripted")) return "debug-scripted"
  if (Option.contains(value, "debug-failing")) return "debug-failing"
  if (Option.contains(value, "debug-slow")) return "debug-slow"
  return "live"
}

type ScheduledJobCommand = readonly [string, ...ReadonlyArray<string>]

const resolveScheduledJobCommand = (runtimePath: string): Option.Option<ScheduledJobCommand> => {
  if (!runtimePath.includes("bun")) return Option.none()
  const cliEntryUrl = new URL("../../tui/src/main.tsx", import.meta.url)
  return Option.some([runtimePath, cliEntryUrl.pathname])
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

  let port = 3000
  if (Number.isFinite(parsedPort)) port = parsedPort
  let persistenceMode: "memory" | "disk" = "disk"
  if (Option.contains(persistenceOpt, "memory")) persistenceMode = "memory"

  return {
    port,
    cwd: Option.getOrElse(cwdOpt, () => process.cwd()),
    home,
    dataDir,
    dbPath: Option.getOrElse(dbPathOpt, () => joinPath(dataDir, "data.db")),
    authDirectory: authDirectoryOpt,
    platform: osInfo.platform,
    osVersion: osInfo.release,
    hostname: osInfo.hostname,
    pid,
    scheduledJobCommand: resolveScheduledJobCommand(execPath),
    persistenceMode,
    providerMode: resolveProviderMode(providerOpt),
    isManaged: Option.getOrUndefined(serverModeOpt) === "shared",
    isDebug: Option.getOrUndefined(debugModeOpt) === "1",
    shell: shellOpt,
    serverId,
    idleTimeoutMs: Number(Option.getOrElse(idleTimeoutOpt, () => "30000")),
    sharedServerUrl: sharedServerUrlOpt,
  }
})

// Platform layer for Storage
const PlatformBaseLayer = Layer.mergeAll(
  BunFileSystem.layer,
  BunServices.layer,
  BunGentPlatformLive,
)
const PlatformLayer = Layer.merge(
  PlatformBaseLayer,
  BuildFingerprint.Live.pipe(Layer.provide(PlatformBaseLayer)),
)

const program = Effect.scoped(
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const config = yield* resolveRuntimeConfig
    const httpServerCtx = yield* Layer.buildWithScope(
      BunHttpServer.layer({ port: config.port, idleTimeout: 0 }),
      scope,
    )
    const httpServer = Context.get(httpServerCtx, HttpServer.HttpServer)
    let boundPort = config.port
    if (httpServer.address._tag === "TcpAddress") boundPort = httpServer.address.port
    const baseUrl = `http://localhost:${boundPort}`

    let sharedServerUrl = config.sharedServerUrl
    if (Option.isNone(sharedServerUrl) && config.isManaged) {
      sharedServerUrl = Option.some(`${baseUrl}/rpc`)
    }
    const buildFingerprint = yield* (yield* BuildFingerprint).resolved
    const startedAt = yield* Clock.currentTimeMillis

    const serverRoot = yield* buildServerRoot({
      dependencies: {
        cwd: config.cwd,
        home: config.home,
        platform: config.platform,
        shell: Option.getOrUndefined(config.shell),
        osVersion: config.osVersion,
        dbPath: config.dbPath,
        authDirectory: Option.getOrUndefined(config.authDirectory),
        persistenceMode: config.persistenceMode,
        providerMode: config.providerMode,
        scheduledJobCommand: Option.getOrUndefined(config.scheduledJobCommand),
        sharedServerUrl: Option.getOrUndefined(sharedServerUrl),
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

    // Process fixtures parse these raw stdout messages.
    if (config.isManaged) {
      yield* Console.log(`GENT_SERVER_READY ${baseUrl}`)
    } else {
      yield* Console.log(`Gent server ready on ${baseUrl}`)
    }

    // Idle shutdown: managed shared-server mode waits for idle, standalone runs forever.
    if (config.isManaged) {
      let idleTimeoutMs = 30_000
      if (Number.isFinite(config.idleTimeoutMs)) idleTimeoutMs = config.idleTimeoutMs
      const idleCheckIntervalMs = Math.max(50, Math.min(250, Math.floor(idleTimeoutMs / 4)))
      const shutdownDeferred = yield* Deferred.make<void>()

      // Idle watcher fiber — poll faster than the timeout so short-lived test workers exit promptly.
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          let idleStartMs = Option.none<number>()

          while (true) {
            yield* Effect.sleep(`${idleCheckIntervalMs} millis`)
            const count = yield* serverRoot.connectionTracker.count

            if (count === 0) {
              let idleStart: number
              if (Option.isNone(idleStartMs)) {
                idleStart = yield* Clock.currentTimeMillis
                idleStartMs = Option.some(idleStart)
              } else {
                idleStart = idleStartMs.value
              }
              if ((yield* Clock.currentTimeMillis) - idleStart >= idleTimeoutMs) {
                // Final liveness check before shutdown
                const finalCount = yield* serverRoot.connectionTracker.count
                if (finalCount === 0) {
                  yield* Effect.logInfo("idle-shutdown.triggered").pipe(
                    Effect.annotateLogs({ idleMs: (yield* Clock.currentTimeMillis) - idleStart }),
                  )
                  yield* Deferred.succeed(shutdownDeferred, void 0)
                  return
                }
                // Client connected during final check — reset
                idleStartMs = Option.none()
              }
            } else {
              idleStartMs = Option.none()
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
