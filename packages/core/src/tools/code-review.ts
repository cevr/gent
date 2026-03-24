import { Effect, Schema } from "effect"
import {
  Agents,
  getAdversarialModels,
  SubagentRunnerService,
  type AgentDefinition,
  type SubagentRunner,
} from "../domain/agent.js"
import { EventStore, WorkflowCompleted, WorkflowPhaseStarted } from "../domain/event.js"
import { ExtensionRegistry } from "../runtime/extensions/registry.js"
import { defineWorkflow, type WorkflowContext } from "../domain/workflow.js"
import { runLoop } from "../runtime/loop.js"
import { Storage } from "../storage/sqlite-storage.js"
import {
  extractLoopEvaluation,
  requireText,
  runCommand as runCommandBase,
  workflowResultFromLoopReason,
  type WorkflowRunContext,
} from "./workflow-helpers.js"

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
      description: "report: findings only, fix: apply fixes iteratively",
    }),
  ),
  maxIterations: Schema.optional(
    Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 10 })).annotate({
      description: "Max fix iterations (default 3)",
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

const runCommand = (cmd: string[]) =>
  runCommandBase(cmd).pipe(
    Effect.filterOrFail(
      (out) => out !== "",
      () => new CodeReviewError({ message: `Failed to run command: ${cmd.join(" ")}` }),
    ),
  )

const resolveReviewInput = (params: {
  content?: string
  files?: ReadonlyArray<string>
  diffSpec?: string
}) => {
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

  return runCommand(args)
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

const buildEvaluatePrompt = (executionOutput: string, comments: ReadonlyArray<ReviewComment>) =>
  [
    "Evaluate whether the review findings have been addressed.",
    "",
    "## Original Findings",
    JSON.stringify(comments, null, 2),
    "",
    "## Execution Output",
    executionOutput,
    "",
    "## Instructions",
    "You MUST call the loop_evaluation tool.",
    "- verdict: done when the findings are addressed",
    "- verdict: continue when work remains",
    "- summary: short explanation of remaining issues or confirmation",
  ].join("\n")

const runReviewCycle = Effect.fn("runReviewCycle")(function* (params: {
  runner: SubagentRunner
  reviewer: AgentDefinition
  runnerContext: WorkflowRunContext
  reviewInput: string
  description?: string
  emitPhase: (phase: string) => Effect.Effect<void, never>
}) {
  const [modelA, modelB] = getAdversarialModels()
  const reviewPrompt = buildReviewPrompt(params.reviewInput, params.description)
  const reviewOverrides = {
    allowedActions: ["read"] as const,
    deniedTools: ["bash"] as const,
  }

  yield* params.emitPhase("review")
  const [reviewResultA, reviewResultB] = yield* Effect.all(
    [
      params.runner.run({
        agent: params.reviewer,
        prompt: reviewPrompt,
        ...params.runnerContext,
        overrides: { ...reviewOverrides, modelId: modelA },
      }),
      params.runner.run({
        agent: params.reviewer,
        prompt: reviewPrompt,
        ...params.runnerContext,
        overrides: { ...reviewOverrides, modelId: modelB },
      }),
    ] as const,
    { concurrency: 2 },
  )
  const reviewA = yield* requireText(reviewResultA, "review-A")
  const reviewB = yield* requireText(reviewResultB, "review-B")

  yield* params.emitPhase("adversarial")
  const [critiqueResultOfA, critiqueResultOfB] = yield* Effect.all(
    [
      params.runner.run({
        agent: params.reviewer,
        prompt: buildAdversarialPrompt(reviewA, params.reviewInput, params.description),
        ...params.runnerContext,
        overrides: { ...reviewOverrides, modelId: modelB },
      }),
      params.runner.run({
        agent: params.reviewer,
        prompt: buildAdversarialPrompt(reviewB, params.reviewInput, params.description),
        ...params.runnerContext,
        overrides: { ...reviewOverrides, modelId: modelA },
      }),
    ] as const,
    { concurrency: 2 },
  )
  const critiqueOfA = yield* requireText(critiqueResultOfA, "critique-of-A")
  const critiqueOfB = yield* requireText(critiqueResultOfB, "critique-of-B")

  yield* params.emitPhase("synthesize")
  const synthesisResult = yield* params.runner.run({
    agent: params.reviewer,
    prompt: buildSynthesisPrompt(
      reviewA,
      reviewB,
      critiqueOfA,
      critiqueOfB,
      params.reviewInput,
      params.description,
    ),
    ...params.runnerContext,
    overrides: { ...reviewOverrides, modelId: modelA },
  })
  const raw = yield* requireText(synthesisResult, "synthesize")
  const comments = yield* decodeReviewComments(raw)

  return {
    comments,
    raw,
    sessionId: synthesisResult._tag === "success" ? synthesisResult.sessionId : undefined,
  }
})

export const CodeReviewTool = defineWorkflow({
  name: "code_review",
  description:
    "Run adversarial dual-model code review. Report mode returns findings. Fix mode applies fixes iteratively.",
  command: "code_review",
  promptSnippet: "Adversarial dual-model code review",
  promptGuidelines: [
    "report mode for read-only review, fix mode to auto-apply",
    "Pass description to guide review focus",
  ],
  phases: ["review", "adversarial", "synthesize", "execute", "evaluate"] as const,
  params: CodeReviewParams,
  execute: Effect.fn("CodeReviewTool.execute")(function* (params, ctx: WorkflowContext) {
    const runner = yield* SubagentRunnerService
    const eventStore = yield* EventStore
    const storage = yield* Storage
    const registry = yield* ExtensionRegistry

    const mode = params.mode ?? "report"
    const maxIterations = params.maxIterations ?? 3
    const runnerContext: WorkflowRunContext = {
      parentSessionId: ctx.sessionId,
      parentBranchId: ctx.branchId,
      toolCallId: ctx.toolCallId,
      cwd: process.cwd(),
    }

    const reviewer = (yield* registry.getAgent("reviewer")) ?? Agents.reviewer
    const callerAgentName = ctx.agentName ?? "cowork"
    const executor = (yield* registry.getAgent(callerAgentName)) ?? Agents.cowork

    const emitPhase = (phase: string) =>
      eventStore
        .publish(
          new WorkflowPhaseStarted({
            sessionId: ctx.sessionId,
            branchId: ctx.branchId,
            workflowName: "code_review",
            phase,
          }),
        )
        .pipe(Effect.catchEager(() => Effect.void))

    const emitIterationPhase = (phase: string, iteration: number) =>
      eventStore
        .publish(
          new WorkflowPhaseStarted({
            sessionId: ctx.sessionId,
            branchId: ctx.branchId,
            workflowName: "code_review",
            phase,
            iteration,
            maxIterations,
          }),
        )
        .pipe(Effect.catchEager(() => Effect.void))

    const completeWorkflow = (result: "success" | "rejected" | "error" | "max_iterations") =>
      eventStore
        .publish(
          new WorkflowCompleted({
            sessionId: ctx.sessionId,
            branchId: ctx.branchId,
            workflowName: "code_review",
            result,
          }),
        )
        .pipe(Effect.catchEager(() => Effect.void))

    const reviewInput = yield* resolveReviewInput({
      content: params.content,
      files: params.files,
      diffSpec: params.diff_spec,
    })

    if (mode === "report") {
      const report = yield* runReviewCycle({
        runner,
        reviewer,
        runnerContext,
        reviewInput,
        description: params.description,
        emitPhase,
      })
      const summary = summarizeComments(report.comments)
      yield* completeWorkflow("success")

      return {
        comments: report.comments,
        summary,
        raw: report.raw,
        session: report.sessionId !== undefined ? `session://${report.sessionId}` : undefined,
      }
    }

    let latestComments: ReadonlyArray<ReviewComment> = []

    const loopResult = yield* runLoop({
      maxIterations,
      body: (iteration, _previousOutput, evaluatorFeedback) =>
        Effect.gen(function* () {
          const reviewReport = yield* runReviewCycle({
            runner,
            reviewer,
            runnerContext,
            reviewInput:
              evaluatorFeedback !== undefined && evaluatorFeedback !== ""
                ? `${reviewInput}\n\n## Remaining Issues\n${evaluatorFeedback}`
                : reviewInput,
            description: params.description,
            emitPhase,
          })
          latestComments = reviewReport.comments

          if (reviewReport.comments.length === 0) {
            return {
              _tag: "success" as const,
              text: "[]",
              sessionId: ctx.sessionId,
              agentName: callerAgentName,
            }
          }

          yield* emitIterationPhase("execute", iteration)
          return yield* runner.run({
            agent: executor,
            prompt: buildExecutePrompt(reviewReport.comments, params.description),
            ...runnerContext,
          })
        }),
      evaluate: (iteration, bodyOutput) =>
        Effect.gen(function* () {
          if (latestComments.length === 0) {
            return { verdict: "done" as const, feedback: "No findings remain." }
          }

          yield* emitIterationPhase("evaluate", iteration)
          const evalResult = yield* runner.run({
            agent: reviewer,
            prompt: buildEvaluatePrompt(bodyOutput, latestComments),
            ...runnerContext,
            overrides: {
              allowedActions: ["read"],
              deniedTools: ["bash"],
              tags: ["loop-evaluation"],
            },
          })

          if (evalResult._tag === "error") return { verdict: "done" as const }
          const envelopes = yield* storage
            .listEvents({ sessionId: evalResult.sessionId })
            .pipe(Effect.catchEager(() => Effect.succeed([])))
          return extractLoopEvaluation(envelopes, evalResult.text)
        }),
    })

    yield* completeWorkflow(workflowResultFromLoopReason(loopResult.reason))

    const summary = summarizeComments(latestComments)
    return {
      comments: latestComments,
      summary,
      raw: loopResult.output,
      session: undefined,
      ...(loopResult.error !== undefined ? { error: loopResult.error } : {}),
    }
  }),
})
