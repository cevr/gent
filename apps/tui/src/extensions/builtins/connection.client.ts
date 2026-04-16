import { ExtensionPackage } from "@gent/core/domain/extension-package.js"
import { widgetContribution } from "@gent/core/domain/extension-client.js"
import { ConnectionWidget } from "../../components/connection-widget"

export default ExtensionPackage.tui("@gent/connection", () => [
  widgetContribution({
    id: "connection",
    slot: "below-messages",
    priority: 30,
    component: ConnectionWidget,
  }),
])
