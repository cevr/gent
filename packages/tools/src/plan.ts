import { Effect, Schema } from "effect"
import { FileSystem, Path } from "@effect/platform"
import { defineTool, PlanHandler } from "@gent/core"

export const PlanParams = Schema.Struct({
  plan: Schema.String.annotations({
    description: "The plan to present (markdown supported)",
  }),
  title: Schema.optional(Schema.String).annotations({
    description: "Optional title for the plan",
  }),
  path: Schema.optional(Schema.String).annotations({
    description: "Optional path to save the plan markdown",
  }),
})

export const PlanResult = Schema.Struct({
  decision: Schema.Literal("confirm", "reject"),
  planPath: Schema.String,
})

const defaultPlanPath = (sessionId: string, toolCallId: string) =>
  `${process.cwd()}/.gent/plans/${sessionId}-${toolCallId}.md`

export const PlanTool = defineTool({
  name: "plan",
  description:
    "Present a plan for confirmation using the plan UI. The plan is saved to disk and shown inline as markdown.",
  params: PlanParams,
  execute: Effect.fn("PlanTool.execute")(function* (params, ctx) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const planHandler = yield* PlanHandler

    const resolvedPath = path.resolve(params.path ?? defaultPlanPath(ctx.sessionId, ctx.toolCallId))
    const planText =
      params.title !== undefined ? `# ${params.title}\n\n${params.plan}` : params.plan

    yield* fs.makeDirectory(path.dirname(resolvedPath), { recursive: true })
    yield* fs.writeFileString(resolvedPath, planText)

    const decision = yield* planHandler.present({
      sessionId: ctx.sessionId,
      branchId: ctx.branchId,
      planPath: resolvedPath,
      prompt: planText,
    })

    return { decision, planPath: resolvedPath }
  }),
})
