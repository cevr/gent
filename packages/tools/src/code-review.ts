import { Effect, Schema } from "effect"
import { Agents, SubagentRunnerService, defineTool } from "@gent/core"

// Code Review Error

export class CodeReviewError extends Schema.TaggedErrorClass<CodeReviewError>()("CodeReviewError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// Review comment schema

export const ReviewComment = Schema.Struct({
  file: Schema.String,
  line: Schema.optional(Schema.Number),
  severity: Schema.Literals(["critical", "high", "medium", "low"]),
  type: Schema.Literals(["bug", "suggestion", "style"]),
  text: Schema.String,
  fix: Schema.optional(Schema.String),
})
export type ReviewComment = typeof ReviewComment.Type

export const ReviewOutput = Schema.Array(ReviewComment)

// Code Review Params

export const CodeReviewParams = Schema.Struct({
  description: Schema.String.annotate({
    description: "What was changed and why — guides the review focus",
  }),
  files: Schema.optional(
    Schema.Array(Schema.String).annotate({
      description: "Specific file paths to review (otherwise reviews git diff)",
    }),
  ),
  diff_spec: Schema.optional(
    Schema.String.annotate({
      description: "Git diff spec, e.g. 'HEAD~3' or 'main...feature' (default: staged + unstaged)",
    }),
  ),
})

// Code Review Tool

export const CodeReviewTool = defineTool({
  name: "code_review",
  concurrency: "serial",
  description:
    "Spawn a sub-agent to review code changes. Returns structured comments with severity levels.",
  params: CodeReviewParams,
  execute: Effect.fn("CodeReviewTool.execute")(function* (params, ctx) {
    const runner = yield* SubagentRunnerService

    const filesStr =
      params.files !== undefined && params.files.length > 0
        ? `\nFiles to review:\n${params.files.map((f) => `- ${f}`).join("\n")}`
        : ""

    const diffSpec = params.diff_spec ?? "HEAD"

    const prompt = `Review the following code changes.

Description: ${params.description}
${filesStr}

Steps:
1. Run \`git diff ${diffSpec}\` to see the changes${params.files !== undefined ? ", focusing on the specified files" : ""}
2. Read any files you need more context on
3. Produce your review as a JSON array of comments

Each comment must have: file, line (optional), severity (critical/high/medium/low), type (bug/suggestion/style), text, fix (optional).
Output ONLY the JSON array, no other text.`

    const result = yield* runner.run({
      agent: Agents.reviewer,
      prompt,
      parentSessionId: ctx.sessionId,
      parentBranchId: ctx.branchId,
      cwd: process.cwd(),
    })

    if (result._tag === "error") {
      const ref =
        result.sessionId !== undefined ? `\n\nFull session: session://${result.sessionId}` : ""
      return { error: `${result.error}${ref}`, comments: [] }
    }

    // Try to parse structured output
    const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(ReviewOutput))
    const comments = yield* decode(result.text).pipe(
      Effect.catch(() => Effect.succeed([] as readonly ReviewComment[])),
    )

    const sessionRef = `\n\nFull session: session://${result.sessionId}`

    if (comments.length === 0) {
      return {
        comments: [],
        raw: result.text + sessionRef,
        metadata: { sessionId: result.sessionId, agentName: result.agentName },
      }
    }

    const summary = { critical: 0, high: 0, medium: 0, low: 0 }
    for (const c of comments) {
      summary[c.severity]++
    }

    return {
      comments,
      summary,
      session: `session://${result.sessionId}`,
      metadata: { sessionId: result.sessionId, agentName: result.agentName },
    }
  }),
})
