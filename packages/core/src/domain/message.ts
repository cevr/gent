import { DateTime, Schema, SchemaGetter as Getter } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { SessionId, BranchId, MessageId, ToolCallId } from "./ids"
import { ReasoningEffort } from "./agent"

export const dateFromMillis = (millis: number): Date =>
  Schema.decodeUnknownSync(DateFromNumber)(millis)

export const DateFromNumber = Schema.DateTimeUtcFromMillis.pipe(
  Schema.decodeTo(Schema.DateValid, {
    decode: Getter.transform(DateTime.toDateUtc),
    encode: Getter.dateTimeUtcFromInput(),
  }),
)

export class ToolInteraction extends Schema.Class<ToolInteraction>("ToolInteraction")({
  id: ToolCallId,
  toolName: Schema.String,
  status: Schema.Literals(["running", "completed", "error"]),
  input: Schema.UndefinedOr(Schema.Unknown),
  summary: Schema.UndefinedOr(Schema.String),
  output: Schema.UndefinedOr(Schema.String),
}) {}

export const MessagePart = Schema.Union([
  Prompt.TextPart,
  Prompt.FilePart,
  Prompt.ToolCallPart,
  Prompt.ToolResultPart,
  Prompt.ReasoningPart,
  Prompt.ToolApprovalRequestPart,
  Prompt.ToolApprovalResponsePart,
])
export type MessagePart = Prompt.Part

// Message Role

export const MessageRole = Schema.Literals(["user", "assistant", "system", "tool"])
export type MessageRole = typeof MessageRole.Type

// Message Metadata — extension-authored envelope for hidden/custom messages

export const MessageMetadata = Schema.Struct({
  /** Extension-defined type tag for custom message rendering */
  customType: Schema.optional(Schema.String),
  /** Which extension authored this message */
  extensionId: Schema.optional(Schema.String),
  /** If true, message is excluded from LLM context but visible in transcript */
  hidden: Schema.optional(Schema.Boolean),
  /** Arbitrary structured details for the custom message */
  details: Schema.optional(Schema.Unknown),
})
export type MessageMetadata = typeof MessageMetadata.Type

// Message

const MessageFields = {
  id: MessageId,
  sessionId: SessionId,
  branchId: BranchId,
  role: MessageRole,
  parts: Schema.Array(MessagePart),
  createdAt: DateFromNumber,
  turnDurationMs: Schema.optional(Schema.Number),
  metadata: Schema.optional(MessageMetadata),
}

const RegularMessageStruct = Schema.TaggedStruct("regular", MessageFields)
const InterjectionMessageStruct = Schema.TaggedStruct("interjection", {
  ...MessageFields,
  role: Schema.Literal("user"),
})

export const Message = Schema.Union([RegularMessageStruct, InterjectionMessageStruct]).pipe(
  Schema.toTaggedUnion("_tag"),
)
export type Message = Schema.Schema.Type<typeof Message>
export type RegularMessage = Extract<Message, { _tag: "regular" }>
export type InterjectionMessage = Extract<Message, { _tag: "interjection" }>

const ProjectedMessageFields = {
  ...MessageFields,
  toolInteractions: Schema.Array(ToolInteraction),
}

const RegularProjectedMessageStruct = Schema.TaggedStruct("regular", ProjectedMessageFields)
const InterjectionProjectedMessageStruct = Schema.TaggedStruct("interjection", {
  ...ProjectedMessageFields,
  role: Schema.Literal("user"),
})

export const ProjectedMessage = Schema.Union([
  RegularProjectedMessageStruct,
  InterjectionProjectedMessageStruct,
]).pipe(Schema.toTaggedUnion("_tag"))
export type ProjectedMessage = Schema.Schema.Type<typeof ProjectedMessage>

export const copyMessageToBranch = (
  message: Message,
  params: {
    id: MessageId
    sessionId?: SessionId
    branchId: BranchId
  },
): Message => {
  const fields = {
    id: params.id,
    sessionId: params.sessionId ?? message.sessionId,
    branchId: params.branchId,
    role: message.role,
    parts: message.parts,
    createdAt: message.createdAt,
    ...(message.turnDurationMs !== undefined ? { turnDurationMs: message.turnDurationMs } : {}),
    ...(message.metadata !== undefined ? { metadata: message.metadata } : {}),
  }
  return message._tag === "interjection"
    ? Message.cases.interjection.make({ ...fields, role: "user" })
    : Message.cases.regular.make(fields)
}

export const projectMessage = (
  message: Message,
  toolInteractions: ReadonlyArray<ToolInteraction>,
): ProjectedMessage => {
  const fields = {
    id: message.id,
    sessionId: message.sessionId,
    branchId: message.branchId,
    role: message.role,
    parts: message.parts,
    createdAt: message.createdAt,
    toolInteractions,
    ...(message.turnDurationMs !== undefined ? { turnDurationMs: message.turnDurationMs } : {}),
    ...(message.metadata !== undefined ? { metadata: message.metadata } : {}),
  }
  return message._tag === "interjection"
    ? ProjectedMessage.cases.interjection.make({ ...fields, role: "user" })
    : ProjectedMessage.cases.regular.make(fields)
}

// Session

export class Session extends Schema.Class<Session>("Session")({
  id: SessionId,
  name: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  reasoningLevel: Schema.optional(ReasoningEffort),
  activeBranchId: Schema.optional(BranchId),
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

interface SessionTreeNodeEncoded {
  session: Schema.Codec.Encoded<typeof Session>
  children: readonly SessionTreeNodeEncoded[]
}

export const SessionTreeNode: Schema.Codec<SessionTreeNode, SessionTreeNodeEncoded> = Schema.Struct(
  {
    session: Session,
    children: Schema.Array(
      Schema.suspend((): Schema.Codec<SessionTreeNode, SessionTreeNodeEncoded> => SessionTreeNode),
    ),
  },
)

export interface BranchTreeNode {
  branch: Branch
  messageCount: number
  children: readonly BranchTreeNode[]
}

interface BranchTreeNodeEncoded {
  branch: Schema.Codec.Encoded<typeof Branch>
  messageCount: number
  children: readonly BranchTreeNodeEncoded[]
}

export const BranchTreeNode: Schema.Codec<BranchTreeNode, BranchTreeNodeEncoded> = Schema.Struct({
  branch: Branch,
  messageCount: Schema.Number,
  children: Schema.Array(
    Schema.suspend((): Schema.Codec<BranchTreeNode, BranchTreeNodeEncoded> => BranchTreeNode),
  ),
})
