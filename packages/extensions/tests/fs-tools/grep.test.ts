import { describe, it, expect } from "effect-bun-test"
import { Effect, FileSystem, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { GrepTool } from "../../src/fs-tools/grep.js"
import { FallbackFileIndexLive } from "../../src/fs-tools/file-index.js"
import { runToolWithCtx } from "@gent/core-internal/test-utils"
import { testToolContext } from "@gent/core-internal/test-utils/extension-harness"

const ToolLayer = Layer.merge(
  BunServices.layer,
  Layer.provide(FallbackFileIndexLive, BunServices.layer),
)
const ctx = testToolContext()

describe("GrepTool", () => {
  it.scopedLive("finds pattern in files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/file1.ts`, "const foo = 1")
      yield* fs.writeFileString(`${tmpDir}/file2.ts`, "const bar = 2")
      yield* fs.writeFileString(`${tmpDir}/file3.ts`, "const foo = 3")

      const result = yield* runToolWithCtx(GrepTool, { pattern: "foo", path: tmpDir }, ctx)
      expect(result.matches.length).toBe(2)
    }).pipe(Effect.provide(ToolLayer)),
  )

  it.scopedLive("respects glob filter", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/file1.ts`, "const foo = 1")
      yield* fs.writeFileString(`${tmpDir}/file2.js`, "const foo = 2")

      const result = yield* runToolWithCtx(
        GrepTool,
        { pattern: "foo", path: tmpDir, glob: "*.ts" },
        ctx,
      )
      expect(result.matches.length).toBe(1)
      expect(result.matches[0]!.file).toContain("file1.ts")
    }).pipe(Effect.provide(ToolLayer)),
  )

  it.scopedLive("searches single file directly", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/target.ts`, "hello\nworld\nhello again")

      const result = yield* runToolWithCtx(
        GrepTool,
        { pattern: "hello", path: `${tmpDir}/target.ts` },
        ctx,
      )
      expect(result.matches.length).toBe(2)
    }).pipe(Effect.provide(ToolLayer)),
  )
})
