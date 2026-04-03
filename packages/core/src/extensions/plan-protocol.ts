import { ExtensionMessage } from "../domain/extension-protocol.js"
import { PLAN_EXTENSION_ID } from "./plan.js"

export const PlanProtocol = {
  TogglePlan: ExtensionMessage(PLAN_EXTENSION_ID, "TogglePlan", {}),
  ExecutePlan: ExtensionMessage(PLAN_EXTENSION_ID, "ExecutePlan", {}),
  RefinePlan: ExtensionMessage(PLAN_EXTENSION_ID, "RefinePlan", {}),
}
