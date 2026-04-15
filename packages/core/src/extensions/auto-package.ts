import { defineExtensionPackage } from "./api.js"
import { AutoExtension, AutoUiModel } from "./auto.js"

export const AutoPackage = defineExtensionPackage({
  id: "@gent/auto",
  server: AutoExtension,
  snapshot: AutoUiModel,
})
