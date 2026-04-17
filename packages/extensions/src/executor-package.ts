import { defineExtensionPackage } from "@gent/core/extensions/api"
import { ExecutorExtension } from "./executor/index.js"
import { ExecutorProtocol } from "./executor/protocol.js"

export const ExecutorPackage = defineExtensionPackage({
  id: "@gent/executor",
  server: ExecutorExtension,
  snapshotRequest: () => ExecutorProtocol.GetSnapshot(),
})
