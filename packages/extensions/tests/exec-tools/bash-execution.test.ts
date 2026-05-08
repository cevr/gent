import { describe, it, expect } from "effect-bun-test"
import { Deferred, Effect, Layer, Path } from "effect"
import { BunChildProcessSpawner, BunFileSystem } from "@effect/platform-bun"
import { BashTool } from "@gent/extensions/exec-tools/bash"
import { BranchId, SessionId, ToolCallId } from "@gent/core/domain/ids"
import type { ToolCapabilityContext } from "@gent/core/domain/capability/tool"
import { getToolEffect } from "@gent/core/domain/capability/tool"
import { testExtensionHostContext } from "@gent/core/test-utils"

const makePlatformLayer = () =>
  Layer.mergeAll(
    BunFileSystem.layer,
    Path.layer,
    BunChildProcessSpawner.layer.pipe(Layer.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
  )
const provideBun = <A, E, R>(e: Effect.Effect<A, E, R>) =>
  Effect.provide(e, makePlatformLayer()) as Effect.Effect<A, E, never>

const processTestTimeout = 5_000
const withProcessTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.timeout("4 seconds"))

const dieStub = (label: string) => () => Effect.die(`${label} not wired in test`)

const stubCtx: ToolCapabilityContext = {
  sessionId: SessionId.make("test-session"),
  branchId: BranchId.make("test-branch"),
  toolCallId: ToolCallId.make("tc-1"),
  cwd: process.cwd(),
  home: "/tmp",
  host: testExtensionHostContext().host,
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
          const result = yield* provideBun(
            getToolEffect(BashTool)({ command: "echo hello" }, stubCtx),
          )

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
          const result = yield* provideBun(getToolEffect(BashTool)({ command: "exit 2" }, stubCtx))

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
            getToolEffect(BashTool)({ command: "pwd", cwd: "/tmp" }, stubCtx),
          )

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
          const result = yield* provideBun(
            getToolEffect(BashTool)({ command: "cd /tmp && pwd" }, stubCtx),
          )

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
          const ctx: ToolCapabilityContext = {
            ...stubCtx,
            session: {
              ...stubCtx.session,
              queueFollowUp: (params) => Deferred.succeed(sent, params),
            },
          }
          const result = yield* provideBun(
            getToolEffect(BashTool)(
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
