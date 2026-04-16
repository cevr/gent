import { describe, it, expect } from "effect-bun-test"
import { Effect, FileSystem, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { GlobTool } from "@gent/extensions/fs-tools/glob"
import type { ToolContext } from "@gent/core/domain/tool"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"
import { FallbackFileIndexLive } from "@gent/core/runtime/file-index/index"

const ctx: ToolContext = {
  sessionId: "test-session",
  branchId: "test-branch",
  toolCallId: "test-call",
  cwd: "/tmp",
  home: "/tmp",
  extensions: {
    send: () => Effect.die("not wired"),
    ask: () => Effect.die("not wired"),
  },
}

const PlatformLayer = Layer.mergeAll(
  BunServices.layer,
  RuntimePlatform.Test({
    cwd: process.cwd(),
    home: "/tmp/test-home",
    platform: "test",
  }),
  Layer.provide(FallbackFileIndexLive, BunServices.layer),
)

describe("GlobTool", () => {
  it.scopedLive("finds files matching pattern", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/a.ts`, "")
      yield* fs.writeFileString(`${tmpDir}/b.ts`, "")
      yield* fs.writeFileString(`${tmpDir}/c.js`, "")

      const result = yield* GlobTool.execute({ pattern: "*.ts", path: tmpDir }, ctx)
      expect(result.files.length).toBe(2)
      expect(result.files.every((f) => f.endsWith(".ts"))).toBe(true)
    }).pipe(Effect.provide(PlatformLayer)),
  )

  it.scopedLive("respects limit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      for (let i = 0; i < 5; i++) {
        yield* fs.writeFileString(`${tmpDir}/file${i}.ts`, "")
      }

      const result = yield* GlobTool.execute({ pattern: "*.ts", path: tmpDir, limit: 2 }, ctx)
      expect(result.files.length).toBe(2)
      expect(result.truncated).toBe(true)
    }).pipe(Effect.provide(PlatformLayer)),
  )

  it.scopedLive("sorts by mtime descending", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/old.ts`, "old")
      // Small delay to ensure different mtime
      yield* Effect.sleep(50)
      yield* fs.writeFileString(`${tmpDir}/new.ts`, "new")

      const result = yield* GlobTool.execute({ pattern: "*.ts", path: tmpDir }, ctx)
      expect(result.files.length).toBe(2)
      // Newest first
      expect(result.files[0]).toContain("new.ts")
      expect(result.files[1]).toContain("old.ts")
    }).pipe(Effect.provide(PlatformLayer)),
  )
})
