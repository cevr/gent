import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { narrowR } from "../../../core/tests/helpers/effect"

import { AskUserTool } from "../../src/interaction-tools/ask-user.js"
import { BranchId, SessionId, ToolCallId } from "@gent/core-internal/domain/ids"
import { testToolContext } from "@gent/core-internal/test-utils/extension-harness"
import { runToolWithCtx } from "@gent/core-internal/test-utils"

const makeCtx = (
  decision: Effect.Effect<{ readonly approved: boolean; readonly notes?: string }>,
) => {
  const interaction = {
    approve: () => decision,
    present: () => Effect.die("not wired"),
    confirm: () => Effect.die("not wired"),
    review: () => Effect.die("not wired"),
  }
  return {
    ctx: testToolContext({
      sessionId: SessionId.make("test-session"),
      branchId: BranchId.make("test-branch"),
      toolCallId: ToolCallId.make("test-call"),
      cwd: "/tmp",
      home: "/tmp",
      Interaction: interaction,
    }),
    interaction,
  } satisfies {
    readonly ctx: ReturnType<typeof testToolContext>
    readonly interaction: typeof interaction
  }
}

describe("AskUser Tool", () => {
  it.live("asks questions and returns answers", () => {
    const { ctx } = makeCtx(Effect.succeed({ approved: true, notes: "Option A" }))

    return runToolWithCtx(
      AskUserTool,
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

  it.live("decodes structured JSON answers from notes", () => {
    const { ctx } = makeCtx(
      Effect.succeed({ approved: true, notes: '[["Option A","Option B"],["Option C"]]' }),
    )

    return runToolWithCtx(
      AskUserTool,
      {
        questions: [
          { question: "Pick first set", options: [{ label: "Option A" }, { label: "Option B" }] },
          { question: "Pick second", options: [{ label: "Option C" }] },
        ],
      },
      ctx,
    ).pipe(
      Effect.map((result) => {
        expect(result.answers).toEqual([["Option A", "Option B"], ["Option C"]])
        expect(result.cancelled).toBeUndefined()
      }),
      narrowR,
    )
  })

  it.live("falls back to wrapping raw notes when JSON is malformed", () => {
    const { ctx } = makeCtx(Effect.succeed({ approved: true, notes: "not-json {{{" }))

    return runToolWithCtx(AskUserTool, { questions: [{ question: "Free-form?" }] }, ctx).pipe(
      Effect.map((result) => {
        expect(result.answers).toEqual([["not-json {{{"]])
      }),
      narrowR,
    )
  })

  it.live("cancel returns cancelled flag with empty answers", () => {
    const { ctx } = makeCtx(Effect.succeed({ approved: false }))

    return runToolWithCtx(
      AskUserTool,
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
