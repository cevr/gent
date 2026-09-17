import { Predicate, Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { SessionId, BranchId, MessageId, ToolCallId } from "./ids"
import { ReasoningEffort } from "./agent"
import { ModelId } from "./model"

export const dateFromMillis = (millis: number): Date => Schema.decodeSync(DateFromNumber)(millis)

// Actor payloads are already materialized domain values, while persisted and
// transport inputs use epoch milliseconds. Accept both forms and encode Dates
// back to numbers at boundaries that request encoding.
const DateFromNumber = Schema.Union([Schema.DateFromMillis, Schema.Date])

export const decodeDateFromMillis = Schema.decodeUnknownEffect(DateFromNumber)

export class ToolInteraction extends Schema.Class<ToolInteraction>("ToolInteraction")({
  id: ToolCallId,
  toolName: Schema.String,
  status: Schema.Literals(["running", "completed", "error"]),
  input: Schema.UndefinedOr(Schema.Unknown),
  summary: Schema.UndefinedOr(Schema.String),
  output: Schema.UndefinedOr(Schema.String),
  /** Wall time between the started and terminal receipts; absent while running or without receipts. */
  durationMs: Schema.UndefinedOr(Schema.Finite),
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

/**
 * Custom types of the user-role messages the runtime writes for the model:
 * a continuation prompt inside a turn, a context-window handoff marker, the
 * model-change notice, and steering that joined a turn already running. None
 * of them is a turn a person asked for on its own, so recovery never answers
 * one by itself.
 *
 * `max-steps` marks the instruction that opens the last step a turn is
 * allowed. The step that reads it runs with tools disabled, so the turn ends
 * with an answer rather than being cut off mid-plan. Like the others it is
 * never a turn to answer on its own.
 *
 * `steering` marks only an interjection delivered at a step boundary: the
 * turn it joined already answers it, and it never gets a `TurnCompleted` of
 * its own. An interjection that woke an idle branch is a turn in its own
 * right, carries no marker, and still recovers after a restart.
 */
export const RuntimeUserMessageType = Schema.Literals([
  "continuation",
  "context-window",
  "max-steps",
  "model-change",
  "steering",
])
export type RuntimeUserMessageType = typeof RuntimeUserMessageType.Type
const isRuntimeUserMessageType = Schema.is(RuntimeUserMessageType)

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
  turnDurationMs: Schema.optional(Schema.Finite),
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

/**
 * One ordered piece of an assistant answer, in the order the model produced it.
 *
 * The transcript renders these in sequence; a client that only wants the text
 * still reads `parts`. `tool-call` names an interaction on the same projected
 * message, so a client resolves it by id instead of copying the payload.
 */
const TextSegmentStruct = Schema.TaggedStruct("Text", { content: Schema.String })
const ReasoningSegmentStruct = Schema.TaggedStruct("Reasoning", { content: Schema.String })
const ImageSegmentStruct = Schema.TaggedStruct("Image", { mediaType: Schema.String })
const ToolCallSegmentStruct = Schema.TaggedStruct("ToolCall", { toolCallId: ToolCallId })

export const MessageSegment = Schema.Union([
  TextSegmentStruct,
  ReasoningSegmentStruct,
  ImageSegmentStruct,
  ToolCallSegmentStruct,
]).pipe(Schema.toTaggedUnion("_tag"))
export type MessageSegment = Schema.Schema.Type<typeof MessageSegment>

const ProjectedMessageFields = {
  ...MessageFields,
  toolInteractions: Schema.Array(ToolInteraction),
  /** Assistant answer pieces in production order; empty for other roles. */
  segments: Schema.Array(MessageSegment),
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

const messageFields = (message: Message) => {
  const optional: { -readonly [K in "turnDurationMs" | "metadata"]?: Message[K] } = {}
  if (Predicate.isNotUndefined(message.turnDurationMs))
    optional.turnDurationMs = message.turnDurationMs
  if (Predicate.isNotUndefined(message.metadata)) optional.metadata = message.metadata
  return {
    id: message.id,
    sessionId: message.sessionId,
    branchId: message.branchId,
    role: message.role,
    parts: message.parts,
    createdAt: message.createdAt,
    ...optional,
  }
}

export const copyMessageToBranch = (
  message: Message,
  params: {
    id: MessageId
    sessionId?: SessionId
    branchId: BranchId
  },
): Message => {
  const fields = {
    ...messageFields(message),
    id: params.id,
    sessionId: params.sessionId ?? message.sessionId,
    branchId: params.branchId,
  }
  if (message._tag === "interjection")
    return Message.cases.interjection.make({ ...fields, role: "user" })
  return Message.cases.regular.make(fields)
}

/** Assistant answer pieces in production order. Other roles produce none. */
const messageSegments = (
  message: Message,
  toolInteractions: ReadonlyArray<ToolInteraction>,
): ReadonlyArray<MessageSegment> => {
  if (message.role !== "assistant") return []
  const interactionIds = new Set(toolInteractions.map((interaction) => String(interaction.id)))
  const segments: MessageSegment[] = []
  for (const part of message.parts) {
    if (part.type === "text") {
      segments.push(MessageSegment.cases.Text.make({ content: part.text }))
      continue
    }
    if (part.type === "reasoning") {
      segments.push(MessageSegment.cases.Reasoning.make({ content: part.text }))
      continue
    }
    if (part.type === "file" && part.mediaType.startsWith("image/")) {
      segments.push(MessageSegment.cases.Image.make({ mediaType: part.mediaType }))
      continue
    }
    // A call without a projected interaction has no payload to show yet.
    if (part.type === "tool-call" && interactionIds.has(part.id)) {
      segments.push(MessageSegment.cases.ToolCall.make({ toolCallId: ToolCallId.make(part.id) }))
    }
  }
  return segments
}

export const projectMessage = (
  message: Message,
  toolInteractions: ReadonlyArray<ToolInteraction>,
): ProjectedMessage => {
  const fields = {
    ...messageFields(message),
    toolInteractions,
    segments: messageSegments(message, toolInteractions),
  }
  if (message._tag === "interjection")
    return ProjectedMessage.cases.interjection.make({ ...fields, role: "user" })
  return ProjectedMessage.cases.regular.make(fields)
}

// Session

export class Session extends Schema.Class<Session>("Session")({
  id: SessionId,
  name: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  /** Session-scoped model; wins over the agent definition and config for every turn. */
  modelId: Schema.optional(ModelId),
  reasoningLevel: Schema.optional(ReasoningEffort),
  activeBranchId: Schema.optional(BranchId),
  parentSessionId: Schema.optional(SessionId),
  parentBranchId: Schema.optional(BranchId),
  /**
   * The thread this session belongs to, named by the session that started it.
   *
   * A compaction handoff inherits its parent's thread, so work that outgrew one
   * context window stays one thread. A delegate run or a `/btw` side question
   * starts its own, so it never pollutes the thread it was launched from.
   * Storage fills it in on create; only a caller continuing existing work
   * passes one.
   */
  threadId: Schema.optional(SessionId),
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
  createdAt: DateFromNumber,
}) {}

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
  messageCount: Schema.Finite,
  children: Schema.Array(
    Schema.suspend((): Schema.Codec<BranchTreeNode, BranchTreeNodeEncoded> => BranchTreeNode),
  ),
})

export const assistantMessageIdForTurn = (messageId: MessageId, step = 1): MessageId =>
  MessageId.make(`${messageId}:assistant:${step}`)

/** A user-role message the runtime wrote for the model, not a turn to answer. */
export const isRuntimeUserMessage = (message: {
  readonly role: MessageRole
  readonly metadata?: MessageMetadata
}): boolean => message.role === "user" && isRuntimeUserMessageType(message.metadata?.customType)
