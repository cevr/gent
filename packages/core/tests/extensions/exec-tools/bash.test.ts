import { describe, test, it, expect } from "effect-bun-test"
import { Deferred, Effect, Layer, Path } from "effect"
import { BunFileSystem, BunChildProcessSpawner } from "@effect/platform-bun"
import {
  splitCdCommand,
  injectGitTrailers,
  stripBackground,
  BashTool,
} from "@gent/extensions/exec-tools/bash"

const platformLayer = Layer.mergeAll(
  BunFileSystem.layer,
  Path.layer,
  BunChildProcessSpawner.layer.pipe(Layer.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
)
const provideBun = <A, E, R>(e: Effect.Effect<A, E, R>) =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test boundary, R is platform services we provide here
  Effect.provide(e, platformLayer) as Effect.Effect<A, E, never>

const processTestTimeout = 15_000
const withProcessTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.timeout("10 seconds"))

import { BranchId, SessionId, ToolCallId } from "@gent/core/domain/ids"
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
    const result = injectGitTrailers('git commit -m "fix bug"', SessionId.make("sess-123"))
    expect(result).toContain('--trailer "Session-Id: sess-123"')
    expect(result).toContain("git commit")
  })

  test("git push → unchanged", () => {
    const cmd = "git push origin main"
    expect(injectGitTrailers(cmd, SessionId.make("sess-123"))).toBe(cmd)
  })

  test("already has --trailer → unchanged", () => {
    const cmd = 'git commit --trailer "Foo: bar" -m "msg"'
    expect(injectGitTrailers(cmd, SessionId.make("sess-123"))).toBe(cmd)
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
  sessionId: SessionId.make("test-session"),
  branchId: BranchId.make("test-branch"),
  toolCallId: ToolCallId.make("tc-1"),
  cwd: process.cwd(),
  home: "/tmp",
  extension: {
    request: dieStub("request"),
  },
  actors: {
    find: dieStub("actors.find"),
    findOne: dieStub("actors.findOne"),
    tell: dieStub("actors.tell"),
    ask: dieStub("actors.ask"),
  } as never,
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
    queueFollowUp: dieStub("queueFollowUp"),
  },
  interaction: {
    approve: () => Effect.succeed({ approved: true }),
    present: dieStub("present"),
    confirm: dieStub("confirm"),
    review: dieStub("review"),
  },
}

describe("BashTool execution", () => {
  it.live(
    "runs a command and returns stdout",
    () =>
      withProcessTimeout(
        Effect.gen(function* () {
          const result = yield* provideBun(BashTool.effect({ command: "echo hello" }, stubCtx))

          expect(result.stdout.trim()).toBe("hello")
          expect(result.exitCode).toBe(0)
        }),
      ),
    processTestTimeout,
  )

  it.live(
    "captures nonzero exit code",
    () =>
      withProcessTimeout(
        Effect.gen(function* () {
          const result = yield* provideBun(BashTool.effect({ command: "exit 2" }, stubCtx))

          expect(result.exitCode).toBe(2)
        }),
      ),
    processTestTimeout,
  )

  it.live(
    "respects cwd parameter",
    () =>
      withProcessTimeout(
        Effect.gen(function* () {
          const result = yield* provideBun(
            BashTool.effect({ command: "pwd", cwd: "/tmp" }, stubCtx),
          )

          // /tmp may resolve to /private/tmp on macOS
          expect(result.stdout.trim()).toMatch(/\/tmp$/)
          expect(result.exitCode).toBe(0)
        }),
      ),
    processTestTimeout,
  )

  it.live(
    "splits cd + command into cwd and executes",
    () =>
      withProcessTimeout(
        Effect.gen(function* () {
          const result = yield* provideBun(BashTool.effect({ command: "cd /tmp && pwd" }, stubCtx))

          expect(result.stdout.trim()).toMatch(/\/tmp$/)
          expect(result.exitCode).toBe(0)
        }),
      ),
    processTestTimeout,
  )

  it.live(
    "background mode queues a follow-up on completion",
    () =>
      withProcessTimeout(
        Effect.gen(function* () {
          const sent = yield* Deferred.make<{ content: string }>()
          const ctx: ToolContext = {
            ...stubCtx,
            session: {
              ...stubCtx.session,
              queueFollowUp: (params) => Deferred.succeed(sent, params),
            },
          }
          const result = yield* provideBun(
            BashTool.effect(
              { command: "printf background-finished", run_in_background: true },
              ctx,
            ),
          )

          expect(result.exitCode).toBe(0)
          expect(result.stdout).toContain("Command started in background")

          const message = yield* Deferred.await(sent).pipe(Effect.timeout("2 seconds"))
          expect(message.content).toContain("Background command completed (exit code 0)")
          expect(message.content).toContain("$ printf background-finished")
        }),
      ),
    processTestTimeout,
  )
})
