import {
  borderLabelContribution,
  clientCommandContribution,
  overlayContribution,
} from "@gent/core/domain/extension-client.js"
import { AutoPackage } from "@gent/extensions/auto-package.js"
import { AutoProtocol } from "@gent/extensions/auto-protocol.js"
import { AutoGoalOverlay } from "../auto-goal-overlay"

export default AutoPackage.tui((ctx) => [
  borderLabelContribution({
    position: "top-left",
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
  }),
  overlayContribution({
    id: "auto-goal",
    component: AutoGoalOverlay,
  }),
  clientCommandContribution({
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
  }),
])
