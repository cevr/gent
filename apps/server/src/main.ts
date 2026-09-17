/**
 * Standalone HTTP server launcher. Reads the process environment, hands the
 * resolved shape to `Gent.server`, announces the bound URL, and waits. Every
 * composition decision lives in the SDK server primitive.
 */
import { BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Option } from "effect"
import { Gent, LaunchConfig, type IdleShutdownSpec } from "@gent/sdk"

/** `GENT_PROVIDER_MODE=debug-scripted` picks the scripted language model. */
const resolveProvider = (mode: "live" | "debug-scripted") => {
  if (mode === "debug-scripted") return Gent.provider.mock()
  return Gent.provider.live()
}

const resolveLaunch = Effect.gen(function* () {
  const launch = yield* LaunchConfig

  const isManaged = launch.serverMode === "shared"
  // A managed shared server exits once its workers disconnect; standalone runs forever.
  let idleShutdown = Option.none<IdleShutdownSpec>()
  if (isManaged) idleShutdown = Option.some({ idleMs: launch.idleTimeoutMs })

  // `GENT_DATA_DIR` reaches the database path through the SDK, which owns it.
  let state = Gent.state.sqlite({ home: Option.getOrUndefined(launch.home) })
  if (launch.persistenceMode === "memory") state = Gent.state.memory()

  return {
    isManaged,
    options: {
      cwd: process.cwd(),
      port: launch.port,
      state,
      provider: resolveProvider(launch.providerMode),
      authDirectory: Option.getOrUndefined(launch.authDirectory),
      shell: Option.getOrUndefined(launch.shell),
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
