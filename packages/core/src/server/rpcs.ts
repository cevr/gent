import { Rpc, RpcGroup, type RpcClient, type RpcGroup as RpcGroupNs } from "effect/unstable/rpc"
import { Schema } from "effect"
import { SessionId, BranchId } from "../domain/ids.js"
import { Model } from "../domain/model.js"
import { PermissionRule } from "../domain/permission.js"
import { Task } from "../domain/task.js"
import {
  ActorProcessMetrics,
  ActorProcessState,
  ActorTarget,
  InterruptPayload,
  InvokeToolPayload,
  SendToolResultPayload,
  SendUserMessagePayload,
} from "../runtime/actor-process.js"
import { GentRpcError } from "./errors.js"
import {
  CreateSessionPayload,
  CreateSessionSuccess,
  SessionInfo,
  SessionTreeNodeSchema,
  GetChildSessionsPayload,
  GetSessionTreePayload,
  BranchInfo,
  ListBranchesPayload,
  CreateBranchPayload,
  CreateBranchSuccess,
  BranchTreeNodeSchema,
  GetBranchTreePayload,
  SwitchBranchPayload,
  ForkBranchPayload,
  ForkBranchSuccess,
  SendMessagePayload,
  MessageInfo,
  ListMessagesPayload,
  GetSessionStatePayload,
  SessionState,
  SteerPayload,
  DrainQueuedMessagesPayload,
  DrainQueuedMessagesSuccess,
  GetQueuedMessagesPayload,
  GetQueuedMessagesSuccess,
  SubscribeEventsPayload,
  SubscribeLiveEventsPayload,
  WatchSessionStatePayload,
  WatchQueuePayload,
  RespondQuestionsPayload,
  RespondPermissionPayload,
  UpdateSessionBypassPayload,
  UpdateSessionBypassSuccess,
  UpdateSessionReasoningLevelPayload,
  UpdateSessionReasoningLevelSuccess,
  RespondPromptPayload,
  RespondHandoffPayload,
  RespondHandoffSuccess,
  DeletePermissionRulePayload,
  SetAuthKeyPayload,
  DeleteAuthKeyPayload,
  ListAuthMethodsSuccess,
  AuthorizeAuthPayload,
  AuthorizeAuthSuccess,
  CallbackAuthPayload,
  AuthProviderInfo,
  EventEnvelope,
  SkillInfo,
  SkillContent,
} from "./transport-contract.js"
export {
  CreateSessionPayload,
  CreateSessionSuccess,
  SessionInfo,
  SessionTreeNodeSchema,
  type SessionTreeNodeType,
  GetChildSessionsPayload,
  GetSessionTreePayload,
  BranchInfo,
  ListBranchesPayload,
  CreateBranchPayload,
  CreateBranchSuccess,
  BranchTreeNodeSchema,
  GetBranchTreePayload,
  SwitchBranchPayload,
  ForkBranchPayload,
  ForkBranchSuccess,
  SendMessagePayload,
  MessageInfo,
  ListMessagesPayload,
  GetSessionStatePayload,
  SessionState,
  SteerPayload,
  DrainQueuedMessagesPayload,
  DrainQueuedMessagesSuccess,
  GetQueuedMessagesPayload,
  GetQueuedMessagesSuccess,
  SubscribeEventsPayload,
  SubscribeLiveEventsPayload,
  WatchSessionStatePayload,
  WatchQueuePayload,
  RespondQuestionsPayload,
  RespondPermissionPayload,
  UpdateSessionBypassPayload,
  UpdateSessionBypassSuccess,
  UpdateSessionReasoningLevelPayload,
  UpdateSessionReasoningLevelSuccess,
  RespondPromptPayload,
  RespondHandoffPayload,
  RespondHandoffSuccess,
  DeletePermissionRulePayload,
  SetAuthKeyPayload,
  DeleteAuthKeyPayload,
  ListAuthMethodsSuccess,
  AuthorizeAuthPayload,
  AuthorizeAuthSuccess,
  CallbackAuthPayload,
  AuthProviderInfo,
  EventEnvelope,
  SkillInfo,
  SkillContent,
} from "./transport-contract.js"

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
  Rpc.make("drainQueuedMessages", {
    payload: DrainQueuedMessagesPayload.fields,
    success: DrainQueuedMessagesSuccess,
    error: GentRpcError,
  }),
  Rpc.make("getQueuedMessages", {
    payload: GetQueuedMessagesPayload.fields,
    success: GetQueuedMessagesSuccess,
    error: GentRpcError,
  }),

  // Event subscription (streaming)
  Rpc.make("subscribeEvents", {
    payload: SubscribeEventsPayload.fields,
    success: EventEnvelope,
    stream: true,
    error: GentRpcError,
  }),
  Rpc.make("subscribeLiveEvents", {
    payload: SubscribeLiveEventsPayload.fields,
    success: EventEnvelope,
    stream: true,
    error: GentRpcError,
  }),
  Rpc.make("watchSessionState", {
    payload: WatchSessionStatePayload.fields,
    success: SessionState,
    stream: true,
    error: GentRpcError,
  }),
  Rpc.make("watchQueue", {
    payload: WatchQueuePayload.fields,
    success: GetQueuedMessagesSuccess,
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

  // Prompts
  Rpc.make("respondPrompt", {
    payload: RespondPromptPayload.fields,
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
  Rpc.make("actorInvokeTool", {
    payload: InvokeToolPayload.fields,
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

  // Skills RPCs
  Rpc.make("listSkills", {
    success: Schema.Array(SkillContent),
    error: GentRpcError,
  }),
  Rpc.make("getSkillContent", {
    payload: { name: Schema.String },
    success: Schema.NullOr(SkillContent),
    error: GentRpcError,
  }),
) {}

// ============================================================================
// RPC Client Types
// ============================================================================

export type GentRpcClient = RpcClient.RpcClient<RpcGroupNs.Rpcs<typeof GentRpcs>>

export type GentRpcClientError = Rpc.Error<RpcGroupNs.Rpcs<typeof GentRpcs>>

export type GentRpcsClient = GentRpcClient
