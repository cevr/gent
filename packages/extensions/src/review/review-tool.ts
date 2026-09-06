import { Effect, Option, Schema } from "effect"
import {
  AgentDefinition,
  AgentName,
  CapabilityError,
  DEFAULT_AGENT_NAME,
  defineExtension,
  ExtensionId,
  ExtensionContext,
  getDurableAgentRunSessionId,
  makeRunSpec,
  request,
  requireAgent,
  resolveDualModelPair,
  tool,
  type ToolCallId,
} from "@gent/core/extensions/api"
import { requireText, runCommand as runCommandBase } from "../workflow-helpers.js"
import { saveArtifactBestEffort } from "../artifacts/store.js"

export class ReviewError extends Schema.TaggedError<ReviewError>()("ReviewError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

const REVIEW_EXTENSION_ID = ExtensionId.make("@gent/review")

export const ReviewComment = Schema.Struct({
  file: Schema.String,
  line: Schema.optional(Schema.Finite),
  severity: Schema.Literals(["critical", "high", "medium", "low"]),
  type: Schema.Literals(["bug", "suggestion", "style"]),
  text: Schema.String,
  fix: Schema.optional(Schema.String),
})
export type ReviewComment = typeof ReviewComment.Type

export const ReviewOutput = Schema.Array(ReviewComment)
const encodeReviewOutput = Schema.encodeSync(Schema.fromJsonString(ReviewOutput))

export const ReviewParams = Schema.Struct({
  description: Schema.optionalKey(
    Schema.String.annotate({
      description: "What changed and why — guides the review focus",
    }),
  ),
  content: Schema.optionalKey(
    Schema.String.annotate({
      description: "Explicit content to review directly instead of reading git diff",
    }),
  ),
  files: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description: "Specific file paths to review",
    }),
  ),
  diff_spec: Schema.optionalKey(
    Schema.String.annotate({
      description: "Git diff spec, e.g. 'HEAD~3' or 'main...feature' (default: unstaged diff)",
    }),
  ),
  mode: Schema.optionalKey(
    Schema.Literals(["report", "fix"]).annotate({
      description: "report: findings only, fix: single-cycle review + apply",
    }),
  ),
})

export const ReviewResult = Schema.Struct({
  mode: Schema.Literals(["report", "fix"]),
  comments: ReviewOutput,
  summary: Schema.Struct({
    critical: Schema.Finite,
    high: Schema.Finite,
    medium: Schema.Finite,
    low: Schema.Finite,
  }),
  raw: Schema.String,
  session: Schema.optional(Schema.String),
  output: Schema.optional(Schema.String),
})

const REVIEW_AGENT_PROMPT = `
Reviewer agent. Examine code changes for bugs, security issues, and improvements.
Run git diff or read specified files, then produce a structured review.

Output format: JSON array of comments. Each comment:
- file: path to file
- line: line number (optional)
- severity: critical | high | medium | low
- type: bug | suggestion | style
- text: description of the issue
- fix: suggested fix (optional)

Severity definitions:
- critical: will cause data loss, security breach, or crash in production
- high: likely bug or regression that affects correctness
- medium: code smell, missed edge case, or maintainability concern
- low: style, naming, or minor improvement

Ground every finding in a specific file and line.
Prioritize root cause over symptoms.
Flag backwards compat / legacy shims as architectural issues.

Only output the JSON array, no other text.
`.trim()

const reviewAgent = AgentDefinition.make({
  name: AgentName.make("review-worker"),
  allowedTools: ["grep", "glob", "read", "memory_search"],
  systemPromptAddendum: REVIEW_AGENT_PROMPT,
})

const decodeReviewComments = (text: string) =>
  Schema.decodeEffect(Schema.fromJsonString(ReviewOutput))(text).pipe(
    Effect.catchEager((cause) =>
      Effect.logWarning("review.decodeComments.failed").pipe(
        Effect.annotateLogs({ error: String(cause), rawLength: text.length }),
        Effect.flatMap(() =>
          Effect.fail(
            new ReviewError({
              message: `Review output was not valid JSON (${text.length} chars). Agent should retry with stricter format instructions.`,
            }),
          ),
        ),
      ),
    ),
  )

const summarizeComments = (comments: ReadonlyArray<ReviewComment>) => {
  const summary = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const comment of comments) {
    summary[comment.severity]++
  }
  return summary
}

const runShellCommand = (cmd: string[]) =>
  runCommandBase(cmd).pipe(
    Effect.filterOrFail(
      (out) => out !== "",
      () => new ReviewError({ message: `Failed to run command: ${cmd.join(" ")}` }),
    ),
  )

const resolveReviewInput = (params: {
  content?: string
  files?: ReadonlyArray<string>
  diffSpec?: string
}) => {
  const content = Option.fromNullishOr(params.content)
  if (Option.isSome(content) && content.value.trim() !== "") {
    return Effect.succeed(content.value)
  }

  const diffSpec = Option.fromNullishOr(params.diffSpec)
  const files = Option.getOrElse(Option.fromNullishOr(params.files), () => [])
  let args = ["git", "diff", "--", ...files]
  if (Option.isSome(diffSpec)) args = ["git", "diff", diffSpec.value]

  if (Option.isSome(diffSpec) && files.length > 0) {
    args.push("--", ...files)
  }

  return runShellCommand(args)
}

const intentSection = (description: Option.Option<string>): ReadonlyArray<string> => {
  if (Option.isSome(description) && description.value !== "") {
    return ["", "## Intent", description.value]
  }
  return []
}

const buildReviewPrompt = (reviewInput: string, description?: string) =>
  [
    "Review the following code changes adversarially.",
    ...intentSection(Option.fromNullishOr(description)),
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
    ...intentSection(Option.fromNullishOr(description)),
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
    ...intentSection(Option.fromNullishOr(description)),
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
    ...intentSection(Option.fromNullishOr(description)),
    "",
    "## Findings",
    encodeReviewOutput(comments),
    "",
    "## Instructions",
    "Work through the findings in small batches grouped by file or dependency.",
    "Apply the fixes directly.",
    "Preserve behavior unless the finding requires a change.",
    "Summarize what you changed, which findings are done, and what remains.",
  ].join("\n")

const runReviewCycle = Effect.fn("runReviewCycle")(function* (params: {
  worker: AgentDefinition
  toolCallId?: ToolCallId
  reviewInput: string
  description?: string
}) {
  const ctx = yield* ExtensionContext
  const agents = yield* ctx.Agent.listAgents
  const [modelA, modelB] = yield* resolveDualModelPair(agents)
  const reviewPrompt = buildReviewPrompt(params.reviewInput, params.description)
  const reviewOverrides = {
    allowedTools: ["grep", "glob", "read", "memory_search"],
    deniedTools: ["bash"],
  }

  const runAgent = (prompt: string, modelId: typeof modelA) =>
    ctx.Agent.run({
      agent: params.worker,
      prompt,
      runSpec: makeRunSpec({
        persistence: "ephemeral",
        parentToolCallId: params.toolCallId,
        overrides: { ...reviewOverrides, modelId },
      }),
    })

  const [reviewResultA, reviewResultB] = yield* Effect.all(
    [runAgent(reviewPrompt, modelA), runAgent(reviewPrompt, modelB)],
    { concurrency: 2 },
  )
  const reviewA = yield* requireText(reviewResultA, "review-A")
  const reviewB = yield* requireText(reviewResultB, "review-B")

  const [critiqueResultOfA, critiqueResultOfB] = yield* Effect.all(
    [
      runAgent(buildAdversarialPrompt(reviewA, params.reviewInput, params.description), modelB),
      runAgent(buildAdversarialPrompt(reviewB, params.reviewInput, params.description), modelA),
    ],
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
  let sessionId = Option.none<ReturnType<typeof getDurableAgentRunSessionId>>()
  if (synthesisResult._tag === "success") {
    sessionId = Option.fromNullishOr(getDurableAgentRunSessionId(synthesisResult))
  }

  return {
    comments,
    raw,
    sessionId,
  }
})

export const ReviewTool = tool({
  id: "review",
  description:
    "Run adversarial dual-model code review. Report mode returns findings. Fix mode runs one review+execute cycle. Use @gent/auto for iterative refinement.",
  promptSnippet: "Adversarial dual-model code review",
  promptGuidelines: [
    "report mode for read-only review, fix mode for single-cycle review+apply",
    "Use report mode as a per-batch gate: after implementation, before commit",
    "For iterative review loops, start @gent/auto then call review each iteration",
    "Pass description to guide review focus",
  ],
  params: ReviewParams,
  output: ReviewResult,
  execute: Effect.fn("ReviewTool.execute")(function* (params) {
    const ctx = yield* ExtensionContext
    const mode = params.mode ?? "report"

    const callerAgentName = ctx.agentName ?? DEFAULT_AGENT_NAME
    const executor = yield* requireAgent(callerAgentName)

    const reviewInput = yield* resolveReviewInput({
      content: params.content,
      files: params.files,
      diffSpec: params.diff_spec,
    })

    // Adversarial review cycle (always runs)
    const report = yield* runReviewCycle({
      worker: reviewAgent,
      toolCallId: ctx.toolCallId,
      reviewInput,
      description: params.description,
    })
    const summary = summarizeComments(report.comments)

    // Persist as artifact for prompt projection
    yield* saveArtifactBestEffort(ctx.sessionId, ctx.branchId, {
      label: `Review: ${summary.critical + summary.high + summary.medium + summary.low} findings`,
      sourceTool: "review",
      content: report.raw,
      metadata: { summary, commentCount: report.comments.length },
    })

    if (mode === "report") {
      return {
        mode,
        comments: report.comments,
        summary,
        raw: report.raw,
        session: Option.getOrUndefined(
          report.sessionId.pipe(Option.map((id) => `session://${id}`)),
        ),
      }
    }

    // Fix mode: single cycle — review + execute. Agent uses @gent/auto for iteration.
    if (report.comments.length === 0) {
      return { mode, comments: [], summary, raw: report.raw, output: "No findings to fix." }
    }

    // Executor applies fixes — durable so the user can navigate to the child session.
    const execResult = yield* ctx.Agent.run({
      agent: executor,
      prompt: buildExecutePrompt(report.comments, params.description),
      runSpec: makeRunSpec({ persistence: "durable", parentToolCallId: ctx.toolCallId }),
    })
    let execOutput = "Execution failed."
    if (execResult._tag === "success") execOutput = execResult.text

    return { mode, comments: report.comments, summary, raw: report.raw, output: execOutput }
  }),
})

export const ReviewExtension = defineExtension({
  id: REVIEW_EXTENSION_ID,
  requests: [
    request({
      id: "review-command",
      description: "Run adversarial dual-model code review",
      slash: {
        trigger: "review",
        name: "Review",
        description: "Run adversarial dual-model code review",
        category: "Tools",
      },
      input: Schema.String,
      output: Schema.Void,
      execute: (input: string) =>
        Effect.gen(function* () {
          const ctx = yield* ExtensionContext
          let content =
            "Use the review tool in report mode on the most recent changes. Focus on correctness, edge cases, and architectural issues."
          if (input.trim().length > 0) {
            content = `Use the review tool in report mode: ${input.trim()}`
          }
          yield* ctx.Session.queueFollowUp({
            sourceId: "review-command",
            content,
          })
        }).pipe(
          Effect.mapError(
            (cause) =>
              new CapabilityError({
                extensionId: REVIEW_EXTENSION_ID,
                capabilityId: "review-command",
                reason: cause.message,
              }),
          ),
        ),
    }),
  ],
  tools: [ReviewTool],
})
