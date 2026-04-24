import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { AskUserTool } from "@gent/extensions/interaction-tools/ask-user"
import type { ToolContext } from "@gent/core/domain/tool"
import { ApprovalService } from "../../../src/runtime/approval-service"
import { RuntimePlatform } from "../../../src/runtime/runtime-platform"
import { SessionId, BranchId, ToolCallId } from "@gent/core/domain/ids"
import { testToolContext } from "@gent/core/test-utils/extension-harness"

const makeCtx = (approvalService: {
  present: ToolContext["interaction"]["approve"]
}): ToolContext =>
  testToolContext({
    sessionId: SessionId.make("test-session"),
    branchId: BranchId.make("test-branch"),
    toolCallId: ToolCallId.make("test-call"),
    cwd: "/tmp",
    home: "/tmp",
    interaction: {
      approve: approvalService.present,
      present: () => Effect.die("not wired"),
      confirm: () => Effect.die("not wired"),
      review: () => Effect.die("not wired"),
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
            sessionId: SessionId.make("test-session"),
            branchId: BranchId.make("test-branch"),
          }),
      })

      const result = yield* AskUserTool.effect(
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
            sessionId: SessionId.make("test-session"),
            branchId: BranchId.make("test-branch"),
          }),
      })

      const result = yield* AskUserTool.effect(
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
