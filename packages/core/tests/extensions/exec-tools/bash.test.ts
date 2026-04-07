import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import {
  splitCdCommand,
  injectGitTrailers,
  stripBackground,
  BashTool,
} from "@gent/core/extensions/exec-tools/bash"
import type { SessionId, BranchId, ToolCallId } from "@gent/core/domain/ids"
import type { ToolContext } from "@gent/core/domain/tool"

describe("splitCdCommand", () => {
  test("cd /foo && ls → { cwd: '/foo', command: 'ls' }", () => {
    const result = splitCdCommand("cd /foo && ls")
    expect(result).toEqual({ cwd: "/foo", command: "ls" })
  })

  test("cd with quoted path && cmd → quoted path", () => {
    const result = splitCdCommand('cd "/path with spaces" && ls -la')
    expect(result).toEqual({ cwd: "/path with spaces", command: "ls -la" })
  })

  test("cd /foo; ls → semicolon separator", () => {
    const result = splitCdCommand("cd /foo; ls")
    expect(result).toEqual({ cwd: "/foo", command: "ls" })
  })

  test("plain command → null", () => {
    expect(splitCdCommand("ls -la")).toBeNull()
  })
})

describe("injectGitTrailers", () => {
  test('git commit -m "msg" → injects --trailer', () => {
    const result = injectGitTrailers('git commit -m "fix bug"', "sess-123")
    expect(result).toContain('--trailer "Session-Id: sess-123"')
    expect(result).toContain("git commit")
  })

  test("git push → unchanged", () => {
    const cmd = "git push origin main"
    expect(injectGitTrailers(cmd, "sess-123")).toBe(cmd)
  })

  test("already has --trailer → unchanged", () => {
    const cmd = 'git commit --trailer "Foo: bar" -m "msg"'
    expect(injectGitTrailers(cmd, "sess-123")).toBe(cmd)
  })
})

describe("stripBackground", () => {
  test('"cmd &" → "cmd"', () => {
    expect(stripBackground("cmd &")).toBe("cmd")
  })

  test('"cmd  &  " → "cmd"', () => {
    expect(stripBackground("cmd  &  ")).toBe("cmd")
  })

  test('"cmd" → "cmd"', () => {
    expect(stripBackground("cmd")).toBe("cmd")
  })
})

// ============================================================================
// Integration — real command execution
// ============================================================================

const stubCtx = {
  sessionId: "test-session" as SessionId,
  branchId: "test-branch" as BranchId,
  toolCallId: "tc-1" as ToolCallId,
  cwd: process.cwd(),
  home: "/tmp",
  interaction: {
    approve: () => Effect.succeed({ approved: true }),
  },
} as unknown as ToolContext

describe("BashTool execution", () => {
  test("runs a command and returns stdout", async () => {
    const result = await Effect.runPromise(BashTool.execute({ command: "echo hello" }, stubCtx))
    expect(result.stdout.trim()).toBe("hello")
    expect(result.exitCode).toBe(0)
  })

  test("captures nonzero exit code", async () => {
    const result = await Effect.runPromise(BashTool.execute({ command: "exit 2" }, stubCtx))
    expect(result.exitCode).toBe(2)
  })

  test("respects cwd parameter", async () => {
    const result = await Effect.runPromise(
      BashTool.execute({ command: "pwd", cwd: "/tmp" }, stubCtx),
    )
    // /tmp may resolve to /private/tmp on macOS
    expect(result.stdout.trim()).toMatch(/\/tmp$/)
    expect(result.exitCode).toBe(0)
  })

  test("splits cd + command into cwd and executes", async () => {
    const result = await Effect.runPromise(BashTool.execute({ command: "cd /tmp && pwd" }, stubCtx))
    expect(result.stdout.trim()).toMatch(/\/tmp$/)
    expect(result.exitCode).toBe(0)
  })
})
