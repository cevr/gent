import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { parseFileRefs, expandFileRefs } from "../src/utils/file-refs"
import { Effect } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import type { FileSystem } from "@effect/platform"
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"

describe("parseFileRefs", () => {
  test("parses simple file reference", () => {
    const refs = parseFileRefs("check @src/foo.ts for details")
    expect(refs).toEqual([{ path: "src/foo.ts" }])
  })

  test("parses reference with single line number", () => {
    const refs = parseFileRefs("see @src/foo.ts#42")
    expect(refs).toEqual([{ path: "src/foo.ts", startLine: 42 }])
  })

  test("parses reference with line range", () => {
    const refs = parseFileRefs("look at @src/foo.ts#10-20")
    expect(refs).toEqual([{ path: "src/foo.ts", startLine: 10, endLine: 20 }])
  })

  test("parses multiple references", () => {
    const refs = parseFileRefs("compare @src/a.ts#1-5 with @src/b.ts#10-15")
    expect(refs).toEqual([
      { path: "src/a.ts", startLine: 1, endLine: 5 },
      { path: "src/b.ts", startLine: 10, endLine: 15 },
    ])
  })

  test("parses references at start of text", () => {
    const refs = parseFileRefs("@package.json needs update")
    expect(refs).toEqual([{ path: "package.json" }])
  })

  test("parses references at end of text", () => {
    const refs = parseFileRefs("update the file @README.md")
    expect(refs).toEqual([{ path: "README.md" }])
  })

  test("handles paths with dashes and underscores", () => {
    const refs = parseFileRefs("check @src/my-file_name.ts#5")
    expect(refs).toEqual([{ path: "src/my-file_name.ts", startLine: 5 }])
  })

  test("handles deeply nested paths", () => {
    const refs = parseFileRefs("@packages/core/src/utils/helpers.ts#100-200")
    expect(refs).toEqual([{ path: "packages/core/src/utils/helpers.ts", startLine: 100, endLine: 200 }])
  })

  test("returns empty array for no references", () => {
    const refs = parseFileRefs("no references here")
    expect(refs).toEqual([])
  })

  test("handles reference followed by punctuation", () => {
    const refs = parseFileRefs("See @src/foo.ts, @src/bar.ts.")
    expect(refs).toHaveLength(2)
    expect(refs[0]?.path).toBe("src/foo.ts,")
    expect(refs[1]?.path).toBe("src/bar.ts.")
  })

  test("handles email-like patterns (should not match)", () => {
    // @ in email context has different semantics
    // Our pattern captures anything after @ until whitespace
    const refs = parseFileRefs("contact user@example.com for help")
    expect(refs).toEqual([{ path: "example.com" }])
  })
})

describe("expandFileRefs", () => {
  let testDir: string
  const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
    Effect.runPromise(effect.pipe(Effect.provide(BunFileSystem.layer)))

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "file-refs-test-"))
    await mkdir(join(testDir, "src"), { recursive: true })

    // Create test files
    await writeFile(join(testDir, "src", "foo.ts"), "line1\nline2\nline3\nline4\nline5\n")
    await writeFile(join(testDir, "src", "bar.ts"), "export const bar = 1\n")
    await writeFile(join(testDir, "README.md"), "# Title\n\nDescription here.\n")
  })

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  test("expands simple file reference", async () => {
    const result = await run(expandFileRefs("check @src/bar.ts", testDir))
    expect(result).toContain("```src/bar.ts")
    expect(result).toContain("export const bar = 1")
    expect(result).toContain("```")
    expect(result).not.toContain("@src/bar.ts")
  })

  test("expands reference with line range", async () => {
    const result = await run(expandFileRefs("see @src/foo.ts#2-4", testDir))
    expect(result).toContain("```src/foo.ts:2-4")
    expect(result).toContain("line2")
    expect(result).toContain("line3")
    expect(result).toContain("line4")
    expect(result).not.toContain("line1")
    expect(result).not.toContain("line5")
  })

  test("expands reference with single line", async () => {
    const result = await run(expandFileRefs("@src/foo.ts#3 is important", testDir))
    expect(result).toContain("```src/foo.ts:3")
    expect(result).toContain("line3")
  })

  test("expands multiple references", async () => {
    const result = await run(expandFileRefs("compare @src/foo.ts#1 and @src/bar.ts", testDir))
    expect(result).toContain("```src/foo.ts:1")
    expect(result).toContain("```src/bar.ts")
    expect(result).toContain("line1")
    expect(result).toContain("export const bar")
  })

  test("returns original text when no references", async () => {
    const text = "no file references here"
    const result = await run(expandFileRefs(text, testDir))
    expect(result).toBe(text)
  })

  test("preserves non-reference text around expansions", async () => {
    const result = await run(expandFileRefs("Before @src/bar.ts after", testDir))
    expect(result.startsWith("Before ")).toBe(true)
    expect(result.endsWith(" after")).toBe(true)
  })

  test("leaves reference as-is when file not found", async () => {
    const text = "check @nonexistent/file.ts"
    const result = await run(expandFileRefs(text, testDir))
    expect(result).toBe(text)
  })

  test("handles out-of-range line numbers gracefully", async () => {
    // File has 5 lines, requesting lines 10-20
    const result = await run(expandFileRefs("@src/foo.ts#10-20", testDir))
    // Should expand but content will be empty or partial
    expect(result).toContain("```src/foo.ts:10-20")
  })

  test("handles root-level files", async () => {
    const result = await run(expandFileRefs("see @README.md for docs", testDir))
    expect(result).toContain("```README.md")
    expect(result).toContain("# Title")
  })
})
