import { defineClientExtension } from "@gent/core/domain/extension-client.js"
import { TaskWidget } from "../../components/task-widget"

export default defineClientExtension({
  id: "@gent/tasks",
  setup: () => ({
    widgets: [
      {
        id: "tasks",
        slot: "below-messages",
        priority: 20,
        component: TaskWidget,
      },
    ],
  }),
})
