import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { AskUserTool } from "@gent/core/extensions/interaction-tools/ask-user"
import type { ToolContext } from "@gent/core/domain/tool"
import { ApprovalService } from "@gent/core/runtime/approval-service"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"
import type { SessionId, BranchId, ToolCallId } from "@gent/core/domain/ids"

const makeCtx = (approvalService: { present: ToolContext["approve"] }): ToolContext => ({
  sessionId: "test-session" as SessionId,
  branchId: "test-branch" as BranchId,
  toolCallId: "test-call" as ToolCallId,
  approve: approvalService.present,
  cwd: "/tmp",
  home: "/tmp",
  extension: {
    send: () => Effect.die("not wired"),
    ask: () => Effect.die("not wired"),
    getUiSnapshots: () => Effect.die("not wired"),
    getUiSnapshot: () => Effect.die("not wired"),
  },
  extensions: {
    send: () => Effect.die("not wired"),
    ask: () => Effect.die("not wired"),
  },
  agent: {
    get: () => Effect.die("not wired"),
    require: () => Effect.die("not wired"),
    run: () => Effect.die("not wired"),
    resolveDualModelPair: () => Effect.die("not wired"),
  },
  session: {
    listMessages: () => Effect.die("not wired"),
    getSession: () => Effect.die("not wired"),
    getDetail: () => Effect.die("not wired"),
    renameCurrent: () => Effect.die("not wired"),
    estimateContextPercent: () => Effect.die("not wired"),
    search: () => Effect.die("not wired"),
  },
  interaction: {
    approve: approvalService.present,
    present: () => Effect.die("not wired"),
    confirm: () => Effect.die("not wired"),
    review: () => Effect.die("not wired"),
  },
  turn: {
    queueFollowUp: () => Effect.die("not wired"),
    interject: () => Effect.die("not wired"),
  },
})

const PlatformLayer = Layer.merge(
  BunServices.layer,
  RuntimePlatform.Test({
    cwd: process.cwd(),
    home: "/tmp/test-home",
    platform: "test",
  }),
)

describe("AskUser Tool", () => {
  it.live("asks questions and returns answers", () => {
    const layer = Layer.merge(
      ApprovalService.Test([{ approved: true, notes: "Option A" }]),
      PlatformLayer,
    )

    return Effect.gen(function* () {
      const approval = yield* ApprovalService
      const ctx = makeCtx({
        present: (params) =>
          approval.present(params, {
            sessionId: "test-session" as SessionId,
            branchId: "test-branch" as BranchId,
          }),
      })

      const result = yield* AskUserTool.execute(
        {
          questions: [
            {
              question: "Which approach?",
              header: "Approach",
              options: [
                { label: "Option A", description: "First option" },
                { label: "Option B", description: "Second option" },
              ],
            },
          ],
        },
        ctx,
      )

      expect(result.answers.length).toBe(1)
      expect(result.answers[0]).toEqual(["Option A"])
      expect(result.cancelled).toBeUndefined()
    }).pipe(Effect.provide(layer))
  })

  it.live("cancel returns cancelled flag with empty answers", () => {
    const layer = Layer.merge(ApprovalService.Test([{ approved: false }]), PlatformLayer)

    return Effect.gen(function* () {
      const approval = yield* ApprovalService
      const ctx = makeCtx({
        present: (params) =>
          approval.present(params, {
            sessionId: "test-session" as SessionId,
            branchId: "test-branch" as BranchId,
          }),
      })

      const result = yield* AskUserTool.execute(
        {
          questions: [
            {
              question: "Which approach?",
              options: [{ label: "A" }, { label: "B" }],
            },
          ],
        },
        ctx,
      )

      expect(result.cancelled).toBe(true)
      expect(result.answers).toEqual([])
    }).pipe(Effect.provide(layer))
  })
})
