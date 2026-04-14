/**
 * Build fingerprint — identifies gent executable/source version.
 * Used by server identity and SDK registry for version-aware restarts.
 */

// @effect-diagnostics nodeBuiltinImport:off
import { statSync } from "node:fs"
// @effect-diagnostics nodeBuiltinImport:off
import { resolve } from "node:path"
// @effect-diagnostics nodeBuiltinImport:off
import { fileURLToPath } from "node:url"

import { Config, Effect, Option } from "effect"

/** True when process.execPath is a compiled gent binary, not a generic runtime like bun. */
const isCompiledBinary = (): boolean => {
  const exe = process.execPath
  return !exe.endsWith("/bun") && !exe.includes("/.bun/")
}

/**
 * Compute a build fingerprint from local sources (no env).
 * Priority: compiled binary mtime → gent source git hash → "unknown"
 */
export const computeLocalFingerprint = (): string => {
  // 1. Binary mtime (compiled mode only — skip if running via bun runtime)
  if (isCompiledBinary()) {
    try {
      const stat = statSync(process.execPath)
      return `bin-${stat.mtimeMs.toString(36)}`
    } catch {
      // stat failed
    }
  }

  // 2. Git hash from gent source root (dev mode)
  try {
    const gentRoot = resolve(fileURLToPath(import.meta.url), "../../../..")
    const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: gentRoot })
    const hash = new TextDecoder().decode(proc.stdout).trim()
    if (hash.length > 0) return `src-${hash}`
  } catch {
    // no git or not in repo
  }

  return "unknown"
}

/** Resolve the build fingerprint. Env var takes precedence, then local computation. */
export const resolveBuildFingerprint: Effect.Effect<string> = Effect.succeed(
  computeLocalFingerprint(),
).pipe(
  Effect.flatMap((local) =>
    Effect.gen(function* () {
      const opt: Option.Option<string> = yield* Config.option(
        Config.string("GENT_BUILD_FINGERPRINT"),
      )
      return Option.isSome(opt) && opt.value !== "" ? opt.value : local
    }).pipe(Effect.catchEager(() => Effect.succeed(local))),
  ),
)
