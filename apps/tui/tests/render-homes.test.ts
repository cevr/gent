import { BunServices } from "@effect/platform-bun"
import { Config, Effect, FileSystem, Path, Stream } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { ChildProcess } from "effect/unstable/process"

/**
 * Each render in the TUI harness gets its own home. The homes of one test
 * process live under that process's root, and the process removes its own
 * root after its last test; it never touches another process's root. Each
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

/** Run `RENDER_ONCE` in a child `bun test` whose temp directory is `sandbox`. */
const runRenderOnce = (sandbox: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const file = path.join(sandbox, "render-once.test.ts")
    yield* fs.writeFileString(file, RENDER_ONCE)
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
      const run = yield* runRenderOnce(sandbox)
      expect(run.output).toContain("1 pass")
      expect(run.exitCode).toBe(0)
      expect(yield* fs.exists(other)).toBe(true)
      const left = (yield* fs.readDirectory(sandbox)).filter(
        (name) => name.startsWith("gent-tui-homes-") || name.startsWith("gent-test-home-"),
      )
      expect(left).toEqual(["gent-tui-homes-999999999-other"])
    }).pipe(Effect.timeout("60 seconds")),
  )
})
