import { Config, Effect, Layer, Option } from "effect"
import { GentPlatform } from "@gent/core/runtime/gent-platform.js"
import { BunGentPlatformLive } from "@gent/core/runtime/gent-platform-bun.js"

/**
 * Detect if terminal is using dark or light mode.
 * Uses multiple strategies in order:
 * 1. COLORFGBG env var (set by some terminals)
 * 2. macOS system appearance
 * 3. Default to dark
 */
export function detectColorScheme(): "dark" | "light" {
  // Check COLORFGBG env (set by some terminals like rxvt, xterm, some terminal emulators)
  // Format: "fg;bg" where higher bg number = light theme
  const colorFgBg = Effect.runSync(
    Effect.gen(function* () {
      const opt = yield* Config.option(Config.string("COLORFGBG"))
      return Option.getOrUndefined(opt)
    }),
  )
  if (colorFgBg !== undefined && colorFgBg.length > 0) {
    const parts = colorFgBg.split(";")
    const bg = parseInt(parts[parts.length - 1] ?? "0", 10)
    // ANSI colors 0-6 are typically dark, 7+ are light
    return bg > 6 ? "light" : "dark"
  }

  // Check macOS system appearance
  if (process.platform === "darwin") {
    const exitCode = Effect.runSync(
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const result = yield* platform.spawnSync(["defaults", "read", "-g", "AppleInterfaceStyle"])
        return result.exitCode
        // @effect-diagnostics-next-line strictEffectProvide:off
      }).pipe(Effect.provide(Layer.fresh(BunGentPlatformLive))),
    )
    if (exitCode === 0) {
      return "dark"
    }
    return "light"
  }

  // Default to dark
  return "dark"
}
