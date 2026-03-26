import { defineClientExtension } from "@gent/core/domain/extension-client.js"
import { PlanModeWidget } from "../plan-mode-widget"

export default defineClientExtension({
  id: "@gent/plan-mode",
  setup: () => ({
    widgets: [
      {
        id: "plan-mode",
        slot: "above-input",
        priority: 10,
        component: PlanModeWidget,
      },
    ],
  }),
})
