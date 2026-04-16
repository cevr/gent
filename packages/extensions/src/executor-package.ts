import { defineExtensionPackage } from "@gent/core/extensions/api"
import { ExecutorExtension, ExecutorUiModel } from "./executor/index.js"

export const ExecutorPackage = defineExtensionPackage({
  id: "@gent/executor",
  server: ExecutorExtension,
  snapshot: ExecutorUiModel,
})
