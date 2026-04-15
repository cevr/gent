import { defineExtensionPackage } from "./api.js"
import { HandoffExtension } from "./handoff.js"

export const HandoffPackage = defineExtensionPackage({
  id: "@gent/handoff",
  server: HandoffExtension,
})
