import { Effect, Schema } from "effect"
import { defineTool } from "../domain/tool.js"

// Handoff Tool Error

export class HandoffError extends Schema.TaggedErrorClass<HandoffError>()("HandoffError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// Handoff Tool Params

export const HandoffParams = Schema.Struct({
  context: Schema.String.annotate({
    description:
      "Distilled context for the new session. Include: current task, key decisions, relevant files, open questions, and any state that needs to carry over. This becomes the initial prompt.",
  }),
  reason: Schema.optional(
    Schema.String.annotate({
      description: "Why handoff is needed (e.g. context window filling up)",
    }),
  ),
})

// Handoff Tool

export const HandoffTool = defineTool({
  name: "handoff",
  concurrency: "serial",
  description:
    "Create a new session with distilled context from the current one. Use when context is getting large and you want to continue with a clean slate while preserving key information. Blocks until the user confirms.",
  promptSnippet: "Transfer context to a new session",
  promptGuidelines: [
    "ONLY use when context is getting large and you need a clean slate",
    "Include all essential context — the new session starts fresh",
  ],
  params: HandoffParams,
  execute: Effect.fn("HandoffTool.execute")(function* (params, ctx) {
    // Use summarizer agent to refine context if it's large
    let summary = params.context
    if (params.context.length > 2000) {
      const summarizer = yield* ctx.agent.require("summarizer")
      const summarizeResult = yield* ctx.agent.run({
        agent: summarizer,
        prompt: `Distill this context for a handoff to a new session. Preserve: current task, key decisions, relevant files, open questions, state to carry over. Be concise.\n\n${params.context}`,
        toolCallId: ctx.toolCallId,
      })
      if (summarizeResult._tag === "success") {
        summary = summarizeResult.text
      }
    }

    // Present handoff to user via ctx.interaction.approve() — blocks until confirmed or rejected
    const decision = yield* ctx.interaction.approve({
      text: summary,
      metadata: { type: "handoff", reason: params.reason },
    })

    if (!decision.approved) {
      return {
        handoff: false,
        reason: "User rejected handoff",
      }
    }

    return {
      handoff: true,
      summary,
      reason: params.reason,
      parentSessionId: ctx.sessionId,
    }
  }),
})
