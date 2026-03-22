import { Schema, SchemaGetter as Getter } from "effect"
import { SessionId, BranchId, MessageId } from "./ids"
import { ReasoningEffort } from "./agent"

// v4: DateFromNumber was removed — define locally
export const DateFromNumber = Schema.Number.pipe(
  Schema.decodeTo(Schema.DateValid, {
    decode: Getter.transform((n: number) => new Date(n)),
    encode: Getter.transform((d: Date) => d.getTime()),
  }),
)

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
    type: Schema.Literals(["json", "error-json"]),
    value: Schema.Unknown,
  }),
}) {}

export class ReasoningPart extends Schema.Class<ReasoningPart>("ReasoningPart")({
  type: Schema.Literal("reasoning"),
  text: Schema.String,
}) {}

export const MessagePart = Schema.Union([
  TextPart,
  ImagePart,
  ToolCallPart,
  ToolResultPart,
  ReasoningPart,
])
export type MessagePart = typeof MessagePart.Type

// Message Role

export const MessageRole = Schema.Literals(["user", "assistant", "system", "tool"])
export type MessageRole = typeof MessageRole.Type

// Message

export class Message extends Schema.Class<Message>("Message")({
  id: MessageId,
  sessionId: SessionId,
  branchId: BranchId,
  kind: Schema.optional(Schema.Literals(["regular", "interjection"])),
  role: MessageRole,
  parts: Schema.Array(MessagePart),
  createdAt: DateFromNumber,
  turnDurationMs: Schema.optional(Schema.Number),
}) {}

// Session

export class Session extends Schema.Class<Session>("Session")({
  id: SessionId,
  name: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  bypass: Schema.optional(Schema.Boolean),
  reasoningLevel: Schema.optional(ReasoningEffort),
  parentSessionId: Schema.optional(SessionId),
  parentBranchId: Schema.optional(BranchId),
  createdAt: DateFromNumber,
  updatedAt: DateFromNumber,
}) {}

// Branch

export class Branch extends Schema.Class<Branch>("Branch")({
  id: BranchId,
  sessionId: SessionId,
  parentBranchId: Schema.optional(BranchId),
  parentMessageId: Schema.optional(MessageId),
  name: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  createdAt: DateFromNumber,
}) {}

// Session Tree Node - recursive structure for session hierarchy

export interface SessionTreeNode {
  session: Session
  children: readonly SessionTreeNode[]
}
