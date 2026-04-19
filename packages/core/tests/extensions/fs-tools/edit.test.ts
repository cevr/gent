import { describe, test, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  detectRedaction,
  unescapeStr,
  normalizeWhitespace,
  findMatch,
  EditTool,
} from "@gent/extensions/fs-tools/edit"
import { FileLockService } from "@gent/core/domain/file-lock"
import type { ToolContext } from "@gent/core/domain/tool"

describe("detectRedaction", () => {
  test("clean replacement → undefined", () => {
    expect(detectRedaction("old code", "new code")).toBeUndefined()
  })

  test("catches [REDACTED]", () => {
    const result = detectRedaction("old", "before [REDACTED] after")
    expect(result).toContain("[REDACTED]")
  })

  test("catches [...omitted code]", () => {
    const result = detectRedaction("old", "before [...omitted code] after")
    expect(result).toContain("[...omitted code]")
  })

  test("catches [rest of file unchanged]", () => {
    const result = detectRedaction("old", "before [rest of file unchanged] after")
    expect(result).toContain("[rest of file unchanged]")
  })

  test("catches // ... existing code", () => {
    const result = detectRedaction("old", "line1\n// ... existing code\nline3")
    expect(result).toContain("// ... existing code")
  })

  test("catches # ... existing code", () => {
    const result = detectRedaction("old", "line1\n# ... existing code\nline3")
    expect(result).toContain("# ... existing code")
  })

  test("allows pattern when also in oldString (legitimate content)", () => {
    const content = "// ... existing code"
    expect(detectRedaction(content, content)).toBeUndefined()
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
    expect(result).toBeDefined()
    expect(result!.strategy).toBe("exact")
    expect(result!.index).toBe(6)
  })

  test("literal \\n in oldString → falls through to 'unescaped'", () => {
    const content = "line1\nline2"
    const result = findMatch(content, "line1\\nline2")
    expect(result).toBeDefined()
    expect(result!.strategy).toBe("unescaped")
  })

  test("trailing whitespace diff → falls through to 'normalized'", () => {
    const content = "hello\nworld"
    const result = findMatch(content, "hello   \nworld")
    expect(result).toBeDefined()
    expect(result!.strategy).toBe("normalized")
  })

  test("no match → undefined", () => {
    expect(findMatch("hello world", "xyz")).toBeUndefined()
  })
})

// ============================================================================
// Integration — real file editing
// ============================================================================

const editLayer = Layer.mergeAll(
  BunServices.layer,
  Layer.provide(FileLockService.layer, BunServices.layer),
)

const stubCtx = {} as unknown as ToolContext

describe("EditTool execution", () => {
  test("applies edit to a real file and reads back the result", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-edit-"))
    const filePath = path.join(dir, "test.txt")
    fs.writeFileSync(filePath, "hello world\ngoodbye world\n")

    try {
      const result = await Effect.runPromise(
        EditTool.effect(
          { path: filePath, oldString: "hello world", newString: "hi there" },
          stubCtx,
        ).pipe(Effect.provide(editLayer)),
      )

      expect(result.replacements).toBe(1)
      expect(result.path).toBe(filePath)

      const content = fs.readFileSync(filePath, "utf8")
      expect(content).toBe("hi there\ngoodbye world\n")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("replaceAll replaces every occurrence", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-edit-"))
    const filePath = path.join(dir, "test.txt")
    fs.writeFileSync(filePath, "foo bar foo baz foo\n")

    try {
      const result = await Effect.runPromise(
        EditTool.effect(
          { path: filePath, oldString: "foo", newString: "qux", replaceAll: true },
          stubCtx,
        ).pipe(Effect.provide(editLayer)),
      )

      expect(result.replacements).toBe(3)

      const content = fs.readFileSync(filePath, "utf8")
      expect(content).toBe("qux bar qux baz qux\n")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("fails when oldString not found", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-edit-"))
    const filePath = path.join(dir, "test.txt")
    fs.writeFileSync(filePath, "hello world\n")

    try {
      const exit = await Effect.runPromise(
        Effect.exit(
          EditTool.effect(
            { path: filePath, oldString: "not here", newString: "replaced" },
            stubCtx,
          ).pipe(Effect.provide(editLayer)),
        ),
      )

      expect(exit._tag).toBe("Failure")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("fails on ambiguous match without replaceAll", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-edit-"))
    const filePath = path.join(dir, "test.txt")
    fs.writeFileSync(filePath, "foo bar foo\n")

    try {
      const exit = await Effect.runPromise(
        Effect.exit(
          EditTool.effect({ path: filePath, oldString: "foo", newString: "baz" }, stubCtx).pipe(
            Effect.provide(editLayer),
          ),
        ),
      )

      expect(exit._tag).toBe("Failure")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("fuzzy match handles literal backslash-n in oldString", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-edit-"))
    const filePath = path.join(dir, "test.txt")
    fs.writeFileSync(filePath, "line1\nline2\n")

    try {
      const result = await Effect.runPromise(
        EditTool.effect(
          { path: filePath, oldString: "line1\\nline2", newString: "merged" },
          stubCtx,
        ).pipe(Effect.provide(editLayer)),
      )

      expect(result.replacements).toBe(1)

      const content = fs.readFileSync(filePath, "utf8")
      expect(content).toBe("merged\n")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
