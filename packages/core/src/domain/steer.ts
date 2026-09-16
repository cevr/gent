import { Schema } from "effect"
import { AgentName } from "./agent"
import { BranchId, MessageId, RequestId, SessionId } from "./ids"

// Steer Command — RPC payload that targets a session/branch loop.
// Lives in domain so transport-contract and runtime can both import without
// either taking a dependency on the other.

const SteerTargetFields = {
  sessionId: SessionId,
  branchId: BranchId,
  requestId: RequestId,
}

export const SteerCommand = Schema.Union([
  Schema.TaggedStruct("Cancel", {
    ...SteerTargetFields,
    messageId: Schema.optional(MessageId),
  }),
  Schema.TaggedStruct("Interrupt", {
    ...SteerTargetFields,
    messageId: Schema.optional(MessageId),
  }),
  Schema.TaggedStruct("Interject", {
    ...SteerTargetFields,
    message: Schema.String,
    agent: Schema.optional(AgentName),
    /**
     * Start a turn when the branch is idle, instead of waiting in the queue.
     *
     * Steering exists to reach a turn that is already running, so an idle
     * branch parks it by default and a reader can still see it through
     * `queue.get`. A caller that wants an answer now — a queued question
     * being answered, a child reporting back — says so here.
     */
    wake: Schema.optional(Schema.Boolean),
  }),
  Schema.TaggedStruct("SwitchAgent", { ...SteerTargetFields, agent: AgentName }),
])
export type SteerCommand = typeof SteerCommand.Type
