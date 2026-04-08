import { defineExtensionPackage } from "../domain/extension-package.js"
import { TaskExtension } from "./task-tools/index.js"
import { TaskUiModel } from "./task-tools-protocol.js"

export const TaskToolsPackage = defineExtensionPackage({
  id: "@gent/task-tools",
  server: TaskExtension,
  snapshot: TaskUiModel,
})
