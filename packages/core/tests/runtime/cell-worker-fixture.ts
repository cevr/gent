import { expect } from "effect-bun-test"
import { Effect, FileSystem, Path } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { GentPlatform } from "@gent/core-internal/runtime/gent-platform"

export const buildCellWorker = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const platform = yield* GentPlatform
  const binaryPath = yield* platform.execPath
  const directory = yield* fs.makeTempDirectoryScoped()
  const workerPath = path.join(directory, "worker.js")
  const sourcePath = new URL("../../src/runtime/code-cell/main.ts", import.meta.url).pathname
  const build = yield* ChildProcess.make(
    binaryPath,
    ["build", sourcePath, "--target=bun", "--outfile", workerPath],
    { stdout: "ignore", stderr: "inherit" },
  )
  expect(Number(yield* build.exitCode)).toBe(0)
  return { binaryPath, workerPath }
})

export const buildCellExecutable = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const platform = yield* GentPlatform
  const bunPath = yield* platform.execPath
  const directory = yield* fs.makeTempDirectoryScoped()
  const binaryPath = path.join(directory, "gent-cell")
  const sourcePath = new URL("../../src/runtime/code-cell/main.ts", import.meta.url).pathname
  const build = yield* ChildProcess.make(
    bunPath,
    [
      "build",
      sourcePath,
      "--compile",
      "--no-compile-autoload-bunfig",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-tsconfig",
      "--no-compile-autoload-package-json",
      "--outfile",
      binaryPath,
    ],
    { stdout: "ignore", stderr: "inherit" },
  )
  expect(Number(yield* build.exitCode)).toBe(0)
  return { binaryPath, workerPath: binaryPath }
})
