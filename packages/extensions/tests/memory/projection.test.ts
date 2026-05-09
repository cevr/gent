import { describe, expect, it } from "effect-bun-test"
import { Effect, FileSystem, Layer, Path } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import { projectMemoryVaultTurn } from "../../src/memory/projection.js"
import {
  Test as MemoryVaultTest,
  projectKey,
  type MemoryFrontmatter,
} from "../../src/memory/vault.js"
import { BranchId, SessionId } from "@gent/core-internal/domain/ids"
import { makeScopedTempDir } from "../helpers/scoped-temp-dir"
import { ExtensionContext } from "@gent/core/extensions/api"
import { testToolContext } from "@gent/core-internal/test-utils/extension-harness"

const projectionTest = it.scopedLive.layer(Layer.merge(BunFileSystem.layer, Path.layer))

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
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const full = path.join(tmpDir, rel)
    yield* fs.makeDirectory(path.dirname(full), { recursive: true })
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
    yield* fs.writeFileString(full, fmText)
  })
const sid = SessionId.make("019d97c0-0000-7000-0000-000000000000")
const bid = BranchId.make("019d97c0-0000-7001-0000-000000000000")
const withMemoryProjectionContext = (cwd: string, home: string) =>
  projectMemoryVaultTurn().pipe(
    Effect.provide(MemoryVaultTest(home)),
    Effect.provideService(
      ExtensionContext,
      testToolContext({
        sessionId: sid,
        branchId: bid,
        cwd,
        home,
        turn: {
          sessionId: sid,
          branchId: bid,
          agent: {} as never,
          allTools: [],
        },
      }),
    ),
  )
describe("memory vault turn projection", () => {
  projectionTest("empty vault produces no prompt section", () =>
    Effect.gen(function* () {
      const tmpDir = yield* makeScopedTempDir
      const result = yield* withMemoryProjectionContext("/no/such/repo", tmpDir)
      expect(result).toEqual({})
    }),
  )
  projectionTest("global vault entries produce a prompt section", () =>
    Effect.gen(function* () {
      const tmpDir = yield* makeScopedTempDir
      yield* writeFile(tmpDir, "global/pattern-a.md", "# Pattern A\n\nFirst pattern.").pipe(
        Effect.orDie,
      )
      yield* writeFile(tmpDir, "global/pattern-b.md", "# Pattern B\n\nSecond pattern.").pipe(
        Effect.orDie,
      )
      const result = yield* withMemoryProjectionContext("/no/such/repo", tmpDir)
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
        yield* writeFile(
          tmpDir,
          `project/${key}/gotcha.md`,
          "# SQLite Gotcha\n\nWatch out.",
          "project",
        ).pipe(Effect.orDie)
        const result = yield* withMemoryProjectionContext("/test-repo", tmpDir)
        expect(result.promptSections?.length).toBe(1)
        expect(result.promptSections?.[0]!.content).toContain("Project:")
        expect(result.promptSections?.[0]!.content).toContain("SQLite Gotcha")
      }),
  )
})
describe("memory vault turn projection — read-only and scoped", () => {
  projectionTest("query does not create vault directories (read-only contract)", () =>
    Effect.gen(function* () {
      const tmpDir = yield* makeScopedTempDir
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      // Vault with no global/ or project/ subdirs at all
      expect(yield* fs.exists(path.join(tmpDir, "global"))).toBe(false)
      expect(yield* fs.exists(path.join(tmpDir, "project"))).toBe(false)
      yield* withMemoryProjectionContext("/some/repo", tmpDir).pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            expect(value).toEqual({})
          }),
        ),
        Effect.provide(MemoryVaultTest(tmpDir)),
      )
      // Projection must not have created the dirs as a side-effect
      expect(yield* fs.exists(path.join(tmpDir, "global"))).toBe(false)
      expect(yield* fs.exists(path.join(tmpDir, "project"))).toBe(false)
    }),
  )
  projectionTest(
    "project list is scoped to active project — unrelated projects do not leak in",
    () =>
      Effect.gen(function* () {
        const tmpDir = yield* makeScopedTempDir
        const activeKey = projectKey("/active-repo")
        const otherKey = projectKey("/other-repo")
        yield* writeFile(
          tmpDir,
          `project/${activeKey}/active.md`,
          "# Active\n\nMine.",
          "project",
        ).pipe(Effect.orDie)
        yield* writeFile(
          tmpDir,
          `project/${otherKey}/other.md`,
          "# Other\n\nNot mine.",
          "project",
        ).pipe(Effect.orDie)
        yield* writeFile(tmpDir, "global/g.md", "# G\n\nGlobal entry.").pipe(Effect.orDie)
        const value = yield* withMemoryProjectionContext("/active-repo", tmpDir)
        const content = value.promptSections?.[0]?.content ?? ""
        expect(content).toContain("Active")
        expect(content).toContain("G")
        expect(content).not.toContain("Other")
      }),
  )
})
