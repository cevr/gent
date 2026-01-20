import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "@effect/platform"
import { Schema } from "effect"
import {
  CreateSessionPayload,
  CreateSessionSuccess,
  SessionInfo,
  SendMessagePayload,
  MessageInfo,
  SteerPayload,
} from "./operations.js"

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
    HttpApiEndpoint.post("create", "/sessions")
      .setPayload(CreateSessionRequest)
      .addSuccess(CreateSessionResponse),
  )
  .add(HttpApiEndpoint.get("list", "/sessions").addSuccess(Schema.Array(SessionResponse)))
  .add(
    HttpApiEndpoint.get("get", "/sessions/:sessionId")
      .setPath(Schema.Struct({ sessionId: Schema.String }))
      .addSuccess(SessionResponse),
  )
  .add(
    HttpApiEndpoint.del("delete", "/sessions/:sessionId")
      .setPath(Schema.Struct({ sessionId: Schema.String }))
      .addSuccess(Schema.Void),
  ) {}

export class MessagesApi extends HttpApiGroup.make("messages")
  .add(
    HttpApiEndpoint.post("send", "/messages")
      .setPayload(SendMessageRequest)
      .addSuccess(Schema.Void),
  )
  .add(
    HttpApiEndpoint.get("list", "/sessions/:sessionId/branches/:branchId/messages")
      .setPath(Schema.Struct({ sessionId: Schema.String, branchId: Schema.String }))
      .addSuccess(Schema.Array(MessageResponse)),
  )
  .add(HttpApiEndpoint.post("steer", "/steer").setPayload(SteerRequest).addSuccess(Schema.Void)) {}

export class EventsApi extends HttpApiGroup.make("events").add(
  HttpApiEndpoint.get("subscribe", "/events/:sessionId")
    .setPath(Schema.Struct({ sessionId: Schema.String }))
    .addSuccess(Schema.String), // SSE stream
) {}

// Full API

export class GentApi extends HttpApi.make("gent")
  .add(SessionsApi)
  .add(MessagesApi)
  .add(EventsApi)
  .annotate(OpenApi.Title, "Gent API") {}
