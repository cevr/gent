import { Schema } from "effect"
import { AgentEvent, MessagePart } from "@gent/core"

// ============================================================================
// Session Operations
// ============================================================================

export const CreateSessionPayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  firstMessage: Schema.optional(Schema.String),
})

export const CreateSessionSuccess = Schema.Struct({
  sessionId: Schema.String,
  branchId: Schema.String,
  name: Schema.String,
})

export const SessionInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  branchId: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})

// ============================================================================
// Branch Operations
// ============================================================================

export const BranchInfo = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  name: Schema.optional(Schema.String),
  createdAt: Schema.Number,
})

export const ListBranchesPayload = Schema.Struct({
  sessionId: Schema.String,
})

export const CreateBranchPayload = Schema.Struct({
  sessionId: Schema.String,
  name: Schema.optional(Schema.String),
})

export const CreateBranchSuccess = Schema.Struct({
  branchId: Schema.String,
})

// ============================================================================
// Message Operations
// ============================================================================

export const SendMessagePayload = Schema.Struct({
  sessionId: Schema.String,
  branchId: Schema.String,
  content: Schema.String,
})

export const MessageInfo = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  branchId: Schema.String,
  role: Schema.Literal("user", "assistant", "system", "tool"),
  parts: Schema.Array(MessagePart),
  createdAt: Schema.Number,
  turnDurationMs: Schema.optional(Schema.Number),
})

export const ListMessagesPayload = Schema.Struct({
  branchId: Schema.String,
})

// ============================================================================
// Steer Operations
// ============================================================================

export const SteerPayload = Schema.Union(
  Schema.TaggedStruct("Cancel", {}),
  Schema.TaggedStruct("Interrupt", { message: Schema.String }),
  Schema.TaggedStruct("SwitchModel", { model: Schema.String }),
  Schema.TaggedStruct("SwitchMode", { mode: Schema.Literal("build", "plan") })
)
export type SteerPayload = typeof SteerPayload.Type

// ============================================================================
// Event Operations
// ============================================================================

export const SubscribeEventsPayload = Schema.Struct({
  sessionId: Schema.String,
})

export { AgentEvent }
