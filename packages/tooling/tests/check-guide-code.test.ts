import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { requireContextModules, steeringFilesAmong } from "../src/check-guide-code"

const contextTest = it.scopedLive.layer(BunServices.layer)

const extension = {
  name: "extension",
  tsconfig: "tsconfig.json",
  modules: "examples/node_modules",
}

describe("a compile context's dependencies", () => {
  contextTest("a context whose node_modules is missing fails the check by name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repoRoot = yield* fs.makeTempDirectoryScoped({ prefix: "gent-guide-root-" })
      const error = yield* Effect.flip(requireContextModules(repoRoot, extension))
      expect(error._tag).toBe("GuideCodeError")
      expect(error.message).toContain("examples/node_modules")
      expect(error.message).toContain("bun install")
    }),
  )

  contextTest("a context whose node_modules is installed compiles", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const repoRoot = yield* fs.makeTempDirectoryScoped({ prefix: "gent-guide-root-" })
      yield* fs.makeDirectory(path.join(repoRoot, "examples", "node_modules"), { recursive: true })
      yield* requireContextModules(repoRoot, extension)
    }),
  )
})

describe("the steering files the check reads", () => {
  contextTest("a listed file gone from disk is skipped, and a symlink is read once", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const repoRoot = yield* fs.makeTempDirectoryScoped({ prefix: "gent-guide-root-" })
      yield* fs.writeFileString(path.join(repoRoot, "AGENTS.md"), "# Agents\n")
      yield* fs.symlink("AGENTS.md", path.join(repoRoot, "CLAUDE.md"))
      // `docs/gone.md` is still in the index but was trashed from the worktree.
      const listed = ["AGENTS.md", "CLAUDE.md", "docs/gone.md"]
      expect(yield* steeringFilesAmong(repoRoot, listed)).toEqual(["AGENTS.md"])
    }),
  )
})
