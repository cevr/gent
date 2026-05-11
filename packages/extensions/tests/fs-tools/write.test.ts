import { describe, it, expect } from "effect-bun-test"
import { Effect, FileSystem, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { WriteTool } from "../../src/fs-tools/write.js"
import { RuntimeEnvironment } from "@gent/core-internal/runtime/runtime-environment"
import { testToolContext } from "@gent/core-internal/test-utils/extension-harness"
import { BranchId, SessionId, ToolCallId } from "@gent/core-internal/domain/ids"
import { getToolEffect } from "@gent/core-internal/domain/capability/tool"

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

  writeTest("writes content to a new file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      const filePath = `${tmpDir}/new-file.txt`

      const result = yield* getToolEffect(WriteTool)(
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

      yield* getToolEffect(WriteTool)({ path: filePath, content: "nested" }, ctx)

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

      yield* getToolEffect(WriteTool)({ path: filePath, content: "replaced" }, ctx)

      const written = yield* fs.readFileString(filePath)
      expect(written).toBe("replaced")
    }),
  )
})
