import {
  DriverError,
  DriverFailureId,
  NotFoundError,
  ProviderError,
  SessionRuntimeError,
} from "@gent/core/test-utils"
import { EventStoreError, StorageError } from "@gent/core/extensions/branch-tools"
import { describe, expect, it, test } from "effect-bun-test"
import { Effect, FileSystem, Option, Schema } from "effect"
import { GentRpcError, lineCount } from "@gent/core/protocol"
import { RpcClientError } from "effect/rpc/RpcClientError"
import { SocketCloseError } from "effect/socket/Socket"
import {
  type ActivityCall,
  describeCellCode,
  expandFileRefs,
  fitWidth,
  fileUrl,
  formatActivityHeader,
  formatAge,
  formatCost,
  formatCellRowLabel,
  formatDuration,
  formatConnectionIssue,
  formatError,
  formatGenericToolText,
  formatGroupDuration,
  formatPreviewFooter,
  formatRowCounts,
  formatTokens,
  formatUsageStats,
  displayPath,
  isAbsPath,
  previewOutput,
  toolArgSummary,
  truncate,
  truncatePath,
  truncateStart,
  workingIconFrame,
} from "../src/utils"
import { BunServices } from "@effect/platform-bun"
import { ProviderAuthError } from "@gent/core/extensions/api"
import os from "node:os"

// ── file refs ───────────────────────────────────────────────────────────────

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

  // A range past the end names no line, so it stays a reference, as a missing file does.
  fileRefsTest("a range that starts past the end of the file stays a reference", () =>
    Effect.gen(function* () {
      const testDir = yield* makeFixture
      expect(yield* expandFileRefs("@src/foo.ts#10-20", testDir)).toBe("@src/foo.ts#10-20")
      expect(yield* expandFileRefs("@src/foo.ts#9", testDir)).toBe("@src/foo.ts#9")
      // A range that starts inside the file keeps the lines it reaches.
      const partial = yield* expandFileRefs("@src/foo.ts#4-20", testDir)
      expect(partial).toContain("```src/foo.ts:4-20")
      expect(partial).toContain("line5")
    }),
  )

  fileRefsTest("leaves a binary file as a reference", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const testDir = yield* makeFixture
      yield* fs.writeFile(`${testDir}/tool.bin`, new Uint8Array([0x7f, 0x45, 0x00, 0x01, 0x41]))
      const text = "run @tool.bin"
      expect(yield* expandFileRefs(text, testDir)).toBe(text)
    }),
  )

  fileRefsTest("cuts a large file at the shell-mode cap and says so", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const testDir = yield* makeFixture
      const lines = Array.from({ length: 5000 }, (_, i) => `row ${i + 1}`)
      yield* fs.writeFileString(`${testDir}/big.log`, lines.join("\n"))
      const result = yield* expandFileRefs("see @big.log", testDir)
      expect(result).toContain("row 2000\n")
      expect(result).not.toContain("row 2001")
      expect(result).toContain(
        "[big.log cut at 2000 lines of 5000; read the rest with the read tool]",
      )
    }),
  )

  fileRefsTest("a file of exactly the cap's lines is whole, with no cut note", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const testDir = yield* makeFixture
      const lines = Array.from({ length: 2000 }, (_, i) => `row ${i + 1}`)
      yield* fs.writeFileString(`${testDir}/exact.txt`, `${lines.join("\n")}\n`)
      const result = yield* expandFileRefs("see @exact.txt", testDir)
      expect(result).toContain("row 2000\n")
      expect(result).not.toContain("cut at")
    }),
  )

  fileRefsTest("the byte cap counts UTF-8 bytes, not UTF-16 units", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const testDir = yield* makeFixture
      // 20 lines of 1,000 three-byte characters: 60 KB of UTF-8, 20,000 units.
      const lines = Array.from({ length: 20 }, () => "\u20ac".repeat(1000))
      yield* fs.writeFileString(`${testDir}/euro.txt`, lines.join("\n"))
      const result = yield* expandFileRefs("see @euro.txt", testDir)
      expect(result).toContain("[euro.txt cut at 17 lines of 20;")
    }),
  )

  fileRefsTest("a quoted reference expands a path with a space or a hash", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const testDir = yield* makeFixture
      yield* fs.writeFileString(`${testDir}/my notes.md`, "spaced body\nsecond\n")
      yield* fs.writeFileString(`${testDir}/issue#12.md`, "hashed body\n")
      const result = yield* expandFileRefs(
        'see @"my notes.md" and @"issue#12.md" and @"my notes.md"#2',
        testDir,
      )
      expect(result).toContain("```my notes.md\nspaced body")
      expect(result).toContain("```issue#12.md\nhashed body")
      expect(result).toContain("```my notes.md:2\nsecond\n```")
      expect(result).not.toContain("@")
    }),
  )

  fileRefsTest("trailing punctuation after a reference stays in the sentence", () =>
    Effect.gen(function* () {
      const testDir = yield* makeFixture
      const result = yield* expandFileRefs("look at @src/bar.ts, then (@src/bar.ts).", testDir)
      const block = "```src/bar.ts\nexport const bar = 1\n\n```"
      expect(result).toBe(`look at ${block}, then (${block}).`)
    }),
  )

  fileRefsTest("keeps every dollar pattern in the file text as written", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const testDir = yield* makeFixture
      const content = "pid $$\nwhole [$&]\nbefore $`\nafter $'\ngroup $1\n"
      yield* fs.writeFileString(`${testDir}/dollar.sh`, content)
      const result = yield* expandFileRefs("look at @dollar.sh please", testDir)
      expect(result).toBe(`look at \`\`\`dollar.sh\n${content}\n\`\`\` please`)
    }),
  )

  fileRefsTest("expands a reference whose text repeats inside an earlier file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const testDir = yield* makeFixture
      yield* fs.writeFileString(`${testDir}/a.md`, "see @src/bar.ts\n")
      const result = yield* expandFileRefs("@a.md then @src/bar.ts", testDir)
      expect(result).toBe(
        "```a.md\nsee @src/bar.ts\n\n``` then ```src/bar.ts\nexport const bar = 1\n\n```",
      )
    }),
  )

  fileRefsTest("expands a line number written with a leading zero", () =>
    Effect.gen(function* () {
      const testDir = yield* makeFixture
      const result = yield* expandFileRefs("see @src/foo.ts#03", testDir)
      expect(result).toBe("see ```src/foo.ts:3\nline3\n```")
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

  fileRefsTest("expands a nested path whose name holds dashes and underscores", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const testDir = yield* makeFixture
      yield* fs.makeDirectory(`${testDir}/packages/core/src`, { recursive: true })
      yield* fs.writeFileString(`${testDir}/packages/core/src/my-file_name.ts`, "one\ntwo\nthree\n")
      const result = yield* expandFileRefs("check @packages/core/src/my-file_name.ts#2-3", testDir)
      expect(result).toContain("```packages/core/src/my-file_name.ts:2-3")
      expect(result).toContain("two\nthree")
      expect(result).not.toContain("one")
    }),
  )
})

// ── format duration ─────────────────────────────────────────────────────────

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

    test("an hour or more reads in hours and minutes", () => {
      expect(formatDuration(3_600_000, "compact")).toBe("1h 0m")
      expect(formatDuration(3_720_000, "compact")).toBe("1h 2m")
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

    test("an hour or more reads in hours and two-digit minutes", () => {
      expect(formatDuration(3_720_000, "padded")).toBe("1h02m")
    })
  })

  describe("precise", () => {
    test("milliseconds under a second, tenths under a minute, then minutes and seconds", () => {
      expect(formatDuration(12, "precise")).toBe("12ms")
      expect(formatDuration(999.6, "precise")).toBe("1000ms")
      expect(formatDuration(1_250, "precise")).toBe("1.3s")
      expect(formatDuration(59_940, "precise")).toBe("59.9s")
      expect(formatDuration(65_000, "precise")).toBe("1m 5s")
      expect(formatDuration(3_720_000, "precise")).toBe("1h 2m")
    })
  })
})

// ── format error ────────────────────────────────────────────────────────────

describe("formatError", () => {
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

  // Each error the server can answer with says what failed, never "Unknown error".
  test("config and interaction errors read by their own words", () => {
    const decode = Schema.decodeUnknownSync(GentRpcError)
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [
        { _tag: "ConfigLoadError", path: "/nonexistent/gent-probe-x/config.json", message: "bad" },
        "Config /nonexistent/gent-probe-x/config.json: bad",
      ],
      [
        { _tag: "ConfigWriteError", path: "/nonexistent/gent-probe-x/config.json", message: "ro" },
        "Config /nonexistent/gent-probe-x/config.json: ro",
      ],
      [
        { _tag: "InteractionDecisionConflictError", message: "answered", requestId: "req-1" },
        "Interaction: answered",
      ],
      [
        {
          _tag: "InteractionRequestMismatchError",
          message: "not the open request",
          actualRequestId: "req-2",
          sessionId: "session-1",
          branchId: "branch-1",
        },
        "Interaction: not the open request",
      ],
    ]
    for (const [input, expected] of cases) expect(formatError(decode(input))).toBe(expected)
  })
})

describe("formatConnectionIssue", () => {
  // A lost connection is told by the transport's reason, never by words in a message.
  test("a transport loss reads as lost; an answer reads as an issue", () => {
    const lost = new RpcClientError({ reason: new SocketCloseError({ code: 1006 }) })
    expect(formatConnectionIssue(lost)).toBe("connection lost; retrying")
    expect(formatConnectionIssue(new NotFoundError({ message: "session abc" }))).toBe(
      "connection issue: Not found: session abc",
    )
    expect(formatConnectionIssue(new NotFoundError({ message: "network timeout config" }))).toBe(
      "connection issue: Not found: network timeout config",
    )
  })
})

// ── format tool ─────────────────────────────────────────────────────────────

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
    expect(result).toBe("3 turns ↑1.5k ↓500 $0.002 gpt-5.4")
  })

  test("singular turn", () => {
    expect(formatUsageStats({ turns: 1 })).toBe("1 turn")
  })

  test("model alone", () => {
    expect(formatUsageStats({}, "claude-opus")).toBe("claude-opus")
  })

  test("partial fields", () => {
    expect(formatUsageStats({ input: 500 })).toBe("↑500")
    expect(formatUsageStats({ cost: 0.01 })).toBe("$0.01")
  })
})

describe("formatCost", () => {
  test("a cent or more reads in cents", () => {
    expect(formatCost(0.01)).toBe("$0.01")
    expect(formatCost(0.125)).toBe("$0.13")
    expect(formatCost(12.3)).toBe("$12.30")
  })

  test("under a cent keeps a tenth of a cent, so it never reads as free", () => {
    expect(formatCost(0.002)).toBe("$0.002")
    expect(formatCost(0.0004)).toBe("<$0.001")
    expect(formatCost(0)).toBe("$0.00")
  })
})

const CWD = `${HOME}/code/proj`
const PLACE = { cwd: CWD, home: HOME }

describe("displayPath", () => {
  test("a path under the cwd reads from the cwd", () => {
    expect(displayPath(`${CWD}/apps/tui/src/app.tsx`, PLACE)).toBe("apps/tui/src/app.tsx")
    expect(displayPath(CWD, PLACE)).toBe(".")
  })

  test("a path under home but outside the cwd starts with ~", () => {
    expect(displayPath(`${HOME}/foo/bar.ts`, PLACE)).toBe("~/foo/bar.ts")
    expect(displayPath(HOME, PLACE)).toBe("~")
  })

  test("a sibling that only shares a prefix keeps its full spelling", () => {
    expect(displayPath(`${CWD}-other/a.ts`, PLACE)).toBe("~/code/proj-other/a.ts")
    expect(displayPath(`${HOME}x/a.ts`, PLACE)).toBe(`${HOME}x/a.ts`)
  })

  test("other paths stay as given", () => {
    expect(displayPath("/tmp/foo.ts", PLACE)).toBe("/tmp/foo.ts")
    expect(displayPath("relative/path.ts", PLACE)).toBe("relative/path.ts")
  })

  test("a cwd of / reads every absolute path from the root", () => {
    const root = { cwd: "/", home: HOME }
    expect(displayPath("/tmp/a", root)).toBe("tmp/a")
    expect(displayPath("/", root)).toBe(".")
  })
})

describe("toolArgSummary", () => {
  test("bash: first line of command", () => {
    expect(toolArgSummary("bash", { command: "ls -la" }, PLACE)).toBe("ls -la")
    expect(toolArgSummary("bash", { command: "echo hello\necho world" }, PLACE)).toBe("echo hello")
    expect(toolArgSummary("bash", {}, PLACE)).toBe("")
  })

  test("read: path with optional range", () => {
    expect(toolArgSummary("read", { path: "/tmp/foo.ts" }, PLACE)).toBe("/tmp/foo.ts")
    expect(toolArgSummary("read", { path: "/tmp/foo.ts", offset: 10 }, PLACE)).toBe(
      "/tmp/foo.ts:10",
    )
    expect(toolArgSummary("read", { path: "/tmp/foo.ts", offset: 10, limit: 20 }, PLACE)).toBe(
      "/tmp/foo.ts:10-29",
    )
    expect(toolArgSummary("read", { path: "/tmp/foo.ts", limit: 50 }, PLACE)).toBe(
      "/tmp/foo.ts:1-50",
    )
    expect(toolArgSummary("read", {}, PLACE)).toBe("")
  })

  test("read: shortens home paths", () => {
    expect(toolArgSummary("read", { path: `${HOME}/src/app.ts` }, PLACE)).toBe("~/src/app.ts")
  })

  test("write: path with line count", () => {
    expect(toolArgSummary("write", { path: "/tmp/foo.ts", content: "a\nb\nc" }, PLACE)).toBe(
      "/tmp/foo.ts (3 lines)",
    )
    expect(toolArgSummary("write", { path: "/tmp/foo.ts", content: "single" }, PLACE)).toBe(
      "/tmp/foo.ts",
    )
    expect(toolArgSummary("write", { path: "/tmp/foo.ts" }, PLACE)).toBe("/tmp/foo.ts")
    expect(toolArgSummary("write", {}, PLACE)).toBe("")
  })

  test("write: a final newline ends the last line, it does not start one", () => {
    expect(toolArgSummary("write", { path: "/tmp/foo.ts", content: "a\nb\n" }, PLACE)).toBe(
      "/tmp/foo.ts (2 lines)",
    )
    expect(toolArgSummary("write", { path: "/tmp/foo.ts", content: "single\n" }, PLACE)).toBe(
      "/tmp/foo.ts",
    )
  })

  test("edit: shortened path", () => {
    expect(toolArgSummary("edit", { path: `${HOME}/src/app.ts` }, PLACE)).toBe("~/src/app.ts")
    expect(toolArgSummary("edit", {}, PLACE)).toBe("")
  })

  test("grep: pattern and path", () => {
    expect(toolArgSummary("grep", { pattern: "TODO", path: "/src" }, PLACE)).toBe("/TODO/ in /src")
    expect(toolArgSummary("grep", { pattern: "err" }, PLACE)).toBe("/err/ in .")
    expect(toolArgSummary("grep", {}, PLACE)).toBe("")
  })

  test("delegate.start: todo", () => {
    expect(toolArgSummary("delegate.start", { todo: "find the bug" }, PLACE)).toBe("find the bug")
    expect(toolArgSummary("delegate.start", {}, PLACE)).toBe("")
  })

  test("delegate.start: truncates long todo text within its 40-column budget", () => {
    const longTodo = "a".repeat(60)
    const result = toolArgSummary("delegate.start", { todo: longTodo }, PLACE)
    expect(result).toBe(`${"a".repeat(39)}…`)
    expect(Bun.stringWidth(result)).toBe(40)
  })

  test("read_session: session id", () => {
    expect(toolArgSummary("read_session", { sessionId: "019debug1-session" }, PLACE)).toBe(
      "019debug1-session",
    )
  })

  test("handoff: reason", () => {
    expect(toolArgSummary("handoff", { reason: "need deeper analysis" }, PLACE)).toBe(
      "need deeper analysis",
    )
  })

  test("degrades gracefully on bad input types", () => {
    expect(toolArgSummary("grep", { pattern: "ok", path: {} }, PLACE)).toBe("/ok/ in .")
    expect(
      toolArgSummary("read", { path: "/tmp/f.ts", offset: "bad", limit: nullValue }, PLACE),
    ).toBe("/tmp/f.ts")
    expect(toolArgSummary("bash", { command: 123 }, PLACE)).toBe("")
    expect(toolArgSummary("read", { path: nullValue }, PLACE)).toBe("")
  })

  test("a tool with no formatter shows its leading argument", () => {
    expect(toolArgSummary("unknown_tool", { anything: "value" }, PLACE)).toBe("")
    expect(toolArgSummary("webfetch", { url: "https://a.test/x\nmore" }, PLACE)).toBe(
      "https://a.test/x",
    )
    expect(toolArgSummary("custom", { path: `${CWD}/src/a.ts` }, PLACE)).toBe("src/a.ts")
  })

  test("input that is not an object has no label", () => {
    expect(toolArgSummary("bash", nullValue, PLACE)).toBe("")
    expect(toolArgSummary("bash", absent, PLACE)).toBe("")
    expect(toolArgSummary("bash", "string", PLACE)).toBe("")
    expect(toolArgSummary("Bash", { command: "git status" }, PLACE)).toBe("git status")
  })

  test("paths read from the place", () => {
    expect(toolArgSummary("read", { path: `${CWD}/src/app.ts`, offset: 3 }, PLACE)).toBe(
      "src/app.ts:3",
    )
    expect(toolArgSummary("grep", { pattern: "err", path: CWD }, PLACE)).toBe("/err/ in .")
    expect(toolArgSummary("write", { path: `${HOME}/notes.md` }, PLACE)).toBe("~/notes.md")
  })
})

// ── generic format ──────────────────────────────────────────────────────────

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

// ── message list utils ──────────────────────────────────────────────────────

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
    expect(
      formatRowCounts("cell", { inputLines: lineCount("a\nb\nc"), outputLines: lineCount("x\ny") }),
    ).toBe("↑ 3 ↓ 2 lines")
    expect(
      formatRowCounts("bash", { inputLines: lineCount("ls"), outputLines: lineCount("x") }),
    ).toBe("↓ 1 line")
    expect(
      formatRowCounts("read", { inputLines: lineCount(""), outputLines: lineCount("x") }),
    ).toBe("")
  })

  test("a final newline ends the last line and does not start one", () => {
    expect(lineCount("")).toBe(0)
    expect(lineCount("\n")).toBe(1)
    expect(lineCount("hello\n")).toBe(1)
    expect(lineCount("a\nb\n")).toBe(2)
    expect(lineCount("a\n\n")).toBe(2)
    expect(
      formatRowCounts("bash", { inputLines: lineCount("ls\n"), outputLines: lineCount("hello\n") }),
    ).toBe("↓ 1 line")
    expect(
      formatRowCounts("cell", { inputLines: lineCount("a\nb\n"), outputLines: lineCount("x\n") }),
    ).toBe("↑ 2 ↓ 1 lines")
  })

  test("one count of one line reads singular; two counts share the plural", () => {
    expect(
      formatRowCounts("bash", { inputLines: lineCount("ls"), outputLines: lineCount("x") }),
    ).toBe("↓ 1 line")
    expect(
      formatRowCounts("cell", { inputLines: lineCount("a"), outputLines: lineCount("x") }),
    ).toBe("↑ 1 ↓ 1 lines")
  })

  test("a zero count is left out, so a cell with no output shows only its code", () => {
    expect(
      formatRowCounts("cell", { inputLines: lineCount("a"), outputLines: lineCount("") }),
    ).toBe("↑ 1 line")
    expect(
      formatRowCounts("bash", { inputLines: lineCount("ls"), outputLines: lineCount("") }),
    ).toBe("")
    expect(formatRowCounts("cell", { inputLines: lineCount(""), outputLines: lineCount("") })).toBe(
      "",
    )
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

// ── truncate ────────────────────────────────────────────────────────────────

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

describe("fitWidth", () => {
  test("a cut or padded name fills exactly its column budget, wide glyphs included", () => {
    for (const name of ["漢字漢字漢字漢字漢字", "漢字", "👩‍💻 fix", "👩‍💻".repeat(9), "plain"]) {
      expect(Bun.stringWidth(fitWidth(name, 12))).toBe(12)
    }
    expect(fitWidth("漢字", 6)).toBe("漢字  ")
  })
})

describe("truncateStart", () => {
  test("keeps the tail of a query within the budget", () => {
    expect(truncateStart("abcdefghij", 4)).toBe("ghij")
    expect(truncateStart("漢字漢字", 3)).toBe("字")
    expect(truncateStart("fits", 10)).toBe("fits")
  })
})
