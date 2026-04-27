/**
 * @gent/exec-tools — shell-execution capability surface.
 *
 * The W10-1d migration removed the legacy `notificationMachine` /
 * `notificationResource` FSM that mediated background-command
 * notifications. The bash tool now calls `ctx.session.queueFollowUp`
 * directly from its `Effect.forkDetach` watcher (`bash.ts`), which is
 * the same surface that the FSM's `afterTransition` `QueueFollowUp`
 * effect ultimately reached. The state machine carried no observable
 * data — its sole job was to translate one inbound command into one
 * outbound effect — so it is deleted rather than migrated. This also
 * removes the extension's last `protocols`/`actorRoute` surface.
 */

import { defineExtension } from "@gent/core/extensions/api"
import { BashTool } from "./bash.js"
import { EXEC_TOOLS_EXTENSION_ID } from "./protocol.js"

export const ExecToolsExtension = defineExtension({
  id: EXEC_TOOLS_EXTENSION_ID,
  tools: [BashTool],
})
