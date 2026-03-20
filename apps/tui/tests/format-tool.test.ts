import { describe, test, expect } from "bun:test"
import os from "node:os"
import {
  formatTokens,
  formatUsageStats,
  shortenPath,
  toolArgSummary,
} from "../src/utils/format-tool.js"

const HOME = os.homedir()

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
    expect(formatTokens(999999)).toBe("1000k")
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
    expect(formatUsageStats({ input: undefined })).toBe("")
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
    expect(shortenPath(`${HOME}/foo/bar.ts`)).toBe("~/foo/bar.ts")
  })

  test("leaves non-home paths unchanged", () => {
    expect(shortenPath("/tmp/foo.ts")).toBe("/tmp/foo.ts")
    expect(shortenPath("relative/path.ts")).toBe("relative/path.ts")
  })

  test("handles home directory exactly", () => {
    expect(shortenPath(HOME)).toBe("~")
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
    expect(toolArgSummary("read", { file_path: `${HOME}/src/app.ts` })).toBe("~/src/app.ts")
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
    expect(toolArgSummary("edit", { file_path: `${HOME}/src/app.ts` })).toBe("~/src/app.ts")
    expect(toolArgSummary("edit", {})).toBe("")
  })

  test("grep: pattern and path", () => {
    expect(toolArgSummary("grep", { pattern: "TODO", path: "/src" })).toBe("/TODO/ in /src")
    expect(toolArgSummary("grep", { pattern: "err" })).toBe("/err/ in .")
    expect(toolArgSummary("grep", {})).toBe("")
  })

  test("glob: pattern and path", () => {
    expect(toolArgSummary("glob", { pattern: "*.ts", path: "/src" })).toBe("*.ts in /src")
    expect(toolArgSummary("glob", { pattern: "*.tsx" })).toBe("*.tsx in .")
    expect(toolArgSummary("glob", {})).toBe("")
  })

  test("webfetch: url", () => {
    expect(toolArgSummary("webfetch", { url: "https://example.com" })).toBe("https://example.com")
    expect(toolArgSummary("webfetch", {})).toBe("")
  })

  test("repo_explorer: action + spec", () => {
    expect(toolArgSummary("repo_explorer", { action: "fetch", spec: "effect-ts/effect" })).toBe(
      "fetch effect-ts/effect",
    )
    expect(toolArgSummary("repo_explorer", { action: "path" })).toBe("path")
    expect(toolArgSummary("repo_explorer", {})).toBe("")
  })

  test("task: single/parallel/chain modes", () => {
    expect(toolArgSummary("task", { agent: "explore", task: "find the bug" })).toBe(
      "explore:find the bug",
    )
    expect(
      toolArgSummary("task", {
        tasks: [
          { agent: "a", task: "x" },
          { agent: "b", task: "y" },
        ],
      }),
    ).toBe("2 parallel")
    expect(
      toolArgSummary("task", {
        chain: [
          { agent: "a", task: "x" },
          { agent: "b", task: "y" },
          { agent: "c", task: "z" },
        ],
      }),
    ).toBe("3 chain")
    expect(toolArgSummary("task", { agent: "explore" })).toBe("explore")
  })

  test("task: truncates long task text", () => {
    const longTask = "a".repeat(60)
    const result = toolArgSummary("task", { agent: "explore", task: longTask })
    expect(result).toBe(`explore:${"a".repeat(40)}…`)
  })

  test("finder: query with truncation", () => {
    expect(toolArgSummary("finder", { query: "where is the auth module" })).toBe(
      "where is the auth module",
    )
    const longQuery = "q".repeat(60)
    expect(toolArgSummary("finder", { query: longQuery })).toBe("q".repeat(50) + "…")
  })

  test("counsel: prompt with truncation", () => {
    expect(toolArgSummary("counsel", { prompt: "review this code" })).toBe("review this code")
    const longPrompt = "p".repeat(60)
    expect(toolArgSummary("counsel", { prompt: longPrompt })).toBe("p".repeat(50) + "…")
  })

  test("unknown tool returns empty", () => {
    expect(toolArgSummary("unknown_tool", { anything: "value" })).toBe("")
  })
})
