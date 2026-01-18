import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "@effect/platform"
import { Schema } from "effect"

// Request/Response Schemas

export const SendMessageRequest = Schema.Struct({
  sessionId: Schema.String,
  branchId: Schema.String,
  content: Schema.String,
})

export const CreateSessionRequest = Schema.Struct({
  name: Schema.optional(Schema.String),
})

export const CreateSessionResponse = Schema.Struct({
  sessionId: Schema.String,
  branchId: Schema.String,
})

export const SessionResponse = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})

export const MessageResponse = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  branchId: Schema.String,
  role: Schema.Literal("user", "assistant", "system"),
  parts: Schema.Array(Schema.Unknown),
  createdAt: Schema.Number,
})

export const SteerRequest = Schema.Union(
  Schema.TaggedStruct("Cancel", {}),
  Schema.TaggedStruct("Interrupt", { message: Schema.String }),
  Schema.TaggedStruct("SwitchModel", { model: Schema.String })
)

// API Groups

export class SessionsApi extends HttpApiGroup.make("sessions")
  .add(
    HttpApiEndpoint.post("create", "/sessions")
      .setPayload(CreateSessionRequest)
      .addSuccess(CreateSessionResponse)
  )
  .add(
    HttpApiEndpoint.get("list", "/sessions").addSuccess(
      Schema.Array(SessionResponse)
    )
  )
  .add(
    HttpApiEndpoint.get("get", "/sessions/:sessionId")
      .setPath(Schema.Struct({ sessionId: Schema.String }))
      .addSuccess(SessionResponse)
  )
  .add(
    HttpApiEndpoint.del("delete", "/sessions/:sessionId")
      .setPath(Schema.Struct({ sessionId: Schema.String }))
      .addSuccess(Schema.Void)
  ) {}

export class MessagesApi extends HttpApiGroup.make("messages")
  .add(
    HttpApiEndpoint.post("send", "/messages")
      .setPayload(SendMessageRequest)
      .addSuccess(Schema.Void)
  )
  .add(
    HttpApiEndpoint.get(
      "list",
      "/sessions/:sessionId/branches/:branchId/messages"
    )
      .setPath(
        Schema.Struct({ sessionId: Schema.String, branchId: Schema.String })
      )
      .addSuccess(Schema.Array(MessageResponse))
  )
  .add(
    HttpApiEndpoint.post("steer", "/steer")
      .setPayload(SteerRequest)
      .addSuccess(Schema.Void)
  ) {}

export class EventsApi extends HttpApiGroup.make("events").add(
  HttpApiEndpoint.get("subscribe", "/events/:sessionId")
    .setPath(Schema.Struct({ sessionId: Schema.String }))
    .addSuccess(Schema.String) // SSE stream
) {}

// Full API

export class GentApi extends HttpApi.make("gent")
  .add(SessionsApi)
  .add(MessagesApi)
  .add(EventsApi)
  .annotate(OpenApi.Title, "Gent API") {}
