/**
 * Build fingerprint — identifies gent executable/source version.
 * Used by server identity and SDK registry for version-aware restarts.
 */

import { Config, Effect, FileSystem, Option, Path } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process"
import { runProcess } from "../utils/run-process.js"

/** True when process.execPath is a compiled gent binary, not a generic runtime like bun. */
const isCompiledBinary = (): boolean => {
  const exe = process.execPath
  return !exe.endsWith("/bun") && !exe.includes("/.bun/")
}

/**
 * Compute a build fingerprint from local sources (no env).
 * Priority: compiled binary mtime → gent source git hash → "unknown"
 */
export const computeLocalFingerprint: Effect.Effect<
  string,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  // 1. Binary mtime (compiled mode only — skip if running via bun runtime)
  if (isCompiledBinary()) {
    const info = yield* fs.stat(process.execPath).pipe(Effect.option)
    if (info._tag === "Some") {
      const mtime = Option.getOrElse(info.value.mtime, () => new Date(0))
      return `bin-${mtime.getTime().toString(36)}`
    }
  }

  // 2. Git hash from gent source root (dev mode)
  const gentRoot = path.resolve(
    decodeURIComponent(new URL(import.meta.url).pathname),
    "../../../..",
  )
  const result = yield* runProcess("git", ["rev-parse", "--short", "HEAD"], {
    cwd: gentRoot,
    stdout: "pipe",
    stderr: "pipe",
  }).pipe(
    Effect.map((r) => (r.exitCode === 0 ? r.stdout.trim() : "")),
    Effect.catchTag("ProcessError", () => Effect.succeed("")),
  )
  if (result.length > 0) return `src-${result}`

  return "unknown"
})

/** Resolve the build fingerprint. Env var takes precedence, then local computation. */
export const resolveBuildFingerprint: Effect.Effect<
  string,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> = computeLocalFingerprint.pipe(
  Effect.flatMap((local) =>
    Effect.gen(function* () {
      const opt: Option.Option<string> = yield* Config.option(
        Config.string("GENT_BUILD_FINGERPRINT"),
      )
      return Option.isSome(opt) && opt.value !== "" ? opt.value : local
    }).pipe(Effect.catchEager(() => Effect.succeed(local))),
  ),
)
