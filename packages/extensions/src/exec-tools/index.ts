/**
 * @gent/exec-tools — shell-execution capability surface.
 *
 * The bash tool calls `ctx.session.queueFollowUp` directly from its
 * `Effect.forkDetach` watcher (`bash.ts`). Background command completion is
 * modeled as a direct session follow-up, with no extension-owned state machine.
 */

import { defineExtension } from "@gent/core/extensions/api"
import { BashTool } from "./bash.js"
import { EXEC_TOOLS_EXTENSION_ID } from "./protocol.js"

export const ExecToolsExtension = defineExtension({
  id: EXEC_TOOLS_EXTENSION_ID,
  tools: [BashTool],
})
