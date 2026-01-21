import { Schema } from "effect"

// Message Part Types - matching AI SDK v6 shape

export class TextPart extends Schema.Class<TextPart>("TextPart")({
  type: Schema.Literal("text"),
  text: Schema.String,
}) {}

export class ImagePart extends Schema.Class<ImagePart>("ImagePart")({
  type: Schema.Literal("image"),
  image: Schema.String, // URL or base64
  mediaType: Schema.optional(Schema.String),
}) {}

export class ToolCallPart extends Schema.Class<ToolCallPart>("ToolCallPart")({
  type: Schema.Literal("tool-call"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  input: Schema.Unknown, // AI SDK v6 uses 'input' not 'args'
}) {}

// Simplified ToolResultOutput - just JSON for now
export class ToolResultPart extends Schema.Class<ToolResultPart>("ToolResultPart")({
  type: Schema.Literal("tool-result"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  output: Schema.Struct({
    type: Schema.Literal("json", "error-json"),
    value: Schema.Unknown,
  }),
}) {}

export class ReasoningPart extends Schema.Class<ReasoningPart>("ReasoningPart")({
  type: Schema.Literal("reasoning"),
  text: Schema.String,
}) {}

export const MessagePart = Schema.Union(
  TextPart,
  ImagePart,
  ToolCallPart,
  ToolResultPart,
  ReasoningPart,
)
export type MessagePart = typeof MessagePart.Type

// Message Role

export const MessageRole = Schema.Literal("user", "assistant", "system", "tool")
export type MessageRole = typeof MessageRole.Type

// Message

export class Message extends Schema.Class<Message>("Message")({
  id: Schema.String,
  sessionId: Schema.String,
  branchId: Schema.String,
  role: MessageRole,
  parts: Schema.Array(MessagePart),
  createdAt: Schema.DateFromNumber,
  turnDurationMs: Schema.optional(Schema.Number),
}) {}

// Session

export class Session extends Schema.Class<Session>("Session")({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
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
  model: Schema.optional(Schema.String),
  createdAt: Schema.DateFromNumber,
}) {}

// Checkpoint - discriminated union for context management

const CheckpointBase = {
  id: Schema.String,
  branchId: Schema.String,
  messageCount: Schema.Number,
  tokenCount: Schema.Number,
  createdAt: Schema.DateFromNumber,
}

// Compaction checkpoint: summarizes history, keeps recent messages
export class CompactionCheckpoint extends Schema.TaggedClass<CompactionCheckpoint>()(
  "CompactionCheckpoint",
  {
    ...CheckpointBase,
    summary: Schema.String,
    firstKeptMessageId: Schema.String,
  },
) {}

// Plan checkpoint: hard reset, only plan file as context
export class PlanCheckpoint extends Schema.TaggedClass<PlanCheckpoint>()("PlanCheckpoint", {
  ...CheckpointBase,
  planPath: Schema.String,
}) {}

export const Checkpoint = Schema.Union(CompactionCheckpoint, PlanCheckpoint)
export type Checkpoint = typeof Checkpoint.Type
