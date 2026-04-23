import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import {
  splitCdCommand,
  injectGitTrailers,
  stripBackground,
  BashTool,
} from "@gent/extensions/exec-tools/bash"
import { ExecToolsProtocol } from "@gent/extensions/exec-tools/protocol"
import { SessionId, BranchId, ToolCallId } from "@gent/core/domain/ids"
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

const dieStub = (label: string) => () => Effect.die(`${label} not wired in test`)

const stubCtx: ToolContext = {
  sessionId: SessionId.of("test-session"),
  branchId: BranchId.of("test-branch"),
  toolCallId: ToolCallId.of("tc-1"),
  cwd: process.cwd(),
  home: "/tmp",
  extension: {
    send: dieStub("send"),
    ask: dieStub("ask"),
    request: dieStub("request"),
  },
  agent: {
    get: dieStub("get"),
    require: dieStub("require"),
    run: dieStub("run"),
    resolveDualModelPair: dieStub("resolveDualModelPair"),
  },
  session: {
    listMessages: dieStub("listMessages"),
    getSession: dieStub("getSession"),
    getDetail: dieStub("getDetail"),
    renameCurrent: dieStub("renameCurrent"),
    estimateContextPercent: dieStub("estimateContextPercent"),
    search: dieStub("search"),
    listBranches: dieStub("listBranches"),
    createBranch: dieStub("createBranch"),
    forkBranch: dieStub("forkBranch"),
    switchBranch: dieStub("switchBranch"),
    createChildSession: dieStub("createChildSession"),
    getChildSessions: dieStub("getChildSessions"),
    getSessionAncestors: dieStub("getSessionAncestors"),
    deleteSession: dieStub("deleteSession"),
    deleteBranch: dieStub("deleteBranch"),
    deleteMessages: dieStub("deleteMessages"),
  },
  interaction: {
    approve: () => Effect.succeed({ approved: true }),
    present: dieStub("present"),
    confirm: dieStub("confirm"),
    review: dieStub("review"),
  },
}

describe("BashTool execution", () => {
  test("runs a command and returns stdout", async () => {
    const result = await Effect.runPromise(BashTool.effect({ command: "echo hello" }, stubCtx))
    expect(result.stdout.trim()).toBe("hello")
    expect(result.exitCode).toBe(0)
  })

  test("captures nonzero exit code", async () => {
    const result = await Effect.runPromise(BashTool.effect({ command: "exit 2" }, stubCtx))
    expect(result.exitCode).toBe(2)
  })

  test("respects cwd parameter", async () => {
    const result = await Effect.runPromise(
      BashTool.effect({ command: "pwd", cwd: "/tmp" }, stubCtx),
    )
    // /tmp may resolve to /private/tmp on macOS
    expect(result.stdout.trim()).toMatch(/\/tmp$/)
    expect(result.exitCode).toBe(0)
  })

  test("splits cd + command into cwd and executes", async () => {
    const result = await Effect.runPromise(BashTool.effect({ command: "cd /tmp && pwd" }, stubCtx))
    expect(result.stdout.trim()).toMatch(/\/tmp$/)
    expect(result.exitCode).toBe(0)
  })

  test("background mode notifies through the extension protocol on completion", async () => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    let resolveSent: ((value: unknown) => void) | undefined
    const sent = new Promise<unknown>((resolve, reject) => {
      resolveSent = resolve
      timeout = setTimeout(() => reject(new Error("background notification timed out")), 2_000)
    })
    const ctx: ToolContext = {
      ...stubCtx,
      extension: {
        ...stubCtx.extension,
        send: (message) =>
          Effect.sync(() => {
            if (timeout !== undefined) clearTimeout(timeout)
            resolveSent?.(message)
          }),
      },
    }
    const result = await Effect.runPromise(
      BashTool.effect({ command: "printf background-finished", run_in_background: true }, ctx),
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Command started in background")

    const message = await sent
    expect(ExecToolsProtocol.BackgroundCompleted.is(message)).toBe(true)
    if (!ExecToolsProtocol.BackgroundCompleted.is(message)) {
      throw new Error("expected BackgroundCompleted protocol message")
    }
    expect(message.content).toContain("Background command completed (exit code 0)")
    expect(message.content).toContain("$ printf background-finished")
  })
})
