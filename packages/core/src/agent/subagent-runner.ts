import { Context, Schema } from "effect"
import type * as Effect from "effect/Effect"
import type { AgentDefinition, AgentName } from "./agent-definition"

export type SubagentResult =
  | {
      _tag: "success"
      text: string
      sessionId: string
      agentName: AgentName
      usage?: { input: number; output: number; cost: number }
    }
  | {
      _tag: "error"
      error: string
      sessionId?: string
      agentName?: AgentName
    }

export class SubagentError extends Schema.TaggedError<SubagentError>()("SubagentError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export interface SubagentRunner {
  readonly run: (params: {
    agent: AgentDefinition
    prompt: string
    parentSessionId: string
    parentBranchId: string
    cwd: string
  }) => Effect.Effect<SubagentResult, SubagentError>
}

export class SubagentRunnerService extends Context.Tag(
  "@gent/core/src/agent/subagent-runner/SubagentRunnerService",
)<SubagentRunnerService, SubagentRunner>() {}
