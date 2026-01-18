import { Schema } from "effect"

// Message Part Types

export class TextPart extends Schema.TaggedClass<TextPart>()("TextPart", {
  text: Schema.String,
}) {}

export class ToolCallPart extends Schema.TaggedClass<ToolCallPart>()(
  "ToolCallPart",
  {
    toolCallId: Schema.String,
    toolName: Schema.String,
    args: Schema.Unknown,
  }
) {}

export class ToolResultPart extends Schema.TaggedClass<ToolResultPart>()(
  "ToolResultPart",
  {
    toolCallId: Schema.String,
    toolName: Schema.String,
    result: Schema.Unknown,
    isError: Schema.optional(Schema.Boolean),
  }
) {}

export class ReasoningPart extends Schema.TaggedClass<ReasoningPart>()(
  "ReasoningPart",
  {
    text: Schema.String,
  }
) {}

export class ImagePart extends Schema.TaggedClass<ImagePart>()("ImagePart", {
  url: Schema.String,
  mimeType: Schema.optional(Schema.String),
}) {}

export const MessagePart = Schema.Union(
  TextPart,
  ToolCallPart,
  ToolResultPart,
  ReasoningPart,
  ImagePart
)
export type MessagePart = typeof MessagePart.Type

// Message Role

export const MessageRole = Schema.Literal("user", "assistant", "system")
export type MessageRole = typeof MessageRole.Type

// Message

export class Message extends Schema.Class<Message>("Message")({
  id: Schema.String,
  sessionId: Schema.String,
  branchId: Schema.String,
  role: MessageRole,
  parts: Schema.Array(MessagePart),
  createdAt: Schema.DateFromNumber,
}) {}

// Session

export class Session extends Schema.Class<Session>("Session")({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  createdAt: Schema.DateFromNumber,
  updatedAt: Schema.DateFromNumber,
}) {}

// Branch

export class Branch extends Schema.Class<Branch>("Branch")({
  id: Schema.String,
  sessionId: Schema.String,
  parentBranchId: Schema.optional(Schema.String),
  parentMessageId: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  createdAt: Schema.DateFromNumber,
}) {}

// Compaction

export class Compaction extends Schema.Class<Compaction>("Compaction")({
  id: Schema.String,
  branchId: Schema.String,
  summary: Schema.String,
  messageCount: Schema.Number,
  tokenCount: Schema.Number,
  createdAt: Schema.DateFromNumber,
}) {}
