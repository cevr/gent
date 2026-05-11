/**
 * Build fingerprint — identifies gent executable/source version.
 * Used by server identity and SDK registry for version-aware restarts.
 */

import { Config, Context, Effect, FileSystem, Layer, Option, Path } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process"
import { dateFromMillis } from "../domain/message.js"
import { GentPlatform } from "../runtime/gent-platform.js"
import { runProcess } from "../utils/run-process.js"

/** True when execPath is a compiled gent binary, not a generic runtime like bun. */
const isCompiledBinary = (exe: string): boolean => !exe.endsWith("/bun") && !exe.includes("/.bun/")

/**
 * Compute a build fingerprint from local sources (no env).
 * Priority: compiled binary mtime → gent source git hash → "unknown"
 */
const computeLocalFingerprintUncached: Effect.Effect<
  string,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | GentPlatform
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const platform = yield* GentPlatform
  const exe = yield* platform.execPath

  // 1. Binary mtime (compiled mode only — skip if running via bun runtime)
  if (isCompiledBinary(exe)) {
    const info = yield* fs.stat(exe).pipe(Effect.option)
    if (info._tag === "Some") {
      const mtime = Option.getOrElse(info.value.mtime, () => dateFromMillis(0))
      return `bin-${mtime.getTime().toString(36)}`
    }
  }

  // 2. Git hash from gent source root (dev mode)
  const gentRoot = path.resolve(platform.fileURLToPath(import.meta.url), "../../../..")
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

export interface BuildFingerprintShape {
  /** Cached local fingerprint computation. Identical across yields within TTL. */
  readonly local: Effect.Effect<string>
  /** Resolved fingerprint — env override (`GENT_BUILD_FINGERPRINT`) wins, else local. */
  readonly resolved: Effect.Effect<string>
}

export class BuildFingerprint extends Context.Service<BuildFingerprint, BuildFingerprintShape>()(
  "@gent/core/src/server/build-fingerprint/BuildFingerprint",
) {
  static Live: Layer.Layer<
    BuildFingerprint,
    never,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | GentPlatform
  > = Layer.effect(
    BuildFingerprint,
    Effect.gen(function* () {
      const ctx = yield* Effect.context<
        FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | GentPlatform
      >()
      const cached = yield* Effect.cachedWithTTL(computeLocalFingerprintUncached, "1 hour")
      const local: Effect.Effect<string> = Effect.provide(cached, ctx)
      const resolved: Effect.Effect<string> = Effect.gen(function* () {
        const opt: Option.Option<string> = yield* Config.option(
          Config.string("GENT_BUILD_FINGERPRINT"),
        )
        if (Option.isSome(opt) && opt.value !== "") return opt.value
        return yield* local
      }).pipe(Effect.catchEager(() => local))
      return { local, resolved }
    }),
  )

  /** Deterministic test layer. */
  static Test = (fingerprint = "test-fingerprint"): Layer.Layer<BuildFingerprint> =>
    Layer.succeed(BuildFingerprint, {
      local: Effect.succeed(fingerprint),
      resolved: Effect.succeed(fingerprint),
    })
}
