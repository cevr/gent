import { Rpc, RpcGroup, type RpcClient, type RpcGroup as RpcGroupNs } from "effect/unstable/rpc"
import { Schema } from "effect"
import { SessionId, BranchId, MessageId } from "@gent/core/domain/ids.js"
import { MessagePart } from "@gent/core/domain/message.js"
import { EventEnvelope, PlanDecision, HandoffDecision } from "@gent/core/domain/event.js"
import { AgentName, ReasoningEffort } from "@gent/core/domain/agent.js"
import { Model } from "@gent/core/domain/model.js"
import { PermissionDecision, PermissionRule } from "@gent/core/domain/permission.js"
import { Task } from "@gent/core/domain/task.js"
import { AuthAuthorization, AuthMethod } from "@gent/core/domain/auth-method.js"
import { AuthProviderInfo } from "@gent/core/domain/auth-guard.js"
import {
  ActorProcessMetrics,
  ActorProcessState,
  ActorTarget,
  InterruptPayload,
  SendToolResultPayload,
  SendUserMessagePayload,
} from "@gent/core/runtime/actor-process.js"
import { GentRpcError } from "./errors.js"

// ============================================================================
// Session Operations
// ============================================================================

export const CreateSessionPayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  firstMessage: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  bypass: Schema.optional(Schema.Boolean),
  parentSessionId: Schema.optional(SessionId),
  parentBranchId: Schema.optional(BranchId),
})

export const CreateSessionSuccess = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
  name: Schema.String,
  bypass: Schema.Boolean,
})

export const SessionInfo = Schema.Struct({
  id: SessionId,
  name: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  bypass: Schema.optional(Schema.Boolean),
  reasoningLevel: Schema.optional(ReasoningEffort),
  branchId: Schema.optional(BranchId),
  parentSessionId: Schema.optional(SessionId),
  parentBranchId: Schema.optional(BranchId),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})

// ============================================================================
// Session Tree
// ============================================================================

export interface SessionTreeNodeType {
  id: SessionId
  name?: string
  cwd?: string
  bypass?: boolean
  parentSessionId?: SessionId
  parentBranchId?: BranchId
  createdAt: number
  updatedAt: number
  children: readonly SessionTreeNodeType[]
}

interface SessionTreeNodeEncoded {
  id: string
  name?: string
  cwd?: string
  bypass?: boolean
  parentSessionId?: string
  parentBranchId?: string
  createdAt: number
  updatedAt: number
  children: readonly SessionTreeNodeEncoded[]
}

export const SessionTreeNodeSchema: Schema.Codec<SessionTreeNodeType, SessionTreeNodeEncoded> =
  Schema.Struct({
    id: SessionId,
    name: Schema.optional(Schema.String),
    cwd: Schema.optional(Schema.String),
    bypass: Schema.optional(Schema.Boolean),
    parentSessionId: Schema.optional(SessionId),
    parentBranchId: Schema.optional(BranchId),
    createdAt: Schema.Number,
    updatedAt: Schema.Number,
    children: Schema.Array(Schema.suspend(() => SessionTreeNodeSchema)),
  })

export const GetChildSessionsPayload = Schema.Struct({
  parentSessionId: SessionId,
})

export const GetSessionTreePayload = Schema.Struct({
  sessionId: SessionId,
})

// ============================================================================
// Branch Operations
// ============================================================================

export const BranchInfo = Schema.Struct({
  id: BranchId,
  sessionId: SessionId,
  parentBranchId: Schema.optional(BranchId),
  parentMessageId: Schema.optional(MessageId),
  name: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  createdAt: Schema.Number,
})

export const ListBranchesPayload = Schema.Struct({
  sessionId: SessionId,
})

export const CreateBranchPayload = Schema.Struct({
  sessionId: SessionId,
  name: Schema.optional(Schema.String),
})

export const CreateBranchSuccess = Schema.Struct({
  branchId: BranchId,
})

export interface BranchTreeNode {
  id: BranchId
  name?: string
  summary?: string
  parentMessageId?: MessageId
  messageCount: number
  createdAt: number
  children: readonly BranchTreeNode[]
}

interface BranchTreeNodeEncoded {
  id: string
  name?: string
  summary?: string
  parentMessageId?: string
  messageCount: number
  createdAt: number
  children: readonly BranchTreeNodeEncoded[]
}

export const BranchTreeNodeSchema: Schema.Codec<BranchTreeNode, BranchTreeNodeEncoded> =
  Schema.Struct({
    id: BranchId,
    name: Schema.optional(Schema.String),
    summary: Schema.optional(Schema.String),
    parentMessageId: Schema.optional(MessageId),
    messageCount: Schema.Number,
    createdAt: Schema.Number,
    children: Schema.Array(Schema.suspend(() => BranchTreeNodeSchema)),
  })

export const GetBranchTreePayload = Schema.Struct({
  sessionId: SessionId,
})

export const SwitchBranchPayload = Schema.Struct({
  sessionId: SessionId,
  fromBranchId: BranchId,
  toBranchId: BranchId,
  summarize: Schema.optional(Schema.Boolean),
})

export const ForkBranchPayload = Schema.Struct({
  sessionId: SessionId,
  fromBranchId: BranchId,
  atMessageId: MessageId,
  name: Schema.optional(Schema.String),
})

export const ForkBranchSuccess = Schema.Struct({
  branchId: BranchId,
})

// ============================================================================
// Message Operations
// ============================================================================

export const SendMessagePayload = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
  content: Schema.String,
})

export const MessageInfo = Schema.Struct({
  id: MessageId,
  sessionId: SessionId,
  branchId: BranchId,
  kind: Schema.optional(Schema.Literals(["regular", "interjection"])),
  role: Schema.Literals(["user", "assistant", "system", "tool"]),
  parts: Schema.Array(MessagePart),
  createdAt: Schema.Number,
  turnDurationMs: Schema.optional(Schema.Number),
})

export const ListMessagesPayload = Schema.Struct({
  branchId: BranchId,
})

export const GetSessionStatePayload = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
})

export const SessionState = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
  messages: Schema.Array(MessageInfo),
  lastEventId: Schema.NullOr(Schema.Number),
  isStreaming: Schema.Boolean,
  agent: AgentName,
  bypass: Schema.optional(Schema.Boolean),
  reasoningLevel: Schema.optional(ReasoningEffort),
})

// ============================================================================
// Steer Operations
// ============================================================================

const SteerTargetFields = {
  sessionId: SessionId,
  branchId: BranchId,
}

export const SteerPayload = Schema.Union([
  Schema.TaggedStruct("Cancel", SteerTargetFields),
  Schema.TaggedStruct("Interrupt", SteerTargetFields),
  Schema.TaggedStruct("Interject", { ...SteerTargetFields, message: Schema.String }),
  Schema.TaggedStruct("SwitchAgent", { ...SteerTargetFields, agent: AgentName }),
])
export type SteerPayload = typeof SteerPayload.Type

// ============================================================================
// Event Operations
// ============================================================================

export const SubscribeEventsPayload = Schema.Struct({
  sessionId: SessionId,
  branchId: Schema.optional(BranchId),
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
  sessionId: SessionId,
  bypass: Schema.Boolean,
})

export const UpdateSessionBypassSuccess = Schema.Struct({
  bypass: Schema.Boolean,
})

export const UpdateSessionReasoningLevelPayload = Schema.Struct({
  sessionId: SessionId,
  reasoningLevel: Schema.UndefinedOr(ReasoningEffort),
})

export const UpdateSessionReasoningLevelSuccess = Schema.Struct({
  reasoningLevel: Schema.UndefinedOr(ReasoningEffort),
})

export const RespondPlanPayload = Schema.Struct({
  requestId: Schema.String,
  decision: PlanDecision,
  reason: Schema.optional(Schema.String),
})

export const RespondHandoffPayload = Schema.Struct({
  requestId: Schema.String,
  decision: HandoffDecision,
  reason: Schema.optional(Schema.String),
})

export const RespondHandoffSuccess = Schema.Struct({
  childSessionId: Schema.optional(SessionId),
  childBranchId: Schema.optional(BranchId),
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

export const SetAuthKeyPayload = Schema.Struct({
  provider: Schema.String,
  key: Schema.String,
})

export const DeleteAuthKeyPayload = Schema.Struct({
  provider: Schema.String,
})

export const ListAuthMethodsSuccess = Schema.Record(Schema.String, Schema.Array(AuthMethod))

export const AuthorizeAuthPayload = Schema.Struct({
  sessionId: Schema.String,
  provider: Schema.String,
  method: Schema.Number,
})

export const AuthorizeAuthSuccess = Schema.NullOr(AuthAuthorization)

export const CallbackAuthPayload = Schema.Struct({
  sessionId: Schema.String,
  provider: Schema.String,
  method: Schema.Number,
  authorizationId: Schema.String,
  code: Schema.optional(Schema.String),
})

export { AuthProviderInfo }

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
    payload: { sessionId: SessionId },
    success: Schema.NullOr(SessionInfo),
    error: GentRpcError,
  }),
  Rpc.make("deleteSession", {
    payload: { sessionId: SessionId },
    error: GentRpcError,
  }),
  Rpc.make("getChildSessions", {
    payload: GetChildSessionsPayload.fields,
    success: Schema.Array(SessionInfo),
    error: GentRpcError,
  }),
  Rpc.make("getSessionTree", {
    payload: GetSessionTreePayload.fields,
    success: SessionTreeNodeSchema,
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

  // Handoff
  Rpc.make("respondHandoff", {
    payload: RespondHandoffPayload.fields,
    success: RespondHandoffSuccess,
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

  // Models (pricing/metadata)
  Rpc.make("listModels", {
    success: Schema.Array(Model),
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
  Rpc.make("listAuthMethods", {
    success: ListAuthMethodsSuccess,
    error: GentRpcError,
  }),
  Rpc.make("authorizeAuth", {
    payload: AuthorizeAuthPayload.fields,
    success: AuthorizeAuthSuccess,
    error: GentRpcError,
  }),
  Rpc.make("callbackAuth", {
    payload: CallbackAuthPayload.fields,
    error: GentRpcError,
  }),

  Rpc.make("updateSessionBypass", {
    payload: UpdateSessionBypassPayload.fields,
    success: UpdateSessionBypassSuccess,
    error: GentRpcError,
  }),
  Rpc.make("updateSessionReasoningLevel", {
    payload: UpdateSessionReasoningLevelPayload.fields,
    success: UpdateSessionReasoningLevelSuccess,
    error: GentRpcError,
  }),

  // Tasks
  Rpc.make("listTasks", {
    payload: {
      sessionId: SessionId,
      branchId: Schema.optional(BranchId),
    },
    success: Schema.Array(Task),
    error: GentRpcError,
  }),

  // ActorProcess
  Rpc.make("actorSendUserMessage", {
    payload: SendUserMessagePayload.fields,
    error: GentRpcError,
  }),
  Rpc.make("actorSendToolResult", {
    payload: SendToolResultPayload.fields,
    error: GentRpcError,
  }),
  Rpc.make("actorInterrupt", {
    payload: InterruptPayload.fields,
    error: GentRpcError,
  }),
  Rpc.make("actorGetState", {
    payload: ActorTarget.fields,
    success: ActorProcessState,
    error: GentRpcError,
  }),
  Rpc.make("actorGetMetrics", {
    payload: ActorTarget.fields,
    success: ActorProcessMetrics,
    error: GentRpcError,
  }),
) {}

// ============================================================================
// RPC Client Types
// ============================================================================

export type GentRpcClient = RpcClient.RpcClient<RpcGroupNs.Rpcs<typeof GentRpcs>>

export type GentRpcClientError = Rpc.Error<RpcGroupNs.Rpcs<typeof GentRpcs>>

export type GentRpcsClient = GentRpcClient
