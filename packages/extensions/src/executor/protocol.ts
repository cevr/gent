import { Schema } from "effect"
import { ExtensionMessage } from "@gent/core/extensions/api"
import { EXECUTOR_EXTENSION_ID } from "./domain.js"

/** Snapshot reply. Carries enough state for both:
 *   - the projection (status drives tool gating, executorPrompt feeds the
 *     executor-guidance prompt section),
 *   - the execute/resume tools (baseUrl needed for MCP dispatch). */
export const ExecutorSnapshotReply = Schema.Struct({
  status: Schema.Literals(["idle", "connecting", "ready", "error"]),
  baseUrl: Schema.optional(Schema.String),
  executorPrompt: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
})
export type ExecutorSnapshotReply = typeof ExecutorSnapshotReply.Type

export const ExecutorProtocol = {
  Connect: ExtensionMessage.command(EXECUTOR_EXTENSION_ID, "Connect", {
    cwd: Schema.optional(Schema.String),
  }),
  Disconnect: ExtensionMessage.command(EXECUTOR_EXTENSION_ID, "Disconnect", {}),
  GetSnapshot: ExtensionMessage.reply(
    EXECUTOR_EXTENSION_ID,
    "GetSnapshot",
    {},
    ExecutorSnapshotReply,
  ),
}
