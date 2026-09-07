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
  }),
  Schema.TaggedStruct("SwitchAgent", { ...SteerTargetFields, agent: AgentName }),
])
export type SteerCommand = typeof SteerCommand.Type
