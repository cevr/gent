import { Effect, Schema } from "effect"
import { defineTool } from "../../domain/tool.js"
import { AgentRunnerService, getDurableAgentRunSessionId } from "../../domain/agent.js"
import { requireAgent } from "../../runtime/extensions/registry.js"
import { RuntimePlatform } from "../../runtime/runtime-platform.js"

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
    const runner = yield* AgentRunnerService
    const platform = yield* RuntimePlatform

    const agent = yield* requireAgent("finder")
    const result = yield* runner.run({
      agent,
      prompt: params.query,
      parentSessionId: ctx.sessionId,
      parentBranchId: ctx.branchId,
      toolCallId: ctx.toolCallId,
      cwd: platform.cwd,
    })

    if (result._tag === "error") {
      const sessionId = getDurableAgentRunSessionId(result)
      const ref = sessionId !== undefined ? `\n\nFull session: session://${sessionId}` : ""
      return { found: false, error: `${result.error}${ref}` }
    }

    const sessionId = getDurableAgentRunSessionId(result)

    const parts = [result.text]
    if (result.savedPath !== undefined) parts.push(`\n\nFull output: ${result.savedPath}`)
    if (sessionId !== undefined) parts.push(`\n\nFull session: session://${sessionId}`)

    return {
      found: true,
      response: parts.join(""),
      metadata: {
        sessionId,
        agentName: result.agentName,
        usage: result.usage,
        toolCalls: result.toolCalls,
      },
    }
  }),
})
