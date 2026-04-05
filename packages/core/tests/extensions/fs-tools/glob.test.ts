import { describe, it, expect } from "effect-bun-test"
import { Effect, FileSystem, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { GlobTool } from "@gent/core/extensions/fs-tools/glob"
import type { ToolContext } from "@gent/core/domain/tool"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"

const ctx: ToolContext = {
  sessionId: "test-session",
  branchId: "test-branch",
  toolCallId: "test-call",
}

const PlatformLayer = Layer.merge(
  BunServices.layer,
  RuntimePlatform.Test({
    cwd: process.cwd(),
    home: "/tmp/test-home",
    platform: "test",
  }),
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
})
