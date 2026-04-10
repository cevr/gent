import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import {
  CreateSessionInput,
  CreateSessionResult,
  SessionInfo,
  SendMessageInput,
  MessageInfo,
  SteerCommand,
} from "./rpcs.js"
import { SessionId, BranchId } from "../domain/ids.js"

// API Groups

export class SessionsApi extends HttpApiGroup.make("sessions")
  .add(
    HttpApiEndpoint.post("create", "/sessions", {
      payload: CreateSessionInput,
      success: CreateSessionResult,
    }),
  )
  .add(
    HttpApiEndpoint.get("list", "/sessions", {
      success: Schema.Array(SessionInfo),
    }),
  )
  .add(
    HttpApiEndpoint.get("get", "/sessions/:sessionId", {
      params: { sessionId: SessionId },
      success: SessionInfo,
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
      payload: SendMessageInput,
      success: Schema.Void,
    }),
  )
  .add(
    HttpApiEndpoint.get("list", "/sessions/:sessionId/branches/:branchId/messages", {
      params: { sessionId: SessionId, branchId: BranchId },
      success: Schema.Array(MessageInfo),
    }),
  )
  .add(
    HttpApiEndpoint.post("steer", "/steer", {
      payload: SteerCommand,
      success: Schema.Void,
    }),
  ) {}

// Full API (REST endpoints - use /rpc for streaming)

export class GentApi extends HttpApi.make("gent")
  .add(SessionsApi)
  .add(MessagesApi)
  .annotate(OpenApi.Title, "Gent API") {}
