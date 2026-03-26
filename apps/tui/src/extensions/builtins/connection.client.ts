import { defineClientExtension } from "@gent/core/domain/extension-client.js"
import { ConnectionWidget } from "../../components/connection-widget"

export default defineClientExtension({
  id: "@gent/connection",
  setup: () => ({
    widgets: [
      {
        id: "connection",
        slot: "below-messages",
        priority: 30,
        component: ConnectionWidget,
      },
    ],
  }),
})
