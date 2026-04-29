import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import * as Fs from "node:fs"
import * as Path from "node:path"
import { projectMemoryVaultTurn } from "@gent/extensions/memory/projection"
import {
  Test as MemoryVaultTest,
  projectKey,
  type MemoryFrontmatter,
} from "@gent/extensions/memory/vault"
import type { ProjectionTurnContext } from "@gent/core/extensions/api"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { makeScopedTempDir } from "../helpers/scoped-temp-dir"

const projectionTest = it.scopedLive.layer(BunFileSystem.layer)

const makeFm = (scope: "global" | "project" = "global"): MemoryFrontmatter => ({
  scope,
  tags: [],
  created: "2026-01-01T00:00:00Z",
  updated: "2026-01-01T00:00:00Z",
  source: "agent",
})
const writeFile = (
  tmpDir: string,
  rel: string,
  body: string,
  scope: "global" | "project" = "global",
) => {
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
const turnCtx = (cwd: string, home: string): ProjectionTurnContext =>
  ({
    sessionId: sid,
    branchId: bid,
    cwd,
    home,
    // turn is required by the type but unused by the memory turn projection
    turn: {} as never,
  }) as ProjectionTurnContext
describe("memory vault turn projection", () => {
  projectionTest("empty vault produces no prompt section", () =>
    Effect.gen(function* () {
      const tmpDir = yield* makeScopedTempDir
      const result = yield* Effect.gen(function* () {
        return yield* projectMemoryVaultTurn(turnCtx("/no/such/repo", tmpDir))
      }).pipe(Effect.provide(MemoryVaultTest(tmpDir)))
      expect(result).toEqual({})
    }),
  )
  projectionTest("global vault entries produce a prompt section", () =>
    Effect.gen(function* () {
      const tmpDir = yield* makeScopedTempDir
      writeFile(tmpDir, "global/pattern-a.md", "# Pattern A\n\nFirst pattern.")
      writeFile(tmpDir, "global/pattern-b.md", "# Pattern B\n\nSecond pattern.")
      const result = yield* Effect.gen(function* () {
        return yield* projectMemoryVaultTurn(turnCtx("/no/such/repo", tmpDir))
      }).pipe(Effect.provide(MemoryVaultTest(tmpDir)))
      expect(result.promptSections?.length).toBe(1)
      expect(result.promptSections?.[0]!.content).toContain("Pattern A")
      expect(result.promptSections?.[0]!.content).toContain("Pattern B")
      expect(result.promptSections?.[0]!.content).toContain("memory_recall")
    }),
  )
  projectionTest(
    "project entries appear under project heading when cwd resolves to a project key",
    () =>
      Effect.gen(function* () {
        const tmpDir = yield* makeScopedTempDir
        // projectKey("/test-repo") yields "test-repo-<hash>"
        // Compute the expected key + write a file under that path
        const key = projectKey("/test-repo")
        writeFile(tmpDir, `project/${key}/gotcha.md`, "# SQLite Gotcha\n\nWatch out.", "project")
        const result = yield* Effect.gen(function* () {
          return yield* projectMemoryVaultTurn(turnCtx("/test-repo", tmpDir))
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
  projectionTest("query does not create vault directories (read-only contract)", () =>
    Effect.gen(function* () {
      const tmpDir = yield* makeScopedTempDir
      // Vault with no global/ or project/ subdirs at all
      expect(Fs.existsSync(Path.join(tmpDir, "global"))).toBe(false)
      expect(Fs.existsSync(Path.join(tmpDir, "project"))).toBe(false)
      yield* Effect.gen(function* () {
        const value = yield* projectMemoryVaultTurn(turnCtx("/some/repo", tmpDir))
        expect(value).toEqual({})
      }).pipe(Effect.provide(MemoryVaultTest(tmpDir)))
      // Projection must not have created the dirs as a side-effect
      expect(Fs.existsSync(Path.join(tmpDir, "global"))).toBe(false)
      expect(Fs.existsSync(Path.join(tmpDir, "project"))).toBe(false)
    }),
  )
  projectionTest(
    "project list is scoped to active project — unrelated projects do not leak in",
    () =>
      Effect.gen(function* () {
        const tmpDir = yield* makeScopedTempDir
        const activeKey = projectKey("/active-repo")
        const otherKey = projectKey("/other-repo")
        writeFile(tmpDir, `project/${activeKey}/active.md`, "# Active\n\nMine.", "project")
        writeFile(tmpDir, `project/${otherKey}/other.md`, "# Other\n\nNot mine.", "project")
        writeFile(tmpDir, "global/g.md", "# G\n\nGlobal entry.")
        const value = yield* Effect.gen(function* () {
          return yield* projectMemoryVaultTurn(turnCtx("/active-repo", tmpDir))
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
