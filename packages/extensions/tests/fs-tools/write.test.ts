import { describe, it, expect } from "effect-bun-test"
import { Effect, FileSystem, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { WriteTool } from "../../src/fs-tools/write.js"
import { RuntimeEnvironment } from "@gent/core-internal/runtime/runtime-environment"
import { testToolContext } from "@gent/core-internal/test-utils/extension-harness"
import { BranchId, SessionId, ToolCallId } from "@gent/core-internal/domain/ids"
import { runToolWithCtx } from "@gent/core-internal/test-utils"

const ctx = testToolContext({
  sessionId: SessionId.make("test-session"),
  branchId: BranchId.make("test-branch"),
  toolCallId: ToolCallId.make("test-call"),
  cwd: "/tmp",
  home: "/tmp",
})

const ToolLayer = Layer.merge(
  BunServices.layer,
  RuntimeEnvironment.Test({
    cwd: process.cwd(),
    home: "/tmp/test-home",
    platform: "test",
  }),
)

describe("WriteTool", () => {
  const writeTest = it.scopedLive.layer(ToolLayer)

  writeTest("atomic replacement writes complete content and leaves no temporary file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const path = `${dir}/result.md`
      yield* fs.writeFileString(path, "previous result")
      const content = "complete result\n".repeat(100_000)
      const result = yield* runToolWithCtx(WriteTool, { path, content, atomic: true }, ctx)
      expect(result.bytesWritten).toBe(content.length)
      expect(yield* fs.readFileString(path)).toBe(content)
      expect(yield* fs.readDirectory(dir)).toEqual(["result.md"])
    }),
  )

  writeTest("failed atomic rename preserves the destination and removes the temporary file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const destination = `${dir}/saved`
      yield* fs.makeDirectory(destination)
      yield* fs.writeFileString(`${destination}/previous.md`, "previous result")
      const result = yield* runToolWithCtx(
        WriteTool,
        { path: destination, content: "new result", atomic: true },
        ctx,
      ).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      expect(yield* fs.readFileString(`${destination}/previous.md`)).toBe("previous result")
      expect(yield* fs.readDirectory(dir)).toEqual(["saved"])
    }),
  )

  writeTest("atomic replacement replaces a symlink while normal writes follow it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const target = `${dir}/target.md`
      const link = `${dir}/link.md`
      yield* fs.writeFileString(target, "original")
      yield* fs.symlink(target, link)
      yield* runToolWithCtx(WriteTool, { path: link, content: "normal write" }, ctx)
      expect(yield* fs.readFileString(target)).toBe("normal write")
      yield* runToolWithCtx(WriteTool, { path: link, content: "atomic result", atomic: true }, ctx)
      expect(yield* fs.readFileString(target)).toBe("normal write")
      expect(yield* fs.readFileString(link)).toBe("atomic result")
      expect((yield* fs.stat(link)).type).toBe("File")
      expect((yield* fs.readDirectory(dir)).sort()).toEqual(["link.md", "target.md"])
    }),
  )

  writeTest("writes content to a new file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      const filePath = `${tmpDir}/new-file.txt`

      const result = yield* runToolWithCtx(
        WriteTool,
        { path: filePath, content: "Hello, World!" },
        ctx,
      )

      expect(result.path).toBe(filePath)
      expect(result.bytesWritten).toBe(13)

      const written = yield* fs.readFileString(filePath)
      expect(written).toBe("Hello, World!")
    }),
  )

  writeTest("creates parent directories when missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      const filePath = `${tmpDir}/nested/dir/file.txt`

      yield* runToolWithCtx(WriteTool, { path: filePath, content: "nested" }, ctx)

      const written = yield* fs.readFileString(filePath)
      expect(written).toBe("nested")
    }),
  )

  writeTest("overwrites existing file content", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      const filePath = `${tmpDir}/existing.txt`
      yield* fs.writeFileString(filePath, "original content")

      yield* runToolWithCtx(WriteTool, { path: filePath, content: "replaced" }, ctx)

      const written = yield* fs.readFileString(filePath)
      expect(written).toBe("replaced")
    }),
  )
})
