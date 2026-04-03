import { ExtensionMessage } from "../domain/extension-protocol.js"

export const PLAN_EXTENSION_ID = "@gent/plan"

export const PlanProtocol = {
  TogglePlan: ExtensionMessage(PLAN_EXTENSION_ID, "TogglePlan", {}),
  ExecutePlan: ExtensionMessage(PLAN_EXTENSION_ID, "ExecutePlan", {}),
  RefinePlan: ExtensionMessage(PLAN_EXTENSION_ID, "RefinePlan", {}),
}
