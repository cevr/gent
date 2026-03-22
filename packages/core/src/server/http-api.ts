import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import {
  CreateSessionPayload,
  CreateSessionSuccess,
  SessionInfo,
  SendMessagePayload,
  MessageInfo,
  SteerPayload,
} from "./rpcs.js"
import { SessionId, BranchId } from "../domain/ids.js"

// Re-export schemas under HTTP-friendly names for backward compatibility
export const SendMessageRequest = SendMessagePayload
export const CreateSessionRequest = CreateSessionPayload
export const CreateSessionResponse = CreateSessionSuccess
export const SessionResponse = SessionInfo
export const MessageResponse = MessageInfo
export const SteerRequest = SteerPayload

// API Groups

export class SessionsApi extends HttpApiGroup.make("sessions")
  .add(
    HttpApiEndpoint.post("create", "/sessions", {
      payload: CreateSessionRequest,
      success: CreateSessionResponse,
    }),
  )
  .add(
    HttpApiEndpoint.get("list", "/sessions", {
      success: Schema.Array(SessionResponse),
    }),
  )
  .add(
    HttpApiEndpoint.get("get", "/sessions/:sessionId", {
      params: { sessionId: SessionId },
      success: SessionResponse,
    }),
  )
  .add(
    HttpApiEndpoint.delete("delete", "/sessions/:sessionId", {
      params: { sessionId: SessionId },
      success: Schema.Void,
    }),
  ) {}

export class MessagesApi extends HttpApiGroup.make("messages")
  .add(
    HttpApiEndpoint.post("send", "/messages", {
      payload: SendMessageRequest,
      success: Schema.Void,
    }),
  )
  .add(
    HttpApiEndpoint.get("list", "/sessions/:sessionId/branches/:branchId/messages", {
      params: { sessionId: SessionId, branchId: BranchId },
      success: Schema.Array(MessageResponse),
    }),
  )
  .add(
    HttpApiEndpoint.post("steer", "/steer", {
      payload: SteerRequest,
      success: Schema.Void,
    }),
  ) {}

// EventsApi deprecated - use RPC streaming via /rpc endpoint instead
export class EventsApi extends HttpApiGroup.make("events").add(
  HttpApiEndpoint.get("subscribe", "/events/:sessionId", {
    params: { sessionId: SessionId },
    success: Schema.String, // SSE stream (deprecated)
  }),
) {}

// Full API (REST endpoints - use /rpc for streaming)

export class GentApi extends HttpApi.make("gent")
  .add(SessionsApi)
  .add(MessagesApi)
  .annotate(OpenApi.Title, "Gent API") {}
