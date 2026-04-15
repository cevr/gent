import { defineExtensionPackage } from "./api.js"
import { ExecutorExtension, ExecutorUiModel } from "./executor/index.js"

export const ExecutorPackage = defineExtensionPackage({
  id: "@gent/executor",
  server: ExecutorExtension,
  snapshot: ExecutorUiModel,
})
