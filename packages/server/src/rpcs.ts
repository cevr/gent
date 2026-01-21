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
  SendMessagePayload,
  ListMessagesPayload,
  MessageInfo,
  SteerPayload,
  SubscribeEventsPayload,
  AgentEvent,
  RespondQuestionsPayload,
  RespondPermissionPayload,
  RespondPlanPayload,
} from "./operations.js"
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

  // Steer RPC
  Rpc.make("steer", {
    payload: { command: SteerPayload },
    error: GentRpcError,
  }),

  // Event subscription (streaming)
  Rpc.make("subscribeEvents", {
    payload: SubscribeEventsPayload.fields,
    success: AgentEvent,
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

  // Respond to plan prompt
  Rpc.make("respondPlan", {
    payload: RespondPlanPayload.fields,
    error: GentRpcError,
  }),
) {}

// Type for the RPC client
export type GentRpcsClient = RpcClient.RpcClient<RpcGroupNs.Rpcs<typeof GentRpcs>>
