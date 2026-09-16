/**
 * Standalone HTTP server launcher. Reads the process environment, hands the
 * resolved shape to `Gent.server`, announces the bound URL, and waits. Every
 * composition decision lives in the SDK server primitive.
 */
import { BunRuntime } from "@effect/platform-bun"
import { Config, Console, Effect, Option } from "effect"
import { Gent, knownModeOr, positiveIntegerOr, tcpPortOr, type IdleShutdownSpec } from "@gent/sdk"

const joinPath = (...parts: readonly string[]) => parts.join("/").replace(/\/+/g, "/")

/** The mode words each variable accepts. An unknown one stops the launch. */
const SERVER_MODES: ReadonlyArray<"standalone" | "shared"> = ["standalone", "shared"]
const PERSISTENCE_MODES: ReadonlyArray<"sqlite" | "memory"> = ["sqlite", "memory"]
const PROVIDER_MODES: ReadonlyArray<"live" | "debug-scripted"> = ["live", "debug-scripted"]

/** `GENT_PROVIDER_MODE=debug-scripted` picks the scripted language model. */
const resolveProvider = (mode: "live" | "debug-scripted") => {
  if (mode === "debug-scripted") return Gent.provider.mock()
  return Gent.provider.live()
}

const resolveLaunch = Effect.gen(function* () {
  const portRaw = yield* Config.option(Config.string("GENT_PORT"))
  const homeOpt = yield* Config.option(Config.string("HOME"))
  const dataDirOpt = yield* Config.option(Config.string("GENT_DATA_DIR"))
  const authDirectoryOpt = yield* Config.option(Config.string("GENT_AUTH_DIRECTORY"))
  const persistenceOpt = yield* Config.option(Config.string("GENT_PERSISTENCE_MODE"))
  const providerOpt = yield* Config.option(Config.string("GENT_PROVIDER_MODE"))
  const serverModeOpt = yield* Config.option(Config.string("GENT_SERVER_MODE"))
  const shellOpt = yield* Config.option(Config.string("SHELL"))
  const idleTimeoutOpt = yield* Config.option(Config.string("GENT_IDLE_TIMEOUT_MS"))

  const serverMode = yield* knownModeOr(
    "GENT_SERVER_MODE",
    serverModeOpt,
    SERVER_MODES,
    "standalone",
  )
  const persistenceMode = yield* knownModeOr(
    "GENT_PERSISTENCE_MODE",
    persistenceOpt,
    PERSISTENCE_MODES,
    "sqlite",
  )
  const providerMode = yield* knownModeOr("GENT_PROVIDER_MODE", providerOpt, PROVIDER_MODES, "live")
  const port = yield* tcpPortOr("GENT_PORT", portRaw, 3000)

  const isManaged = serverMode === "shared"
  // A managed shared server exits once its workers disconnect; standalone runs forever.
  let idleShutdown = Option.none<IdleShutdownSpec>()
  if (isManaged) {
    const idleMs = yield* positiveIntegerOr("GENT_IDLE_TIMEOUT_MS", idleTimeoutOpt, 30_000)
    idleShutdown = Option.some({ idleMs })
  }

  // `GENT_DATA_DIR` names the directory holding `data.db`.
  const dbPath = Option.map(dataDirOpt, (dataDir) => joinPath(dataDir, "data.db"))
  let state = Gent.state.sqlite({
    home: Option.getOrUndefined(homeOpt),
    dbPath: Option.getOrUndefined(dbPath),
  })
  if (persistenceMode === "memory") state = Gent.state.memory()

  return {
    isManaged,
    options: {
      cwd: process.cwd(),
      port,
      state,
      provider: resolveProvider(providerMode),
      authDirectory: Option.getOrUndefined(authDirectoryOpt),
      shell: Option.getOrUndefined(shellOpt),
      idleShutdown: Option.getOrUndefined(idleShutdown),
    },
  }
})

const program = Effect.scoped(
  Effect.gen(function* () {
    const launch = yield* resolveLaunch
    const server = yield* Gent.server(launch.options)
    const baseUrl = server.url.replace("/rpc", "")

    // Process fixtures parse these raw stdout messages.
    if (launch.isManaged) {
      yield* Console.log(`GENT_SERVER_READY ${baseUrl}`)
    } else {
      yield* Console.log(`Gent server ready on ${baseUrl}`)
    }

    return yield* Gent.awaitShutdown(server)
  }),
)

BunRuntime.runMain(program)
