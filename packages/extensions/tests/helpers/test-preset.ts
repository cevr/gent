/**
 * Test preset — provides extension config for core integration tests.
 * Imports from @gent/extensions so test-utils don't need to.
 */
import { expect } from "effect-bun-test"
import { Effect, FileSystem, Layer, Path } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { BuiltinExtensions, CellBranchTools } from "@gent/extensions"
import { GentPlatform } from "@gent/core-internal/runtime/gent-platform.js"
import { BunPlatformLive } from "@gent/core-internal/runtime/gent-platform-bun.js"

export { ModelContextCompactorLive } from "../../src/compaction.js"
import { CELL_EXTENSION_ID } from "../../src/cell.js"
import { AllBuiltinAgents } from "./builtin-agents.js"
import type { E2ELayerConfig } from "@gent/core-internal/test-utils/index"

/**
 * The shipped composition: every builtin extension, and the branch-tool
 * feature the cell surface among them runs on. Named together because a
 * `cell` tool whose storage and kernel are missing fails on first use.
 */
export const shippedPreset = {
  agents: AllBuiltinAgents,
  extensionInputs: BuiltinExtensions,
  branchTools: CellBranchTools,
} satisfies Pick<E2ELayerConfig, "agents" | "extensionInputs" | "branchTools">

/**
 * Native tool surface for tool-behavior tests. Without the cell builtin the
 * model calls host tools directly; the same bound execution path serves cells.
 */
export const e2ePreset = {
  agents: AllBuiltinAgents,
  extensionInputs: BuiltinExtensions.filter(
    (extension) => extension.manifest.id !== CELL_EXTENSION_ID,
  ),
} satisfies Pick<E2ELayerConfig, "agents" | "extensionInputs">

/** Compile this checkout's cell worker into a scoped directory, as the release build ships it. */
export const buildCellExecutable = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const platform = yield* GentPlatform
  const bunPath = yield* platform.execPath
  const directory = yield* fs.makeTempDirectoryScoped()
  const binaryPath = path.join(directory, "gent-cell")
  const sourcePath = new URL("../../src/cell-worker-boundary.ts", import.meta.url).pathname
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

/**
 * The platform with the cell worker compiled from this checkout. A cell that
 * runs through the shipped preset otherwise launches whatever binary sits at
 * the source-mode sibling path, which no build step refreshes.
 */
export const currentCellPlatform = Effect.gen(function* () {
  const artifact = yield* buildCellExecutable
  const platform = yield* GentPlatform
  return Layer.succeed(
    GentPlatform,
    GentPlatform.of({ ...platform, siblingBinaryPath: () => Effect.succeed(artifact.binaryPath) }),
  )
}).pipe(Effect.provide(BunPlatformLive))
