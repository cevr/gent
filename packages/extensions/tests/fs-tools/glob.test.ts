import { describe, it, expect } from "effect-bun-test"
import { Effect, FileSystem, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { GlobTool } from "../../src/fs-tools/glob.js"
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

describe("GlobTool", () => {
  it.scopedLive("finds files matching pattern", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/a.ts`, "")
      yield* fs.writeFileString(`${tmpDir}/b.ts`, "")
      yield* fs.writeFileString(`${tmpDir}/c.js`, "")

      const result = yield* getToolEffect(GlobTool)({ pattern: "*.ts", path: tmpDir }, ctx)
      expect(result.files.length).toBe(2)
      expect(result.files.every((f: string) => f.endsWith(".ts"))).toBe(true)
    }).pipe(Effect.provide(ToolLayer)),
  )

  it.scopedLive("respects limit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      for (let i = 0; i < 5; i++) {
        yield* fs.writeFileString(`${tmpDir}/file${i}.ts`, "")
      }

      const result = yield* getToolEffect(GlobTool)(
        { pattern: "*.ts", path: tmpDir, limit: 2 },
        ctx,
      )
      expect(result.files.length).toBe(2)
      expect(result.truncated).toBe(true)
    }).pipe(Effect.provide(ToolLayer)),
  )

  it.scopedLive("sorts by mtime descending", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/old.ts`, "old")
      yield* fs.writeFileString(`${tmpDir}/new.ts`, "new")
      yield* fs.utimes(`${tmpDir}/old.ts`, 1_000, 1_000)
      yield* fs.utimes(`${tmpDir}/new.ts`, 2_000, 2_000)

      const result = yield* getToolEffect(GlobTool)({ pattern: "*.ts", path: tmpDir }, ctx)
      expect(result.files.length).toBe(2)
      // Newest first
      expect(result.files[0]).toContain("new.ts")
      expect(result.files[1]).toContain("old.ts")
    }).pipe(Effect.provide(ToolLayer)),
  )
})
