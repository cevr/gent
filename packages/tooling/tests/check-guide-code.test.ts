import { BunServices } from "@effect/platform-bun"
import { Config, Effect, FileSystem, Path } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { describe, expect, it } from "effect-bun-test"
import { fileSet } from "../src/check-guardrails"
import { requireContextModules, steeringFiles, steeringFilesAmong } from "../src/check-guide-code"

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

  contextTest("a repo reached through a symlinked root still reads its files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "gent-guide-root-" })
      yield* fs.makeDirectory(path.join(parent, "repo"))
      yield* fs.writeFileString(path.join(parent, "repo", "AGENTS.md"), "# Agents\n")
      // macOS temp roots live under `/var`, a link to `/private/var`.
      yield* fs.symlink("repo", path.join(parent, "linked"))
      const repoRoot = path.join(parent, "linked")
      expect(yield* steeringFilesAmong(repoRoot, ["AGENTS.md"])).toEqual(["AGENTS.md"])
    }),
  )

  contextTest("the check reads the staged steering files, not an untracked one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const repoRoot = yield* fs.makeTempDirectoryScoped({ prefix: "gent-guide-root-" })
      // Git's whole environment: no hook's `GIT_INDEX_FILE`, no user config.
      const env = { PATH: yield* Config.string("PATH"), HOME: repoRoot }
      const git = (args: ReadonlyArray<string>) =>
        spawner.exitCode(ChildProcess.make("git", args, { cwd: repoRoot, env, extendEnv: false }))
      yield* fs.writeFileString(path.join(repoRoot, "AGENTS.md"), "# Agents\n")
      yield* fs.makeDirectory(path.join(repoRoot, "docs"))
      yield* fs.writeFileString(path.join(repoRoot, "docs", "draft.md"), "# Draft\n")
      expect(yield* git(["init", "-q"])).toBe(ChildProcessSpawner.ExitCode(0))
      expect(yield* git(["add", "AGENTS.md"])).toBe(ChildProcessSpawner.ExitCode(0))
      expect(yield* steeringFiles(repoRoot, fileSet(repoRoot, env))).toEqual(["AGENTS.md"])
    }),
  )
})
