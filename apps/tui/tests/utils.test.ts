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
  activityRows,
  failedOperations,
  describeCellCode,
  dropLastGrapheme,
  expandFileRefs,
  fitWidth,
  fileHref,
  formatActivityHeader,
  formatActivityRow,
  formatFailureRow,
  formatRunningCall,
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
  headGraphemes,
  displayPath,
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
import { textWidth } from "../src/bun-adapter"

// ── file refs ───────────────────────────────────────────────────────────────

// A terminal opens the href as a URL: a space, `#` or `%` in the path is
// encoded, or the link names another file. Only an absolute path has one.
describe("fileHref", () => {
  const cases: ReadonlyArray<readonly [string, Option.Option<string>]> = [
    ["/Users/cvr/foo.ts", Option.some("file:///Users/cvr/foo.ts")],
    ["/", Option.some("file:///")],
    ["/Users/cvr/my project/foo.ts", Option.some("file:///Users/cvr/my%20project/foo.ts")],
    ["/tmp/issue #4/a.ts", Option.some("file:///tmp/issue%20%234/a.ts")],
    ["/tmp/100%/a.ts", Option.some("file:///tmp/100%25/a.ts")],
    ["foo", Option.none()],
    ["./foo", Option.none()],
    ["~/foo", Option.none()],
    ["", Option.none()],
  ]
  for (const [path, href] of cases) {
    test(`"${path}" links to ${Option.getOrElse(href, () => "nothing")}`, () => {
      expect(fileHref(path)).toEqual(href)
    })
  }
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

  // A range whose end is before its start names no line either.
  fileRefsTest("a reversed range stays a reference", () =>
    Effect.gen(function* () {
      const testDir = yield* makeFixture
      expect(yield* expandFileRefs("@src/foo.ts#4-2", testDir)).toBe("@src/foo.ts#4-2")
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
      expect(formatDuration(1_250, "precise")).toBe("1.3s")
      expect(formatDuration(59_940, "precise")).toBe("59.9s")
      expect(formatDuration(65_000, "precise")).toBe("1m 5s")
      expect(formatDuration(3_720_000, "precise")).toBe("1h 2m")
    })

    test("a value that rounds up to the next unit is written in that unit", () => {
      expect(formatDuration(999.4, "precise")).toBe("999ms")
      expect(formatDuration(999.6, "precise")).toBe("1.0s")
      expect(formatDuration(59_960, "precise")).toBe("1m 0s")
      expect(formatDuration(119_600, "precise")).toBe("2m 0s")
      expect(formatDuration(3_599_600, "precise")).toBe("1h 0m")
    })
  })
})

// ── format error ────────────────────────────────────────────────────────────

describe("error text", () => {
  test("a storage failure reads as Storage: and its message", () => {
    const err = new StorageError({ message: "disk full" })
    expect(formatError(err)).toBe("Storage: disk full")
  })

  test("a runtime failure reads as Runtime: and its message", () => {
    const err = new SessionRuntimeError({ message: "max turns" })
    expect(formatError(err)).toBe("Runtime: max turns")
  })

  test("a provider failure names the model it came from", () => {
    const err = new ProviderError({ message: "rate limited", model: "gpt-4" })
    expect(formatError(err)).toBe("gpt-4: rate limited")
  })

  test("an event store failure reads as Events: and its message", () => {
    const err = new EventStoreError({ message: "replay failed" })
    expect(formatError(err)).toBe("Events: replay failed")
  })

  test("a missing record reads as Not found: and what was missing", () => {
    const err = new NotFoundError({ message: "session abc" })
    expect(formatError(err)).toBe("Not found: session abc")
  })

  test("an auth failure reads as Auth: and its message", () => {
    const err = new ProviderAuthError({ message: "invalid key" })
    expect(formatError(err)).toBe("Auth: invalid key")
  })

  test("a driver failure names the driver and its reason", () => {
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
// eslint-disable-next-line effect/noNullish -- a wire field the server leaves unset is present and undefined.
const absent = undefined
// eslint-disable-next-line effect/noNullish -- JSON on the wire carries null here; the test hands it on as is.
const nullValue = null

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

  test("ask_user_async: the first question's label, text and assumption, and how many more", () => {
    const question = { header: "cache", question: "Which backend?", assume: "in-memory LRU" }
    expect(toolArgSummary("ask_user_async", { questions: [question] }, PLACE)).toBe(
      "cache · Which backend? · assuming in-memory LRU",
    )
    expect(
      toolArgSummary(
        "ask_user_async",
        { questions: [question, { question: "Port?", assume: "8080" }] },
        PLACE,
      ),
    ).toBe("cache · Which backend? · assuming in-memory LRU · +1 more")
    expect(toolArgSummary("ask_user_async", {}, PLACE)).toBe("")
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

  // A CJK directory takes two columns a character: the budget counts columns.
  test("a wide-character path is cut by the columns it takes", () => {
    const path = "/项目/文档/设计/说明.md"
    const result = truncatePath(path, 20)
    expect(result.startsWith("…/")).toBe(true)
    expect(result.endsWith("说明.md")).toBe(true)
    expect(textWidth(result)).toBeLessThanOrEqual(22) // +2 for "…/"
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
  test("counts the tools by kind, largest first, ties in the order they ran", () => {
    expect(
      formatActivityHeader([
        cell([op("bash", "pwd"), op("read", "a.ts"), op("edit", "x.ts")]),
        cell([op("read", "b.ts"), op("write", "y.ts"), op("read", "c.ts"), op("read", "d.ts")]),
      ]),
    ).toBe("7 tools · 4 read · 2 edit · 1 command")
    expect(
      formatActivityHeader([
        cell([op("delegate.start", "compute"), op("delegate.start", "verify")]),
        cell([op("grep", "/x/ in ."), op("read_session", "s1"), op("mcp.query", "q")]),
      ]),
    ).toBe("5 tools · 2 children · 1 search · 1 read · 1 mcp.query")
    expect(formatActivityHeader([cell([op("bash", "a"), op("bash", "b")])])).toBe(
      "2 tools · 2 commands",
    )
    expect(formatActivityHeader([cell([op("ask_user_async", "cache"), op("bash", "a")])])).toBe(
      "2 tools · 1 question · 1 command",
    )
  })

  test("a cell with no ops is one tool that names its source's verbs", () => {
    expect(formatActivityHeader([cell([])])).toBe("1 tool")
    expect(formatActivityHeader([{ ...cell([]), code: "await Bun.$`bun test`.text()" }])).toBe(
      "1 tool · $ bun test",
    )
  })

  test("a cell that failed with its op counts one failure", () => {
    // An interrupted cell: live its op is settled to failed when the cell ends,
    // and a reload projects the same op as failed.
    expect(formatActivityHeader([cell([op("bash", "git checkout", "failed")], "error")])).toBe(
      "1 tool · 1 command · 1 failed",
    )
    expect(
      formatActivityHeader([cell([op("bash", "a", "failed"), op("bash", "b", "failed")], "error")]),
    ).toBe("2 tools · 2 commands · 2 failed")
  })

  test("a cell that failed while its ops succeeded is one failure and no extra tool", () => {
    // After a restart the op row shows exit 0; the op stays a success.
    expect(formatActivityHeader([cell([op("bash", "pwd")], "error")])).toBe(
      "1 tool · 1 command · 1 failed",
    )
    expect(
      formatActivityHeader([
        cell([op("bash", "a", "failed")], "error"),
        cell([op("read", "c.ts")], "error"),
        cell([], "error"),
      ]),
    ).toBe("3 tools · 1 command · 1 read · 3 failed")
  })

  test("a finished group carries the sum of its call durations", () => {
    expect(formatActivityHeader([{ ...cell([op("bash", "pwd")]), durationMs: 1_250 }])).toBe(
      "1 tool · 1 command · 1.3s",
    )
    expect(
      formatActivityHeader([
        { ...cell([]), durationMs: 800 },
        { ...cell([]), durationMs: 700 },
        cell([], "running"),
      ]),
    ).toBe("3 tools · 1.5s")
    expect(formatGroupDuration([cell([], "running")])).toBe("")
  })

  test("a direct tool call counts as the one tool it is", () => {
    expect(
      formatActivityHeader([
        { toolName: "read", status: "completed", operations: [], code: "" },
        { toolName: "read", status: "error", operations: [], code: "" },
        cell([op("bash")]),
      ]),
    ).toBe("3 tools · 2 read · 1 command · 1 failed")
  })

  test("a narrow header drops kinds from the right and keeps the count, failures and time", () => {
    const calls = [
      {
        ...cell([
          op("read", "a"),
          op("read", "b"),
          op("read", "c"),
          op("grep", "x"),
          op("edit", "e"),
          op("bash", "t", "failed"),
        ]),
        durationMs: 9_700,
      },
    ]
    expect(formatActivityHeader(calls)).toBe(
      "6 tools · 3 read · 1 search · 1 edit · 1 command · 1 failed · 9.7s",
    )
    expect(formatActivityHeader(calls, 50)).toBe("6 tools · 3 read · 1 search · 1 failed · 9.7s")
    expect(formatActivityHeader(calls, 10)).toBe("6 tools · 1 failed · 9.7s")
  })

  test("thoughts count after the kinds, and a narrow header drops them first", () => {
    const calls = [cell([op("read", "a"), op("bash", "t", "failed")])]
    expect(formatActivityHeader(calls, Number.POSITIVE_INFINITY, 1)).toBe(
      "2 tools · 1 read · 1 command · 1 thought · 1 failed",
    )
    expect(formatActivityHeader(calls, Number.POSITIVE_INFINITY, 6)).toBe(
      "2 tools · 1 read · 1 command · 6 thoughts · 1 failed",
    )
    expect(formatActivityHeader(calls, 40, 6)).toBe("2 tools · 1 read · 1 command · 1 failed")
  })
})

describe("activity rows", () => {
  const rows = (calls: ReadonlyArray<ActivityCall>, width?: number) =>
    activityRows(calls).map((row) => {
      const text = formatActivityRow(row, width)
      const diff = Option.match(text.diff, {
        onNone: () => "",
        onSome: ({ added, removed }) => ` +${added} / -${removed}`,
      })
      return `${text.head}${diff}${text.tail}`
    })

  test("ops read in past-tense verbs, consecutive ops of one tool folded into one row", () => {
    expect(
      rows([
        cell([op("read", "a.ts"), op("read", "b.ts")]),
        cell([op("read", "c.ts"), op("grep", "/x/ in src"), op("bash", "bun test")]),
      ]),
    ).toEqual(["Read a.ts, b.ts, c.ts", "Searched /x/ in src", "Ran bun test"])
    expect(
      rows([
        cell([
          op("delegate.start", "compute"),
          op("write", "out.json"),
          op("ask_user", "pick one"),
          op("mcp.query", "q"),
        ]),
      ]),
    ).toEqual(["Started compute", "Wrote out.json", "Asked pick one", "mcp.query q"])
  })

  test("the subjects that fit the width show, then a count of the rest", () => {
    const reads = cell(["a.ts", "b.ts", "c.ts", "d.ts"].map((path) => op("read", path)))
    expect(rows([reads], 100)).toEqual(["Read a.ts, b.ts, c.ts, d.ts"])
    expect(rows([reads], 20)).toEqual(["Read a.ts, b.ts +2"])
    // The first subject always shows; the row's own clip cuts it.
    expect(rows([reads], 4)).toEqual(["Read a.ts +3"])
  })

  test("an edit row sums the lines its edits changed", () => {
    const edit = (path: string, added: number, removed: number) => ({
      ...op("edit", path),
      diff: { added, removed },
    })
    expect(rows([cell([edit("x.ts", 10, 3), edit("y.ts", 2, 0)])])).toEqual([
      "Edited x.ts, y.ts +12 / -3",
    ])
  })

  test("a failed op keeps its own row, and the running op shows last in the running tense", () => {
    expect(
      rows([
        cell([op("bash", "lint"), op("bash", "test", "failed"), op("bash", "build", "running")]),
      ]),
    ).toEqual(["Ran lint", "Ran test · failed", "Running build"])
    expect(rows([cell([op("bash", "a", "running")]), cell([op("bash", "b", "running")])])).toEqual([
      "Running a",
      "Running b",
    ])
  })

  test("an MCP call reads as Called <server>.<tool>, and the header counts it by server", () => {
    const calls = [
      cell([
        op("mcp.linear.list_issues", "team=core"),
        op("mcp.linear.get_issue", "GEN-12"),
        op("mcp.github.search", "", "failed"),
      ]),
    ]
    expect(rows(calls)).toEqual([
      "Called linear.list_issues team=core",
      "Called linear.get_issue GEN-12",
      "Called github.search · failed",
    ])
    expect(formatActivityHeader(calls)).toBe("3 tools · 2 linear · 1 github · 1 failed")
    expect(failedOperations(calls).map((operation) => formatFailureRow(operation))).toEqual([
      "Called github.search · failed",
    ])
  })

  test("a running call reads in its row's running words", () => {
    expect(formatRunningCall("bash", "mkdir -p gent-debug-tools")).toBe(
      "Running mkdir -p gent-debug-tools",
    )
    expect(formatRunningCall("mcp.linear.list_issues", "team=core")).toBe(
      "Calling linear.list_issues team=core",
    )
    expect(formatRunningCall("cell", "")).toBe("cell")
  })

  test("failed ops never fold, and a command's row ends with its exit status", () => {
    const exited = (detail: string, exit: number) => ({ ...op("bash", detail, "failed"), exit })
    expect(rows([cell([exited("a", 1), exited("b", 2), op("bash", "c", "failed")])])).toEqual([
      "Ran a · exit 1",
      "Ran b · exit 2",
      "Ran c · failed",
    ])
  })

  test("a cell's own failure is a row after its ops; a cell with no ops names its verbs", () => {
    expect(rows([cell([op("read", "a.ts")], "error")])).toEqual(["Read a.ts", "cell · failed"])
    expect(rows([{ ...cell([], "error"), code: "await tools.ask_user({})" }])).toEqual([
      "cell ask_user · failed",
    ])
    // A saved receipt carries no arguments: the verb stands alone.
    expect(rows([cell([op("read"), op("write", "", "failed")])])).toEqual([
      "Read",
      "Wrote · failed",
    ])
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

describe("grapheme edits", () => {
  test("dropping the last character takes a whole emoji sequence", () => {
    expect(dropLastGrapheme("ok 👍🏽")).toBe("ok ")
    expect(dropLastGrapheme("🇺🇸")).toBe("")
    expect(dropLastGrapheme("a👨‍👩‍👧")).toBe("a")
    expect(dropLastGrapheme("é")).toBe("")
    expect(dropLastGrapheme("")).toBe("")
  })

  test("a head cut counts characters and never splits one", () => {
    expect(headGraphemes("ab👍🏽cd", 3)).toBe("ab👍🏽…")
    expect(headGraphemes("ab👍🏽", 3)).toBe("ab👍🏽")
    expect(headGraphemes("", 3)).toBe("")
  })
})

/**
 * The one column-budget truncation.
 *
 * Every caller budgets terminal columns. A name whose `.length` fits the
 * budget can still be wider than it: CJK glyphs take two columns and an emoji
 * is one grapheme of several code units. A code-unit slice lets those rows
 * overflow; the `.length` line in each test shows the name it would pass.
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

describe("failure rows", () => {
  const failure = (detail: string, reason: string, exit: number) => ({
    ...op("bash", detail, "failed"),
    reason,
    exit,
  })

  test("the failures of a run are its failed ops in order, a cell's own failure included", () => {
    const calls = [
      cell([op("read", "a.ts"), failure("x", "boom", 2)]),
      { ...cell([op("bash", "y")], "error"), reason: "cell died" },
    ]
    expect(failedOperations(calls).map((operation) => formatFailureRow(operation))).toEqual([
      "Ran x · exit 2 · boom",
      "cell · failed · cell died",
    ])
  })

  test("a narrow row cuts the reason first, then drops it, then cuts the subject", () => {
    const row = failure("sleep 2; ls d.ts", "ls: cannot access 'd.ts': No such file", 2)
    expect(formatFailureRow(row, 80)).toBe(
      "Ran sleep 2; ls d.ts · exit 2 · ls: cannot access 'd.ts': No such file",
    )
    expect(formatFailureRow(row, 40)).toBe("Ran sleep 2; ls d.ts · exit 2 · ls: can…")
    expect(formatFailureRow(row, 30)).toBe("Ran sleep 2; ls d.ts · exit 2")
    expect(formatFailureRow(row, 20)).toBe("Ran sleep … · exit 2")
    for (const width of [80, 40, 30, 20])
      expect(textWidth(formatFailureRow(row, width))).toBeLessThanOrEqual(width)
  })

  test("a failure with no reason ends with its outcome word", () => {
    expect(formatFailureRow(op("write", "out.json", "failed"))).toBe("Wrote out.json · failed")
  })
})
