import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"

const narrowR = <A, E, R>(e: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> =>
  e as Effect.Effect<A, E, never>
import { AskUserTool } from "@gent/extensions/interaction-tools/ask-user"
import type { ToolCapabilityContext } from "@gent/core/domain/capability/tool"
import { BranchId, SessionId, ToolCallId } from "@gent/core/domain/ids"
import { testToolContext } from "@gent/core/test-utils/extension-harness"
import { getToolEffect } from "@gent/core/domain/capability/tool"

const makeCtx = (
  decision: Effect.Effect<{ readonly approved: boolean; readonly notes?: string }>,
): ToolCapabilityContext =>
  testToolContext({
    sessionId: SessionId.make("test-session"),
    branchId: BranchId.make("test-branch"),
    toolCallId: ToolCallId.make("test-call"),
    cwd: "/tmp",
    home: "/tmp",
    interaction: {
      approve: () => decision,
      present: () => Effect.die("not wired"),
      confirm: () => Effect.die("not wired"),
      review: () => Effect.die("not wired"),
    },
  })

describe("AskUser Tool", () => {
  it.live("asks questions and returns answers", () => {
    const ctx = makeCtx(Effect.succeed({ approved: true, notes: "Option A" }))

    return getToolEffect(AskUserTool)(
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
    ).pipe(
      Effect.map((result) => {
        expect(result.answers.length).toBe(1)
        expect(result.answers[0]).toEqual(["Option A"])
        expect(result.cancelled).toBeUndefined()
      }),
      narrowR,
    )
  })

  it.live("cancel returns cancelled flag with empty answers", () => {
    const ctx = makeCtx(Effect.succeed({ approved: false }))

    return getToolEffect(AskUserTool)(
      {
        questions: [
          {
            question: "Which approach?",
            options: [{ label: "A" }, { label: "B" }],
          },
        ],
      },
      ctx,
    ).pipe(
      Effect.map((result) => {
        expect(result.cancelled).toBe(true)
        expect(result.answers).toEqual([])
      }),
      narrowR,
    )
  })
})
