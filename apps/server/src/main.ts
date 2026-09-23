/**
 * Standalone HTTP server launcher. Reads the process environment, hands the
 * resolved shape to `Gent.server`, announces the bound URL, and runs until a
 * signal stops it. Every composition decision lives in the SDK server primitive.
 */
import { BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Option } from "effect"
import { Gent, LaunchConfig } from "@gent/sdk"

/** `GENT_PROVIDER_MODE=debug-scripted` picks the scripted language model. */
const resolveProvider = (mode: "live" | "debug-scripted") => {
  if (mode === "debug-scripted") return Gent.provider.mock()
  return Gent.provider.live()
}

const resolveOptions = Effect.gen(function* () {
  const launch = yield* LaunchConfig

  // `GENT_DATA_DIR` and the home directory reach the database path through the SDK, which owns them.
  let state = Gent.state.sqlite()
  if (launch.persistenceMode === "memory") state = Gent.state.memory()

  return {
    cwd: process.cwd(),
    port: launch.port,
    state,
    provider: resolveProvider(launch.providerMode),
    authDirectory: Option.getOrUndefined(launch.authDirectory),
    shell: Option.getOrUndefined(launch.shell),
  }
})

const program = Effect.scoped(
  Effect.gen(function* () {
    const server = yield* Gent.server(yield* resolveOptions)
    // Process fixtures parse this raw stdout line.
    yield* Console.log(`Gent server ready on ${server.url.replace("/rpc", "")}`)
    return yield* Effect.never
  }),
)

BunRuntime.runMain(program)
