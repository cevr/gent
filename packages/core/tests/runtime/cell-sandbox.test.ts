import { describe, expect, it } from "effect-bun-test"
import { Effect, Path } from "effect"
import { makeMacosCellSandboxProfile } from "@gent/core-internal/runtime/code-cell/cell-sandbox"

describe("cell sandbox policy", () => {
  it.live("grants exact artifact paths without granting their directory contents", () =>
    Effect.gen(function* () {
      const profile = yield* makeMacosCellSandboxProfile({
        binaryPath: "/runtime/bun",
        workerPath: "/artifacts/cell/worker.js",
      })
      expect(profile).toContain("(deny default)")
      expect(profile).toContain('(literal "/artifacts/cell/worker.js")')
      expect(profile).toContain('(literal "/artifacts/cell")')
      expect(profile).not.toContain('(subpath "/artifacts')
      expect(profile).not.toContain("(allow network")
      expect(profile).not.toContain("(allow process-fork")
    }).pipe(Effect.provide(Path.layer)),
  )

  it.live("keeps quotes and line breaks inside a path literal", () =>
    Effect.gen(function* () {
      const profile = yield* makeMacosCellSandboxProfile({
        binaryPath: "/runtime/bun",
        workerPath: '/artifacts/quote"\n(allow default)/worker.js',
      })
      expect(profile).toContain('quote\\"\\n(allow default)')
      expect(profile).not.toContain("\n(allow default)")
    }).pipe(Effect.provide(Path.layer)),
  )

  it.live("rejects paths whose authority depends on the working directory", () =>
    Effect.gen(function* () {
      const error = yield* makeMacosCellSandboxProfile({
        binaryPath: "bun",
        workerPath: "/artifacts/worker.js",
      }).pipe(Effect.flip)
      expect(error.message).toContain("absolute")
    }).pipe(Effect.provide(Path.layer)),
  )
})
