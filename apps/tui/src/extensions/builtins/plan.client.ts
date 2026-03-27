import { defineClientExtension } from "@gent/core/domain/extension-client.js"
import { PlanWidget } from "../plan-widget"

export default defineClientExtension({
  id: "@gent/plan",
  setup: () => ({
    widgets: [
      {
        id: "plan",
        slot: "above-input",
        priority: 10,
        component: PlanWidget,
      },
    ],
  }),
})
