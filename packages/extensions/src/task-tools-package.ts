import { defineExtensionPackage } from "@gent/core/extensions/api"
import { TaskExtension } from "./task-tools/index.js"
import { TaskListRef } from "./task-tools/queries.js"

export const TaskToolsPackage = defineExtensionPackage({
  id: "@gent/task-tools",
  server: TaskExtension,
  snapshotQuery: TaskListRef,
})
