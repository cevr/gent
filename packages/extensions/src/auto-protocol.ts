import { Schema } from "effect"
import { ExtensionMessage } from "@gent/core/extensions/api"

export const AUTO_EXTENSION_ID = "@gent/auto"

const AutoSnapshotLearning = Schema.Struct({
  iteration: Schema.Number,
  content: Schema.String,
})

/** Snapshot reply schema. Carries enough state for both:
 *   - interceptors (active + iteration + maxIterations + goal)
 *   - the prompt projection (learnings, lastSummary, nextIdea) — replaces the
 *     workflow's previous `derive().promptSections` path that was lost when
 *     `WorkflowContribution.turn` was deleted in C2.
 *  The TUI widget consumes only the interceptor-shaped fields. */
export const AutoSnapshotReply = Schema.Struct({
  active: Schema.Boolean,
  phase: Schema.optional(Schema.Literals(["working", "awaiting-review"])),
  iteration: Schema.optional(Schema.Number),
  maxIterations: Schema.optional(Schema.Number),
  goal: Schema.optional(Schema.String),
  learnings: Schema.optional(Schema.Array(AutoSnapshotLearning)),
  lastSummary: Schema.optional(Schema.String),
  nextIdea: Schema.optional(Schema.String),
})
export type AutoSnapshotReply = typeof AutoSnapshotReply.Type

export const AutoProtocol = {
  StartAuto: ExtensionMessage(AUTO_EXTENSION_ID, "StartAuto", {
    goal: Schema.String,
    maxIterations: Schema.optional(Schema.Number),
  }),
  RequestHandoff: ExtensionMessage(AUTO_EXTENSION_ID, "RequestHandoff", {
    content: Schema.String,
  }),
  CancelAuto: ExtensionMessage(AUTO_EXTENSION_ID, "CancelAuto", {}),
  ToggleAuto: ExtensionMessage(AUTO_EXTENSION_ID, "ToggleAuto", {
    goal: Schema.optional(Schema.String),
    maxIterations: Schema.optional(Schema.Number),
  }),
  IsActive: ExtensionMessage.reply(AUTO_EXTENSION_ID, "IsActive", {}, Schema.Boolean),
  /** Read the current workflow snapshot. Replaces `getUiSnapshot(@gent/auto)`
   *  self-reads from the auto-handoff and journal interceptors — workflows
   *  expose state through typed protocols, not the UI snapshot pipe. */
  GetSnapshot: ExtensionMessage.reply(AUTO_EXTENSION_ID, "GetSnapshot", {}, AutoSnapshotReply),
}
