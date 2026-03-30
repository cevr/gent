import { defineClientExtension } from "@gent/core/domain/extension-client.js"
import { AutoGoalOverlay } from "../auto-goal-overlay"

export default defineClientExtension({
  id: "@gent/auto",
  setup: (ctx) => ({
    overlays: [
      {
        id: "auto-goal",
        component: AutoGoalOverlay,
      },
    ],
    commands: [
      {
        id: "auto.toggle",
        title: "Toggle Auto Mode",
        category: "Auto",
        keybind: "shift+tab",
        slash: "auto",
        onSelect: () => {
          // If auto is active → cancel. If inactive → open goal input overlay.
          const snap = ctx.getSnapshot("auto")
          const model = snap?.model as { active?: boolean } | undefined
          if (model?.active) {
            ctx.sendIntent("auto", { _tag: "CancelAuto" })
          } else {
            ctx.openOverlay("auto-goal")
          }
        },
      },
    ],
  }),
})
