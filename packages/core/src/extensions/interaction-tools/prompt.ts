import { Effect, Schema } from "effect"
import { defineTool } from "../../domain/tool.js"

// Prompt Params — discriminated union on mode

const PresentParams = Schema.Struct({
  mode: Schema.Literal("present"),
  content: Schema.String.annotate({
    description: "Markdown content to display",
  }),
  title: Schema.optional(Schema.String).annotate({
    description: "Optional title",
  }),
})

const ConfirmParams = Schema.Struct({
  mode: Schema.Literal("confirm"),
  content: Schema.String.annotate({
    description: "Markdown content requiring yes/no confirmation",
  }),
  title: Schema.optional(Schema.String).annotate({
    description: "Optional title",
  }),
})

const ReviewParams = Schema.Struct({
  mode: Schema.Literal("review"),
  content: Schema.String.annotate({
    description: "Markdown content for review (persisted to disk, editable)",
  }),
  title: Schema.optional(Schema.String).annotate({
    description: "Optional title",
  }),
})

export const PromptParams = Schema.Union([PresentParams, ConfirmParams, ReviewParams])

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

export const PromptTool = defineTool({
  name: "prompt",
  concurrency: "serial",
  description:
    "Present content to the user for review, confirmation, or informational display. " +
    "Use mode=present for informational content (no response needed), " +
    "mode=confirm for yes/no decisions, " +
    "mode=review for content that should be persisted and can be edited by the user.",
  params: PromptParams,
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
