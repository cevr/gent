import {
  DriverError,
  DriverFailureId,
  EventStoreError,
  NotFoundError,
  ProviderError,
  SessionRuntimeError,
  StorageError,
} from "@gent/core/test-utils"
import { describe, expect, it, test } from "effect-bun-test"
import { Effect, FileSystem, Option, Schema } from "effect"
import {
  type ActivityCall,
  ClientError,
  describeCellCode,
  expandFileRefs,
  fileUrl,
  formatActivityHeader,
  formatAge,
  formatCellRowLabel,
  formatDuration,
  formatError,
  formatGenericToolText,
  formatGroupDuration,
  formatPreviewFooter,
  formatRowCounts,
  lineCount,
  formatTokens,
  formatToolInput,
  formatUsageStats,
  isAbsPath,
  parseFileRefs,
  previewOutput,
  shortenPath,
  toolArgSummary,
  truncate,
  truncatePath,
  truncateStart,
  workingIconFrame,
} from "../src/utils"
import { BunServices } from "@effect/platform-bun"
import { ProviderAuthError } from "@gent/core/extensions/api"
import os from "node:os"

// ── context-window.test ─────────────────────────────────────────────────────

// ── Context window % computation (extracted logic) ───────────────────

type ContextPct = { pct: number; label: string; severity: "muted" | "warning" | "error" }

function computeContextPct(
  inputTokens: number,
  contextLength: Option.Option<number>,
): Option.Option<ContextPct> {
  if (inputTokens <= 0) return Option.none()
  return Option.map(contextLength, (length) => {
    const pct = Math.min(100, Math.round((inputTokens / length) * 100))
    let severity: ContextPct["severity"] = "muted"
    if (pct >= 90) severity = "error"
    else if (pct >= 70) severity = "warning"
    return { pct, label: `${formatTokens(inputTokens)} (${pct}%)`, severity }
  })
}

const absentContextPct: ContextPct = { pct: -1, label: "", severity: "muted" }
const requireContextPct = (inputTokens: number, contextLength: number): ContextPct =>
  Option.getOrElse(
    computeContextPct(inputTokens, Option.some(contextLength)),
    () => absentContextPct,
  )

describe("context window utilization", () => {
  test("0% when no tokens", () => {
    expect(Option.isNone(computeContextPct(0, Option.some(200000)))).toBe(true)
  })

  test("hidden when contextLength is absent", () => {
    expect(Option.isNone(computeContextPct(50000, Option.none()))).toBe(true)
  })

  test("50% — muted", () => {
    const result = requireContextPct(100000, 200000)
    expect(result.pct).toBe(50)
    expect(result.severity).toBe("muted")
    expect(result.label).toBe("100k (50%)")
  })

  test("70% threshold — warning", () => {
    const result = requireContextPct(140000, 200000)
    expect(result.pct).toBe(70)
    expect(result.severity).toBe("warning")
  })

  test("69% — still muted", () => {
    const result = requireContextPct(138000, 200000)
    expect(result.pct).toBe(69)
    expect(result.severity).toBe("muted")
  })

  test("90% threshold — error", () => {
    const result = requireContextPct(180000, 200000)
    expect(result.pct).toBe(90)
    expect(result.severity).toBe("error")
  })

  test("100% — clamped", () => {
    const result = requireContextPct(200000, 200000)
    expect(result.pct).toBe(100)
    expect(result.severity).toBe("error")
  })

  test("over 100% — clamped to 100", () => {
    const result = requireContextPct(250000, 200000)
    expect(result.pct).toBe(100)
  })

  test("small token count formats correctly", () => {
    const result = requireContextPct(500, 200000)
    expect(result.label).toBe("500 (0%)")
    expect(result.severity).toBe("muted")
  })

  test("large token count formats with M suffix", () => {
    const result = requireContextPct(1500000, 2000000)
    expect(result.label).toBe("1.5M (75%)")
    expect(result.severity).toBe("warning")
  })
})

// ── file-refs.test ──────────────────────────────────────────────────────────

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

describe("fileUrl", () => {
  test("converts absolute path to file:// URL", () => {
    expect(fileUrl("/Users/cvr/foo.ts")).toBe("file:///Users/cvr/foo.ts")
  })

  test("handles root path", () => {
    expect(fileUrl("/")).toBe("file:///")
  })

  test("handles path with spaces", () => {
    expect(fileUrl("/Users/cvr/my project/foo.ts")).toBe("file:///Users/cvr/my project/foo.ts")
  })
})

describe("isAbsPath", () => {
  test("/foo is absolute", () => {
    expect(isAbsPath("/foo")).toBe(true)
  })

  test("foo is not absolute", () => {
    expect(isAbsPath("foo")).toBe(false)
  })

  test("~/foo is not absolute", () => {
    expect(isAbsPath("~/foo")).toBe(false)
  })

  test("empty string is not absolute", () => {
    expect(isAbsPath("")).toBe(false)
  })

  test("./foo is not absolute", () => {
    expect(isAbsPath("./foo")).toBe(false)
  })
})

describe("expandFileRefs", () => {
  const fileRefsTest = it.scopedLive.layer(BunServices.layer)
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

// ── format-duration.test ────────────────────────────────────────────────────

describe("formatDuration", () => {
  describe("compact", () => {
    test("whole seconds under a minute", () => {
      expect(formatDuration(0, "compact")).toBe("0s")
      expect(formatDuration(1_000, "compact")).toBe("1s")
      expect(formatDuration(30_000, "compact")).toBe("30s")
      expect(formatDuration(59_999, "compact")).toBe("59s")
    })

    test("minutes and unpadded seconds", () => {
      expect(formatDuration(60_000, "compact")).toBe("1m 0s")
      expect(formatDuration(61_000, "compact")).toBe("1m 1s")
      expect(formatDuration(90_000, "compact")).toBe("1m 30s")
      expect(formatDuration(125_000, "compact")).toBe("2m 5s")
    })

    test("minutes past the hour stay minutes", () => {
      expect(formatDuration(3_600_000, "compact")).toBe("60m 0s")
      expect(formatDuration(3_661_000, "compact")).toBe("61m 1s")
    })
  })

  describe("padded", () => {
    test("whole seconds under a minute", () => {
      expect(formatDuration(0, "padded")).toBe("0s")
      expect(formatDuration(45_500, "padded")).toBe("45s")
    })

    test("minutes and two-digit seconds without a space", () => {
      expect(formatDuration(60_000, "padded")).toBe("1m00s")
      expect(formatDuration(125_000, "padded")).toBe("2m05s")
      expect(formatDuration(754_000, "padded")).toBe("12m34s")
    })
  })

  describe("precise", () => {
    test("milliseconds under a second, tenths under a minute, then minutes and seconds", () => {
      expect(formatDuration(12, "precise")).toBe("12ms")
      expect(formatDuration(999.6, "precise")).toBe("1000ms")
      expect(formatDuration(1_250, "precise")).toBe("1.3s")
      expect(formatDuration(59_940, "precise")).toBe("59.9s")
      expect(formatDuration(65_000, "precise")).toBe("1m 5s")
    })
  })
})

// ── format-error.test ───────────────────────────────────────────────────────

describe("formatError", () => {
  test("ClientError → message", () => {
    expect(formatError(ClientError("connection lost"))).toBe("connection lost")
  })

  test("StorageError → prefixed", () => {
    const err = new StorageError({ message: "disk full" })
    expect(formatError(err)).toBe("Storage: disk full")
  })

  test("SessionRuntimeError → prefixed", () => {
    const err = new SessionRuntimeError({ message: "max turns" })
    expect(formatError(err)).toBe("Runtime: max turns")
  })

  test("ProviderError → model:message", () => {
    const err = new ProviderError({ message: "rate limited", model: "gpt-4" })
    expect(formatError(err)).toBe("gpt-4: rate limited")
  })

  test("EventStoreError → prefixed", () => {
    const err = new EventStoreError({ message: "replay failed" })
    expect(formatError(err)).toBe("Events: replay failed")
  })

  test("NotFoundError → prefixed", () => {
    const err = new NotFoundError({ message: "session abc" })
    expect(formatError(err)).toBe("Not found: session abc")
  })

  test("ProviderAuthError → prefixed", () => {
    const err = new ProviderAuthError({ message: "invalid key" })
    expect(formatError(err)).toBe("Auth: invalid key")
  })

  test("DriverError → driver and reason", () => {
    const err = new DriverError({
      driver: DriverFailureId.make("openai"),
      reason: "catalog filter failed",
    })
    expect(formatError(err)).toBe("Driver openai: catalog filter failed")
  })
})

// ── format-tool.test ────────────────────────────────────────────────────────

const HOME = os.homedir()
const absent = Option.getOrUndefined(Option.none())
const nullValue = Option.getOrNull(Option.none())

describe("formatTokens", () => {
  test("small counts returned as-is", () => {
    expect(formatTokens(0)).toBe("0")
    expect(formatTokens(42)).toBe("42")
    expect(formatTokens(999)).toBe("999")
  })

  test("1k-10k shows one decimal", () => {
    expect(formatTokens(1000)).toBe("1.0k")
    expect(formatTokens(1500)).toBe("1.5k")
    expect(formatTokens(9999)).toBe("10.0k")
  })

  test("10k-1M shows rounded k", () => {
    expect(formatTokens(10000)).toBe("10k")
    expect(formatTokens(15432)).toBe("15k")
    expect(formatTokens(999499)).toBe("999k")
    expect(formatTokens(999500)).toBe("1.0M")
  })

  test(">=1M shows one decimal M", () => {
    expect(formatTokens(1000000)).toBe("1.0M")
    expect(formatTokens(1500000)).toBe("1.5M")
    expect(formatTokens(10000000)).toBe("10.0M")
  })
})

describe("formatUsageStats", () => {
  test("empty usage returns empty string", () => {
    expect(formatUsageStats({})).toBe("")
  })

  test("omits zero/undefined fields", () => {
    expect(formatUsageStats({ input: 0, output: 0, cost: 0 })).toBe("")
    expect(formatUsageStats({ input: absent })).toBe("")
  })

  test("formats all populated fields", () => {
    const result = formatUsageStats({ input: 1500, output: 500, cost: 0.0023, turns: 3 }, "gpt-5.4")
    expect(result).toBe("3 turns ↑1.5k ↓500 $0.0023 gpt-5.4")
  })

  test("singular turn", () => {
    expect(formatUsageStats({ turns: 1 })).toBe("1 turn")
  })

  test("model alone", () => {
    expect(formatUsageStats({}, "claude-opus")).toBe("claude-opus")
  })

  test("partial fields", () => {
    expect(formatUsageStats({ input: 500 })).toBe("↑500")
    expect(formatUsageStats({ cost: 0.01 })).toBe("$0.0100")
  })
})

describe("shortenPath", () => {
  test("replaces home directory with ~", () => {
    expect(shortenPath(`${HOME}/foo/bar.ts`, HOME)).toBe("~/foo/bar.ts")
  })

  test("leaves non-home paths unchanged", () => {
    expect(shortenPath("/tmp/foo.ts")).toBe("/tmp/foo.ts")
    expect(shortenPath("relative/path.ts")).toBe("relative/path.ts")
  })

  test("handles home directory exactly", () => {
    expect(shortenPath(HOME, HOME)).toBe("~")
  })
})

describe("toolArgSummary", () => {
  test("bash: first line of command", () => {
    expect(toolArgSummary("bash", { command: "ls -la" })).toBe("ls -la")
    expect(toolArgSummary("bash", { command: "echo hello\necho world" })).toBe("echo hello")
    expect(toolArgSummary("bash", { cmd: "git status" })).toBe("git status")
    expect(toolArgSummary("bash", {})).toBe("")
  })

  test("read: path with optional range", () => {
    expect(toolArgSummary("read", { file_path: "/tmp/foo.ts" })).toBe("/tmp/foo.ts")
    expect(toolArgSummary("read", { file_path: "/tmp/foo.ts", offset: 10 })).toBe("/tmp/foo.ts:10")
    expect(toolArgSummary("read", { file_path: "/tmp/foo.ts", offset: 10, limit: 20 })).toBe(
      "/tmp/foo.ts:10-29",
    )
    expect(toolArgSummary("read", { file_path: "/tmp/foo.ts", limit: 50 })).toBe("/tmp/foo.ts:1-50")
    expect(toolArgSummary("read", { path: "/tmp/bar.ts" })).toBe("/tmp/bar.ts")
    expect(toolArgSummary("read", {})).toBe("")
  })

  test("read: shortens home paths", () => {
    expect(toolArgSummary("read", { file_path: `${HOME}/src/app.ts` }, { home: HOME })).toBe(
      "~/src/app.ts",
    )
  })

  test("write: path with line count", () => {
    expect(toolArgSummary("write", { file_path: "/tmp/foo.ts", content: "a\nb\nc" })).toBe(
      "/tmp/foo.ts (3 lines)",
    )
    expect(toolArgSummary("write", { file_path: "/tmp/foo.ts", content: "single" })).toBe(
      "/tmp/foo.ts",
    )
    expect(toolArgSummary("write", { file_path: "/tmp/foo.ts" })).toBe("/tmp/foo.ts")
    expect(toolArgSummary("write", {})).toBe("")
  })

  test("edit: shortened path", () => {
    expect(toolArgSummary("edit", { file_path: `${HOME}/src/app.ts` }, { home: HOME })).toBe(
      "~/src/app.ts",
    )
    expect(toolArgSummary("edit", {})).toBe("")
  })

  test("grep: pattern and path", () => {
    expect(toolArgSummary("grep", { pattern: "TODO", path: "/src" })).toBe("/TODO/ in /src")
    expect(toolArgSummary("grep", { pattern: "err" })).toBe("/err/ in .")
    expect(toolArgSummary("grep", {})).toBe("")
  })

  test("delegate.start: todo", () => {
    expect(toolArgSummary("delegate.start", { todo: "find the bug" })).toBe("find the bug")
    expect(toolArgSummary("delegate.start", {})).toBe("")
  })

  test("delegate.start: truncates long todo text within its 40-column budget", () => {
    const longTodo = "a".repeat(60)
    const result = toolArgSummary("delegate.start", { todo: longTodo })
    expect(result).toBe(`${"a".repeat(39)}…`)
    expect(Bun.stringWidth(result)).toBe(40)
  })

  test("read_session: session id", () => {
    expect(toolArgSummary("read_session", { sessionId: "019debug1-session" })).toBe(
      "019debug1-session",
    )
  })

  test("handoff: reason", () => {
    expect(toolArgSummary("handoff", { reason: "need deeper analysis" })).toBe(
      "need deeper analysis",
    )
  })

  test("degrades gracefully on bad input types", () => {
    expect(toolArgSummary("grep", { pattern: "ok", path: {} })).toBe("/ok/ in .")
    expect(
      toolArgSummary("read", { file_path: "/tmp/f.ts", offset: "bad", limit: nullValue }),
    ).toBe("/tmp/f.ts")
    expect(toolArgSummary("bash", { command: 123 })).toBe("")
    expect(toolArgSummary("read", { file_path: nullValue })).toBe("")
  })

  test("unknown tool returns empty", () => {
    expect(toolArgSummary("unknown_tool", { anything: "value" })).toBe("")
  })
})

// ── generic-format.test ─────────────────────────────────────────────────────

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

describe("formatGenericToolText", () => {
  test("returns plain text unchanged", () => {
    expect(formatGenericToolText("plain failure")).toBe("plain failure")
  })

  test("extracts error message from json object", () => {
    expect(
      formatGenericToolText(
        encodeJson({
          error: "Tool input failed:\n - agent:\nExpected string | undefined, got null",
        }),
      ),
    ).toBe("Tool input failed:\n - agent:\nExpected string | undefined, got null")
  })

  test("combines message with details when present", () => {
    expect(
      formatGenericToolText(
        encodeJson({
          message: "Validation failed",
          details: "path is required",
        }),
      ),
    ).toBe("Validation failed\npath is required")
  })

  test("pretty prints json when no common message fields exist", () => {
    expect(formatGenericToolText(encodeJson({ files: ["a.ts", "b.ts"] }))).toBe(
      '{\n  "files": [\n    "a.ts",\n    "b.ts"\n  ]\n}',
    )
  })
})

// ── message-list-utils.test ─────────────────────────────────────────────────

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

  test("formats grep pattern and path", () => {
    const result = formatToolInput("grep", { pattern: "TODO", path: "/src" })
    expect(result).toBe("/TODO/ in /src")
  })

  test("grep uses cwd fallback when no path", () => {
    expect(formatToolInput("grep", { pattern: "error" }, "/my/project")).toBe(
      "/error/ in /my/project",
    )
  })

  test("returns empty for grep without pattern", () => {
    expect(formatToolInput("grep", { path: "/foo" })).toBe("")
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
    expect(formatToolInput("grep", { pattern: {}, path: "/foo" })).toBe("")
  })

  test("formats delegate.start with its todo", () => {
    expect(formatToolInput("delegate.start", { todo: "find the bug" })).toBe("find the bug")
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

describe("formatActivityHeader", () => {
  test("a cell-only turn counts cells, ops, children, and failures instead of tool calls", () => {
    expect(formatActivityHeader([cell([op("bash", "pwd"), op("read", "a.ts")])])).toBe(
      "1 cell · 2 ops",
    )
    expect(
      formatActivityHeader([
        cell([op("delegate.start", "compute"), op("delegate.start", "verify")]),
        cell([op("write", "b.ts", "failed")]),
        cell([], "error"),
      ]),
    ).toBe("3 cells · 3 ops · 2 children · 1 failed · 1 cell failed")
    expect(formatActivityHeader([cell([])])).toBe("1 cell")
  })

  test("a cell that failed with its op counts one failure", () => {
    // An interrupted cell: live its op is settled to failed when the cell ends,
    // and a reload projects the same op as failed.
    expect(formatActivityHeader([cell([op("bash", "git checkout", "failed")], "error")])).toBe(
      "1 cell · 1 op · 1 failed",
    )
    expect(
      formatActivityHeader([cell([op("bash", "a", "failed"), op("bash", "b", "failed")], "error")]),
    ).toBe("1 cell · 2 ops · 2 failed")
  })

  test("a cell that failed while its ops succeeded is worded apart from op failures", () => {
    // After a restart the op row shows exit 0; the header must not call it failed.
    expect(formatActivityHeader([cell([op("bash", "pwd")], "error")])).toBe(
      "1 cell · 1 op · 1 cell failed",
    )
    expect(
      formatActivityHeader([
        cell([op("bash", "a", "failed")], "error"),
        cell([op("read", "c.ts")], "error"),
        cell([], "error"),
      ]),
    ).toBe("3 cells · 2 ops · 1 failed · 2 cells failed")
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
      await tools.read({ path: "c.ts" })
      await tools.read({ path: "d.ts" })
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

  test("names host tools by their id path and skips catalog reads", () => {
    const code = `
      const spec = tools("delegate.start").parameters
      const child = await tools.delegate.start({ todo: "x" })
      await tools["must-not-run"]({})
      await tools("read.then")({})
      await tools.wake.cancel()
    `
    expect(describeCellCode(code)).toEqual([
      "delegate.start",
      "must-not-run",
      "read.then",
      "wake.cancel",
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
    expect(formatRowCounts("bash", { input: "ls", output: "x" })).toBe("↓ 1 line")
    expect(formatRowCounts("read", { input: "", output: "x" })).toBe("")
  })

  test("a final newline ends the last line and does not start one", () => {
    expect(lineCount("")).toBe(0)
    expect(lineCount("\n")).toBe(1)
    expect(lineCount("hello\n")).toBe(1)
    expect(lineCount("a\nb\n")).toBe(2)
    expect(lineCount("a\n\n")).toBe(2)
    expect(formatRowCounts("bash", { input: "ls\n", output: "hello\n" })).toBe("↓ 1 line")
    expect(formatRowCounts("cell", { input: "a\nb\n", output: "x\n" })).toBe("↑ 2 ↓ 1 lines")
  })

  test("one count of one line reads singular; two counts share the plural", () => {
    expect(formatRowCounts("bash", { input: "ls", output: "x" })).toBe("↓ 1 line")
    expect(formatRowCounts("cell", { input: "a", output: "x" })).toBe("↑ 1 ↓ 1 lines")
  })

  test("a zero count is left out, so a cell with no output shows only its code", () => {
    expect(formatRowCounts("cell", { input: "a", output: "" })).toBe("↑ 1 line")
    expect(formatRowCounts("bash", { input: "ls", output: "" })).toBe("")
    expect(formatRowCounts("cell", { input: "", output: "" })).toBe("")
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
})

// ── truncate.test ───────────────────────────────────────────────────────────

/**
 * The one column-budget truncation.
 *
 * Every caller budgets terminal columns. A name whose `.length` fits the
 * budget can still be wider than it: CJK glyphs take two columns and an emoji
 * is one grapheme of several code units. The old code-unit slice let those
 * rows overflow; the receipt for that is the `.length` line in each test.
 */

describe("truncate", () => {
  test("a CJK name whose length fits but whose width does not is cut to the column budget", () => {
    const name = "漢字漢字漢字"
    expect(name.length).toBeLessThanOrEqual(8)
    expect(Bun.stringWidth(name)).toBeGreaterThan(8)
    const result = truncate(name, 8)
    expect(result).toBe("漢字漢…")
    expect(Bun.stringWidth(result)).toBeLessThanOrEqual(8)
  })

  test("an emoji name is cut on a grapheme boundary and never splits a glyph", () => {
    const name = "👩‍💻".repeat(4)
    expect(Bun.stringWidth(name)).toBe(8)
    const result = truncate(name, 5)
    expect(result).toBe("👩‍💻👩‍💻…")
    expect(Bun.stringWidth(result)).toBe(5)
  })

  test("text that fits comes back unchanged, on one line", () => {
    expect(truncate("short", 10)).toBe("short")
    expect(truncate("two\nlines\there", 20)).toBe("two lines here")
  })

  test("a zero budget yields nothing and an ascii overflow ends in one ellipsis glyph", () => {
    expect(truncate("anything", 0)).toBe("")
    expect(truncate("abcdefghij", 6)).toBe("abcde…")
    expect(truncate("abcdefghij", 6)).not.toContain("...")
  })
})

describe("truncateStart", () => {
  test("keeps the tail of a query within the budget", () => {
    expect(truncateStart("abcdefghij", 4)).toBe("ghij")
    expect(truncateStart("漢字漢字", 3)).toBe("字")
    expect(truncateStart("fits", 10)).toBe("fits")
  })
})
