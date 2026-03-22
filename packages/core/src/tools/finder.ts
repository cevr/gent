import { Effect, Schema } from "effect"
import { defineTool } from "../domain/tool.js"
import { Agents, SubagentRunnerService } from "../domain/agent.js"

// Finder Tool Error

export class FinderError extends Schema.TaggedErrorClass<FinderError>()("FinderError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// Finder Tool Params

export const FinderParams = Schema.Struct({
  query: Schema.String.annotate({
    description: "What to search for in the codebase — can be a concept, pattern, or specific code",
  }),
})

// Finder Tool

export const FinderTool = defineTool({
  name: "finder",
  action: "delegate",
  concurrency: "serial",
  idempotent: true,
  description:
    "Delegate a multi-step codebase search to a fast sub-agent. Use when you need to find something that requires chaining multiple grep/read/glob calls.",
  params: FinderParams,
  execute: Effect.fn("FinderTool.execute")(function* (params, ctx) {
    const runner = yield* SubagentRunnerService

    const result = yield* runner.run({
      agent: Agents.finder,
      prompt: params.query,
      parentSessionId: ctx.sessionId,
      parentBranchId: ctx.branchId,
      toolCallId: ctx.toolCallId,
      cwd: process.cwd(),
    })

    if (result._tag === "error") {
      const ref =
        result.sessionId !== undefined ? `\n\nFull session: session://${result.sessionId}` : ""
      return { found: false, error: `${result.error}${ref}` }
    }

    return {
      found: true,
      response: `${result.text}\n\nFull session: session://${result.sessionId}`,
      metadata: {
        sessionId: result.sessionId,
        agentName: result.agentName,
        usage: result.usage,
        toolCalls: result.toolCalls,
      },
    }
  }),
})
