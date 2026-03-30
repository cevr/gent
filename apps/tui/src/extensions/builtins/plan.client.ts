import { defineClientExtension } from "@gent/core/domain/extension-client.js"
import { PlanWidget } from "../plan-widget"

export default defineClientExtension({
  id: "@gent/plan",
  setup: (ctx) => ({
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
          ctx.sendIntent("plan", { _tag: "TogglePlan" })
        },
        onSlash: (args) => {
          if (args.trim().length > 0) {
            // /plan <prompt> → tool invocation
            ctx.sendMessage(
              `Use the plan tool to create an implementation plan for: ${args.trim()}`,
            )
          } else {
            // /plan → toggle plan mode (same as palette)
            ctx.sendIntent("plan", { _tag: "TogglePlan" })
          }
        },
      },
      {
        id: "plan.execute",
        title: "Execute Plan",
        category: "Plan",
        onSelect: () => {
          ctx.sendIntent("plan", { _tag: "ExecutePlan" })
        },
      },
      {
        id: "plan.refine",
        title: "Refine Plan",
        category: "Plan",
        onSelect: () => {
          ctx.sendIntent("plan", { _tag: "RefinePlan" })
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
