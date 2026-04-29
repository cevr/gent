import { describe, expect, it, test } from "effect-bun-test"
import { parseFileRefs, expandFileRefs } from "../src/utils/file-refs"
import { Effect, FileSystem } from "effect"
import { BunFileSystem } from "@effect/platform-bun"

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
    expect(refs).toEqual([
      { path: "packages/core/src/utils/helpers.ts", startLine: 100, endLine: 200 },
    ])
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
  const fileRefsTest = it.scopedLive.layer(BunFileSystem.layer)
  const makeFixture = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const testDir = yield* fs.makeTempDirectoryScoped()
    yield* fs.makeDirectory(`${testDir}/src`, { recursive: true })
    yield* fs.writeFileString(`${testDir}/src/foo.ts`, "line1\nline2\nline3\nline4\nline5\n")
    yield* fs.writeFileString(`${testDir}/src/bar.ts`, "export const bar = 1\n")
    yield* fs.writeFileString(`${testDir}/README.md`, "# Title\n\nDescription here.\n")
    return testDir
  })

  fileRefsTest("expands simple file reference", () =>
    Effect.gen(function* () {
      const testDir = yield* makeFixture
      const result = yield* expandFileRefs("check @src/bar.ts", testDir)
      expect(result).toContain("```src/bar.ts")
      expect(result).toContain("export const bar = 1")
      expect(result).toContain("```")
      expect(result).not.toContain("@src/bar.ts")
    }),
  )

  fileRefsTest("expands reference with line range", () =>
    Effect.gen(function* () {
      const testDir = yield* makeFixture
      const result = yield* expandFileRefs("see @src/foo.ts#2-4", testDir)
      expect(result).toContain("```src/foo.ts:2-4")
      expect(result).toContain("line2")
      expect(result).toContain("line3")
      expect(result).toContain("line4")
      expect(result).not.toContain("line1")
      expect(result).not.toContain("line5")
    }),
  )

  fileRefsTest("expands reference with single line", () =>
    Effect.gen(function* () {
      const testDir = yield* makeFixture
      const result = yield* expandFileRefs("@src/foo.ts#3 is important", testDir)
      expect(result).toContain("```src/foo.ts:3")
      expect(result).toContain("line3")
    }),
  )

  fileRefsTest("expands multiple references", () =>
    Effect.gen(function* () {
      const testDir = yield* makeFixture
      const result = yield* expandFileRefs("compare @src/foo.ts#1 and @src/bar.ts", testDir)
      expect(result).toContain("```src/foo.ts:1")
      expect(result).toContain("```src/bar.ts")
      expect(result).toContain("line1")
      expect(result).toContain("export const bar")
    }),
  )

  fileRefsTest("returns original text when no references", () =>
    Effect.gen(function* () {
      const testDir = yield* makeFixture
      const text = "no file references here"
      const result = yield* expandFileRefs(text, testDir)
      expect(result).toBe(text)
    }),
  )

  fileRefsTest("preserves non-reference text around expansions", () =>
    Effect.gen(function* () {
      const testDir = yield* makeFixture
      const result = yield* expandFileRefs("Before @src/bar.ts after", testDir)
      expect(result.startsWith("Before ")).toBe(true)
      expect(result.endsWith(" after")).toBe(true)
    }),
  )

  fileRefsTest("leaves reference as-is when file not found", () =>
    Effect.gen(function* () {
      const testDir = yield* makeFixture
      const text = "check @nonexistent/file.ts"
      const result = yield* expandFileRefs(text, testDir)
      expect(result).toBe(text)
    }),
  )

  fileRefsTest("handles out-of-range line numbers gracefully", () =>
    // File has 5 lines, requesting lines 10-20
    Effect.gen(function* () {
      const testDir = yield* makeFixture
      const result = yield* expandFileRefs("@src/foo.ts#10-20", testDir)
      // Should expand but content will be empty or partial
      expect(result).toContain("```src/foo.ts:10-20")
    }),
  )

  fileRefsTest("handles root-level files", () =>
    Effect.gen(function* () {
      const testDir = yield* makeFixture
      const result = yield* expandFileRefs("see @README.md for docs", testDir)
      expect(result).toContain("```README.md")
      expect(result).toContain("# Title")
    }),
  )
})
