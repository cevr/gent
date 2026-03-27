import { defineClientExtension } from "@gent/core/domain/extension-client.js"
import { AutoWidget } from "../auto-widget"

export default defineClientExtension({
  id: "@gent/auto",
  setup: (ctx) => ({
    widgets: [
      {
        id: "auto",
        slot: "above-input",
        priority: 5,
        component: AutoWidget,
      },
    ],
    commands: [
      {
        id: "auto.toggle",
        title: "Toggle Auto Mode",
        category: "Auto",
        keybind: "ctrl+shift+a",
        slash: "auto",
        onSelect: () => {
          // Toggle: if active → cancel, if inactive → start
          ctx.sendIntent("auto", { _tag: "ToggleAuto" })
        },
      },
    ],
  }),
})
