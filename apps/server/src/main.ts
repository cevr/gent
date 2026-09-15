/**
 * Standalone HTTP server launcher. Reads the process environment, hands the
 * resolved shape to `Gent.server`, announces the bound URL, and waits. Every
 * composition decision lives in the SDK server primitive.
 */
import { BunRuntime } from "@effect/platform-bun"
import { Config, Console, Effect, Option } from "effect"
import { Gent, type IdleShutdownSpec } from "@gent/sdk"

const joinPath = (...parts: readonly string[]) => parts.join("/").replace(/\/+/g, "/")

const finiteOr = (raw: Option.Option<string>, fallback: number): number => {
  const parsed = Number(Option.getOrElse(raw, () => String(fallback)))
  if (Number.isFinite(parsed)) return parsed
  return fallback
}

/** `GENT_PROVIDER_MODE=debug-scripted` picks the scripted language model. */
const resolveProvider = (value: Option.Option<string>) => {
  if (Option.contains(value, "debug-scripted")) return Gent.provider.mock()
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

  const isManaged = Option.contains(serverModeOpt, "shared")
  // A managed shared server exits once its workers disconnect; standalone runs forever.
  let idleShutdown = Option.none<IdleShutdownSpec>()
  if (isManaged) idleShutdown = Option.some({ idleMs: finiteOr(idleTimeoutOpt, 30_000) })

  // `GENT_DATA_DIR` names the directory holding `data.db`.
  const dbPath = Option.map(dataDirOpt, (dataDir) => joinPath(dataDir, "data.db"))
  let state = Gent.state.sqlite({
    home: Option.getOrUndefined(homeOpt),
    dbPath: Option.getOrUndefined(dbPath),
  })
  if (Option.contains(persistenceOpt, "memory")) state = Gent.state.memory()

  return {
    isManaged,
    options: {
      cwd: process.cwd(),
      port: finiteOr(portRaw, 3000),
      state,
      provider: resolveProvider(providerOpt),
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
