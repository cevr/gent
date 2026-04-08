import { defineClientExtension } from "@gent/core/domain/extension-client.js"
import { AUTO_EXTENSION_ID, AutoUiModel } from "@gent/core/extensions/auto.js"
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
          const model = ctx.useTypedSnapshot(AUTO_EXTENSION_ID, AutoUiModel)
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
          const model = ctx.useTypedSnapshot(AUTO_EXTENSION_ID, AutoUiModel)
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
