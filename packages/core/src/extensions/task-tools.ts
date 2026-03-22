import { Effect } from "effect"
import { defineExtension } from "../domain/extension.js"
import { TaskCreateTool } from "../tools/task-create.js"
import { TaskListTool } from "../tools/task-list.js"
import { TaskGetTool } from "../tools/task-get.js"
import { TaskUpdateTool } from "../tools/task-update.js"

export const TaskToolsExtension = defineExtension({
  manifest: { id: "@gent/task-tools" },
  setup: () =>
    Effect.succeed({
      tools: [TaskCreateTool, TaskListTool, TaskGetTool, TaskUpdateTool],
    }),
})
