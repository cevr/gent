import { Effect } from "effect"
import { ExtensionPackage, widgetContribution } from "@gent/core/domain/extension-client.js"
import { ConnectionWidget } from "../../components/connection-widget"

export default ExtensionPackage.tui("@gent/connection", {
  setup: Effect.succeed([
    widgetContribution({
      id: "connection",
      slot: "below-messages",
      priority: 30,
      component: ConnectionWidget,
    }),
  ]),
})
