import { BunServices } from "@effect/platform-bun"
import { Config, Effect, FileSystem, Path, Stream } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { ChildProcess } from "effect/process"
import { userInfo } from "node:os"

/**
 * The efficiency capture preload refuses to start a run that could read the
 * owner's login or gent state (the capture rule in `NORTH_STAR.md` → Owner
 * rules). Each case starts `bun --preload fetch-capture.ts started.ts` with
 * only `PATH` and the variables the case names, and reads whether the script
 * started.
 */
const captureTest = it.scopedLive.layer(BunServices.layer)

/** How long a started preload may ignore SIGTERM from the closing scope before it gets SIGKILL. */
const CAPTURE_KILL_GRACE = "2 seconds"

/** Start the preload with `env` alone; its combined output and exit code. */
const startCapture = (root: string, env: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const preload = yield* path.fromFileUrl(
      new URL("../../../docs/architecture/fetch-capture.ts", import.meta.url),
    )
    const started = path.join(root, "started.ts")
    yield* fs.writeFileString(started, 'console.log("STARTED")\n')
    const PATH = yield* Config.String("PATH")
    const handle = yield* ChildProcess.make("bun", ["--preload", preload, started], {
      cwd: root,
      env: { PATH, ...env },
      extendEnv: false,
      forceKillAfter: CAPTURE_KILL_GRACE,
    })
    const [exitCode, output] = yield* Effect.all(
      [handle.exitCode, Stream.mkString(Stream.decodeText(handle.all))],
      { concurrency: "unbounded" },
    )
    return { exitCode: Number(exitCode), output }
  })

/** A capture environment with every variable under `scratch`. */
const scratchEnv = (scratch: string) => ({
  CAP_DIR: `${scratch}/cap`,
  HOME: `${scratch}/home`,
  GENT_AUTH_DIRECTORY: `${scratch}/auth`,
  GENT_DATA_DIR: `${scratch}/data`,
})

describe("the capture preload's scratch check", () => {
  captureTest("every variable under the scratch directory starts the run", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "gent-capture-" })
      const run = yield* startCapture(root, scratchEnv(`${root}/probe`))
      expect(run.output).toContain("STARTED")
      expect(run.exitCode).toBe(0)
    }).pipe(Effect.timeout("20 seconds")),
  )

  captureTest("a HOME symlinked out of the scratch directory is refused", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "gent-capture-" })
      yield* fs.makeDirectory(`${root}/outside`)
      yield* fs.makeDirectory(`${root}/probe`)
      yield* fs.symlink(`${root}/outside`, `${root}/probe/home`)
      const run = yield* startCapture(root, scratchEnv(`${root}/probe`))
      expect(run.output).not.toContain("STARTED")
      expect(run.output).toContain("HOME must name a directory under")
    }).pipe(Effect.timeout("20 seconds")),
  )

  captureTest("a CAP_DIR directly in the owner's home is refused before anything is made", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "gent-capture-" })
      const owner = userInfo().homedir
      const capture = `${owner}/gent-capture-probe-never-made`
      const run = yield* startCapture(root, {
        CAP_DIR: capture,
        HOME: `${owner}/Developer`,
        GENT_AUTH_DIRECTORY: `${owner}/.gent`,
        GENT_DATA_DIR: `${owner}/.gent`,
      })
      expect(run.output).not.toContain("STARTED")
      expect(run.output).toContain("is the owner's home or above it")
      expect(yield* fs.exists(capture)).toBe(false)
    }).pipe(Effect.timeout("20 seconds")),
  )

  captureTest("a path that climbs out with `..` is read as it resolves", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "gent-capture-" })
      const run = yield* startCapture(root, {
        ...scratchEnv(`${root}/probe`),
        HOME: `${root}/probe/home/../../outside`,
      })
      expect(run.output).not.toContain("STARTED")
      expect(run.output).toContain("HOME must name a directory under")
    }).pipe(Effect.timeout("20 seconds")),
  )

  captureTest("a path that ends in a slash is read as it resolves", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "gent-capture-" })
      const nested = yield* startCapture(root, {
        ...scratchEnv(`${root}/probe`),
        GENT_AUTH_DIRECTORY: `${root}/probe/auth/`,
      })
      expect(nested.output).toContain("STARTED")
      const scratch = yield* startCapture(root, {
        ...scratchEnv(`${root}/probe`),
        GENT_DATA_DIR: `${root}/probe/`,
      })
      expect(scratch.output).not.toContain("STARTED")
      expect(scratch.output).toContain("GENT_DATA_DIR must name a directory under")
    }).pipe(Effect.timeout("20 seconds")),
  )
})
