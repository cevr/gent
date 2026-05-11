/**
 * Memory tool tests — covers the auto-derived projectKey contract.
 *
 * The tool schema documents `project_key` as "auto-detected if omitted".
 * Without auto-fill, `memory_remember({ scope: "project" })` silently
 * falls back to global storage, where the vault projection's project
 * section never finds them. These tests lock the auto-derive contract.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, FileSystem, Layer, Path } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import { MemoryRememberTool, MemoryForgetTool } from "../../src/memory/tools.js"
import {
  type MemoryVault,
  Test as MemoryVaultTest,
  projectKey as projectKeyOf,
} from "../../src/memory/vault.js"
import { BranchId, SessionId, ToolCallId } from "@gent/core-internal/domain/ids"
import { BunGentPlatformLive } from "@gent/core-internal/runtime/gent-platform-bun"
import { testToolContext } from "@gent/core-internal/test-utils/extension-harness"
import { makeScopedTempDir } from "../helpers/scoped-temp-dir"
import { getToolEffect } from "@gent/core-internal/domain/capability/tool"

const memoryToolTest = it.scopedLive.layer(
  Layer.mergeAll(BunFileSystem.layer, Path.layer, BunGentPlatformLive),
)

// Tool execution intentionally keeps dependency requirements behind Gent metadata at the public tool boundary.
// These tests provide MemoryVaultTest(tmpDir) at every call site before narrowing to never.
const runMemoryTool = <A, E>(
  effect: Effect.Effect<A, E, MemoryVault>,
  tmpDir: string,
): Effect.Effect<A, E, FileSystem.FileSystem | Path.Path> =>
  effect.pipe(Effect.provide(MemoryVaultTest(tmpDir)))

const dieStub = (label: string) => () => Effect.die(`${label} not wired in test`)
const makeCtx = (cwd: string, home: string): ReturnType<typeof testToolContext> =>
  testToolContext({
    sessionId: SessionId.make("019d97c0-0000-7000-0000-000000000000"),
    branchId: BranchId.make("019d97c0-0000-7001-0000-000000000000"),
    toolCallId: ToolCallId.make("tc1"),
    cwd,
    home,
    Agent: {
      get: dieStub("get"),
      require: dieStub("require"),
      run: dieStub("run"),
      listAgents: dieStub("listAgents"),
    },
    Session: {
      listMessages: dieStub("listMessages"),
      getSession: dieStub("getSession"),
      getDetail: dieStub("getDetail"),
      renameCurrent: dieStub("renameCurrent"),
      estimateContextPercent: dieStub("estimateContextPercent"),
      search: dieStub("search"),
      listBranches: dieStub("listBranches"),
      queueFollowUp: dieStub("queueFollowUp"),
    },
    Interaction: {
      approve: dieStub("approve"),
      present: dieStub("present"),
      confirm: dieStub("confirm"),
      review: dieStub("review"),
    },
  })
describe("MemoryRememberTool — auto-derived projectKey", () => {
  memoryToolTest("project scope without project_key writes under derived key", () =>
    Effect.gen(function* () {
      const tmpDir = yield* makeScopedTempDir
      const cwd = "/some/active/repo"
      const expectedKey = yield* projectKeyOf(cwd)
      yield* runMemoryTool(
        getToolEffect(MemoryRememberTool)(
          {
            title: "Auto Key",
            content: "should land in project dir",
            scope: "project",
          },
          makeCtx(cwd, tmpDir),
        ),
        tmpDir,
      )
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const expectedPath = path.join(tmpDir, "project", expectedKey, "auto-key.md")
      expect(yield* fs.exists(expectedPath)).toBe(true)
      const content = yield* fs.readFileString(expectedPath)
      expect(content).toContain("Auto Key")
      expect(content).toContain("should land in project dir")
    }),
  )
  memoryToolTest("project scope with explicit project_key honors the param", () =>
    Effect.gen(function* () {
      const tmpDir = yield* makeScopedTempDir
      yield* runMemoryTool(
        getToolEffect(MemoryRememberTool)(
          {
            title: "Explicit Key",
            content: "uses provided key",
            scope: "project",
            project_key: "explicit-1234ab",
          },
          makeCtx("/any/cwd", tmpDir),
        ),
        tmpDir,
      )
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      expect(
        yield* fs.exists(path.join(tmpDir, "project", "explicit-1234ab", "explicit-key.md")),
      ).toBe(true)
    }),
  )
  memoryToolTest("global scope ignores cwd and writes to global/", () =>
    Effect.gen(function* () {
      const tmpDir = yield* makeScopedTempDir
      yield* runMemoryTool(
        getToolEffect(MemoryRememberTool)(
          {
            title: "Global Note",
            content: "no project key needed",
            scope: "global",
          },
          makeCtx("/any/repo", tmpDir),
        ),
        tmpDir,
      )
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      expect(yield* fs.exists(path.join(tmpDir, "global", "global-note.md"))).toBe(true)
    }),
  )
})
describe("MemoryForgetTool — auto-derived projectKey", () => {
  memoryToolTest("project scope without project_key removes from derived key dir", () =>
    Effect.gen(function* () {
      const tmpDir = yield* makeScopedTempDir
      const cwd = "/yet/another/repo"
      const key = yield* projectKeyOf(cwd)
      // Pre-create file under derived key
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = path.join(tmpDir, "project", key)
      yield* fs.makeDirectory(dir, { recursive: true })
      const file = path.join(dir, "to-remove.md")
      yield* fs.writeFileString(
        file,
        "---\nscope: project\ntags: []\ncreated: 2026\nupdated: 2026\nsource: agent\n---\n\n# To Remove\n\nbye.",
      )
      expect(yield* fs.exists(file)).toBe(true)
      yield* runMemoryTool(
        getToolEffect(MemoryForgetTool)(
          { title: "To Remove", scope: "project" },
          makeCtx(cwd, tmpDir),
        ),
        tmpDir,
      )
      expect(yield* fs.exists(file)).toBe(false)
    }),
  )
})
