import { describe, expect, test } from "bun:test"
import { findSteeringFilePaths, isSteeringFile } from "../src/steering-file-paths"

const TRACKED = [
  "packages/core/src/runtime/provider.ts",
  "packages/core/src/domain/tool.ts",
  "packages/core-internal/src",
  "apps/tui/tests/render-harness-boundary.tsx",
  "plans/architecture-loop-2026-09-15.md",
  "README.md",
]

const messagesOf = (text: string, file = "ARCHITECTURE.md"): ReadonlyArray<string> =>
  findSteeringFilePaths(file, text, TRACKED).map((finding) => finding.message)

const linesOf = (text: string, file = "ARCHITECTURE.md"): ReadonlyArray<number> =>
  findSteeringFilePaths(file, text, TRACKED).map((finding) => finding.line)

describe("steering file paths", () => {
  test("flags a backticked file that no tracked file matches", () => {
    const text = "- `packages/e2e/tests/transport-harness.ts` — the deleted harness"
    expect(linesOf(text)).toEqual([1])
    expect(messagesOf(text)[0]).toContain("transport-harness.ts")
  })

  test("flags a renamed file at its own line", () => {
    const text = ["# Harnesses", "", "- `apps/tui/tests/render-harness.tsx` — renamed"].join("\n")
    expect(linesOf(text)).toEqual([3])
  })

  test("allows a tracked file", () => {
    expect(messagesOf("see `packages/core/src/runtime/provider.ts`")).toEqual([])
  })

  test("allows a directory that holds a tracked file", () => {
    expect(messagesOf("the tree under `packages/core/src/` holds it")).toEqual([])
  })

  test("allows a tracked symlink written with a trailing slash", () => {
    // git lists `packages/core-internal/src` as one blob and nothing beneath it.
    expect(messagesOf("relative imports inside `packages/core-internal/src/`")).toEqual([])
  })

  test("skips a brace expansion and a glob", () => {
    const text = [
      "- `packages/core/src/domain/capability/{tool,request}.ts`",
      "- `packages/core/src/**/*.test.ts`",
    ].join("\n")
    expect(messagesOf(text)).toEqual([])
  })

  test("skips a placeholder in angle brackets", () => {
    expect(messagesOf("write `plans/<name>.md` for the ledger")).toEqual([])
  })

  test("skips text inside a fenced block", () => {
    const text = [
      "```bash",
      "bun run --cwd apps/tui dev",
      "`packages/gone/src/missing.ts`",
      "```",
      "- `packages/gone/src/missing.ts` in prose",
    ].join("\n")
    expect(linesOf(text)).toEqual([5])
  })

  test("skips a command fragment carrying a shell character", () => {
    const text = "run `bun packages/gone/check.ts` and `packages/gone:build`"
    expect(messagesOf(text)).toEqual([])
  })

  test("ignores a path outside the five source roots", () => {
    expect(messagesOf("see `docs/gone.md` and `scripts/gone.ts`")).toEqual([])
  })

  test("reads a path only when it sits in backticks", () => {
    expect(messagesOf("packages/gone/src/missing.ts is named without backticks")).toEqual([])
  })

  test("checks each of the four steering files and nothing else", () => {
    const text = "- `packages/gone/src/missing.ts`"
    for (const file of ["CLAUDE.md", "AGENTS.md", "apps/tui/AGENTS.md", "ARCHITECTURE.md"]) {
      expect(isSteeringFile(file)).toBe(true)
      expect(messagesOf(text, file)).toHaveLength(1)
    }
    expect(isSteeringFile("plans/some-plan.md")).toBe(false)
    expect(messagesOf(text, "plans/some-plan.md")).toEqual([])
  })
})
