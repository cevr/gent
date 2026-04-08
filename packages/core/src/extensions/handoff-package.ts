import { defineExtensionPackage } from "../domain/extension-package.js"
import { HandoffExtension } from "./handoff.js"

export const HandoffPackage = defineExtensionPackage({
  id: "@gent/handoff",
  server: HandoffExtension,
})
