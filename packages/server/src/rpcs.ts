import { Rpc, RpcGroup, type RpcClient, type RpcGroup as RpcGroupNs } from "@effect/rpc"
import { Schema } from "effect"
import {
  AgentName,
  EventEnvelope,
  MessagePart,
  PermissionDecision,
  PlanDecision,
  PermissionRule,
  Model,
} from "@gent/core"
import { GentRpcError } from "./errors.js"

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
  parentSessionId: Schema.optional(Schema.String),
  parentBranchId: Schema.optional(Schema.String),
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
  agent: AgentName,
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
  Schema.TaggedStruct("SwitchAgent", { agent: AgentName }),
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

// ============================================================================
// Auth Operations
// ============================================================================

export const AuthProviderInfo = Schema.Struct({
  provider: Schema.String,
  hasKey: Schema.Boolean,
  source: Schema.optional(Schema.Literal("env", "stored")),
})
export type AuthProviderInfo = typeof AuthProviderInfo.Type

export const SetAuthKeyPayload = Schema.Struct({
  provider: Schema.String,
  key: Schema.String,
})

export const DeleteAuthKeyPayload = Schema.Struct({
  provider: Schema.String,
})

export { EventEnvelope }

// ============================================================================
// RPC Definitions
// ============================================================================

export class GentRpcs extends RpcGroup.make(
  // Session RPCs
  Rpc.make("createSession", {
    payload: CreateSessionPayload.fields,
    success: CreateSessionSuccess,
    error: GentRpcError,
  }),
  Rpc.make("listSessions", {
    success: Schema.Array(SessionInfo),
    error: GentRpcError,
  }),
  Rpc.make("getSession", {
    payload: { sessionId: Schema.String },
    success: Schema.NullOr(SessionInfo),
    error: GentRpcError,
  }),
  Rpc.make("deleteSession", {
    payload: { sessionId: Schema.String },
    error: GentRpcError,
  }),

  // Branch RPCs
  Rpc.make("listBranches", {
    payload: ListBranchesPayload.fields,
    success: Schema.Array(BranchInfo),
    error: GentRpcError,
  }),
  Rpc.make("createBranch", {
    payload: CreateBranchPayload.fields,
    success: CreateBranchSuccess,
    error: GentRpcError,
  }),

  // Branch tree + navigation
  Rpc.make("getBranchTree", {
    payload: GetBranchTreePayload.fields,
    success: Schema.Array(BranchTreeNodeSchema),
    error: GentRpcError,
  }),
  Rpc.make("switchBranch", {
    payload: SwitchBranchPayload.fields,
    error: GentRpcError,
  }),
  Rpc.make("forkBranch", {
    payload: ForkBranchPayload.fields,
    success: ForkBranchSuccess,
    error: GentRpcError,
  }),

  // Message RPCs
  Rpc.make("sendMessage", {
    payload: SendMessagePayload.fields,
    error: GentRpcError,
  }),
  Rpc.make("listMessages", {
    payload: ListMessagesPayload.fields,
    success: Schema.Array(MessageInfo),
    error: GentRpcError,
  }),
  Rpc.make("getSessionState", {
    payload: GetSessionStatePayload.fields,
    success: SessionState,
    error: GentRpcError,
  }),

  // Steer RPC
  Rpc.make("steer", {
    payload: { command: SteerPayload },
    error: GentRpcError,
  }),

  // Event subscription (streaming)
  Rpc.make("subscribeEvents", {
    payload: SubscribeEventsPayload.fields,
    success: EventEnvelope,
    stream: true,
    error: GentRpcError,
  }),

  // Question responses
  Rpc.make("respondQuestions", {
    payload: RespondQuestionsPayload.fields,
    error: GentRpcError,
  }),
  Rpc.make("respondPermission", {
    payload: RespondPermissionPayload.fields,
    error: GentRpcError,
  }),

  // Plans
  Rpc.make("respondPlan", {
    payload: RespondPlanPayload.fields,
    error: GentRpcError,
  }),

  // Compaction
  Rpc.make("compactBranch", {
    payload: CompactBranchPayload.fields,
    error: GentRpcError,
  }),

  // Permissions
  Rpc.make("getPermissionRules", {
    success: Schema.Array(PermissionRule),
    error: GentRpcError,
  }),
  Rpc.make("deletePermissionRule", {
    payload: DeletePermissionRulePayload.fields,
    error: GentRpcError,
  }),

  // Auth
  Rpc.make("listAuthProviders", {
    success: Schema.Array(AuthProviderInfo),
    error: GentRpcError,
  }),
  Rpc.make("setAuthKey", {
    payload: SetAuthKeyPayload.fields,
    error: GentRpcError,
  }),
  Rpc.make("deleteAuthKey", {
    payload: DeleteAuthKeyPayload.fields,
    error: GentRpcError,
  }),

  // Models
  Rpc.make("listModels", {
    success: Schema.Array(Model),
    error: GentRpcError,
  }),
  Rpc.make("updateSessionBypass", {
    payload: UpdateSessionBypassPayload.fields,
    success: UpdateSessionBypassSuccess,
    error: GentRpcError,
  }),
) {}

// ============================================================================
// RPC Client Types
// ============================================================================

export type GentRpcClient = RpcClient.RpcClient<RpcGroupNs.Rpcs<typeof GentRpcs>>

export type GentRpcClientError = Rpc.Error<RpcGroupNs.Rpcs<typeof GentRpcs>>

export type GentRpcsClient = GentRpcClient
