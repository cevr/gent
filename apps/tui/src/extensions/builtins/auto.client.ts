import { defineClientExtension } from "@gent/core/domain/extension-client.js"
import { AutoWidget } from "../auto-widget"

export default defineClientExtension({
  id: "@gent/auto",
  setup: () => ({
    widgets: [
      {
        id: "auto",
        slot: "above-input",
        priority: 5,
        component: AutoWidget,
      },
    ],
  }),
})
