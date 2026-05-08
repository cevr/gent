import { describe, it, expect } from "effect-bun-test"
import { Effect, FileSystem, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { GrepTool } from "../../src/fs-tools/grep.js"
import { FsRead } from "../../src/fs-tools/read-service"
import type { ToolCapabilityContext } from "@gent/core-internal/domain/capability/tool"
import { RuntimeEnvironment } from "@gent/core-internal/runtime/runtime-environment"
import { testToolContext } from "@gent/core-internal/test-utils/extension-harness"
import { BranchId, SessionId, ToolCallId } from "@gent/core-internal/domain/ids"
import { getToolEffect } from "@gent/core-internal/domain/capability/tool"
import { TestFileIndexLive } from "../helpers/file-index-layer.js"

const ctx: ToolCapabilityContext = testToolContext({
  sessionId: SessionId.make("test-session"),
  branchId: BranchId.make("test-branch"),
  toolCallId: ToolCallId.make("test-call"),
  cwd: "/tmp",
  home: "/tmp",
})

const PlatformLayer = Layer.mergeAll(
  BunServices.layer,
  RuntimeEnvironment.Test({
    cwd: process.cwd(),
    home: "/tmp/test-home",
    platform: "test",
  }),
  Layer.provide(TestFileIndexLive, BunServices.layer),
)
const ToolLayer = Layer.merge(PlatformLayer, Layer.provide(FsRead.Live, PlatformLayer))

describe("GrepTool", () => {
  it.scopedLive("finds pattern in files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/file1.ts`, "const foo = 1")
      yield* fs.writeFileString(`${tmpDir}/file2.ts`, "const bar = 2")
      yield* fs.writeFileString(`${tmpDir}/file3.ts`, "const foo = 3")

      const result = yield* getToolEffect(GrepTool)({ pattern: "foo", path: tmpDir }, ctx)
      expect(result.matches.length).toBe(2)
    }).pipe(Effect.provide(ToolLayer)),
  )

  it.scopedLive("respects glob filter", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/file1.ts`, "const foo = 1")
      yield* fs.writeFileString(`${tmpDir}/file2.js`, "const foo = 2")

      const result = yield* getToolEffect(GrepTool)(
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

      const result = yield* getToolEffect(GrepTool)(
        { pattern: "hello", path: `${tmpDir}/target.ts` },
        ctx,
      )
      expect(result.matches.length).toBe(2)
    }).pipe(Effect.provide(ToolLayer)),
  )
})
