import { Effect, Schema, FileSystem } from "effect"
import { Agents, SubagentRunnerService, defineTool } from "@gent/core"

// Look At Error

export class LookAtError extends Schema.TaggedErrorClass<LookAtError>()("LookAtError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// Look At Params

export const LookAtParams = Schema.Struct({
  path: Schema.String.annotate({
    description: "Path to the file to analyze (image, document, or code)",
  }),
  objective: Schema.String.annotate({
    description: "What to analyze or look for in the file",
  }),
  context: Schema.optional(
    Schema.String.annotate({
      description: "Additional context about the file or what it represents",
    }),
  ),
  referenceFiles: Schema.optional(
    Schema.Array(Schema.String).annotate({
      description: "Additional file paths to compare against the main file",
    }),
  ),
})

// Look At Tool

export const LookAtTool = defineTool({
  name: "look_at",
  concurrency: "serial",
  description:
    "Analyze a file (image, document, code) using a sub-agent. Supports comparison with reference files.",
  params: LookAtParams,
  execute: Effect.fn("LookAtTool.execute")(function* (params, ctx) {
    const runner = yield* SubagentRunnerService
    const fs = yield* FileSystem.FileSystem

    // Verify main file exists
    const exists = yield* fs.exists(params.path)
    if (!exists) {
      return yield* new LookAtError({ message: `File not found: ${params.path}` })
    }

    // Build prompt
    const promptParts: string[] = [`Read the file at "${params.path}" using the read tool.`]

    if (params.referenceFiles !== undefined) {
      for (const ref of params.referenceFiles) {
        promptParts.push(`Also read the reference file at "${ref}".`)
      }
    }

    if (params.context !== undefined) {
      promptParts.push(`\nContext: ${params.context}`)
    }

    promptParts.push(`\nAnalyze with this objective: ${params.objective}`)

    if (params.referenceFiles !== undefined && params.referenceFiles.length > 0) {
      promptParts.push(
        `\nCompare the main file against the reference file(s). Identify all differences and similarities.`,
      )
    }

    const result = yield* runner.run({
      agent: Agents.explore,
      prompt: promptParts.join("\n"),
      parentSessionId: ctx.sessionId,
      parentBranchId: ctx.branchId,
      toolCallId: ctx.toolCallId,
      cwd: process.cwd(),
    })

    if (result._tag === "error") {
      const ref =
        result.sessionId !== undefined ? `\n\nFull session: session://${result.sessionId}` : ""
      return { error: `${result.error}${ref}` }
    }

    return {
      output: `${result.text}\n\nFull session: session://${result.sessionId}`,
      metadata: { path: params.path, sessionId: result.sessionId, agentName: result.agentName },
    }
  }),
})
