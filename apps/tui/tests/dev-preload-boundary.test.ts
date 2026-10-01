import { describe, expect, it } from "effect-bun-test"
import { BunChildProcessSpawner, BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Layer, Path } from "effect"
import { runProcess } from "@gent/core/extensions/api"
import { BunPlatformLive, GentPlatform } from "@gent/core/host"
import { makeTempDirectoryScoped } from "@gent/core/test-utils"

/** Run `file` under the source preload with its own cache home; its stdout, trimmed. */
const runUnderPreload = (file: string, cacheHome: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const bun = yield* (yield* GentPlatform).execPath
    const preload = yield* path.fromFileUrl(
      new URL("../scripts/dev-preload-boundary.ts", import.meta.url),
    )
    const result = yield* runProcess(bun, ["--config=/dev/null", "--preload", preload, file], {
      cwd: path.dirname(file),
      env: { XDG_CACHE_HOME: cacheHome },
      extendEnv: true,
    })
    expect(result.exitCode).toBe(0)
    return result.stdout.trim()
  })

describe("source run preload", () => {
  it.live(
    "serves a file's transform from its cache until the file's text changes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const directory = yield* makeTempDirectoryScoped("gent-dev-preload-")
          const cacheHome = path.join(directory, "cache")
          const file = path.join(directory, "probe.tsx")
          yield* fs.writeFileString(file, `console.log("first")\n`)
          expect(yield* runUnderPreload(file, cacheHome)).toBe("first")

          // One lockfile directory holding one transform result.
          const root = path.join(cacheHome, "gent", "solid-transform")
          const [digest, ...otherDigests] = yield* fs.readDirectory(root)
          expect(otherDigests).toEqual([])
          const lockDirectory = path.join(root, digest ?? "")
          const [entry, ...otherEntries] = yield* fs.readDirectory(lockDirectory)
          expect(otherEntries).toEqual([])
          const cached = path.join(lockDirectory, entry ?? "")

          // The cached text, not a new transform, is what the next launch runs.
          const stored = yield* fs.readFileString(cached)
          yield* fs.writeFileString(cached, stored.replace("first", "from cache"))
          expect(yield* runUnderPreload(file, cacheHome)).toBe("from cache")

          // An edit misses the cache and runs the new text.
          yield* fs.writeFileString(file, `console.log("second")\n`)
          expect(yield* runUnderPreload(file, cacheHome)).toBe("second")
          expect((yield* fs.readDirectory(lockDirectory)).length).toBe(2)
        }),
      ).pipe(
        Effect.timeout("25 seconds"),
        Effect.provide(
          Layer.mergeAll(
            BunPlatformLive,
            BunChildProcessSpawner.layer.pipe(Layer.provide(BunServices.layer)),
          ),
        ),
      ),
    30_000,
  )
})
