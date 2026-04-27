import { describe, it, expect } from "effect-bun-test"
import { Effect, FileSystem, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { ReadTool } from "@gent/extensions/fs-tools/read"
import type { ToolContext } from "@gent/core/domain/tool"
import { RuntimePlatform } from "../../../src/runtime/runtime-platform"
import { testToolContext } from "@gent/core/test-utils/extension-harness"
import { BranchId, SessionId, ToolCallId } from "@gent/core/domain/ids"

const ctx: ToolContext = testToolContext({
  sessionId: SessionId.make("test-session"),
  branchId: BranchId.make("test-branch"),
  toolCallId: ToolCallId.make("test-call"),
  cwd: "/tmp",
  home: "/tmp",
})

const PlatformLayer = Layer.merge(
  BunServices.layer,
  RuntimePlatform.Test({
    cwd: process.cwd(),
    home: "/tmp/test-home",
    platform: "test",
  }),
)

describe("ReadTool", () => {
  const readTest = it.scopedLive.layer(PlatformLayer)

  readTest("reads a file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      const testFile = `${tmpDir}/test.txt`
      yield* fs.writeFileString(testFile, "Hello, World!")

      const result = yield* ReadTool.effect({ path: testFile }, ctx)
      expect(result.content).toBe("1\tHello, World!")
    }),
  )

  readTest("returns error for non-existent file", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(ReadTool.effect({ path: "/nonexistent/file.txt" }, ctx))
      expect(result._tag).toBe("Failure")
    }),
  )

  readTest("returns error for directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()

      const result = yield* Effect.result(ReadTool.effect({ path: tmpDir }, ctx))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure.message).toContain("Cannot read directory")
      }
    }),
  )
})
