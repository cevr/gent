import { BunServices } from "@effect/platform-bun"
import { Config, Effect, FileSystem, Path, Stream } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { ChildProcess } from "effect/unstable/process"

/**
 * The drivers' empty catalog home (`helpers/catalog-source.ts`) is gone once
 * its test process ends. The case runs one test file that reads it in a child
 * `bun test` whose temp directory is a sandbox, and reads what the child left.
 */
const catalogTest = it.scopedLive.layer(BunServices.layer)

const PACKAGE_DIR = new URL("..", import.meta.url).pathname
const HELPER = new URL("./helpers/catalog-source.ts", import.meta.url).pathname
const PRELOAD = new URL("../../tooling/src/test-preload.ts", import.meta.url).pathname

/** A test file that reads the catalog home once; it lives in the sandbox, so its imports resolve from here. */
const READ_ONCE = `import { expect, test } from "bun:test"
import { testCatalogSource } from "${HELPER}"

test("reads the home", () => {
  expect(testCatalogSource().home.length).toBeGreaterThan(0)
})
`

describe("the drivers' catalog home", () => {
  catalogTest("a test process leaves no catalog home behind", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const sandbox = yield* fs.makeTempDirectoryScoped({ prefix: "gent-catalog-home-" })
      const file = path.join(sandbox, "read-once.test.ts")
      yield* fs.writeFileString(file, READ_ONCE)
      const handle = yield* ChildProcess.make("bun", ["test", "--preload", PRELOAD, file], {
        cwd: PACKAGE_DIR,
        env: { PATH: yield* Config.string("PATH"), TMPDIR: sandbox, HOME: sandbox, NO_COLOR: "1" },
        extendEnv: false,
      })
      const [exitCode, output] = yield* Effect.all(
        [handle.exitCode, Stream.mkString(Stream.decodeText(handle.all))],
        { concurrency: "unbounded" },
      )
      expect(output).toContain("1 pass")
      expect(Number(exitCode)).toBe(0)
      const left = (yield* fs.readDirectory(sandbox)).filter(
        (name) => name.startsWith("gent-no-catalog-") || name.startsWith("gent-test-home-"),
      )
      expect(left).toEqual([])
    }).pipe(Effect.timeout("60 seconds")),
  )
})
