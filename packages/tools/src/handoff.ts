import { Effect, Schema } from "effect"
import { defineTool, SubagentRunnerService, Agents } from "@gent/core"

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
    "Create a new session with distilled context from the current one. Use when context is getting large and you want to continue with a clean slate while preserving key information.",
  params: HandoffParams,
  execute: Effect.fn("HandoffTool.execute")(function* (params, ctx) {
    const runner = yield* SubagentRunnerService

    // Use the title agent to generate a name for the handoff session
    const nameResult = yield* runner.run({
      agent: Agents.title,
      prompt: `Generate a 3-5 word lowercase title for a session continuing this work:\n\n${params.context.slice(0, 300)}`,
      parentSessionId: ctx.sessionId,
      parentBranchId: ctx.branchId,
      cwd: process.cwd(),
    })

    const sessionName =
      nameResult._tag === "success"
        ? nameResult.text.trim().replace(/['"]/g, "")
        : "handoff session"

    return {
      handoff: true,
      context: params.context,
      reason: params.reason,
      sessionName,
      parentSessionId: ctx.sessionId,
    }
  }),
})
