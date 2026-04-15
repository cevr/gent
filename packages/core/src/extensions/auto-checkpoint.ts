import { Effect, Schema } from "effect"
import { defineTool } from "./api.js"

/**
 * Signal tool for the auto loop extension.
 *
 * The agent calls this to report iteration results. The extension's mapEvent
 * watches for ToolCallSucceeded("auto_checkpoint") and advances the machine.
 */
export const AutoCheckpointTool = defineTool({
  name: "auto_checkpoint",
  concurrency: "serial",
  description:
    "Report your iteration results. Call with status 'continue' to proceed to the next iteration, " +
    "'complete' when the goal is met, or 'abandon' to stop. You MUST call this tool at the end of each iteration.",
  params: Schema.Struct({
    status: Schema.Literals(["continue", "complete", "abandon"]).annotate({
      description: "Whether to continue iterating, mark as complete, or abandon",
    }),
    summary: Schema.String.annotate({
      description: "Brief summary of what happened this iteration",
    }),
    learnings: Schema.optional(
      Schema.String.annotate({
        description: "New insights from this iteration — appended to accumulated learnings",
      }),
    ),
    metrics: Schema.optional(
      Schema.Record(Schema.String, Schema.Number).annotate({
        description: "Optional quantitative tracking (e.g. findings count, coverage %)",
      }),
    ),
    nextIdea: Schema.optional(
      Schema.String.annotate({
        description: "What to try next iteration — injected into the follow-up prompt",
      }),
    ),
  }),
  execute: (params) => Effect.succeed(params),
})
