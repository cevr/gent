import { Effect } from "effect"
import { defineExtension, type ToolsVisibleInput } from "../domain/extension.js"
import type { AnyToolDefinition } from "../domain/tool.js"
import { LoopTool, LoopEvaluationTool } from "../tools/loop.js"
import { PlanTool } from "../tools/plan.js"
import { AuditTool } from "../tools/audit.js"

export const WorkflowToolsExtension = defineExtension({
  manifest: { id: "@gent/workflow-tools" },
  setup: () =>
    Effect.succeed({
      tools: [LoopTool, PlanTool, AuditTool],
      hooks: {
        "tools.visible": (
          input: ToolsVisibleInput,
          next: (i: ToolsVisibleInput) => Effect.Effect<ReadonlyArray<AnyToolDefinition>>,
        ) => {
          if (input.runContext.tags?.includes("loop-evaluation")) {
            return next({ ...input, tools: [...input.tools, LoopEvaluationTool] })
          }
          return next(input)
        },
      },
    }),
})
