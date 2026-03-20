import { Effect, Schema, FileSystem } from "effect"
import { Agents, SubagentRunnerService, defineTool } from "@gent/core"

// Oracle Tool Error

export class OracleError extends Schema.TaggedErrorClass<OracleError>()("OracleError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// Oracle Tool Params

export const OracleParams = Schema.Struct({
  task: Schema.String.annotate({
    description: "The technical question, problem, or analysis to perform",
  }),
  context: Schema.optional(
    Schema.String.annotate({
      description: "Additional context for the analysis",
    }),
  ),
  files: Schema.optional(
    Schema.Array(Schema.String).annotate({
      description: "File paths to read and include inline as context",
    }),
  ),
})

// Oracle Tool

export const OracleTool = defineTool({
  name: "oracle",
  concurrency: "serial",
  description:
    "Route hard problems (architecture, debugging, complex planning) to a stronger reasoning model. Optionally reads files inline for focused context.",
  params: OracleParams,
  execute: Effect.fn("OracleTool.execute")(function* (params, ctx) {
    const runner = yield* SubagentRunnerService
    const fs = yield* FileSystem.FileSystem

    // Inline file contents into prompt
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
    const prompt = `${params.task}${contextStr}${fileContext}`

    const result = yield* runner.run({
      agent: Agents.oracle,
      prompt,
      parentSessionId: ctx.sessionId,
      parentBranchId: ctx.branchId,
      cwd: process.cwd(),
    })

    if (result._tag === "error") {
      return { error: result.error }
    }

    return {
      output: `${result.text}\n\nFull session: session://${result.sessionId}`,
      metadata: { sessionId: result.sessionId, agentName: result.agentName },
    }
  }),
})
