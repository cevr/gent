/**
 * Memory tool tests — covers the auto-derived projectKey contract.
 *
 * The tool schema documents `project_key` as "auto-detected if omitted".
 * Without auto-fill, `memory_remember({ scope: "project" })` silently
 * falls back to global storage, where the vault projection's project
 * section never finds them. These tests lock the auto-derive contract.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import * as Fs from "node:fs"
import * as Path from "node:path"
import { MemoryRememberTool, MemoryForgetTool } from "@gent/extensions/memory/tools"
import { Test as MemoryVaultTest, projectKey as projectKeyOf } from "@gent/extensions/memory/vault"
import type { ToolContext } from "@gent/core/domain/tool"
import { BranchId, SessionId, ToolCallId } from "@gent/core/domain/ids"
import { testToolContext } from "@gent/core/test-utils/extension-harness"
import { makeScopedTempDir } from "../helpers/scoped-temp-dir"

const memoryToolTest = it.scopedLive.layer(BunFileSystem.layer)

// ToolToken.effect intentionally erases its dependency channel at the public tool boundary.
// These tests provide MemoryVaultTest(tmpDir) at every call site before narrowing to never.
const runMemoryTool = <A, E>(
  effect: Effect.Effect<A, E, unknown>,
  tmpDir: string,
): Effect.Effect<A, E, never> =>
  effect.pipe(Effect.provide(MemoryVaultTest(tmpDir))) as Effect.Effect<A, E, never>

const dieStub = (label: string) => () => Effect.die(`${label} not wired in test`)
const makeCtx = (cwd: string, home: string): ToolContext =>
  testToolContext({
    sessionId: SessionId.make("019d97c0-0000-7000-0000-000000000000"),
    branchId: BranchId.make("019d97c0-0000-7001-0000-000000000000"),
    toolCallId: ToolCallId.make("tc1"),
    cwd,
    home,
    extension: {
      request: dieStub("request"),
    },
    agent: {
      get: dieStub("get"),
      require: dieStub("require"),
      run: dieStub("run"),
      resolveDualModelPair: dieStub("resolveDualModelPair"),
    },
    session: {
      listMessages: dieStub("listMessages"),
      getSession: dieStub("getSession"),
      getDetail: dieStub("getDetail"),
      renameCurrent: dieStub("renameCurrent"),
      estimateContextPercent: dieStub("estimateContextPercent"),
      search: dieStub("search"),
      listBranches: dieStub("listBranches"),
      createBranch: dieStub("createBranch"),
      forkBranch: dieStub("forkBranch"),
      switchBranch: dieStub("switchBranch"),
      createChildSession: dieStub("createChildSession"),
      getChildSessions: dieStub("getChildSessions"),
      getSessionAncestors: dieStub("getSessionAncestors"),
      deleteSession: dieStub("deleteSession"),
      deleteBranch: dieStub("deleteBranch"),
      deleteMessages: dieStub("deleteMessages"),
      queueFollowUp: dieStub("queueFollowUp"),
    },
    interaction: {
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
      const expectedKey = projectKeyOf(cwd)
      yield* runMemoryTool(
        MemoryRememberTool.effect(
          {
            title: "Auto Key",
            content: "should land in project dir",
            scope: "project",
          },
          makeCtx(cwd, tmpDir),
        ),
        tmpDir,
      )
      const expectedPath = Path.join(tmpDir, "project", expectedKey, "auto-key.md")
      expect(Fs.existsSync(expectedPath)).toBe(true)
      const content = Fs.readFileSync(expectedPath, "utf-8")
      expect(content).toContain("Auto Key")
      expect(content).toContain("should land in project dir")
    }),
  )
  memoryToolTest("project scope with explicit project_key honors the param", () =>
    Effect.gen(function* () {
      const tmpDir = yield* makeScopedTempDir
      yield* runMemoryTool(
        MemoryRememberTool.effect(
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
      expect(
        Fs.existsSync(Path.join(tmpDir, "project", "explicit-1234ab", "explicit-key.md")),
      ).toBe(true)
    }),
  )
  memoryToolTest("global scope ignores cwd and writes to global/", () =>
    Effect.gen(function* () {
      const tmpDir = yield* makeScopedTempDir
      yield* runMemoryTool(
        MemoryRememberTool.effect(
          {
            title: "Global Note",
            content: "no project key needed",
            scope: "global",
          },
          makeCtx("/any/repo", tmpDir),
        ),
        tmpDir,
      )
      expect(Fs.existsSync(Path.join(tmpDir, "global", "global-note.md"))).toBe(true)
    }),
  )
})
describe("MemoryForgetTool — auto-derived projectKey", () => {
  memoryToolTest("project scope without project_key removes from derived key dir", () =>
    Effect.gen(function* () {
      const tmpDir = yield* makeScopedTempDir
      const cwd = "/yet/another/repo"
      const key = projectKeyOf(cwd)
      // Pre-create file under derived key
      const dir = Path.join(tmpDir, "project", key)
      Fs.mkdirSync(dir, { recursive: true })
      const file = Path.join(dir, "to-remove.md")
      Fs.writeFileSync(
        file,
        "---\nscope: project\ntags: []\ncreated: 2026\nupdated: 2026\nsource: agent\n---\n\n# To Remove\n\nbye.",
      )
      expect(Fs.existsSync(file)).toBe(true)
      yield* runMemoryTool(
        MemoryForgetTool.effect({ title: "To Remove", scope: "project" }, makeCtx(cwd, tmpDir)),
        tmpDir,
      )
      expect(Fs.existsSync(file)).toBe(false)
    }),
  )
})
