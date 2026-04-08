import { defineExtensionPackage } from "../domain/extension-package.js"
import { PlanExtension, PlanUiModel } from "./plan.js"

export const PlanPackage = defineExtensionPackage({
  id: "@gent/plan",
  server: PlanExtension,
  snapshot: PlanUiModel,
})
