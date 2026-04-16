/**
 * Plan extension — tool-only (no actor).
 *
 * The PlanTool orchestrates adversarial multi-agent planning cycles.
 * Plan artifacts are persisted via the @gent/artifacts extension.
 */

import { extension } from "@gent/core/extensions/api"
import { PlanTool } from "./plan-tool.js"

export { PlanTool, PlanParams } from "./plan-tool.js"

export const PLAN_EXTENSION_ID = "@gent/plan"

export const PlanExtension = extension(PLAN_EXTENSION_ID, ({ ext }) => ext.tools(PlanTool))
