import { defineClientExtension } from "@gent/core/domain/extension-client.js"
import { PLAN_EXTENSION_ID, PlanUiModel } from "@gent/core/extensions/plan.js"
import { PlanProtocol } from "@gent/core/extensions/plan-protocol.js"
import { PlanWidget } from "../plan-widget"

export default defineClientExtension({
  id: "@gent/plan",
  setup: (ctx) => ({
    borderLabels: [
      {
        position: "top-left" as const,
        priority: 30,
        produce: () => {
          const model = ctx.getSnapshot(PLAN_EXTENSION_ID, PlanUiModel)
          if (model?.mode === "plan") return [{ text: "plan", color: "primary" }]
          if (model?.mode === "executing") {
            const p = model.progress
            const label = p ? `exec ${p.completed}/${p.total}` : "exec"
            return [{ text: label, color: "primary" }]
          }
          return []
        },
      },
      {
        position: "bottom-left" as const,
        priority: 40,
        produce: () => {
          const model = ctx.getSnapshot(PLAN_EXTENSION_ID, PlanUiModel)
          if (model?.mode === "plan") return [{ text: "plan", color: "primary" }]
          if (model?.mode === "executing") {
            const p = model.progress
            const label = p ? `exec ${p.completed}/${p.total}` : "exec"
            return [{ text: label, color: "primary" }]
          }
          return []
        },
      },
    ],
    widgets: [
      {
        id: "plan",
        slot: "above-input",
        priority: 10,
        component: PlanWidget,
      },
    ],
    commands: [
      {
        id: "plan.toggle",
        title: "Toggle Plan Mode",
        category: "Plan",
        keybind: "ctrl+shift+p",
        slash: "plan",
        onSelect: () => {
          ctx.send(PlanProtocol.TogglePlan())
        },
        onSlash: (args) => {
          if (args.trim().length > 0) {
            // /plan <prompt> → tool invocation
            ctx.sendMessage(
              `Use the plan tool to create an implementation plan for: ${args.trim()}`,
            )
          } else {
            // /plan → toggle plan mode (same as palette)
            ctx.send(PlanProtocol.TogglePlan())
          }
        },
      },
      {
        id: "plan.execute",
        title: "Execute Plan",
        category: "Plan",
        onSelect: () => {
          ctx.send(PlanProtocol.ExecutePlan())
        },
      },
      {
        id: "plan.refine",
        title: "Refine Plan",
        category: "Plan",
        onSelect: () => {
          ctx.send(PlanProtocol.RefinePlan())
        },
      },
      {
        id: "plan.audit",
        title: "Audit",
        description: "Detect, audit, fix code issues",
        category: "Workflow",
        slash: "audit",
        onSelect: () =>
          ctx.sendMessage(
            "Use the audit tool to audit the current changes. Detects concerns, audits in parallel, synthesizes findings, and applies fixes.",
          ),
        onSlash: (args) =>
          ctx.sendMessage(
            args.trim().length > 0
              ? `Use the audit tool to audit: ${args.trim()}`
              : "Use the audit tool to audit the current changes. Detects concerns, audits in parallel, synthesizes findings, and applies fixes.",
          ),
      },
    ],
  }),
})
