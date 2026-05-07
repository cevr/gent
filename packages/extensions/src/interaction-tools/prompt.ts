import { Effect, Schema } from "effect"
import { tool, ToolNeeds } from "@gent/core/extensions/api"

// Prompt Params — single object shape because Anthropic rejects top-level anyOf tool inputs.

export const PromptParams = Schema.Struct({
  mode: Schema.Literals(["present", "confirm", "review"]).annotate({
    description: "present: show information, confirm: ask yes/no, review: persist editable content",
  }),
  content: Schema.String.annotate({
    description: "Markdown content to display, confirm, or review",
  }),
  title: Schema.optionalKey(Schema.String).annotate({
    description: "Optional title",
  }),
})

// Prompt Result — discriminated union on mode

const PresentResult = Schema.Struct({
  mode: Schema.Literal("present"),
  status: Schema.Literal("shown"),
})

const ConfirmResult = Schema.Struct({
  mode: Schema.Literal("confirm"),
  decision: Schema.Literals(["yes", "no"]),
})

const ReviewResult = Schema.Struct({
  mode: Schema.Literal("review"),
  decision: Schema.Literals(["yes", "no", "edit"]),
  path: Schema.String,
  content: Schema.optional(Schema.String),
})

export const PromptResult = Schema.Union([PresentResult, ConfirmResult, ReviewResult])

export const PromptTool = tool({
  id: "prompt",
  needs: [ToolNeeds.write("interaction")],
  description:
    "Present content to the user for review, confirmation, or informational display. " +
    "Use mode=present for informational content (no response needed), " +
    "mode=confirm for yes/no decisions, " +
    "mode=review for content that should be persisted and can be edited by the user.",
  params: PromptParams,
  output: PromptResult,
  execute: Effect.fn("PromptTool.execute")(function* (params, ctx) {
    if (params.mode === "present") {
      yield* ctx.interaction.present({
        content: params.content,
        title: params.title,
      })
      return { mode: "present" as const, status: "shown" as const }
    }

    if (params.mode === "confirm") {
      const decision = yield* ctx.interaction.confirm({
        content: params.content,
        title: params.title,
      })
      return { mode: "confirm" as const, decision }
    }

    // review mode
    const result = yield* ctx.interaction.review({
      content: params.content,
      title: params.title,
      fileNameSeed: ctx.toolCallId,
    })

    return {
      mode: "review" as const,
      ...result,
    }
  }),
})
