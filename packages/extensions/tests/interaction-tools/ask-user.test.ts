import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { narrowR } from "../../../core/tests/helpers/effect"

import { AskUserTool } from "../../src/interaction-tools/ask-user.js"
import { ExtensionInteraction } from "@gent/core/extensions/api"
import type { ToolCapabilityContext } from "@gent/core-internal/domain/capability/tool"
import { BranchId, SessionId, ToolCallId } from "@gent/core-internal/domain/ids"
import { testToolContext } from "@gent/core-internal/test-utils/extension-harness"
import { getToolEffect } from "@gent/core-internal/domain/capability/tool"

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
      interaction,
    }),
    interaction,
  } satisfies {
    readonly ctx: ToolCapabilityContext
    readonly interaction: typeof interaction
  }
}

describe("AskUser Tool", () => {
  it.live("asks questions and returns answers", () => {
    const { ctx, interaction } = makeCtx(Effect.succeed({ approved: true, notes: "Option A" }))

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
      Effect.provideService(ExtensionInteraction, interaction),
      narrowR,
    )
  })

  it.live("cancel returns cancelled flag with empty answers", () => {
    const { ctx, interaction } = makeCtx(Effect.succeed({ approved: false }))

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
      Effect.provideService(ExtensionInteraction, interaction),
      narrowR,
    )
  })
})
