import { ExtensionPackage } from "@gent/core/domain/extension-package.js"
import { ConnectionWidget } from "../../components/connection-widget"

export default ExtensionPackage.tui("@gent/connection", () => ({
  widgets: [
    {
      id: "connection",
      slot: "below-messages",
      priority: 30,
      component: ConnectionWidget,
    },
  ],
}))
