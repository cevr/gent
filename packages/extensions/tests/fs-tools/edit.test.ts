import { describe, test, expect, it } from "effect-bun-test"
import { Effect, FileSystem, Option, Path } from "effect"
import { narrowR } from "../../../core/tests/helpers/effect"
import { BunServices } from "@effect/platform-bun"
import {
  detectRedaction,
  unescapeStr,
  normalizeWhitespace,
  findMatch,
  EditTool,
} from "../../src/fs-tools/edit.js"
import { testToolContext } from "@gent/core-internal/test-utils/extension-harness"
import { runToolWithCtx } from "@gent/core-internal/test-utils"
describe("detectRedaction", () => {
  test("clean replacement has no redaction", () => {
    expect(Option.isNone(detectRedaction("old code", "new code"))).toBe(true)
  })
  test("catches [REDACTED]", () => {
    const result = detectRedaction("old", "before [REDACTED] after")
    expect(Option.getOrThrow(result)).toContain("[REDACTED]")
  })
  test("catches [...omitted code]", () => {
    const result = detectRedaction("old", "before [...omitted code] after")
    expect(Option.getOrThrow(result)).toContain("[...omitted code]")
  })
  test("catches [rest of file unchanged]", () => {
    const result = detectRedaction("old", "before [rest of file unchanged] after")
    expect(Option.getOrThrow(result)).toContain("[rest of file unchanged]")
  })
  test("catches // ... existing code", () => {
    const result = detectRedaction("old", "line1\n// ... existing code\nline3")
    expect(Option.getOrThrow(result)).toContain("// ... existing code")
  })
  test("catches # ... existing code", () => {
    const result = detectRedaction("old", "line1\n# ... existing code\nline3")
    expect(Option.getOrThrow(result)).toContain("# ... existing code")
  })
  test("allows pattern when also in oldString (legitimate content)", () => {
    const content = "// ... existing code"
    expect(Option.isNone(detectRedaction(content, content))).toBe(true)
  })
})
describe("unescapeStr", () => {
  test("converts literal \\n → newline", () => {
    expect(unescapeStr("line1\\nline2")).toBe("line1\nline2")
  })
  test("converts \\t → tab", () => {
    expect(unescapeStr("col1\\tcol2")).toBe("col1\tcol2")
  })
  test("converts \\r → CR", () => {
    expect(unescapeStr("before\\rafter")).toBe("before\rafter")
  })
  test("converts \\\\\\\\ → single backslash", () => {
    // "a\\\\b" → JS string "a\\b" → after \\\\→\ replacement → "a\b"
    expect(unescapeStr("a\\\\b")).toBe("a\\b")
  })
  test("no-op on clean strings", () => {
    expect(unescapeStr("hello world")).toBe("hello world")
  })
})
describe("normalizeWhitespace", () => {
  test("strips trailing whitespace per line", () => {
    expect(normalizeWhitespace("hello   \nworld  ")).toBe("hello\nworld")
  })
  test("curly quotes → ASCII quotes", () => {
    expect(normalizeWhitespace("\u201Chello\u201D")).toBe('"hello"')
    expect(normalizeWhitespace("\u2018hi\u2019")).toBe("'hi'")
  })
  test("em-dash → hyphen, NBSP → space", () => {
    expect(normalizeWhitespace("a\u2014b")).toBe("a-b")
    expect(normalizeWhitespace("a\u00A0b")).toBe("a b")
  })
})
describe("findMatch", () => {
  test("exact match → strategy 'exact', correct index", () => {
    const content = "hello world foo bar"
    const result = findMatch(content, "world foo")
    const match = Option.getOrThrow(result)
    expect(match.strategy).toBe("exact")
    expect(match.index).toBe(6)
  })
  test("literal \\n in oldString → falls through to 'unescaped'", () => {
    const content = "line1\nline2"
    const result = findMatch(content, "line1\\nline2")
    expect(Option.getOrThrow(result).strategy).toBe("unescaped")
  })
  test("trailing whitespace diff → falls through to 'normalized'", () => {
    const content = "hello\nworld"
    const result = findMatch(content, "hello   \nworld")
    expect(Option.getOrThrow(result).strategy).toBe("normalized")
  })
  test("no match returns none", () => {
    expect(Option.isNone(findMatch("hello world", "xyz"))).toBe(true)
  })
})
// ============================================================================
// Integration — real file editing
// ============================================================================
const editLayer = BunServices.layer
const editTest = it.scopedLive.layer(editLayer)
const stubCtx = testToolContext()
describe("EditTool execution", () => {
  editTest("applies edit to a real file and reads back the result", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const filePath = path.join(dir, "test.txt")
      yield* fs.writeFileString(filePath, "hello world\ngoodbye world\n")
      const result = yield* narrowR(
        runToolWithCtx(
          EditTool,
          { path: filePath, oldString: "hello world", newString: "hi there" },
          stubCtx,
        )
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          .pipe(Effect.provide(editLayer)),
      )
      expect(result.replacements).toBe(1)
      expect(result.path).toBe(filePath)
      const content = yield* fs.readFileString(filePath)
      expect(content).toBe("hi there\ngoodbye world\n")
    }),
  )
  editTest("replaceAll replaces every occurrence", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const filePath = path.join(dir, "test.txt")
      yield* fs.writeFileString(filePath, "foo bar foo baz foo\n")
      const result = yield* narrowR(
        runToolWithCtx(
          EditTool,
          { path: filePath, oldString: "foo", newString: "qux", replaceAll: true },
          stubCtx,
        )
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          .pipe(Effect.provide(editLayer)),
      )
      expect(result.replacements).toBe(3)
      const content = yield* fs.readFileString(filePath)
      expect(content).toBe("qux bar qux baz qux\n")
    }),
  )
  editTest("fails when oldString not found", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const filePath = path.join(dir, "test.txt")
      yield* fs.writeFileString(filePath, "hello world\n")
      const exit = yield* narrowR(
        Effect.exit(
          runToolWithCtx(
            EditTool,
            { path: filePath, oldString: "not here", newString: "replaced" },
            stubCtx,
          )
            // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
            .pipe(Effect.provide(editLayer)),
        ),
      )
      expect(exit._tag).toBe("Failure")
    }),
  )
  editTest("fails on ambiguous match without replaceAll", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const filePath = path.join(dir, "test.txt")
      yield* fs.writeFileString(filePath, "foo bar foo\n")
      const exit = yield* narrowR(
        Effect.exit(
          runToolWithCtx(EditTool, { path: filePath, oldString: "foo", newString: "baz" }, stubCtx)
            // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
            .pipe(Effect.provide(editLayer)),
        ),
      )
      expect(exit._tag).toBe("Failure")
    }),
  )
  editTest("fuzzy match handles literal backslash-n in oldString", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const filePath = path.join(dir, "test.txt")
      yield* fs.writeFileString(filePath, "line1\nline2\n")
      const result = yield* narrowR(
        runToolWithCtx(
          EditTool,
          { path: filePath, oldString: "line1\\nline2", newString: "merged" },
          stubCtx,
        )
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          .pipe(Effect.provide(editLayer)),
      )
      expect(result.replacements).toBe(1)
      const content = yield* fs.readFileString(filePath)
      expect(content).toBe("merged\n")
    }),
  )
})
