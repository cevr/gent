import { describe, it, expect } from "effect-bun-test"
import { Effect, FileSystem, Layer, Option } from "effect"
import { BunServices } from "@effect/platform-bun"
import { ReadTool } from "../../src/fs-tools.js"
import { RuntimeEnvironment } from "@gent/core-internal/runtime/config"
import { runToolWithCtx, testToolContext } from "@gent/core-internal/test-utils/index"
import { BranchId, SessionId, ToolCallId } from "@gent/core-internal/domain/ids"

const ctx = testToolContext({
  sessionId: SessionId.make("test-session"),
  branchId: BranchId.make("test-branch"),
  toolCallId: ToolCallId.make("test-call"),
  cwd: "/tmp",
  home: "/tmp",
})

const PlatformLayer = Layer.merge(
  BunServices.layer,
  RuntimeEnvironment.Live({
    cwd: process.cwd(),
    home: "/tmp/test-home",
    platform: "test",
  }),
)
const ToolLayer = PlatformLayer

describe("ReadTool", () => {
  const readTest = it.scopedLive.layer(ToolLayer)

  readTest("reads a file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      const testFile = `${tmpDir}/test.txt`
      yield* fs.writeFileString(testFile, "Hello, World!")

      const result = yield* runToolWithCtx(ReadTool, { path: testFile }, ctx)
      expect(result.content).toBe("1\tHello, World!")
    }),
  )

  readTest("returns error for non-existent file", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        runToolWithCtx(ReadTool, { path: "/nonexistent/file.txt" }, ctx),
      )
      expect(result._tag).toBe("Failure")
    }),
  )

  readTest("a truncated read reports the offset that continues without a gap", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      const testFile = `${tmpDir}/paged.txt`
      const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`)
      yield* fs.writeFileString(testFile, lines.join("\n"))

      const first = yield* runToolWithCtx(ReadTool, { path: testFile, limit: 4 }, ctx)
      expect(first.truncated).toBe(true)
      expect(first.nextOffset).toBe(5)
      expect(first.content).toContain("4\tline 4")
      expect(first.content).not.toContain("line 5")

      const second = yield* runToolWithCtx(
        ReadTool,
        { path: testFile, offset: Option.getOrThrow(Option.fromNullishOr(first.nextOffset)) },
        ctx,
      )
      // The line-number column is right-padded to the widest number in the page.
      expect(second.content.split("\n")[0]).toBe(" 5\tline 5")
      expect(second.truncated).toBe(false)
      expect(Option.isNone(Option.fromNullishOr(second.nextOffset))).toBe(true)
    }),
  )

  readTest("a complete read reports no continuation offset", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      const testFile = `${tmpDir}/whole.txt`
      yield* fs.writeFileString(testFile, "only line")

      const result = yield* runToolWithCtx(ReadTool, { path: testFile }, ctx)
      expect(result.truncated).toBe(false)
      expect(Option.isNone(Option.fromNullishOr(result.nextOffset))).toBe(true)
    }),
  )

  readTest("returns error for directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()

      const result = yield* Effect.result(runToolWithCtx(ReadTool, { path: tmpDir }, ctx))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure.message).toContain("Cannot read directory")
      }
    }),
  )
})
