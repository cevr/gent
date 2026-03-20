import { Effect, Schema, FileSystem } from "effect"
import { Agents, AgentDefinition, SubagentRunnerService, defineTool } from "@gent/core"

// Counsel Tool Error

export class CounselError extends Schema.TaggedErrorClass<CounselError>()("CounselError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// Counsel Tool Params

export const CounselParams = Schema.Struct({
  prompt: Schema.String.annotate({
    description: "The question or review request for the opposite-vendor model",
  }),
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
  concurrency: "serial",
  description:
    "Get an adversarial peer review from the opposite vendor model. If you're running on Anthropic (cowork), counsel runs on OpenAI (deepwork), and vice versa. Use for architecture reviews, bug hunts, or second opinions.",
  params: CounselParams,
  execute: Effect.fn("CounselTool.execute")(function* (params, ctx) {
    const runner = yield* SubagentRunnerService
    const fs = yield* FileSystem.FileSystem

    // Resolve opposite agent with read-only tool restriction
    const current = ctx.agentName ?? "cowork"
    if (current !== "cowork" && current !== "deepwork") {
      return { error: `Counsel requires a primary agent (cowork/deepwork), got: ${current}` }
    }
    const base = current === "cowork" ? Agents.deepwork : Agents.cowork
    // Spawn with restricted tools — counsel is read-only, no mutations
    const opposite = new AgentDefinition({
      ...base,
      kind: "subagent",
      allowedTools: ["read", "grep", "glob", "bash"],
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

    const contextStr = params.context !== undefined ? `\n\nContext: ${params.context}` : ""

    // Build adversarial prompt
    const adversarialPrompt = `You are reviewing work done by ${current === "cowork" ? "Anthropic Claude" : "OpenAI Codex"}. Your job is to be a rigorous, adversarial peer reviewer.

Review request: ${params.prompt}${contextStr}${fileContext}

Instructions:
- Challenge assumptions. Find what's wrong, not what's right.
- Ground every claim in specific file paths and line numbers.
- If something looks correct, say so briefly and move on.
- Focus on: correctness, edge cases, race conditions, missing error handling, architectural issues.
- Be direct and evidence-based. Back claims with file paths and reasoning.`

    const result = yield* runner.run({
      agent: opposite,
      prompt: adversarialPrompt,
      parentSessionId: ctx.sessionId,
      parentBranchId: ctx.branchId,
      cwd: process.cwd(),
    })

    if (result._tag === "error") {
      const ref =
        result.sessionId !== undefined ? `\n\nFull session: session://${result.sessionId}` : ""
      return { error: `${result.error}${ref}` }
    }

    return {
      review: `${result.text}\n\nFull session: session://${result.sessionId}`,
      reviewer: opposite.name,
      metadata: { sessionId: result.sessionId, agentName: result.agentName, usage: result.usage },
    }
  }),
})
