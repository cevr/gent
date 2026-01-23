import { Schema } from "effect"
import {
  AgentMode,
  EventEnvelope,
  MessagePart,
  PermissionDecision,
  PlanDecision,
} from "@gent/core"

// ============================================================================
// Session Operations
// ============================================================================

export const CreateSessionPayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  firstMessage: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  bypass: Schema.optional(Schema.Boolean),
})

export const CreateSessionSuccess = Schema.Struct({
  sessionId: Schema.String,
  branchId: Schema.String,
  name: Schema.String,
  bypass: Schema.Boolean,
})

export const SessionInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  bypass: Schema.optional(Schema.Boolean),
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
  parentBranchId: Schema.optional(Schema.String),
  parentMessageId: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
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

export interface BranchTreeNode {
  id: string
  name?: string
  summary?: string
  parentMessageId?: string
  messageCount: number
  createdAt: number
  children: readonly BranchTreeNode[]
}

export const BranchTreeNodeSchema: Schema.Schema<BranchTreeNode> = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  parentMessageId: Schema.optional(Schema.String),
  messageCount: Schema.Number,
  createdAt: Schema.Number,
  children: Schema.Array(Schema.suspend(() => BranchTreeNodeSchema)),
})

export const GetBranchTreePayload = Schema.Struct({
  sessionId: Schema.String,
})

export const SwitchBranchPayload = Schema.Struct({
  sessionId: Schema.String,
  fromBranchId: Schema.String,
  toBranchId: Schema.String,
  summarize: Schema.optional(Schema.Boolean),
})

export const ForkBranchPayload = Schema.Struct({
  sessionId: Schema.String,
  fromBranchId: Schema.String,
  atMessageId: Schema.String,
  name: Schema.optional(Schema.String),
})

export const ForkBranchSuccess = Schema.Struct({
  branchId: Schema.String,
})

// ============================================================================
// Message Operations
// ============================================================================

export const SendMessagePayload = Schema.Struct({
  sessionId: Schema.String,
  branchId: Schema.String,
  content: Schema.String,
  mode: Schema.optional(AgentMode),
  model: Schema.optional(Schema.String),
})

export const MessageInfo = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  branchId: Schema.String,
  kind: Schema.optional(Schema.Literal("regular", "interjection")),
  role: Schema.Literal("user", "assistant", "system", "tool"),
  parts: Schema.Array(MessagePart),
  createdAt: Schema.Number,
  turnDurationMs: Schema.optional(Schema.Number),
})

export const ListMessagesPayload = Schema.Struct({
  branchId: Schema.String,
})

export const GetSessionStatePayload = Schema.Struct({
  sessionId: Schema.String,
  branchId: Schema.String,
})

export const SessionState = Schema.Struct({
  sessionId: Schema.String,
  branchId: Schema.String,
  messages: Schema.Array(MessageInfo),
  lastEventId: Schema.NullOr(Schema.Number),
  isStreaming: Schema.Boolean,
  mode: AgentMode,
  model: Schema.optional(Schema.String),
  bypass: Schema.optional(Schema.Boolean),
})

// ============================================================================
// Steer Operations
// ============================================================================

export const SteerPayload = Schema.Union(
  Schema.TaggedStruct("Cancel", {}),
  Schema.TaggedStruct("Interrupt", {}),
  Schema.TaggedStruct("Interject", { message: Schema.String }),
  Schema.TaggedStruct("SwitchModel", { model: Schema.String }),
  Schema.TaggedStruct("SwitchMode", { mode: Schema.Literal("build", "plan") }),
)
export type SteerPayload = typeof SteerPayload.Type

// ============================================================================
// Event Operations
// ============================================================================

export const SubscribeEventsPayload = Schema.Struct({
  sessionId: Schema.String,
  branchId: Schema.optional(Schema.String),
  after: Schema.optional(Schema.Number),
})

// ============================================================================
// Question Response Operations
// ============================================================================

export const RespondQuestionsPayload = Schema.Struct({
  requestId: Schema.String,
  answers: Schema.Array(Schema.Array(Schema.String)),
})

export const RespondPermissionPayload = Schema.Struct({
  requestId: Schema.String,
  decision: PermissionDecision,
  persist: Schema.optional(Schema.Boolean),
})

export const UpdateSessionBypassPayload = Schema.Struct({
  sessionId: Schema.String,
  bypass: Schema.Boolean,
})

export const UpdateSessionBypassSuccess = Schema.Struct({
  bypass: Schema.Boolean,
})

export const RespondPlanPayload = Schema.Struct({
  requestId: Schema.String,
  decision: PlanDecision,
  reason: Schema.optional(Schema.String),
})

// ============================================================================
// Compaction Operations
// ============================================================================

export const CompactBranchPayload = Schema.Struct({
  sessionId: Schema.String,
  branchId: Schema.String,
})

// ============================================================================
// Permission Operations
// ============================================================================

export const DeletePermissionRulePayload = Schema.Struct({
  tool: Schema.String,
  pattern: Schema.optional(Schema.String),
})

export { EventEnvelope }
