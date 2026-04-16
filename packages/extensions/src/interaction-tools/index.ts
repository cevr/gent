/**
 * Interaction-tools extension — `ask_user` + `prompt` tools and a
 * `ProjectionContribution` that derives the active pending-interaction
 * snapshot from `InteractionStorage`.
 *
 * The legacy actor (which mirrored `InteractionPresented`/`InteractionResolved`
 * events into `Pending`/`Idle` state for the UI snapshot) has been deleted.
 * It was pure projection mislabeled — the actual interaction workflow is
 * owned by `AgentLoop.WaitingForInteraction` + `ApprovalService`, both of
 * which are cold-state correct (interactions survive restart). The actor's
 * only job was the snapshot, and that's exactly what a projection is for.
 *
 * @module
 */

import {
  defineExtension,
  projectionContribution,
  toolContribution,
} from "@gent/core/extensions/api"
import { AskUserTool } from "./ask-user.js"
import { PromptTool } from "./prompt.js"
import { InteractionProjection } from "./projection.js"

export const INTERACTION_TOOLS_EXTENSION_ID = "@gent/interaction-tools"

export const InteractionToolsExtension = defineExtension({
  id: INTERACTION_TOOLS_EXTENSION_ID,
  contributions: () => [
    toolContribution(AskUserTool),
    toolContribution(PromptTool),
    projectionContribution(InteractionProjection),
  ],
})
