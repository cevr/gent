import { Effect, Schema } from "effect"
import {
  Agents,
  getAdversarialModels,
  SubagentRunnerService,
  type SubagentRunner,
  type AgentDefinition,
} from "../domain/agent.js"
import { ExtensionRegistry } from "../runtime/extensions/registry.js"
import { EventStore, WorkflowCompleted, WorkflowPhaseStarted } from "../domain/event.js"
import { PromptPresenter } from "../domain/prompt-presenter.js"
import { defineWorkflow, type WorkflowContext } from "../domain/workflow.js"
import { runLoop } from "../runtime/loop.js"
import { Storage } from "../storage/sqlite-storage.js"
import {
  extractLoopEvaluation,
  requireText,
  runAdversarialPair,
  workflowResultFromLoopReason,
  type WorkflowRunContext,
} from "../runtime/workflow-helpers.js"

export const PlanParams = Schema.Struct({
  prompt: Schema.String.annotate({ description: "What to plan" }),
  context: Schema.optional(
    Schema.String.annotate({ description: "Additional context, file paths, constraints" }),
  ),
  files: Schema.optional(
    Schema.Array(Schema.String).annotate({ description: "Key files to read for context" }),
  ),
  mode: Schema.optional(
    Schema.Literals(["plan-only", "fix"]).annotate({
      description: "plan-only: produce and present a plan, fix: execute the synthesized plan",
    }),
  ),
  maxIterations: Schema.optional(
    Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 10 })).annotate({
      description: "Max execution iterations in fix mode (default 3)",
    }),
  ),
})

const buildPlanPrompt = (
  prompt: string,
  context?: string,
  files?: ReadonlyArray<string>,
  evaluatorFeedback?: string,
) => {
  const parts = [`Design an implementation plan for:\n${prompt}`]
  if (context !== undefined) parts.push(`## Additional Context\n${context}`)
  if (files !== undefined && files.length > 0) {
    parts.push(`## Key Files\n${files.map((file) => `- ${file}`).join("\n")}`)
  }
  if (evaluatorFeedback !== undefined && evaluatorFeedback !== "") {
    parts.push(`## Remaining Issues From Prior Iteration\n${evaluatorFeedback}`)
  }
  parts.push(
    [
      "## Instructions",
      "Produce a concrete, actionable implementation plan.",
      "Include file paths, ordering, and the main risks.",
      "If prior iteration feedback is present, address it directly.",
    ].join("\n"),
  )
  return parts.join("\n\n")
}

const buildReviewPrompt = (plan: string) =>
  [
    "Review this implementation plan adversarially.",
    "Find missing steps, bad assumptions, invalid sequencing, and hidden risks.",
    "",
    "## Plan",
    plan,
    "",
    "## Instructions",
    "Be specific. Tie critiques to concrete files, dependencies, or failure modes.",
  ].join("\n")

const buildIncorporatePrompt = (original: string, review: string) =>
  [
    "Revise your implementation plan based on this adversarial review.",
    "",
    "## Original Plan",
    original,
    "",
    "## Review",
    review,
    "",
    "## Instructions",
    "Incorporate valid critiques. Reject weak ones implicitly by producing the better plan.",
    "Output only the revised plan.",
  ].join("\n")

const buildSynthesizePrompt = (planA: string, planB: string, mode: "plan-only" | "fix") =>
  [
    mode === "fix"
      ? "Synthesize these two revised implementation plans into one execution plan organized into batches."
      : "Synthesize these two revised implementation plans into one implementation plan.",
    "",
    "## Plan A",
    planA,
    "",
    "## Plan B",
    planB,
    "",
    "## Instructions",
    ...(mode === "fix"
      ? [
          "Organize the output into a small number of ordered batches.",
          "For each batch, include: title, target files, concrete changes, risks, and verification notes.",
          "Take the strongest parts from each. Resolve conflicts. Keep it execution-ready.",
        ]
      : ["Take the strongest parts from each. Resolve conflicts. Keep it execution-ready."]),
  ].join("\n")

const buildExecutePrompt = (plan: string) =>
  [
    "Execute this implementation plan.",
    "",
    "## Plan",
    plan,
    "",
    "## Instructions",
    "Work through the plan batch by batch, in order.",
    "Keep each batch scoped before moving to the next.",
    "Verify as you go.",
    "Summarize what you changed, what batch you reached, and anything still incomplete.",
  ].join("\n")

const buildEvaluatePrompt = (executionOutput: string) =>
  [
    "Evaluate whether the implementation is complete.",
    "",
    "## Execution Output",
    executionOutput,
    "",
    "## Instructions",
    "You MUST call the loop_evaluation tool.",
    "- verdict: done when the work is complete",
    "- verdict: continue when more iteration is needed",
    "- summary: short explanation of what remains or why it is complete",
  ].join("\n")

const runPlanningCycle = Effect.fn("runPlanningCycle")(function* (params: {
  runner: SubagentRunner
  architect: AgentDefinition
  runnerContext: WorkflowRunContext
  mode: "plan-only" | "fix"
  prompt: string
  context?: string
  files?: ReadonlyArray<string>
  evaluatorFeedback?: string
  emitPhase: (phase: string) => Effect.Effect<void, never>
}) {
  const [modelA, modelB] = getAdversarialModels()

  yield* params.emitPhase("plan")
  const planPrompt = buildPlanPrompt(
    params.prompt,
    params.context,
    params.files,
    params.evaluatorFeedback,
  )
  const [planResultA, planResultB] = yield* runAdversarialPair(
    params.runner,
    params.architect,
    planPrompt,
    modelA,
    modelB,
    params.runnerContext,
  )
  const planA = yield* requireText(planResultA, "plan-A")
  const planB = yield* requireText(planResultB, "plan-B")

  yield* params.emitPhase("review")
  const [reviewResultOfB, reviewResultOfA] = yield* Effect.all(
    [
      params.runner.run({
        agent: params.architect,
        prompt: buildReviewPrompt(planB),
        ...params.runnerContext,
        overrides: { modelId: modelA },
      }),
      params.runner.run({
        agent: params.architect,
        prompt: buildReviewPrompt(planA),
        ...params.runnerContext,
        overrides: { modelId: modelB },
      }),
    ] as const,
    { concurrency: 2 },
  )
  const reviewOfB = yield* requireText(reviewResultOfB, "review-A-to-B")
  const reviewOfA = yield* requireText(reviewResultOfA, "review-B-to-A")

  yield* params.emitPhase("incorporate")
  const [revisedResultA, revisedResultB] = yield* Effect.all(
    [
      params.runner.run({
        agent: params.architect,
        prompt: buildIncorporatePrompt(planA, reviewOfA),
        ...params.runnerContext,
        overrides: { modelId: modelA },
      }),
      params.runner.run({
        agent: params.architect,
        prompt: buildIncorporatePrompt(planB, reviewOfB),
        ...params.runnerContext,
        overrides: { modelId: modelB },
      }),
    ] as const,
    { concurrency: 2 },
  )
  const revisedA = yield* requireText(revisedResultA, "incorporate-A")
  const revisedB = yield* requireText(revisedResultB, "incorporate-B")

  yield* params.emitPhase("synthesize")
  const synthesisResult = yield* params.runner.run({
    agent: params.architect,
    prompt: buildSynthesizePrompt(revisedA, revisedB, params.mode),
    ...params.runnerContext,
    overrides: { modelId: modelA },
  })
  const synthesizedPlan = yield* requireText(synthesisResult, "synthesize")

  return synthesizedPlan
})

export const PlanTool = defineWorkflow({
  name: "plan",
  description:
    "Create an adversarial implementation plan. Default mode presents the plan. Fix mode executes it iteratively.",
  command: "plan",
  phases: [
    "plan",
    "review",
    "incorporate",
    "synthesize",
    "present",
    "execute",
    "evaluate",
  ] as const,
  params: PlanParams,
  execute: Effect.fn("PlanTool.execute")(function* (params, ctx: WorkflowContext) {
    const runner = yield* SubagentRunnerService
    const eventStore = yield* EventStore
    const presenter = yield* PromptPresenter
    const registry = yield* ExtensionRegistry

    const mode = params.mode ?? "plan-only"
    const maxIterations = params.maxIterations ?? 3
    const runnerContext: WorkflowRunContext = {
      parentSessionId: ctx.sessionId,
      parentBranchId: ctx.branchId,
      toolCallId: ctx.toolCallId,
      cwd: process.cwd(),
    }

    const architect = (yield* registry.getAgent("architect")) ?? Agents.architect
    const callerAgentName = ctx.agentName ?? "cowork"
    const executor = (yield* registry.getAgent(callerAgentName)) ?? Agents.cowork

    const completeWorkflow = (result: "success" | "rejected" | "error" | "max_iterations") =>
      eventStore
        .publish(
          new WorkflowCompleted({
            sessionId: ctx.sessionId,
            branchId: ctx.branchId,
            workflowName: "plan",
            result,
          }),
        )
        .pipe(Effect.catchEager(() => Effect.void))

    const emitPlanPhase = (phase: string) =>
      eventStore
        .publish(
          new WorkflowPhaseStarted({
            sessionId: ctx.sessionId,
            branchId: ctx.branchId,
            workflowName: "plan",
            phase,
          }),
        )
        .pipe(Effect.catchEager(() => Effect.void))

    const emitPlanIterationPhase = (phase: string, iteration: number) =>
      eventStore
        .publish(
          new WorkflowPhaseStarted({
            sessionId: ctx.sessionId,
            branchId: ctx.branchId,
            workflowName: "plan",
            phase,
            iteration,
            maxIterations,
          }),
        )
        .pipe(Effect.catchEager(() => Effect.void))

    if (mode === "plan-only") {
      const synthesizedPlan = yield* runPlanningCycle({
        runner,
        architect,
        runnerContext,
        mode,
        prompt: params.prompt,
        context: params.context,
        files: params.files,
        emitPhase: emitPlanPhase,
      })

      yield* emitPlanPhase("present")
      const reviewResult = yield* presenter.review({
        sessionId: ctx.sessionId,
        branchId: ctx.branchId,
        content: synthesizedPlan,
        title: "Implementation Plan",
        fileNameSeed: ctx.toolCallId,
      })

      const workflowResult =
        reviewResult.decision === "yes" || reviewResult.decision === "edit" ? "success" : "rejected"
      yield* completeWorkflow(workflowResult)

      return {
        decision: reviewResult.decision,
        plan:
          reviewResult.decision === "edit"
            ? (reviewResult.content ?? synthesizedPlan)
            : synthesizedPlan,
        path: reviewResult.path,
      }
    }

    const storage = yield* Storage

    const loopResult = yield* runLoop({
      maxIterations,
      body: (iteration, _previousOutput, evaluatorFeedback) =>
        Effect.gen(function* () {
          const synthesizedPlan = yield* runPlanningCycle({
            runner,
            architect,
            runnerContext,
            mode,
            prompt: params.prompt,
            context: params.context,
            files: params.files,
            evaluatorFeedback,
            emitPhase: emitPlanPhase,
          })

          yield* emitPlanIterationPhase("execute", iteration)
          return yield* runner.run({
            agent: executor,
            prompt: buildExecutePrompt(synthesizedPlan),
            ...runnerContext,
          })
        }),
      evaluate: (iteration, bodyOutput) =>
        Effect.gen(function* () {
          yield* emitPlanIterationPhase("evaluate", iteration)
          const evalResult = yield* runner.run({
            agent: architect,
            prompt: buildEvaluatePrompt(bodyOutput),
            ...runnerContext,
            overrides: { tags: ["loop-evaluation"] },
          })

          if (evalResult._tag === "error") return { verdict: "done" as const }
          const envelopes = yield* storage
            .listEvents({ sessionId: evalResult.sessionId })
            .pipe(Effect.catchEager(() => Effect.succeed([])))
          return extractLoopEvaluation(envelopes, evalResult.text)
        }),
    })

    yield* completeWorkflow(workflowResultFromLoopReason(loopResult.reason))

    return {
      iterations: loopResult.iterations,
      reason: loopResult.reason,
      output: loopResult.output,
      ...(loopResult.error !== undefined ? { error: loopResult.error } : {}),
    }
  }),
})
