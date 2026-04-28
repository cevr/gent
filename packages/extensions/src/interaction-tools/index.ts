/**
 * Interaction-tools extension — `ask_user` + `prompt` tools.
 *
 * The legacy actor (which mirrored `InteractionPresented`/`InteractionResolved`
 * events into `Pending`/`Idle` state for the UI snapshot) has been deleted.
 * The actual interaction workflow is owned by
 * `AgentLoop.WaitingForInteraction` + `ApprovalService`, both of which are
 * cold-state correct (interactions survive restart). Clients fetch pending
 * interaction state through typed RPC and refetch from session events.
 *
 * @module
 */

import { defineExtension, ExtensionId } from "@gent/core/extensions/api"
import { AskUserTool } from "./ask-user.js"
import { PromptTool } from "./prompt.js"

export const INTERACTION_TOOLS_EXTENSION_ID = ExtensionId.make("@gent/interaction-tools")

export const InteractionToolsExtension = defineExtension({
  id: INTERACTION_TOOLS_EXTENSION_ID,
  tools: [AskUserTool, PromptTool],
})
