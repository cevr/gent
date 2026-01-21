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
} from "./operations.js"

// ============================================================================
// RPC Definitions
// ============================================================================

export class GentRpcs extends RpcGroup.make(
  // Session RPCs
  Rpc.make("createSession", {
    payload: CreateSessionPayload.fields,
    success: CreateSessionSuccess,
  }),
  Rpc.make("listSessions", {
    success: Schema.Array(SessionInfo),
  }),
  Rpc.make("getSession", {
    payload: { sessionId: Schema.String },
    success: Schema.NullOr(SessionInfo),
  }),
  Rpc.make("deleteSession", {
    payload: { sessionId: Schema.String },
  }),

  // Branch RPCs
  Rpc.make("listBranches", {
    payload: ListBranchesPayload.fields,
    success: Schema.Array(BranchInfo),
  }),
  Rpc.make("createBranch", {
    payload: CreateBranchPayload.fields,
    success: CreateBranchSuccess,
  }),

  // Message RPCs
  Rpc.make("sendMessage", {
    payload: SendMessagePayload.fields,
  }),
  Rpc.make("listMessages", {
    payload: ListMessagesPayload.fields,
    success: Schema.Array(MessageInfo),
  }),

  // Steer RPC
  Rpc.make("steer", {
    payload: { command: SteerPayload },
  }),

  // Event subscription (streaming)
  Rpc.make("subscribeEvents", {
    payload: SubscribeEventsPayload.fields,
    success: AgentEvent,
    stream: true,
  }),

  // Respond to questions
  Rpc.make("respondQuestions", {
    payload: RespondQuestionsPayload.fields,
  }),
) {}

// Type for the RPC client
export type GentRpcsClient = RpcClient.RpcClient<RpcGroupNs.Rpcs<typeof GentRpcs>>
