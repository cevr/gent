import { AutoPackage } from "@gent/core/extensions/auto-package.js"
import { AutoProtocol } from "@gent/core/extensions/auto-protocol.js"
import { AutoGoalOverlay } from "../auto-goal-overlay"

export default AutoPackage.tui((ctx) => ({
  borderLabels: [
    {
      position: "top-left" as const,
      priority: 20,
      produce: () => {
        const model = ctx.getSnapshot()
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
        const model = ctx.getSnapshot()
        if (model?.active) {
          ctx.send(AutoProtocol.CancelAuto())
        } else {
          ctx.openOverlay("auto-goal")
        }
      },
    },
  ],
}))
