import { Rpc, RpcGroup, type RpcClient, type RpcGroup as RpcGroupNs } from "@effect/rpc"
import { Schema } from "effect"
import {
  CreateSessionPayload,
  CreateSessionSuccess,
  SessionInfo,
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
  ListMessagesPayload,
  MessageInfo,
  GetSessionStatePayload,
  SessionState,
  SteerPayload,
  SubscribeEventsPayload,
  EventEnvelope,
  RespondQuestionsPayload,
  RespondPermissionPayload,
  RespondPlanPayload,
  CompactBranchPayload,
  UpdateSessionBypassPayload,
  UpdateSessionBypassSuccess,
  DeletePermissionRulePayload,
  AuthProviderInfo,
  SetAuthKeyPayload,
  DeleteAuthKeyPayload,
} from "./operations.js"
import { PermissionRule } from "@gent/core"
import { GentRpcError } from "./errors.js"

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

  // Respond to questions
  Rpc.make("respondQuestions", {
    payload: RespondQuestionsPayload.fields,
    error: GentRpcError,
  }),

  // Respond to permission request
  Rpc.make("respondPermission", {
    payload: RespondPermissionPayload.fields,
    error: GentRpcError,
  }),

  // Update session bypass
  Rpc.make("updateSessionBypass", {
    payload: UpdateSessionBypassPayload.fields,
    success: UpdateSessionBypassSuccess,
    error: GentRpcError,
  }),

  // Respond to plan prompt
  Rpc.make("respondPlan", {
    payload: RespondPlanPayload.fields,
    error: GentRpcError,
  }),

  // Compaction
  Rpc.make("compactBranch", {
    payload: CompactBranchPayload.fields,
    error: GentRpcError,
  }),

  // Permission rules
  Rpc.make("getPermissionRules", {
    success: Schema.Array(PermissionRule),
    error: GentRpcError,
  }),
  Rpc.make("deletePermissionRule", {
    payload: DeletePermissionRulePayload.fields,
    error: GentRpcError,
  }),

  // Auth RPCs
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
) {}

// Type for the RPC client
export type GentRpcsClient = RpcClient.RpcClient<RpcGroupNs.Rpcs<typeof GentRpcs>>
