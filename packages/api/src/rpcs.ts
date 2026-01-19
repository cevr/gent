import { Rpc, RpcGroup, type RpcClient } from "@effect/rpc"
import { Schema } from "effect"
import {
  CreateSessionPayload,
  CreateSessionSuccess,
  SessionInfo,
  SendMessagePayload,
  ListMessagesPayload,
  MessageInfo,
  SteerPayload,
  SubscribeEventsPayload,
  AgentEvent,
} from "./operations.js"
import type { RpcGroup as RpcGroupNs } from "@effect/rpc"

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
  })
) {}

// Type for the RPC client
export type GentRpcsClient = RpcClient.RpcClient<RpcGroupNs.Rpcs<typeof GentRpcs>>
