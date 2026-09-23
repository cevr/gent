import { describe, expect, test } from "effect-bun-test"
import { Option, Schema } from "effect"
import { OutputCut } from "@gent/core/protocol"
import {
  bashOutputRows,
  countDiffLines,
  getEditUnifiedDiff,
  getFiletype,
} from "../src/tool-renderers"

// ── edit utils ──────────────────────────────────────────────────────────────

describe("getFiletype", () => {
  test("maps common extensions", () => {
    expect(getFiletype("foo.ts")).toBe("typescript")
    expect(getFiletype("bar.tsx")).toBe("tsx")
    expect(getFiletype("baz.js")).toBe("javascript")
    expect(getFiletype("qux.jsx")).toBe("jsx")
    expect(getFiletype("script.py")).toBe("python")
    expect(getFiletype("main.rs")).toBe("rust")
    expect(getFiletype("main.go")).toBe("go")
    expect(getFiletype("README.md")).toBe("markdown")
    expect(getFiletype("config.json")).toBe("json")
    expect(getFiletype("config.yaml")).toBe("yaml")
    expect(getFiletype("config.yml")).toBe("yaml")
    expect(getFiletype("Cargo.toml")).toBe("toml")
  })

  test("handles case insensitivity", () => {
    expect(getFiletype("foo.TS")).toBe("typescript")
    expect(getFiletype("bar.JSON")).toBe("json")
  })

  test("returns undefined for unknown extensions", () => {
    expect(Option.isNone(Option.fromUndefinedOr(getFiletype("foo.xyz")))).toBe(true)
    expect(Option.isNone(Option.fromUndefinedOr(getFiletype("foo.cpp")))).toBe(true)
  })

  test("handles paths with multiple dots", () => {
    expect(getFiletype("/path/to/file.test.ts")).toBe("typescript")
    expect(getFiletype("foo.bar.baz.json")).toBe("json")
  })

  test("handles paths without extension", () => {
    expect(Option.isNone(Option.fromUndefinedOr(getFiletype("Makefile")))).toBe(true)
    expect(Option.isNone(Option.fromUndefinedOr(getFiletype("/bin/bash")))).toBe(true)
  })
})

describe("countDiffLines", () => {
  test("counts lines added", () => {
    const oldStr = "line1\nline2"
    const newStr = "line1\nline2\nline3\nline4"
    const result = countDiffLines(oldStr, newStr)
    expect(result).toEqual({ added: 2, removed: 0 })
  })

  test("counts lines removed", () => {
    const oldStr = "line1\nline2\nline3"
    const newStr = "line1"
    const result = countDiffLines(oldStr, newStr)
    expect(result).toEqual({ added: 0, removed: 2 })
  })

  test("counts changed lines when same count", () => {
    const oldStr = "aaa\nbbb\nccc"
    const newStr = "aaa\nXXX\nccc"
    const result = countDiffLines(oldStr, newStr)
    expect(result).toEqual({ added: 1, removed: 1 })
  })

  test("handles empty strings", () => {
    expect(countDiffLines("", "line1")).toEqual({ added: 1, removed: 0 })
    expect(countDiffLines("line1", "")).toEqual({ added: 0, removed: 1 })
    expect(countDiffLines("", "")).toEqual({ added: 0, removed: 0 })
  })

  test("a final newline ends the last line, it does not start one", () => {
    expect(countDiffLines("a\nb\n", "")).toEqual({ added: 0, removed: 2 })
    expect(countDiffLines("", "a\nb\nc\n")).toEqual({ added: 3, removed: 0 })
  })

  test("handles identical strings", () => {
    const str = "line1\nline2"
    const result = countDiffLines(str, str)
    expect(result).toEqual({ added: 0, removed: 0 })
  })

  test("handles single line changes", () => {
    expect(countDiffLines("old", "new")).toEqual({ added: 1, removed: 1 })
  })
})

describe("getEditUnifiedDiff", () => {
  test("generates diff from valid input with oldString/newString", () => {
    const input = {
      path: "/foo/bar.ts",
      oldString: "const x = 1",
      newString: "const x = 2",
    }
    const result = getEditUnifiedDiff(input)

    expect(result).not.toBeNull()
    expect(result!.filetype).toBe("typescript")
    expect(result!.diff).toContain("---")
    expect(result!.diff).toContain("+++")
    expect(result!.added).toBe(1)
    expect(result!.removed).toBe(1)
  })

  test("supports old_string/new_string snake_case", () => {
    const input = {
      path: "/foo/bar.py",
      old_string: "x = 1",
      new_string: "x = 2",
    }
    const result = getEditUnifiedDiff(input)

    expect(result).not.toBeNull()
    expect(result!.filetype).toBe("python")
  })

  test("returns null for null input", () => {
    const absentInput = Option.getOrNull(Option.none())
    expect(Option.isNone(Option.fromNullishOr(getEditUnifiedDiff(absentInput)))).toBe(true)
  })

  test("returns null for non-object input", () => {
    expect(getEditUnifiedDiff("string")).toBeNull()
    expect(getEditUnifiedDiff(123)).toBeNull()
  })

  test("returns null when path missing", () => {
    const input = { oldString: "a", newString: "b" }
    expect(getEditUnifiedDiff(input)).toBeNull()
  })

  test("returns null when oldString missing", () => {
    const input = { path: "/foo.ts", newString: "b" }
    expect(getEditUnifiedDiff(input)).toBeNull()
  })

  test("returns null when newString missing", () => {
    const input = { path: "/foo.ts", oldString: "a" }
    expect(getEditUnifiedDiff(input)).toBeNull()
  })

  test("returns null when values are wrong type", () => {
    expect(getEditUnifiedDiff({ path: 123, oldString: "a", newString: "b" })).toBeNull()
    expect(getEditUnifiedDiff({ path: "/foo", oldString: 123, newString: "b" })).toBeNull()
    expect(getEditUnifiedDiff({ path: "/foo", oldString: "a", newString: 123 })).toBeNull()
  })

  test("counts multi-line additions correctly", () => {
    const input = {
      path: "/foo.ts",
      oldString: "line1",
      newString: "line1\nline2\nline3",
    }
    const result = getEditUnifiedDiff(input)

    expect(result!.added).toBe(2)
    expect(result!.removed).toBe(0)
  })

  test("counts multi-line removals correctly", () => {
    const input = {
      path: "/foo.ts",
      oldString: "line1\nline2\nline3",
      newString: "line1",
    }
    const result = getEditUnifiedDiff(input)

    expect(result!.added).toBe(0)
    expect(result!.removed).toBe(2)
  })

  test("generates valid unified diff format", () => {
    const input = {
      path: "/foo/bar.ts",
      oldString: "const x = 1\n",
      newString: "const x = 2\n",
    }
    const result = getEditUnifiedDiff(input)

    // Verify unified diff structure
    expect(result!.diff).toContain("--- /foo/bar.ts")
    expect(result!.diff).toContain("+++ /foo/bar.ts")
    expect(result!.diff).toContain("-const x = 1")
    expect(result!.diff).toContain("+const x = 2")
  })
})

// ── cut bash rows ───────────────────────────────────────────────────────────

/**
 * A reloaded bash op whose stdout was cut. The record counts lines as every
 * reader does, so a final newline ends the last line and adds none; the
 * excerpt is the head, one marker line, then the tail from `tailLine`.
 */
const cutBash = (stdout: string, lines: number, tailLine: number) =>
  bashOutputRows({
    id: "cut",
    toolName: "bash",
    status: "completed",
    input: { command: "seq 1 1000" },
    summary: Option.getOrUndefined(Option.none<string>()),
    output: Schema.encodeSync(Schema.fromJsonString(Schema.Json))({
      stdout,
      stderr: "",
      exitCode: 0,
    }),
    cuts: [OutputCut.cases.Text.make({ field: "stdout", lines, tailLine, chars: 0 })],
  })

const drawn = (rows: ReturnType<typeof cutBash>["rows"]) =>
  rows.map((row) => {
    if (row._tag === "line") return `${row.lineNum}:${row.text}`
    return `+${row.count}`
  })

describe("cut bash rows", () => {
  test("an output ending in a newline counts its lines, not the empty part after them", () => {
    const rows = cutBash("1\n2\n…\n999\n1000\n", 1000, 999)
    expect(drawn(rows.rows)).toEqual(["1:1", "2:2", "+996", "999:999", "1000:1000"])
    expect(rows.total).toBe(1000)
  })

  test("a tail that keeps nothing draws the gap to the last line", () => {
    const rows = cutBash("1\n2\n…\n", 1000, 1001)
    expect(drawn(rows.rows)).toEqual(["1:1", "2:2", "+998"])
    expect(rows.total).toBe(1000)
  })

  test("a head that keeps nothing draws the gap from line 1", () => {
    const rows = cutBash("…\n999\n1000", 1000, 999)
    expect(drawn(rows.rows)).toEqual(["+998", "999:999", "1000:1000"])
    expect(rows.total).toBe(1000)
  })

  test("an emptied stdout is one gap over all its lines", () => {
    const rows = cutBash("", 2, 3)
    expect(drawn(rows.rows)).toEqual(["+2"])
    expect(rows.total).toBe(2)
  })
})
