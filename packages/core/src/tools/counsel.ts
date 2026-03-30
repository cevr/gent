import { Effect, Schema, FileSystem } from "effect"
import { defineTool } from "../domain/tool.js"
import { AgentDefinition, SubagentRunnerService } from "../domain/agent.js"
import { requireAgent } from "../runtime/extensions/registry.js"
import { RuntimePlatform } from "../runtime/runtime-platform.js"

// Counsel Tool Error

export class CounselError extends Schema.TaggedErrorClass<CounselError>()("CounselError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// Counsel Tool Params

export const CounselParams = Schema.Struct({
  prompt: Schema.String.annotate({
    description: "The question or review request for the GPT reviewer",
  }),
  content: Schema.optional(
    Schema.String.annotate({
      description: "Inline content to review directly, such as a diff or patch",
    }),
  ),
  context: Schema.optional(
    Schema.String.annotate({
      description: "Additional context for the review",
    }),
  ),
  files: Schema.optional(
    Schema.Array(Schema.String).annotate({
      description: "File paths to read and include inline as context",
    }),
  ),
})

// Counsel Tool

export const CounselTool = defineTool({
  name: "counsel",
  action: "delegate",
  concurrency: "serial",
  description:
    "Get an adversarial peer review from the GPT reviewer model. Spawns a read-only OpenAI subagent for architecture reviews, bug hunts, or second opinions.",
  params: CounselParams,
  execute: Effect.fn("CounselTool.execute")(function* (params, ctx) {
    const runner = yield* SubagentRunnerService
    const fs = yield* FileSystem.FileSystem
    const platform = yield* RuntimePlatform

    // Always spawn deepwork (GPT) as the adversarial reviewer — read-only, no mutations
    const deepwork = yield* requireAgent("deepwork")
    const reviewer = new AgentDefinition({
      ...deepwork,
      kind: "subagent",
      allowedActions: ["read"],
      deniedTools: ["bash"],
    })

    // Inline file contents (oracle pattern)
    let fileContext = ""
    if (params.files !== undefined && params.files.length > 0) {
      const fileContents = yield* Effect.forEach(
        params.files,
        (filePath) =>
          fs.readFileString(filePath).pipe(
            Effect.map((content) => `File: ${filePath}\n\`\`\`\n${content}\n\`\`\``),
            Effect.catch(() => Effect.succeed(`File: ${filePath}\n(could not read)`)),
          ),
        { concurrency: "unbounded" },
      )
      fileContext = "\n\n" + fileContents.join("\n\n")
    }

    const contentStr =
      params.content !== undefined ? `\n\nContent to review:\n${params.content}` : ""
    const contextStr = params.context !== undefined ? `\n\nContext: ${params.context}` : ""

    // Build adversarial prompt
    const adversarialPrompt = `You are reviewing work done by Anthropic Claude. Your job is to be a rigorous, adversarial peer reviewer.

Review request: ${params.prompt}${contextStr}${contentStr}${fileContext}

Instructions:
- Challenge assumptions. Find what's wrong, not what's right.
- Ground every claim in specific file paths and line numbers.
- If something looks correct, say so briefly and move on.
- Focus on: correctness, edge cases, race conditions, missing error handling, architectural issues.
- Be direct and evidence-based. Back claims with file paths and reasoning.`

    const result = yield* runner.run({
      agent: reviewer,
      prompt: adversarialPrompt,
      parentSessionId: ctx.sessionId,
      parentBranchId: ctx.branchId,
      toolCallId: ctx.toolCallId,
      cwd: platform.cwd,
    })

    if (result._tag === "error") {
      const ref =
        result.sessionId !== undefined ? `\n\nFull session: session://${result.sessionId}` : ""
      return { error: `${result.error}${ref}` }
    }

    return {
      review: `${result.text}\n\nFull session: session://${result.sessionId}`,
      reviewer: reviewer.name,
      metadata: {
        sessionId: result.sessionId,
        agentName: result.agentName,
        usage: result.usage,
        toolCalls: result.toolCalls,
      },
    }
  }),
})
