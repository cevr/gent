import { defineExtensionPackage } from "@gent/core/extensions/api"
import { AutoExtension, AutoUiModel } from "./auto.js"

export const AutoPackage = defineExtensionPackage({
  id: "@gent/auto",
  server: AutoExtension,
  snapshot: AutoUiModel,
})
