import { Config, Effect, Option } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { GentPlatform } from "@gent/core-internal/runtime/gent-platform.js"

const readColorFgBg = Config.option(Config.string("COLORFGBG")).pipe(
  Effect.orElseSucceed(() => Option.none<string>()),
)

const readDarwinAppearance = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const exitCode = yield* spawner
    .exitCode(ChildProcess.make("defaults", ["read", "-g", "AppleInterfaceStyle"]))
    .pipe(Effect.orElseSucceed(() => 1))
  if (exitCode === 0) return "dark"
  return "light"
})

/**
 * Detect if terminal is using dark or light mode.
 * Strategies in order:
 * 1. COLORFGBG env var (set by some terminals)
 * 2. macOS system appearance (`defaults read AppleInterfaceStyle`)
 * 3. Default to dark
 */
export const detectColorScheme: Effect.Effect<
  "dark" | "light",
  never,
  ChildProcessSpawner.ChildProcessSpawner | GentPlatform
> = Effect.gen(function* () {
  const colorFgBg = yield* readColorFgBg
  if (Option.isSome(colorFgBg) && colorFgBg.value.length > 0) {
    const parts = colorFgBg.value.split(";")
    const bg = parseInt(
      Option.getOrElse(Option.fromNullishOr(parts[parts.length - 1]), () => "0"),
      10,
    )
    // ANSI colors 0-6 are typically dark, 7+ are light
    if (bg > 6) return "light"
    return "dark"
  }

  const platform = yield* GentPlatform
  const info = yield* platform.osInfo
  if (info.platform === "darwin") return yield* readDarwinAppearance

  return "dark"
})
