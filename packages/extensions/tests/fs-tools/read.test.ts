import { describe, it, expect } from "effect-bun-test"
import { Effect, FileSystem, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { ReadTool } from "../../src/fs-tools/read.js"
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

const PlatformLayer = Layer.merge(
  BunServices.layer,
  RuntimeEnvironment.Test({
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

      const result = yield* getToolEffect(ReadTool)({ path: testFile }, ctx)
      expect(result.content).toBe("1\tHello, World!")
    }),
  )

  readTest("returns error for non-existent file", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        getToolEffect(ReadTool)({ path: "/nonexistent/file.txt" }, ctx),
      )
      expect(result._tag).toBe("Failure")
    }),
  )

  readTest("returns error for directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()

      const result = yield* Effect.result(getToolEffect(ReadTool)({ path: tmpDir }, ctx))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure.message).toContain("Cannot read directory")
      }
    }),
  )
})
