import { Effect, Schema } from "effect"
import type { AgentDefinition } from "../domain/agent.js"
import { defineTool, type ToolContext } from "../domain/tool.js"
import type { ExtensionHostContext } from "../domain/extension-host-context.js"
import { requireText } from "../runtime/workflow-helpers.js"

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
      description: "plan-only: produce and present a plan, fix: single-cycle plan + execute",
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

const runPlanningCycle = Effect.fn("runPlanningCycle")(function* (params: {
  ctx: ExtensionHostContext
  architect: AgentDefinition
  toolCallId?: string
  mode: "plan-only" | "fix"
  prompt: string
  context?: string
  files?: ReadonlyArray<string>
  evaluatorFeedback?: string
}) {
  const { ctx } = params
  const [modelA, modelB] = yield* ctx.agent.resolveDualModelPair()

  const runAgent = (prompt: string, modelId: typeof modelA) =>
    ctx.agent.run({
      agent: params.architect,
      prompt,
      toolCallId: params.toolCallId as never,
      overrides: { modelId },
    })

  const planPrompt = buildPlanPrompt(
    params.prompt,
    params.context,
    params.files,
    params.evaluatorFeedback,
  )
  const [planResultA, planResultB] = yield* Effect.all(
    [runAgent(planPrompt, modelA), runAgent(planPrompt, modelB)] as const,
    { concurrency: 2 },
  )
  const planA = yield* requireText(planResultA, "plan-A")
  const planB = yield* requireText(planResultB, "plan-B")

  const [reviewResultOfB, reviewResultOfA] = yield* Effect.all(
    [
      runAgent(buildReviewPrompt(planB), modelA),
      runAgent(buildReviewPrompt(planA), modelB),
    ] as const,
    { concurrency: 2 },
  )
  const reviewOfB = yield* requireText(reviewResultOfB, "review-A-to-B")
  const reviewOfA = yield* requireText(reviewResultOfA, "review-B-to-A")

  const [revisedResultA, revisedResultB] = yield* Effect.all(
    [
      runAgent(buildIncorporatePrompt(planA, reviewOfA), modelA),
      runAgent(buildIncorporatePrompt(planB, reviewOfB), modelB),
    ] as const,
    { concurrency: 2 },
  )
  const revisedA = yield* requireText(revisedResultA, "incorporate-A")
  const revisedB = yield* requireText(revisedResultB, "incorporate-B")

  const synthesisResult = yield* runAgent(
    buildSynthesizePrompt(revisedA, revisedB, params.mode),
    modelA,
  )
  const synthesizedPlan = yield* requireText(synthesisResult, "synthesize")

  return synthesizedPlan
})

export const PlanTool = defineTool({
  name: "plan",
  action: "delegate" as const,
  concurrency: "serial" as const,
  description:
    "Create an adversarial implementation plan. Default mode presents the plan. Fix mode runs one plan+execute cycle. Use @gent/auto for iterative refinement.",
  params: PlanParams,
  execute: Effect.fn("PlanTool.execute")(function* (params, ctx: ToolContext) {
    const mode = params.mode ?? "plan-only"

    const architect = yield* ctx.agent.require("architect")
    const callerAgentName = ctx.agentName ?? "cowork"
    const executor = yield* ctx.agent.require(callerAgentName)

    // Adversarial planning cycle (always runs)
    const synthesizedPlan = yield* runPlanningCycle({
      ctx,
      architect,
      toolCallId: ctx.toolCallId,
      mode,
      prompt: params.prompt,
      context: params.context,
      files: params.files,
    })

    if (mode === "plan-only") {
      const reviewResult = yield* ctx.interaction.review({
        content: synthesizedPlan,
        title: "Implementation Plan",
        fileNameSeed: ctx.toolCallId,
      })

      return {
        mode,
        decision: reviewResult.decision,
        plan:
          reviewResult.decision === "edit"
            ? (reviewResult.content ?? synthesizedPlan)
            : synthesizedPlan,
        path: reviewResult.path,
      }
    }

    // Fix mode: single cycle — plan + execute. Agent uses @gent/auto for iteration.
    const execResult = yield* ctx.agent.run({
      agent: executor,
      prompt: buildExecutePrompt(synthesizedPlan),
      toolCallId: ctx.toolCallId,
    })
    const execOutput = execResult._tag === "success" ? execResult.text : "Execution failed."

    return { mode, plan: synthesizedPlan, output: execOutput }
  }),
})
