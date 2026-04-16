import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Effect } from "effect"
import * as Fs from "node:fs"
import * as Path from "node:path"
import * as Os from "node:os"
import { initialMemoryState, addSessionMemory } from "@gent/extensions/memory/state"
import {
  MemoryVaultProjection,
  projectSessionMemorySnapshot,
  projectSessionMemoryTurn,
} from "@gent/extensions/memory/projection"
import { Test as MemoryVaultTest, type MemoryFrontmatter } from "@gent/extensions/memory/vault"
import type { ProjectionTurnContext, ProjectionUiContext } from "@gent/core/domain/projection"
import { SessionId, BranchId } from "@gent/core/domain/ids"

let tmpDir: string

beforeEach(() => {
  tmpDir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "gent-memproj-test-"))
})

afterEach(() => {
  Fs.rmSync(tmpDir, { recursive: true, force: true })
})

const makeFm = (scope: "global" | "project" = "global"): MemoryFrontmatter => ({
  scope,
  tags: [],
  created: "2026-01-01T00:00:00Z",
  updated: "2026-01-01T00:00:00Z",
  source: "agent",
})

const writeFile = (rel: string, body: string, scope: "global" | "project" = "global") => {
  const full = Path.join(tmpDir, rel)
  Fs.mkdirSync(Path.dirname(full), { recursive: true })
  const fm = makeFm(scope)
  const fmText = [
    "---",
    `scope: ${fm.scope}`,
    `tags: []`,
    `created: ${fm.created}`,
    `updated: ${fm.updated}`,
    `source: ${fm.source}`,
    "---",
    "",
    body,
  ].join("\n")
  Fs.writeFileSync(full, fmText, "utf-8")
}

const sid = SessionId.of("019d97c0-0000-7000-0000-000000000000")
const bid = BranchId.of("019d97c0-0000-7001-0000-000000000000")

const turnCtx = (cwd: string): ProjectionTurnContext =>
  ({
    sessionId: sid,
    branchId: bid,
    cwd,
    home: tmpDir,
    // turn is required by the type but unused by MemoryVaultProjection.query
    turn: {} as never,
  }) as ProjectionTurnContext

const uiCtx = (cwd: string): ProjectionUiContext => ({
  sessionId: sid,
  branchId: bid,
  cwd,
  home: tmpDir,
})

describe("MemoryVaultProjection", () => {
  test("empty vault produces no prompt section", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const value = yield* MemoryVaultProjection.query(turnCtx("/no/such/repo"))
        const prompt = MemoryVaultProjection.prompt?.(value, turnCtx("/no/such/repo")) ?? []
        return prompt
      }).pipe(Effect.provide(MemoryVaultTest(tmpDir))),
    )
    expect(result).toEqual([])
  })

  test("global vault entries produce a prompt section", async () => {
    writeFile("global/pattern-a.md", "# Pattern A\n\nFirst pattern.")
    writeFile("global/pattern-b.md", "# Pattern B\n\nSecond pattern.")

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const value = yield* MemoryVaultProjection.query(turnCtx("/no/such/repo"))
        return MemoryVaultProjection.prompt?.(value, turnCtx("/no/such/repo")) ?? []
      }).pipe(Effect.provide(MemoryVaultTest(tmpDir))),
    )
    expect(result.length).toBe(1)
    expect(result[0]!.content).toContain("Pattern A")
    expect(result[0]!.content).toContain("Pattern B")
    expect(result[0]!.content).toContain("memory_recall")
  })

  test("project entries appear under project heading when cwd resolves to a project key", async () => {
    // projectKey("/test-repo") yields "test-repo-<hash>"
    // Compute the expected key + write a file under that path
    const { projectKey: pk } = await import("@gent/extensions/memory/vault")
    const key = pk("/test-repo")
    writeFile(`project/${key}/gotcha.md`, "# SQLite Gotcha\n\nWatch out.", "project")

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const value = yield* MemoryVaultProjection.query(turnCtx("/test-repo"))
        return MemoryVaultProjection.prompt?.(value, turnCtx("/test-repo")) ?? []
      }).pipe(Effect.provide(MemoryVaultTest(tmpDir))),
    )
    expect(result.length).toBe(1)
    expect(result[0]!.content).toContain("Project:")
    expect(result[0]!.content).toContain("SQLite Gotcha")
  })

  test("ui projector returns counts and entries", async () => {
    writeFile("global/g.md", "# Global\n\nGlobal entry.")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const value = yield* MemoryVaultProjection.query(uiCtx("/no/such/repo"))
        return MemoryVaultProjection.ui?.project(value, uiCtx("/no/such/repo"))
      }).pipe(Effect.provide(MemoryVaultTest(tmpDir))),
    )
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const ui = result as { vaultCount: number; entries: ReadonlyArray<{ title: string }> }
    expect(ui.vaultCount).toBe(1)
    expect(ui.entries.length).toBe(1)
    expect(ui.entries[0]!.title).toBe("Global")
  })
})

describe("MemoryVaultProjection — read-only and scoped", () => {
  test("query does not create vault directories (read-only contract)", async () => {
    // Vault with no global/ or project/ subdirs at all
    expect(Fs.existsSync(Path.join(tmpDir, "global"))).toBe(false)
    expect(Fs.existsSync(Path.join(tmpDir, "project"))).toBe(false)

    await Effect.runPromise(
      Effect.gen(function* () {
        const value = yield* MemoryVaultProjection.query(turnCtx("/some/repo"))
        expect(value.entries).toEqual([])
      }).pipe(Effect.provide(MemoryVaultTest(tmpDir))),
    )

    // Projection must not have created the dirs as a side-effect
    expect(Fs.existsSync(Path.join(tmpDir, "global"))).toBe(false)
    expect(Fs.existsSync(Path.join(tmpDir, "project"))).toBe(false)
  })

  test("project list is scoped to active project — unrelated projects do not leak in", async () => {
    const { projectKey: pk } = await import("@gent/extensions/memory/vault")
    const activeKey = pk("/active-repo")
    const otherKey = pk("/other-repo")
    writeFile(`project/${activeKey}/active.md`, "# Active\n\nMine.", "project")
    writeFile(`project/${otherKey}/other.md`, "# Other\n\nNot mine.", "project")
    writeFile("global/g.md", "# G\n\nGlobal entry.")

    const value = await Effect.runPromise(
      MemoryVaultProjection.query(turnCtx("/active-repo")).pipe(
        Effect.provide(MemoryVaultTest(tmpDir)),
      ),
    )
    const titles = value.entries.map((e) => e.title).sort()
    expect(titles).toEqual(["Active", "G"])
    expect(titles).not.toContain("Other")
  })
})

describe("session-memory projection helpers", () => {
  test("empty session produces no prompt section", () => {
    const result = projectSessionMemoryTurn(initialMemoryState)
    expect(result.promptSections ?? []).toEqual([])
  })

  test("session memories appear in prompt", () => {
    const state = addSessionMemory(initialMemoryState, {
      title: "API Style",
      content: "Use snake_case for all API endpoints",
      tags: [],
      created: "2026-01-01T00:00:00Z",
    })
    const result = projectSessionMemoryTurn(state)
    const sections = result.promptSections ?? []
    expect(sections.length).toBe(1)
    expect(sections[0]!.content).toContain("API Style")
    expect(sections[0]!.content).toContain("memory_recall")
  })

  test("snapshot returns counts and session entries", () => {
    const state = addSessionMemory(initialMemoryState, {
      title: "Session Note",
      content: "Quick note",
      tags: [],
      created: "2026-01-01T00:00:00Z",
    })
    const ui = projectSessionMemorySnapshot(state)
    expect(ui.sessionCount).toBe(1)
    expect(ui.entries.length).toBe(1)
    expect(ui.entries[0]!.title).toBe("Session Note")
  })
})
