import { defineExtensionPackage } from "@gent/core/extensions/api"
import { HandoffExtension } from "./handoff.js"

export const HandoffPackage = defineExtensionPackage({
  id: "@gent/handoff",
  server: HandoffExtension,
})
