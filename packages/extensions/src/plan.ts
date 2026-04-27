/**
 * Plan extension — tool-only (no actor).
 *
 * The PlanTool orchestrates adversarial multi-agent planning cycles.
 * Plan artifacts are persisted via the @gent/artifacts extension.
 */

import { defineExtension, ExtensionId } from "@gent/core/extensions/api"
import { PlanTool } from "./plan-tool.js"

export { PlanTool, PlanParams } from "./plan-tool.js"

export const PLAN_EXTENSION_ID = ExtensionId.make("@gent/plan")

export const PlanExtension = defineExtension({
  id: PLAN_EXTENSION_ID,
  tools: [PlanTool],
})
