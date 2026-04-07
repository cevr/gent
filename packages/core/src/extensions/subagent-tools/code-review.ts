import { Effect, Schema } from "effect"
import { getDurableAgentRunSessionId, type AgentDefinition } from "../../domain/agent.js"
import { defineTool, type ToolContext } from "../../domain/tool.js"
import type { ExtensionHostContext } from "../../domain/extension-host-context.js"
import { requireText, runCommand as runCommandBase } from "../../runtime/workflow-helpers.js"

export class CodeReviewError extends Schema.TaggedErrorClass<CodeReviewError>()("CodeReviewError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

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

export const CodeReviewParams = Schema.Struct({
  description: Schema.optional(
    Schema.String.annotate({
      description: "What changed and why — guides the review focus",
    }),
  ),
  content: Schema.optional(
    Schema.String.annotate({
      description: "Explicit content to review directly instead of reading git diff",
    }),
  ),
  files: Schema.optional(
    Schema.Array(Schema.String).annotate({
      description: "Specific file paths to review",
    }),
  ),
  diff_spec: Schema.optional(
    Schema.String.annotate({
      description: "Git diff spec, e.g. 'HEAD~3' or 'main...feature' (default: unstaged diff)",
    }),
  ),
  mode: Schema.optional(
    Schema.Literals(["report", "fix"]).annotate({
      description: "report: findings only, fix: single-cycle review + apply",
    }),
  ),
})

const decodeReviewComments = (text: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(ReviewOutput))(text).pipe(
    Effect.catchEager(() => Effect.succeed([])),
  )

const summarizeComments = (comments: ReadonlyArray<ReviewComment>) => {
  const summary = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const comment of comments) {
    summary[comment.severity]++
  }
  return summary
}

const runShellCommand = (cmd: string[], cwd: string) =>
  runCommandBase(cmd, cwd).pipe(
    Effect.filterOrFail(
      (out) => out !== "",
      () => new CodeReviewError({ message: `Failed to run command: ${cmd.join(" ")}` }),
    ),
  )

const resolveReviewInput = (
  params: {
    content?: string
    files?: ReadonlyArray<string>
    diffSpec?: string
  },
  cwd: string,
) => {
  if (params.content !== undefined && params.content.trim() !== "") {
    return Effect.succeed(params.content)
  }

  const args =
    params.diffSpec !== undefined
      ? ["git", "diff", params.diffSpec]
      : ["git", "diff", "--", ...(params.files ?? [])]

  if (params.diffSpec !== undefined && params.files !== undefined && params.files.length > 0) {
    args.push("--", ...params.files)
  }

  return runShellCommand(args, cwd)
}

const buildReviewPrompt = (reviewInput: string, description?: string) =>
  [
    "Review the following code changes adversarially.",
    ...(description !== undefined && description !== "" ? ["", "## Intent", description] : []),
    "",
    "## Changes",
    reviewInput,
    "",
    "## Instructions",
    "Find bugs, regressions, edge cases, and weak assumptions.",
    "Return ONLY a JSON array of comments with shape:",
    '[{"file":"path","line":123,"severity":"critical|high|medium|low","type":"bug|suggestion|style","text":"...","fix":"optional"}]',
  ].join("\n")

const buildAdversarialPrompt = (peerReview: string, reviewInput: string, description?: string) =>
  [
    "Critique this review. Challenge assumptions, re-score overblown findings, and surface what it missed.",
    ...(description !== undefined && description !== "" ? ["", "## Intent", description] : []),
    "",
    "## Changes",
    reviewInput,
    "",
    "## Peer Review",
    peerReview,
    "",
    "## Instructions",
    "Return ONLY a JSON array using the same comment schema.",
    "Do not repeat findings unless you are correcting them.",
  ].join("\n")

const buildSynthesisPrompt = (
  reviewA: string,
  reviewB: string,
  critiqueOfA: string,
  critiqueOfB: string,
  reviewInput: string,
  description?: string,
) =>
  [
    "Synthesize these adversarial reviews into the final review result.",
    ...(description !== undefined && description !== "" ? ["", "## Intent", description] : []),
    "",
    "## Changes",
    reviewInput,
    "",
    "## Review A",
    reviewA,
    "",
    "## Review B",
    reviewB,
    "",
    "## Critique Of A",
    critiqueOfA,
    "",
    "## Critique Of B",
    critiqueOfB,
    "",
    "## Instructions",
    "Return ONLY the final JSON array of comments.",
    "Deduplicate. Keep the strongest evidence-backed findings.",
    "Group by file proximity for executor batching.",
  ].join("\n")

const buildExecutePrompt = (comments: ReadonlyArray<ReviewComment>, description?: string) =>
  [
    "Fix the issues identified in this review.",
    ...(description !== undefined && description !== "" ? ["", "## Intent", description] : []),
    "",
    "## Findings",
    JSON.stringify(comments, null, 2),
    "",
    "## Instructions",
    "Work through the findings in small batches grouped by file or dependency.",
    "Apply the fixes directly.",
    "Preserve behavior unless the finding requires a change.",
    "Summarize what you changed, which findings are done, and what remains.",
  ].join("\n")

const runReviewCycle = Effect.fn("runReviewCycle")(function* (params: {
  ctx: ExtensionHostContext
  reviewer: AgentDefinition
  toolCallId?: string
  reviewInput: string
  description?: string
}) {
  const { ctx } = params
  const [modelA, modelB] = yield* ctx.agent.resolveDualModelPair()
  const reviewPrompt = buildReviewPrompt(params.reviewInput, params.description)
  const reviewOverrides = {
    allowedTools: ["grep", "glob", "read", "memory_search"] as const,
    deniedTools: ["bash"] as const,
  }

  const runAgent = (prompt: string, modelId: typeof modelA) =>
    ctx.agent.run({
      agent: params.reviewer,
      prompt,
      toolCallId: params.toolCallId as never,
      overrides: { ...reviewOverrides, modelId },
    })

  const [reviewResultA, reviewResultB] = yield* Effect.all(
    [runAgent(reviewPrompt, modelA), runAgent(reviewPrompt, modelB)] as const,
    { concurrency: 2 },
  )
  const reviewA = yield* requireText(reviewResultA, "review-A")
  const reviewB = yield* requireText(reviewResultB, "review-B")

  const [critiqueResultOfA, critiqueResultOfB] = yield* Effect.all(
    [
      runAgent(buildAdversarialPrompt(reviewA, params.reviewInput, params.description), modelB),
      runAgent(buildAdversarialPrompt(reviewB, params.reviewInput, params.description), modelA),
    ] as const,
    { concurrency: 2 },
  )
  const critiqueOfA = yield* requireText(critiqueResultOfA, "critique-of-A")
  const critiqueOfB = yield* requireText(critiqueResultOfB, "critique-of-B")

  const synthesisResult = yield* runAgent(
    buildSynthesisPrompt(
      reviewA,
      reviewB,
      critiqueOfA,
      critiqueOfB,
      params.reviewInput,
      params.description,
    ),
    modelA,
  )
  const raw = yield* requireText(synthesisResult, "synthesize")
  const comments = yield* decodeReviewComments(raw)

  return {
    comments,
    raw,
    sessionId:
      synthesisResult._tag === "success" ? getDurableAgentRunSessionId(synthesisResult) : undefined,
  }
})

export const CodeReviewTool = defineTool({
  name: "code_review",
  action: "delegate" as const,
  concurrency: "serial" as const,
  description:
    "Run adversarial dual-model code review. Report mode returns findings. Fix mode runs one review+execute cycle. Use @gent/auto for iterative refinement.",
  promptSnippet: "Adversarial dual-model code review",
  promptGuidelines: [
    "report mode for read-only review, fix mode for single-cycle review+apply",
    "Use report mode as a per-batch gate: after implementation, before commit",
    "For iterative review loops, start @gent/auto then call code_review each iteration",
    "Pass description to guide review focus",
  ],
  params: CodeReviewParams,
  execute: Effect.fn("CodeReviewTool.execute")(function* (params, ctx: ToolContext) {
    const mode = params.mode ?? "report"

    const reviewer = yield* ctx.agent.require("reviewer")
    const callerAgentName = ctx.agentName ?? "cowork"
    const executor = yield* ctx.agent.require(callerAgentName)

    const reviewInput = yield* resolveReviewInput(
      {
        content: params.content,
        files: params.files,
        diffSpec: params.diff_spec,
      },
      ctx.cwd,
    )

    // Adversarial review cycle (always runs)
    const report = yield* runReviewCycle({
      ctx,
      reviewer,
      toolCallId: ctx.toolCallId,
      reviewInput,
      description: params.description,
    })
    const summary = summarizeComments(report.comments)

    if (mode === "report") {
      return {
        mode,
        comments: report.comments,
        summary,
        raw: report.raw,
        session: report.sessionId !== undefined ? `session://${report.sessionId}` : undefined,
      }
    }

    // Fix mode: single cycle — review + execute. Agent uses @gent/auto for iteration.
    if (report.comments.length === 0) {
      return { mode, comments: [], summary, raw: report.raw, output: "No findings to fix." }
    }

    const execResult = yield* ctx.agent.run({
      agent: executor,
      prompt: buildExecutePrompt(report.comments, params.description),
      toolCallId: ctx.toolCallId,
    })
    const execOutput = execResult._tag === "success" ? execResult.text : "Execution failed."

    return { mode, comments: report.comments, summary, raw: report.raw, output: execOutput }
  }),
})
