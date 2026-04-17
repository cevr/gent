import { defineExtensionPackage } from "@gent/core/extensions/api"
import { AutoExtension } from "./auto.js"
import { AutoProtocol } from "./auto-protocol.js"

export const AutoPackage = defineExtensionPackage({
  id: "@gent/auto",
  server: AutoExtension,
  snapshotRequest: () => AutoProtocol.GetSnapshot(),
})
