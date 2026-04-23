/**
 * Memory tool tests — covers the auto-derived projectKey contract.
 *
 * The tool schema documents `project_key` as "auto-detected if omitted".
 * Without auto-fill, `memory_remember({ scope: "project" })` silently
 * falls back to global storage, where the vault projection's project
 * section never finds them. These tests lock the auto-derive contract.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Effect } from "effect"
import * as Fs from "node:fs"
import * as Path from "node:path"
import * as Os from "node:os"
import { MemoryRememberTool, MemoryForgetTool } from "@gent/extensions/memory/tools"
import { Test as MemoryVaultTest, projectKey as projectKeyOf } from "@gent/extensions/memory/vault"
import type { ToolContext } from "@gent/core/domain/tool"
import { SessionId, BranchId, ToolCallId } from "@gent/core/domain/ids"
import { testToolContext } from "@gent/core/test-utils/extension-harness"

let tmpDir: string

beforeEach(() => {
  tmpDir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "gent-memtool-test-"))
})

afterEach(() => {
  Fs.rmSync(tmpDir, { recursive: true, force: true })
})

const dieStub = (label: string) => () => Effect.die(`${label} not wired in test`)

const makeCtx = (cwd: string): ToolContext =>
  testToolContext({
    sessionId: SessionId.of("019d97c0-0000-7000-0000-000000000000"),
    branchId: BranchId.of("019d97c0-0000-7001-0000-000000000000"),
    toolCallId: ToolCallId.of("tc1"),
    cwd,
    home: tmpDir,
    extension: {
      send: dieStub("send"),
      ask: dieStub("ask"),
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
    },
    interaction: {
      approve: dieStub("approve"),
      present: dieStub("present"),
      confirm: dieStub("confirm"),
      review: dieStub("review"),
    },
  })

describe("MemoryRememberTool — auto-derived projectKey", () => {
  test("project scope without project_key writes under derived key", async () => {
    const cwd = "/some/active/repo"
    const expectedKey = projectKeyOf(cwd)
    await Effect.runPromise(
      MemoryRememberTool.effect(
        {
          title: "Auto Key",
          content: "should land in project dir",
          scope: "project",
        },
        makeCtx(cwd),
      ).pipe(Effect.provide(MemoryVaultTest(tmpDir))),
    )
    const expectedPath = Path.join(tmpDir, "project", expectedKey, "auto-key.md")
    expect(Fs.existsSync(expectedPath)).toBe(true)
    const content = Fs.readFileSync(expectedPath, "utf-8")
    expect(content).toContain("Auto Key")
    expect(content).toContain("should land in project dir")
  })

  test("project scope with explicit project_key honors the param", async () => {
    await Effect.runPromise(
      MemoryRememberTool.effect(
        {
          title: "Explicit Key",
          content: "uses provided key",
          scope: "project",
          project_key: "explicit-1234ab",
        },
        makeCtx("/any/cwd"),
      ).pipe(Effect.provide(MemoryVaultTest(tmpDir))),
    )
    expect(Fs.existsSync(Path.join(tmpDir, "project", "explicit-1234ab", "explicit-key.md"))).toBe(
      true,
    )
  })

  test("global scope ignores cwd and writes to global/", async () => {
    await Effect.runPromise(
      MemoryRememberTool.effect(
        {
          title: "Global Note",
          content: "no project key needed",
          scope: "global",
        },
        makeCtx("/any/repo"),
      ).pipe(Effect.provide(MemoryVaultTest(tmpDir))),
    )
    expect(Fs.existsSync(Path.join(tmpDir, "global", "global-note.md"))).toBe(true)
  })
})

describe("MemoryForgetTool — auto-derived projectKey", () => {
  test("project scope without project_key removes from derived key dir", async () => {
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

    await Effect.runPromise(
      MemoryForgetTool.effect({ title: "To Remove", scope: "project" }, makeCtx(cwd)).pipe(
        Effect.provide(MemoryVaultTest(tmpDir)),
      ),
    )
    expect(Fs.existsSync(file)).toBe(false)
  })
})
