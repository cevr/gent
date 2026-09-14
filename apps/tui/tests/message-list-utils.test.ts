import { describe, test, expect } from "bun:test"
import { Option } from "effect"
import {
  formatThinkTime,
  truncatePath,
  getSpinnerFrames,
  formatToolInput,
  describeCellCode,
  formatActivityHeader,
  formatCellRowLabel,
  formatCompactionLabel,
  formatPreviewFooter,
  formatRowCounts,
  formatAge,
  formatDuration,
  formatGroupDuration,
  workingIconFrame,
  previewOutput,
  TOOL_SPINNERS,
  type ActivityCall,
} from "../src/components/message-list-utils.js"

const absent = Option.getOrUndefined(Option.none())
const nullValue = Option.getOrNull(Option.none())

describe("formatThinkTime", () => {
  test("formats seconds under 60", () => {
    expect(formatThinkTime(0)).toBe("0s")
    expect(formatThinkTime(1)).toBe("1s")
    expect(formatThinkTime(30)).toBe("30s")
    expect(formatThinkTime(59)).toBe("59s")
  })

  test("formats minutes and seconds", () => {
    expect(formatThinkTime(60)).toBe("1m 0s")
    expect(formatThinkTime(61)).toBe("1m 1s")
    expect(formatThinkTime(90)).toBe("1m 30s")
    expect(formatThinkTime(125)).toBe("2m 5s")
  })

  test("handles larger values", () => {
    expect(formatThinkTime(3600)).toBe("60m 0s")
    expect(formatThinkTime(3661)).toBe("61m 1s")
  })
})

describe("truncatePath", () => {
  test("returns short paths unchanged", () => {
    expect(truncatePath("/foo/bar.ts")).toBe("/foo/bar.ts")
    expect(truncatePath("file.ts")).toBe("file.ts")
  })

  test("truncates from start keeping filename", () => {
    const longPath = "/Users/cvr/Developer/personal/gent/apps/tui/src/app.tsx"
    const result = truncatePath(longPath, 25)
    expect(result.startsWith("…/")).toBe(true)
    expect(result.endsWith("app.tsx")).toBe(true)
    expect(result.length).toBeLessThanOrEqual(27) // +2 for "…/"
  })

  test("keeps as many path components as fit", () => {
    const path = "/a/b/c/d/e/file.ts"
    const result = truncatePath(path, 15)
    // Algorithm keeps adding components until exceeding maxLen
    // "file.ts" (7) + "/e" (9) + "/d" (11) + "/c" (13) + "…/" prefix = 15 fits
    expect(result).toBe("…/c/d/e/file.ts")
  })

  test("handles custom maxLen", () => {
    const path = "/very/long/path/to/some/file.ts"
    const result20 = truncatePath(path, 20)
    const result30 = truncatePath(path, 30)
    expect(result20.length).toBeLessThanOrEqual(22)
    expect(result30.length).toBeLessThanOrEqual(32)
  })

  test("handles paths equal to maxLen", () => {
    const path = "/foo/bar/baz.ts"
    expect(truncatePath(path, path.length)).toBe(path)
    expect(truncatePath(path, path.length - 1).startsWith("…/")).toBe(true)
  })

  test("handles just filename", () => {
    expect(truncatePath("file.ts", 5)).toBe("…/file.ts")
  })
})

describe("getSpinnerFrames", () => {
  test("returns read spinner for read tool", () => {
    expect(getSpinnerFrames("read")).toBe(TOOL_SPINNERS["read"]!)
    expect(getSpinnerFrames("Read")).toBe(TOOL_SPINNERS["read"]!) // case insensitive
    expect(getSpinnerFrames("READ")).toBe(TOOL_SPINNERS["read"]!)
  })

  test("returns correct spinners for file tools", () => {
    expect(getSpinnerFrames("glob")).toBe(TOOL_SPINNERS["glob"]!)
    expect(getSpinnerFrames("grep")).toBe(TOOL_SPINNERS["grep"]!)
  })

  test("returns typing spinner for edit tools", () => {
    expect(getSpinnerFrames("write")).toBe(TOOL_SPINNERS["write"]!)
    expect(getSpinnerFrames("edit")).toBe(TOOL_SPINNERS["edit"]!)
  })

  test("returns bash spinner for bash", () => {
    expect(getSpinnerFrames("bash")).toBe(TOOL_SPINNERS["bash"]!)
  })

  test("returns network spinner for fetch tools", () => {
    expect(getSpinnerFrames("fetch")).toBe(TOOL_SPINNERS["fetch"]!)
  })

  test("returns default spinner for unknown tools", () => {
    expect(getSpinnerFrames("unknowntool")).toBe(TOOL_SPINNERS["default"]!)
    expect(getSpinnerFrames("custom")).toBe(TOOL_SPINNERS["default"]!)
  })

  test("all spinners have fixed width 3", () => {
    for (const [, frames] of Object.entries(TOOL_SPINNERS)) {
      for (const frame of frames) {
        expect(frame.length).toBe(3)
      }
    }
  })
})

describe("formatToolInput", () => {
  test("returns empty for null/undefined input", () => {
    expect(formatToolInput("bash", nullValue)).toBe("")
    expect(formatToolInput("bash", absent)).toBe("")
  })

  test("returns empty for non-object input", () => {
    expect(formatToolInput("bash", "string")).toBe("")
    expect(formatToolInput("bash", 123)).toBe("")
  })

  test("formats bash command", () => {
    expect(formatToolInput("bash", { command: "ls -la" })).toBe("ls -la")
    expect(formatToolInput("Bash", { command: "git status" })).toBe("git status")
  })

  test("formats read path", () => {
    expect(formatToolInput("read", { path: "/foo/bar.ts" })).toBe("/foo/bar.ts")
  })

  test("formats write path", () => {
    expect(formatToolInput("write", { path: "/foo/bar.ts" })).toBe("/foo/bar.ts")
  })

  test("formats edit path", () => {
    expect(formatToolInput("edit", { path: "/foo/bar.ts" })).toBe("/foo/bar.ts")
  })

  test("truncates long paths", () => {
    const longPath = "/Users/cvr/Developer/personal/gent/apps/tui/src/app.tsx"
    const result = formatToolInput("read", { path: longPath })
    expect(result.length).toBeLessThanOrEqual(42) // 40 + "…/"
    expect(result.endsWith("app.tsx")).toBe(true)
  })

  test("formats glob pattern and path", () => {
    const result = formatToolInput("glob", { pattern: "*.ts", path: "/foo/bar" })
    expect(result).toBe("*.ts in /foo/bar")
  })

  test("formats grep pattern and path", () => {
    const result = formatToolInput("grep", { pattern: "TODO", path: "/src" })
    expect(result).toBe("/TODO/ in /src")
  })

  test("glob uses cwd fallback when no path", () => {
    const result = formatToolInput("glob", { pattern: "*.ts" }, "/custom/cwd")
    expect(result).toContain("*.ts in")
    expect(result).toContain("cwd")
  })

  test("grep uses cwd fallback when no path", () => {
    const result = formatToolInput("grep", { pattern: "error" }, "/my/project")
    expect(result).toContain("/error/ in")
  })

  test("returns empty for glob without pattern", () => {
    expect(formatToolInput("glob", { path: "/foo" })).toBe("")
  })

  test("returns empty for unknown tools", () => {
    expect(formatToolInput("custom", { anything: "value" })).toBe("")
    expect(formatToolInput("unknown", { path: "/foo" })).toBe("")
  })

  test("handles missing expected properties", () => {
    expect(formatToolInput("bash", {})).toBe("")
    expect(formatToolInput("bash", { notCommand: "foo" })).toBe("")
    expect(formatToolInput("read", {})).toBe("")
    expect(formatToolInput("read", { notPath: "foo" })).toBe("")
  })

  test("handles wrong property types", () => {
    expect(formatToolInput("bash", { command: 123 })).toBe("")
    expect(formatToolInput("read", { path: nullValue })).toBe("")
    expect(formatToolInput("glob", { pattern: {}, path: "/foo" })).toBe("")
  })

  test("formats delegate with correct fields", () => {
    expect(formatToolInput("delegate", { todo: "find the bug" })).toBe("find the bug")
  })

  test("read supports file_path field", () => {
    expect(formatToolInput("read", { file_path: "/foo/bar.ts" })).toBe("/foo/bar.ts")
  })
})

const op = (
  tool: string,
  detail = "",
  outcome: ActivityCall["operations"][number]["outcome"] = "succeeded",
) => ({
  tool,
  outcome,
  detail,
})
const cell = (
  operations: ActivityCall["operations"],
  status: ActivityCall["status"] = "completed",
): ActivityCall => ({ toolName: "cell", status, operations, code: "" })

describe("formatDuration", () => {
  test("milliseconds under a second, tenths under a minute, then minutes and seconds", () => {
    expect(formatDuration(12)).toBe("12ms")
    expect(formatDuration(999.6)).toBe("1000ms")
    expect(formatDuration(1_250)).toBe("1.3s")
    expect(formatDuration(59_940)).toBe("59.9s")
    expect(formatDuration(65_000)).toBe("1m 5s")
  })
})

describe("formatActivityHeader", () => {
  test("a cell-only turn counts cells, ops, children, and failures instead of tool calls", () => {
    expect(formatActivityHeader([cell([op("bash", "pwd"), op("read", "a.ts")])])).toBe(
      "1 cell · 2 ops",
    )
    expect(
      formatActivityHeader([
        cell([op("delegate", "compute"), op("delegate", "verify")]),
        cell([op("write", "b.ts", "failed")]),
        cell([], "error"),
      ]),
    ).toBe("3 cells · 3 ops · 2 children · 2 failed")
    expect(formatActivityHeader([cell([])])).toBe("1 cell")
  })

  test("a finished group carries the sum of its call durations", () => {
    expect(formatActivityHeader([{ ...cell([op("bash", "pwd")]), durationMs: 1_250 }])).toBe(
      "1 cell · 1 op · 1.3s",
    )
    expect(
      formatActivityHeader([
        { ...cell([]), durationMs: 800 },
        { ...cell([]), durationMs: 700 },
        cell([], "running"),
      ]),
    ).toBe("3 cells · 1.5s")
    expect(formatGroupDuration([cell([], "running")])).toBe("")
    expect(formatActivityHeader([{ ...cell([]), code: "await Bun.$`bun test`.text()" }])).toBe(
      "1 cell · $ bun test",
    )
  })

  test("a turn with direct tools keeps the tool call counts", () => {
    expect(
      formatActivityHeader([
        { toolName: "read", status: "completed", operations: [], code: "" },
        { toolName: "read", status: "completed", operations: [], code: "" },
        cell([op("bash")]),
      ]),
    ).toBe("3 tool calls · 2 read · 1 cell")
  })
})

describe("describeCellCode", () => {
  test("names host tools, shell, files, globs, and fetches in source order", () => {
    const code = `
      const files = [...new Bun.Glob("src/**/*.ts").scanSync()]
      const out = await Bun.$\`bun test --filter store | head -20\`.text()
      const a = await Bun.file("src/a.ts").text()
      const b = await Bun.file("src/b.ts").text()
      await Bun.write("out.json", JSON.stringify({ a, b }))
      const page = await fetch("https://example.com/docs/x")
      await tools.call('read', { path: "c.ts" })
      await tools.call("read", { path: "d.ts" })
      Bun.spawn(["git", "status", "--short"])
    `
    expect(describeCellCode(code)).toEqual([
      "glob src/**/*.ts",
      "$ bun test --filter",
      "read src/a.ts",
      "read src/b.ts",
      "write out.json",
      "fetch example.com",
      "read ×2",
      "$ git status --short",
    ])
  })

  test("source with no recognised verb yields nothing", () => {
    expect(describeCellCode("const x = 1 + 1")).toEqual([])
  })
})

describe("formatCellRowLabel", () => {
  const fallback = { code: "const x = 1 + 1", display: "", error: "" }

  test("names the operations a cell ran, collapsing repeats and marking failures", () => {
    const label = formatCellRowLabel(
      cell([
        op("bash", "pwd"),
        op("read", "a.ts"),
        op("read", "a.ts"),
        op("write", "b.ts", "failed"),
      ]),
      fallback,
    )
    expect(label).toBe("bash pwd · read a.ts ×2 · ✕ write b.ts")
  })

  test("a cell without operations shows its verbs, else its result, else its first code line", () => {
    expect(
      formatCellRowLabel(cell([]), {
        ...fallback,
        code: 'await Bun.$`git status`.text()\nawait Bun.file("a.ts").text()',
        display: "\n[ 1, 2 ]",
      }),
    ).toBe("$ git status · read a.ts")
    expect(formatCellRowLabel(cell([]), { ...fallback, display: "\n[ 1, 2 ]\nmore" })).toBe(
      "→ [ 1, 2 ]",
    )
    expect(formatCellRowLabel(cell([]), fallback)).toBe("const x = 1 + 1")
  })

  test("a failed cell leads with its error and long labels are cut with an ellipsis", () => {
    expect(
      formatCellRowLabel(cell([op("bash")], "error"), {
        ...fallback,
        error: "TypeError: boom\n  at cell",
      }),
    ).toBe("TypeError: boom")
    const long = formatCellRowLabel(cell([op("bash", "x".repeat(100))]), fallback, 20)
    expect(long.length).toBe(20)
    expect(long.endsWith("…")).toBe(true)
  })
})

describe("working icon and age", () => {
  test("the pulse turns every four ticks and repeats", () => {
    expect([0, 4, 8, 12, 16].map(workingIconFrame)).toEqual(["◇", "◈", "◆", "◈", "◇"])
  })

  test("age shows one unit", () => {
    expect([45_000, 12 * 60_000, 3 * 3_600_000, 2 * 86_400_000].map(formatAge)).toEqual([
      "45s",
      "12m",
      "3h",
      "2d",
    ])
  })
})

describe("progressive disclosure helpers", () => {
  test("cell rows count code in and display out; bash rows count output only", () => {
    expect(formatRowCounts("cell", { input: "a\nb\nc", output: "x\ny" })).toBe("↑ 3 ↓ 2 lines")
    expect(formatRowCounts("bash", { input: "ls", output: "" })).toBe("↓ 0 lines")
    expect(formatRowCounts("read", { input: "", output: "x" })).toBe("")
  })

  test("a preview keeps the head and names the hidden remainder", () => {
    const text = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n")
    const preview = previewOutput(text, 20)
    expect(preview.lines).toHaveLength(20)
    expect(preview.lines[0]).toBe("line 1")
    expect(preview.hidden).toBe(5)
    expect(formatPreviewFooter(preview.hidden)).toBe("… +5 lines (ctrl+o)")
    expect(previewOutput("   \n", 20)).toEqual({ lines: [], hidden: 0 })
  })

  test("a compaction label reports replaced messages and the summary token estimate", () => {
    expect(formatCompactionLabel(12, 400)).toBe("⇣ Compacted 12 messages into ~100 tokens")
    expect(formatCompactionLabel(1, 1)).toBe("⇣ Compacted 1 message into ~1 tokens")
  })
})
