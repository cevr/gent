import { defineClientExtension } from "@gent/core/domain/extension-client.js"
import { AUTO_EXTENSION_ID } from "@gent/core/extensions/auto.js"
import { AutoProtocol } from "@gent/core/extensions/auto-protocol.js"
import { AutoGoalOverlay } from "../auto-goal-overlay"

export default defineClientExtension({
  id: "@gent/auto",
  setup: (ctx) => ({
    borderLabels: [
      {
        position: "top-left" as const,
        priority: 20,
        produce: () => {
          const snap = ctx.getSnapshot(AUTO_EXTENSION_ID)
          const model = snap?.model as
            | { active?: boolean; phase?: string; iteration?: number; maxIterations?: number }
            | undefined
          if (!model?.active) return []
          const phase = model.phase === "awaiting-review" ? "review" : "auto"
          const iter =
            model.iteration !== undefined ? ` ${model.iteration}/${model.maxIterations ?? "?"}` : ""
          return [
            {
              text: `${phase}${iter}`,
              color: model.phase === "awaiting-review" ? "warning" : "info",
            },
          ]
        },
      },
    ],
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
          const snap = ctx.getSnapshot(AUTO_EXTENSION_ID)
          const model = snap?.model as { active?: boolean } | undefined
          if (model?.active) {
            ctx.send(AutoProtocol.CancelAuto())
          } else {
            ctx.openOverlay("auto-goal")
          }
        },
      },
    ],
  }),
})
