import { defineExtensionPackage } from "../domain/extension-package.js"
import { AutoExtension, AutoUiModel } from "./auto.js"

export const AutoPackage = defineExtensionPackage({
  id: "@gent/auto",
  server: AutoExtension,
  snapshot: AutoUiModel,
})
