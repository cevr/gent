import { BunServices } from "@effect/platform-bun"
import { Config, Effect, FileSystem, Path, Stream } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { ChildProcess } from "effect/unstable/process"

/**
 * Each render in the TUI harness gets its own home. The homes of one test
 * file live under that file's root, removed once after the file's last test,
 * so a write the app makes into a home after its test ends never races the
 * removal; a run never touches another process's root. Each
 * case runs one rendering test file in a child `bun test` whose temp
 * directory is a sandbox, so the child's roots land where the case can read
 * them.
 */
const homesTest = it.scopedLive.layer(BunServices.layer)

const APP_DIR = new URL("..", import.meta.url).pathname
const HARNESS = new URL("./render-harness-boundary.tsx", import.meta.url).pathname
const PRELOAD = new URL("../../../packages/tooling/src/test-preload.ts", import.meta.url).pathname

/** A test file that renders once through the harness; it lives in the sandbox, so its imports resolve from here. */
const RENDER_ONCE = `import { Effect } from "${import.meta.resolve("effect")}"
import { it } from "${import.meta.resolve("effect-bun-test")}"
import { renderWithProviders } from "${HARNESS}"

it.live("renders once", () => Effect.promise(() => renderWithProviders(() => undefined)))
`

const WORKSPACE = new URL("../src/workspace.tsx", import.meta.url).pathname
const WRITING_RENDERS = 100

/**
 * Tests whose app keeps writing into its render's home after the test ends,
 * as a prompt-history write the test did not wait for does. Each writer runs
 * past its test's end and stops on its own; the last test waits for them, so
 * no writer outlives the file.
 */
const RENDER_WRITES = `import { mkdir, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "${import.meta.resolve("effect")}"
import { it } from "${import.meta.resolve("effect-bun-test")}"
import { useWorkspace } from "${WORKSPACE}"
import { renderWithProviders } from "${HARNESS}"

const writers = []
const write = async (home) => {
  const directory = join(home, ".cache", "gent")
  const until = Date.now() + 40
  while (Date.now() < until) {
    try {
      await mkdir(directory, { recursive: true })
      const staging = join(directory, ".history-" + Math.random().toString(16).slice(2))
      await writeFile(staging, "[]")
      await rename(staging, join(directory, "history.json"))
    } catch {}
  }
}
const StartWriting = () => {
  const home = useWorkspace().home
  for (let n = 0; n < 4; n++) writers.push(write(home))
  return undefined
}

for (let n = 0; n < ${WRITING_RENDERS}; n++) {
  it.live("writes past its end " + n, () =>
    Effect.promise(() => renderWithProviders(() => StartWriting())).pipe(Effect.andThen(Effect.sleep("2 millis"))),
  )
}
it.live("the writers stop", () => Effect.promise(() => Promise.all(writers)))
`

/** Run `source` as a test file in a child `bun test` whose temp directory is `sandbox`. */
const runTestFile = (sandbox: string, source: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const file = path.join(sandbox, "render.test.ts")
    yield* fs.writeFileString(file, source)
    const PATH = yield* Config.string("PATH")
    const handle = yield* ChildProcess.make("bun", ["test", "--preload", PRELOAD, file], {
      cwd: APP_DIR,
      env: { PATH, TMPDIR: sandbox, HOME: sandbox, NO_COLOR: "1" },
      extendEnv: false,
    })
    const [exitCode, output] = yield* Effect.all(
      [handle.exitCode, Stream.mkString(Stream.decodeText(handle.all))],
      { concurrency: "unbounded" },
    )
    return { exitCode: Number(exitCode), output }
  })

describe("render homes", () => {
  homesTest("a test process removes its own homes root and leaves every other root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const sandbox = yield* fs.makeTempDirectoryScoped({ prefix: "gent-render-homes-" })
      // Another process's root: its pid reads as ended here, as a pid of
      // another pid namespace does, but the root is not this process's to remove.
      const other = path.join(sandbox, "gent-tui-homes-999999999-other")
      yield* fs.makeDirectory(other)
      const run = yield* runTestFile(sandbox, RENDER_ONCE)
      expect(run.output).toContain("1 pass")
      expect(run.exitCode).toBe(0)
      expect(yield* fs.exists(other)).toBe(true)
      const left = (yield* fs.readDirectory(sandbox)).filter(
        (name) => name.startsWith("gent-tui-homes-") || name.startsWith("gent-test-home-"),
      )
      expect(left).toEqual(["gent-tui-homes-999999999-other"])
    }).pipe(Effect.timeout("60 seconds")),
  )

  homesTest(
    "an app write that outlives its test never fails the test or outlives the process",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const sandbox = yield* fs.makeTempDirectoryScoped({ prefix: "gent-render-homes-" })
        const run = yield* runTestFile(sandbox, RENDER_WRITES)
        expect(run.output).toContain(`${WRITING_RENDERS + 1} pass`)
        expect(run.exitCode).toBe(0)
        const left = (yield* fs.readDirectory(sandbox)).filter((name) =>
          name.startsWith("gent-test-home-"),
        )
        expect(left).toEqual([])
      }).pipe(Effect.timeout("60 seconds")),
  )
})
