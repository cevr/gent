import { describe, expect, it } from "effect-bun-test"
import { beforeEach, afterEach } from "bun:test"
import { Effect } from "effect"
import * as Fs from "node:fs"
import * as Path from "node:path"
import * as Os from "node:os"
import { projectMemoryVaultTurn } from "@gent/extensions/memory/projection"
import {
  Test as MemoryVaultTest,
  projectKey,
  type MemoryFrontmatter,
} from "@gent/extensions/memory/vault"
import type { ProjectionTurnContext } from "@gent/core/extensions/api"
import { BranchId, SessionId } from "@gent/core/domain/ids"
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
const sid = SessionId.make("019d97c0-0000-7000-0000-000000000000")
const bid = BranchId.make("019d97c0-0000-7001-0000-000000000000")
const turnCtx = (cwd: string): ProjectionTurnContext =>
  ({
    sessionId: sid,
    branchId: bid,
    cwd,
    home: tmpDir,
    // turn is required by the type but unused by the memory turn projection
    turn: {} as never,
  }) as ProjectionTurnContext
describe("memory vault turn projection", () => {
  it.live("empty vault produces no prompt section", () =>
    Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        return yield* projectMemoryVaultTurn(turnCtx("/no/such/repo"))
      }).pipe(Effect.provide(MemoryVaultTest(tmpDir)))
      expect(result).toEqual({})
    }),
  )
  it.live("global vault entries produce a prompt section", () =>
    Effect.gen(function* () {
      writeFile("global/pattern-a.md", "# Pattern A\n\nFirst pattern.")
      writeFile("global/pattern-b.md", "# Pattern B\n\nSecond pattern.")
      const result = yield* Effect.gen(function* () {
        return yield* projectMemoryVaultTurn(turnCtx("/no/such/repo"))
      }).pipe(Effect.provide(MemoryVaultTest(tmpDir)))
      expect(result.promptSections?.length).toBe(1)
      expect(result.promptSections?.[0]!.content).toContain("Pattern A")
      expect(result.promptSections?.[0]!.content).toContain("Pattern B")
      expect(result.promptSections?.[0]!.content).toContain("memory_recall")
    }),
  )
  it.live("project entries appear under project heading when cwd resolves to a project key", () =>
    Effect.gen(function* () {
      // projectKey("/test-repo") yields "test-repo-<hash>"
      // Compute the expected key + write a file under that path
      const key = projectKey("/test-repo")
      writeFile(`project/${key}/gotcha.md`, "# SQLite Gotcha\n\nWatch out.", "project")
      const result = yield* Effect.gen(function* () {
        return yield* projectMemoryVaultTurn(turnCtx("/test-repo"))
      }).pipe(Effect.provide(MemoryVaultTest(tmpDir)))
      expect(result.promptSections?.length).toBe(1)
      expect(result.promptSections?.[0]!.content).toContain("Project:")
      expect(result.promptSections?.[0]!.content).toContain("SQLite Gotcha")
    }),
  )
  // TODO(c2): "ui projector returns counts and entries" — removed.
  // Memory vault UI surface is gone in C2 (projection.ui no longer exists).
})
describe("memory vault turn projection — read-only and scoped", () => {
  it.live("query does not create vault directories (read-only contract)", () =>
    Effect.gen(function* () {
      // Vault with no global/ or project/ subdirs at all
      expect(Fs.existsSync(Path.join(tmpDir, "global"))).toBe(false)
      expect(Fs.existsSync(Path.join(tmpDir, "project"))).toBe(false)
      yield* Effect.gen(function* () {
        const value = yield* projectMemoryVaultTurn(turnCtx("/some/repo"))
        expect(value).toEqual({})
      }).pipe(Effect.provide(MemoryVaultTest(tmpDir)))
      // Projection must not have created the dirs as a side-effect
      expect(Fs.existsSync(Path.join(tmpDir, "global"))).toBe(false)
      expect(Fs.existsSync(Path.join(tmpDir, "project"))).toBe(false)
    }),
  )
  it.live("project list is scoped to active project — unrelated projects do not leak in", () =>
    Effect.gen(function* () {
      const activeKey = projectKey("/active-repo")
      const otherKey = projectKey("/other-repo")
      writeFile(`project/${activeKey}/active.md`, "# Active\n\nMine.", "project")
      writeFile(`project/${otherKey}/other.md`, "# Other\n\nNot mine.", "project")
      writeFile("global/g.md", "# G\n\nGlobal entry.")
      const value = yield* Effect.gen(function* () {
        return yield* projectMemoryVaultTurn(turnCtx("/active-repo"))
      }).pipe(Effect.provide(MemoryVaultTest(tmpDir)))
      const content = value.promptSections?.[0]?.content ?? ""
      expect(content).toContain("Active")
      expect(content).toContain("G")
      expect(content).not.toContain("Other")
    }),
  )
})
// TODO(c2): "session-memory projection helpers" — removed.
// `projectSessionMemoryTurn` and `projectSessionMemorySnapshot` were
// internal helpers for the deleted UI snapshot pipeline.
