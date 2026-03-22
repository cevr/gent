import { Effect, Schema } from "effect"
import {
  Agents,
  AgentRegistry,
  getAdversarialModels,
  SubagentError,
  SubagentRunnerService,
} from "../domain/agent.js"
import { EventStore, WorkflowPhaseStarted, WorkflowCompleted } from "../domain/event.js"
import { PromptPresenter } from "../domain/prompt-presenter.js"
import { defineWorkflow, type WorkflowContext } from "../domain/workflow.js"
import type { ModelId } from "../domain/model.js"

export const PlanParams = Schema.Struct({
  prompt: Schema.String.annotate({ description: "What to plan" }),
  context: Schema.optional(
    Schema.String.annotate({ description: "Additional context, file paths, constraints" }),
  ),
  files: Schema.optional(
    Schema.Array(Schema.String).annotate({ description: "Key files to read for context" }),
  ),
})

// Prompt builders

const buildPlanPrompt = (prompt: string, context?: string, files?: ReadonlyArray<string>) => {
  const parts = [`Design an implementation plan for:\n${prompt}`]
  if (context !== undefined) parts.push(`\n## Additional Context\n${context}`)
  if (files !== undefined && files.length > 0)
    parts.push(`\n## Key Files\n${files.map((f) => `- ${f}`).join("\n")}`)
  parts.push(
    "\n## Instructions\nProduce a concrete, actionable plan. Include file paths, code patterns, and ordering. Focus on the critical path.",
  )
  return parts.join("\n")
}

const buildReviewPrompt = (plan: string) =>
  `Review this implementation plan adversarially. Find gaps, risks, incorrect assumptions, missing edge cases, and alternatives the author may not have considered.\n\n## Plan\n${plan}\n\n## Instructions\nBe specific. Reference concrete files or patterns. Don't just say "consider X" — say why X matters and what would break without it.`

const buildIncorporatePrompt = (original: string, review: string) =>
  `Revise your implementation plan based on this adversarial review. Incorporate valid points, rebut weak ones with reasoning.\n\n## Original Plan\n${original}\n\n## Review\n${review}\n\n## Instructions\nProduce the revised plan. Don't include meta-commentary about what changed — just output the improved plan.`

const buildSynthesizePrompt = (planA: string, planB: string) =>
  `Synthesize these two revised implementation plans into a single unified plan. Take the strongest elements from each.\n\n## Plan A\n${planA}\n\n## Plan B\n${planB}\n\n## Instructions\nProduce one coherent plan. Resolve conflicts by choosing the more robust approach. Include file paths and ordering.`

export const PlanTool = defineWorkflow({
  name: "plan",
  description:
    "Create an implementation plan using adversarial dual-model planning. " +
    "Two architects plan independently, cross-review, incorporate feedback, " +
    "then synthesize into a unified plan presented for approval.",
  command: "plan",
  phases: ["plan", "review", "incorporate", "synthesize", "present"] as const,
  params: PlanParams,
  execute: Effect.fn("PlanTool.execute")(function* (params, ctx: WorkflowContext) {
    const runner = yield* SubagentRunnerService
    const eventStore = yield* EventStore
    const presenter = yield* PromptPresenter
    const registry = yield* AgentRegistry
    const [modelA, modelB] = getAdversarialModels()

    const architectDef = yield* registry.get("architect")
    const architect = architectDef ?? Agents.architect

    const emitPhase = (phase: string) =>
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

    const runArchitect = (prompt: string, modelId: ModelId) =>
      runner.run({
        agent: architect,
        prompt,
        parentSessionId: ctx.sessionId,
        parentBranchId: ctx.branchId,
        toolCallId: ctx.toolCallId,
        cwd: process.cwd(),
        overrides: { modelId },
      })

    const requireText = (
      result: { _tag: string; text?: string; error?: string },
      label: string,
    ) => {
      if (result._tag === "error") {
        const err = "error" in result ? String(result.error) : "unknown"
        return Effect.fail(new SubagentError({ message: `Plan ${label} failed: ${err}` }))
      }
      return Effect.succeed("text" in result ? String(result.text) : "")
    }

    // Phase 1: Parallel planning — two architects, different models
    yield* emitPhase("plan")
    const planPrompt = buildPlanPrompt(params.prompt, params.context, params.files)
    const [planResultA, planResultB] = yield* Effect.all(
      [runArchitect(planPrompt, modelA), runArchitect(planPrompt, modelB)] as const,
      { concurrency: 2 },
    )
    const planA = yield* requireText(planResultA, "plan-A")
    const planB = yield* requireText(planResultB, "plan-B")

    // Phase 2: Cross-review — each reviews the other's plan
    yield* emitPhase("review")
    const [reviewResultOfB, reviewResultOfA] = yield* Effect.all(
      [
        runArchitect(buildReviewPrompt(planB), modelA),
        runArchitect(buildReviewPrompt(planA), modelB),
      ] as const,
      { concurrency: 2 },
    )
    const reviewOfB = yield* requireText(reviewResultOfB, "review-A→B")
    const reviewOfA = yield* requireText(reviewResultOfA, "review-B→A")

    // Phase 3: Incorporate — each revises based on the other's review
    yield* emitPhase("incorporate")
    const [incorporateResultA, incorporateResultB] = yield* Effect.all(
      [
        runArchitect(buildIncorporatePrompt(planA, reviewOfA), modelA),
        runArchitect(buildIncorporatePrompt(planB, reviewOfB), modelB),
      ] as const,
      { concurrency: 2 },
    )
    const revisedA = yield* requireText(incorporateResultA, "incorporate-A")
    const revisedB = yield* requireText(incorporateResultB, "incorporate-B")

    // Phase 4: Synthesize — merge both revised plans
    yield* emitPhase("synthesize")
    const synthesisResult = yield* runArchitect(buildSynthesizePrompt(revisedA, revisedB), modelA)
    const synthesizedPlan = yield* requireText(synthesisResult, "synthesize")

    // Phase 5: Present to user for approval
    yield* emitPhase("present")
    const reviewResult = yield* presenter.review({
      sessionId: ctx.sessionId,
      branchId: ctx.branchId,
      content: synthesizedPlan,
      title: "Implementation Plan",
      fileNameSeed: ctx.toolCallId,
    })

    const workflowResult =
      reviewResult.decision === "yes" || reviewResult.decision === "edit" ? "success" : "rejected"

    yield* eventStore
      .publish(
        new WorkflowCompleted({
          sessionId: ctx.sessionId,
          branchId: ctx.branchId,
          workflowName: "plan",
          result: workflowResult,
        }),
      )
      .pipe(Effect.catchEager(() => Effect.void))

    return {
      decision: reviewResult.decision,
      plan:
        reviewResult.decision === "edit"
          ? (reviewResult.content ?? synthesizedPlan)
          : synthesizedPlan,
      path: reviewResult.path,
    }
  }),
})
