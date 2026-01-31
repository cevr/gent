import { execSync } from "node:child_process"
import { Config, Effect, Option } from "effect"

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
    Config.option(Config.string("COLORFGBG")).pipe(
      Effect.catchAll(() => Effect.succeed(Option.none())),
      Effect.map(Option.getOrUndefined),
    ),
  )
  if (colorFgBg !== undefined && colorFgBg.length > 0) {
    const parts = colorFgBg.split(";")
    const bg = parseInt(parts[parts.length - 1] ?? "0", 10)
    // ANSI colors 0-6 are typically dark, 7+ are light
    return bg > 6 ? "light" : "dark"
  }

  // Check macOS system appearance
  if (process.platform === "darwin") {
    try {
      execSync("defaults read -g AppleInterfaceStyle 2>/dev/null", {
        encoding: "utf-8",
        timeout: 500,
      })
      // If the command succeeds and returns "Dark", we're in dark mode
      return "dark"
    } catch {
      // If key doesn't exist (command fails), macOS is in light mode
      return "light"
    }
  }

  // Default to dark
  return "dark"
}
