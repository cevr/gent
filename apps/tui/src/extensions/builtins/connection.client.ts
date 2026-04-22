import { Effect } from "effect"
import { defineClientExtension, widgetContribution } from "../client-facets.js"
import { ConnectionWidget } from "../../components/connection-widget"

export default defineClientExtension("@gent/connection", {
  setup: Effect.succeed([
    widgetContribution({
      id: "connection",
      slot: "below-messages",
      priority: 30,
      component: ConnectionWidget,
    }),
  ]),
})
