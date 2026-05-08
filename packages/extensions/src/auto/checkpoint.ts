import { Effect, Schema } from "effect"
import { tool } from "@gent/core/extensions/api"

/**
 * Signal tool for the auto loop extension.
 *
 * The agent calls this to report iteration results. The extension's tool-result
 * reaction watches for ToolCallSucceeded("auto_checkpoint") and advances the
 * machine.
 */
const AutoCheckpointParams = Schema.Struct({
  status: Schema.Literals(["continue", "complete", "abandon"]).annotate({
    description: "Whether to continue iterating, mark as complete, or abandon",
  }),
  summary: Schema.String.annotate({
    description: "Brief summary of what happened this iteration",
  }),
  learnings: Schema.optionalKey(
    Schema.String.annotate({
      description: "New insights from this iteration — appended to accumulated learnings",
    }),
  ),
  metrics: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Number).annotate({
      description: "Optional quantitative tracking (e.g. findings count, coverage %)",
    }),
  ),
  nextIdea: Schema.optionalKey(
    Schema.String.annotate({
      description: "What to try next iteration — injected into the follow-up prompt",
    }),
  ),
})

export const AutoCheckpointTool = tool({
  id: "auto_checkpoint",
  description:
    "Report your iteration results. Call with status 'continue' to proceed to the next iteration, " +
    "'complete' when the goal is met, or 'abandon' to stop. You MUST call this tool at the end of each iteration.",
  params: AutoCheckpointParams,
  output: AutoCheckpointParams,
  execute: (params) => Effect.succeed(params),
})
