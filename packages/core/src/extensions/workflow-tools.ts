import { Effect } from "effect"
import { defineExtension } from "../domain/extension.js"
import { LoopTool, LoopEvaluationTool } from "../tools/loop.js"
import { PlanTool } from "../tools/plan.js"
import { AuditTool } from "../tools/audit.js"

export const WorkflowToolsExtension = defineExtension({
  manifest: { id: "@gent/workflow-tools" },
  setup: () =>
    Effect.succeed({
      tools: [LoopTool, PlanTool, AuditTool],
      tagInjections: [{ tag: "loop-evaluation", tools: [LoopEvaluationTool] }],
    }),
})
