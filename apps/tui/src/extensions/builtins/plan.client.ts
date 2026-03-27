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
    ],
  }),
})
