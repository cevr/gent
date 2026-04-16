import { describe, it, expect } from "effect-bun-test"
import { Effect, FileSystem, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { GrepTool } from "@gent/extensions/fs-tools/grep"
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

describe("GrepTool", () => {
  it.scopedLive("finds pattern in files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/file1.ts`, "const foo = 1")
      yield* fs.writeFileString(`${tmpDir}/file2.ts`, "const bar = 2")
      yield* fs.writeFileString(`${tmpDir}/file3.ts`, "const foo = 3")

      const result = yield* GrepTool.execute({ pattern: "foo", path: tmpDir }, ctx)
      expect(result.matches.length).toBe(2)
    }).pipe(Effect.provide(PlatformLayer)),
  )

  it.scopedLive("respects glob filter", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/file1.ts`, "const foo = 1")
      yield* fs.writeFileString(`${tmpDir}/file2.js`, "const foo = 2")

      const result = yield* GrepTool.execute({ pattern: "foo", path: tmpDir, glob: "*.ts" }, ctx)
      expect(result.matches.length).toBe(1)
      expect(result.matches[0]!.file).toContain("file1.ts")
    }).pipe(Effect.provide(PlatformLayer)),
  )

  it.scopedLive("searches single file directly", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/target.ts`, "hello\nworld\nhello again")

      const result = yield* GrepTool.execute({ pattern: "hello", path: `${tmpDir}/target.ts` }, ctx)
      expect(result.matches.length).toBe(2)
    }).pipe(Effect.provide(PlatformLayer)),
  )
})
