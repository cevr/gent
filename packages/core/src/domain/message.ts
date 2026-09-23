import { Option, Predicate, Result, Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { BranchId, MessageId, RequestId, SessionId, ToolCallId } from "./ids.js"
import { AgentName, ModelId, ReasoningEffort, RunSpecSchema } from "./agent.js"
import type { EventEnvelope, ToolCallStarted, Usage } from "./event.js"
import * as Response from "effect/unstable/ai/Response"

// ── head-tail ───────────────────────────────────────────────────────────────

/**
 * Head + tail projections of a bounded view over a longer sequence: the
 * first half, a truncation marker, the last half.
 */

interface HeadTailResult<T> {
  readonly head: T[]
  readonly tail: T[]
  readonly truncatedCount: number
}

interface HeadTailCharsResult {
  readonly text: string
  readonly truncated: boolean
  readonly totalChars: number
}

/**
 * Truncate an array to head + tail. For when all items are known upfront.
 */
export function headTail<T>(items: readonly T[], maxItems: number = 100): HeadTailResult<T> {
  const total = items.length
  if (total <= maxItems) {
    return { head: [...items], tail: [], truncatedCount: 0 }
  }

  const half = Math.floor(maxItems / 2)
  const head = items.slice(0, half)
  const tail = items.slice(-half)

  return { head, tail, truncatedCount: total - half * 2 }
}

/**
 * Format head+tail arrays with truncation marker.
 */
export function formatHeadTail(
  items: readonly unknown[],
  maxItems: number = 100,
  truncatedMsg: (count: number) => string = (n) => `... [${n} lines truncated] ...`,
): string {
  const { head, tail, truncatedCount } = headTail(items, maxItems)

  if (truncatedCount === 0) {
    return head.map(String).join("\n")
  }

  return [...head.map(String), "", truncatedMsg(truncatedCount), "", ...tail.map(String)].join("\n")
}

/**
 * Truncate raw text to head + tail by characters.
 */
export function headTailChars(text: string, maxChars: number = 64_000): HeadTailCharsResult {
  const total = text.length
  if (total <= maxChars) {
    return { text, truncated: false, totalChars: total }
  }

  const half = Math.floor(maxChars / 2)
  const head = text.slice(0, half)
  const tail = text.slice(-half)

  return {
    text: `${head}\n\n... [${total - maxChars} characters truncated] ...\n\n${tail}`,
    truncated: true,
    totalChars: total,
  }
}

/**
 * Keep the head of `text` up to `maxChars`. A longer text ends in `marker`.
 */
function clipChars(text: string, maxChars: number, marker: string = "…"): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + marker
}

// ── message ─────────────────────────────────────────────────────────────────

export const dateFromMillis = (millis: number): Date => Schema.decodeSync(DateFromNumber)(millis)

// Actor payloads are already materialized domain values, while persisted and
// transport inputs use epoch milliseconds. Accept both forms and encode Dates
// back to numbers at boundaries that request encoding.
const DateFromNumber = Schema.Union([Schema.DateFromMillis, Schema.Date])

export const decodeDateFromMillis = Schema.decodeUnknownEffect(DateFromNumber)

const ToolInteractionFields = {
  id: ToolCallId,
  toolName: Schema.String,
  status: Schema.Literals(["running", "completed", "error"]),
  input: Schema.UndefinedOr(Schema.Unknown),
  summary: Schema.UndefinedOr(Schema.String),
  output: Schema.UndefinedOr(Schema.String),
  /** Wall time between the started and terminal receipts; absent while running or without receipts. */
  durationMs: Schema.UndefinedOr(Schema.Finite),
}

/** One call a cell admitted, read from its stored tool receipts. */
const ToolOperation = Schema.Struct(ToolInteractionFields)
type ToolOperation = typeof ToolOperation.Type

export class ToolInteraction extends Schema.Class<ToolInteraction>("ToolInteraction")({
  ...ToolInteractionFields,
  /**
   * The calls a cell admitted, from the branch's tool receipts. Wire only,
   * never stored. Each carries what its collapsed row draws: bounded scalar
   * input and summary, never the output. Absent when the branch has no
   * receipts for them, as on a fork, which copies messages but not events.
   */
  operations: Schema.optional(Schema.Array(ToolOperation)),
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
 * `steering` is the marker older builds wrote over the custom type of an
 * interjection delivered at a step boundary. Stored rows still carry it, so
 * it stays a runtime type. A delivery now keeps the sender's custom type and
 * sets `MessageMetadata.joinedTurn` instead.
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
  /**
   * Set by the loop on an interjection delivered at a step boundary. The turn
   * it joined answers it, and it never gets a `TurnCompleted` of its own, so
   * recovery must not read it as a turn. An interjection that woke an idle
   * branch is a turn in its own right, carries no mark, and still recovers.
   */
  joinedTurn: Schema.optional(Schema.Boolean),
  /** Arbitrary structured details for the custom message */
  details: Schema.optional(Schema.Unknown),
})
export type MessageMetadata = typeof MessageMetadata.Type

// Steer Command — RPC payload that targets a session/branch loop.
// Lives beside the message vocabulary: an Interject carries the envelope of
// the interjection it persists, and `agent.ts` is upstream of this file.

const SteerTargetFields = {
  sessionId: SessionId,
  branchId: BranchId,
  requestId: RequestId,
}

export const SteerCommand = Schema.Union([
  Schema.TaggedStruct("Cancel", {
    ...SteerTargetFields,
    messageId: Schema.optional(MessageId),
  }),
  // No writer sends `Interrupt`; it stays so stored Steer mailbox rows still decode.
  // The loop treats it as `Cancel`.
  Schema.TaggedStruct("Interrupt", {
    ...SteerTargetFields,
    messageId: Schema.optional(MessageId),
  }),
  Schema.TaggedStruct("Interject", {
    ...SteerTargetFields,
    message: Schema.String,
    /**
     * Envelope on the persisted interjection: who wrote it and why. The
     * envelope survives delivery; an item that joins a running turn also
     * gets `joinedTurn`.
     */
    metadata: Schema.optional(MessageMetadata),
    agent: Schema.optional(AgentName),
    /**
     * Start a turn when the branch is idle, instead of waiting in the queue.
     *
     * Steering exists to reach a turn that is already running, so an idle
     * branch parks it by default and a reader can still see it through
     * `queue.get`. A caller that wants an answer now — a queued question
     * being answered, a child reporting back — says so here.
     */
    wake: Schema.optional(Schema.Boolean),
  }),
])
export type SteerCommand = typeof SteerCommand.Type

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

/** The same message with other parts. */
export const messageWithParts = (message: Message, parts: ReadonlyArray<MessagePart>): Message => {
  const fields = { ...messageFields(message), parts }
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
   * A handoff joins its parent's thread (`continueThread` on create), so work
   * that outgrew one session stays one thread. Every other session, a
   * delegate child or a `/btw` fork included, starts its own, so side work
   * never joins the thread it was launched from. Storage fills it with the
   * session id when the create names none.
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

/** The tool-result message one step of a turn writes. */
export const toolResultMessageIdForTurn = (messageId: MessageId, step = 1): MessageId =>
  MessageId.make(`${messageId}:tool-result:${step}`)

/** A user-role message the runtime wrote for the model, or one a running turn already answered. */
export const isRuntimeUserMessage = (message: {
  readonly role: MessageRole
  readonly metadata?: MessageMetadata
}): boolean =>
  message.role === "user" &&
  (isRuntimeUserMessageType(message.metadata?.customType) || message.metadata?.joinedTurn === true)

// ── tool-output ─────────────────────────────────────────────────────────────

/** Structured failure data. The runner, not the tool, owns transcript identity. */
export class ToolResultFailure extends Schema.TaggedError<ToolResultFailure>()(
  "ToolResultFailure",
  { message: Schema.String, result: Schema.Json },
) {}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

// The event transcript stores this lossless JSON form for replay. Keep the
// human-facing summary and display string separate from this value.
// oxlint-disable-next-line effect/noUnknownParameters -- Tool output is decoded at this schema boundary.
export const encodeToolOutput = (value: unknown): string => encodeJson(value)

export const decodeToolOutput = (value: string): Option.Option<unknown> =>
  Result.try(() => decodeJson(value)).pipe(Result.getSuccess)

// oxlint-disable-next-line effect/noUnknownParameters -- Tool output is an external provider value parsed by the JSON codec below.
const tryStringifyJson = (value: unknown): Option.Option<string> =>
  Result.try(() => encodeJson(value)).pipe(Result.getSuccess)

// oxlint-disable-next-line effect/noUnknownParameters -- Tool output is an external provider value parsed by the JSON codec below.
const tryPrettyStringifyJson = (value: unknown): Option.Option<string> =>
  Result.try(() => {
    const encoded = encodeJson(value)
    const decoded = decodeJson(encoded)
    // oxlint-disable-next-line effect/noGlobals, effect/noNullish -- Pretty output preserves the established tool transcript format.
    const pretty = JSON.stringify(decoded, null, 2)
    if (Predicate.isUndefined(pretty)) return String(value)
    return pretty
  }).pipe(Result.getSuccess)

// oxlint-disable-next-line effect/noUnknownParameters -- Tool output is an external provider value parsed by the JSON codec below.
export const stringifyOutput = (value: unknown): string => {
  if (Predicate.isString(value)) return value
  return Option.getOrElse(tryPrettyStringifyJson(value), () => String(value))
}

/** One-line tool summary for transcripts and the tool row; ASCII marker for plain terminals. */
const clipSummary = (text: string): string => clipChars(text, 100, "...")

// oxlint-disable-next-line effect/noUnknownParameters -- Tool output is an external provider value parsed by the JSON codec below.
export const summarizeOutput = (value: unknown): string => {
  if (Predicate.isString(value)) return clipSummary(value.split("\n")[0] ?? "")
  return Option.match(tryStringifyJson(value), {
    onNone: () => String(value),
    onSome: clipSummary,
  })
}

// ── message-part-display ────────────────────────────────────────────────────

export interface ImagePartProjection {
  readonly mediaType: string
}

interface ToolCallPartProjection {
  readonly id: string
  readonly toolName: string
  readonly input: unknown
}

interface ToolResultPartProjection {
  readonly id: string
  readonly toolName: string
  readonly value: unknown
  readonly summary: string
  readonly text: string
  readonly isError: boolean
}

interface ToolResultState {
  readonly summary: string
  readonly output: string
  readonly isError: boolean
}

interface IndexedToolResultState extends ToolResultState {
  readonly messageIndex: number
  readonly partIndex: number
}

interface ToolCallPosition {
  readonly messageIndex: number
  readonly partIndex: number
}

interface IndexedToolCallState extends ToolCallPartProjection {
  readonly position: ToolCallPosition
}

interface MessagePartsDisplayTextOptions {
  readonly maxToolChars?: number
}

type JsonEncoderInput = Parameters<typeof encodeToolOutput>[0]

const stringifyDisplayValue = (value: JsonEncoderInput): string => {
  const encoded = Result.try(() => encodeToolOutput(value))
  if (Result.isFailure(encoded)) return String(value)
  return encoded.success
}

// oxlint-disable-next-line effect/noNullish -- This projection helper preserves the established public absence contract.
const messagePartText = (part: MessagePart): string | undefined => {
  if (part.type === "text") return part.text
  // oxlint-disable-next-line effect/noNullish -- This projection helper preserves the established public absence contract.
  return undefined
}

// oxlint-disable-next-line effect/noNullish -- This projection helper preserves the established public absence contract.
const messagePartReasoning = (part: MessagePart): string | undefined => {
  if (part.type === "reasoning") return part.text
  // oxlint-disable-next-line effect/noNullish -- This projection helper preserves the established public absence contract.
  return undefined
}

// oxlint-disable-next-line effect/noNullish -- This projection helper preserves the established public absence contract.
const messagePartImage = (part: MessagePart): ImagePartProjection | undefined => {
  // oxlint-disable-next-line effect/noNullish -- This projection helper preserves the established public absence contract.
  if (part.type !== "file" || !part.mediaType.startsWith("image/")) return undefined
  return { mediaType: part.mediaType }
}

// oxlint-disable-next-line effect/noNullish -- This projection helper preserves the established public absence contract.
const messagePartToolCall = (part: MessagePart): ToolCallPartProjection | undefined => {
  // oxlint-disable-next-line effect/noNullish -- This projection helper preserves the established public absence contract.
  if (part.type !== "tool-call") return undefined
  return {
    id: part.id,
    toolName: part.name,
    input: part.params,
  }
}

// oxlint-disable-next-line effect/noNullish -- This projection helper preserves the established public absence contract.
const messagePartToolResult = (part: MessagePart): ToolResultPartProjection | undefined => {
  // oxlint-disable-next-line effect/noNullish -- This projection helper preserves the established public absence contract.
  if (part.type !== "tool-result") return undefined
  return {
    id: part.id,
    toolName: part.name,
    value: part.result,
    summary: summarizeOutput(part.result),
    text: stringifyOutput(part.result),
    isError: part.isFailure,
  }
}

export const messagePartsText = (parts: ReadonlyArray<MessagePart>): string =>
  parts.flatMap((part) => messagePartText(part) ?? []).join("")

export const messagePartsTextLines = (parts: ReadonlyArray<MessagePart>): ReadonlyArray<string> =>
  parts.flatMap((part) => {
    const text = messagePartText(part)
    if (Predicate.isUndefined(text)) return []
    return [text]
  })

// oxlint-disable-next-line effect/noNullish -- This projection helper preserves the established public absence contract.
export const messageSingleText = (parts: ReadonlyArray<MessagePart>): string | undefined => {
  // oxlint-disable-next-line effect/noNullish -- This projection helper preserves the established public absence contract.
  if (parts.length !== 1) return undefined
  const [part] = parts
  // oxlint-disable-next-line effect/noNullish -- This projection helper preserves the established public absence contract.
  if (Predicate.isUndefined(part)) return undefined
  return messagePartText(part)
}

export const messagePartsReasoning = (parts: ReadonlyArray<MessagePart>): string =>
  parts.flatMap((part) => messagePartReasoning(part) ?? []).join("")

/**
 * The answer a child run hands back: the last assistant message's text, or its
 * reasoning when the model wrote nothing else.
 */
export const latestAssistantText = (
  messages: ReadonlyArray<{ readonly role: string; readonly parts: ReadonlyArray<MessagePart> }>,
): string => {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (Predicate.isUndefined(message) || message.role !== "assistant") continue
    const text = messagePartsTextLines(message.parts)[0] ?? ""
    if (text.length > 0) return text
    return messagePartsReasoningLines(message.parts).join("\n")
  }
  return ""
}

const messagePartsReasoningLines = (parts: ReadonlyArray<MessagePart>): ReadonlyArray<string> =>
  parts.flatMap((part) => {
    const reasoning = messagePartReasoning(part)
    if (Predicate.isUndefined(reasoning)) return []
    return [reasoning]
  })

export const messagePartsImages = (
  parts: ReadonlyArray<MessagePart>,
): ReadonlyArray<ImagePartProjection> =>
  parts.flatMap((part) => {
    const image = messagePartImage(part)
    if (Predicate.isUndefined(image)) return []
    return [image]
  })

export const messagePartsToolCallParts = (
  parts: ReadonlyArray<MessagePart>,
): ReadonlyArray<Prompt.ToolCallPart> =>
  parts.flatMap((part) => {
    if (part.type === "tool-call") return [part]
    return []
  })

const buildToolResultMapFromMessages = (
  messages: ReadonlyArray<Message>,
): ReadonlyMap<string, ReadonlyArray<IndexedToolResultState>> => {
  const resultMap = new Map<string, IndexedToolResultState[]>()
  for (const [messageIndex, message] of messages.entries()) {
    if (message.role !== "tool") continue
    for (const [partIndex, part] of message.parts.entries()) {
      const result = messagePartToolResult(part)
      if (Predicate.isUndefined(result)) continue
      const results = resultMap.get(result.id) ?? []
      results.push({
        messageIndex,
        partIndex,
        summary: result.summary,
        output: result.text,
        isError: result.isError,
      })
      resultMap.set(result.id, results)
    }
  }
  return resultMap
}

const comparePosition = (left: ToolCallPosition, right: ToolCallPosition): number => {
  if (left.messageIndex !== right.messageIndex) return left.messageIndex - right.messageIndex
  return left.partIndex - right.partIndex
}

const indexedToolCalls = (
  messages: ReadonlyArray<Message>,
): ReadonlyMap<string, ReadonlyArray<IndexedToolCallState>> => {
  const calls = new Map<string, IndexedToolCallState[]>()
  for (const [messageIndex, message] of messages.entries()) {
    for (const [partIndex, part] of message.parts.entries()) {
      const toolCall = messagePartToolCall(part)
      if (Predicate.isUndefined(toolCall)) continue
      const existing = calls.get(toolCall.id) ?? []
      existing.push({ ...toolCall, position: { messageIndex, partIndex } })
      calls.set(toolCall.id, existing)
    }
  }
  return calls
}

const buildToolResultPairings = (
  messages: ReadonlyArray<Message>,
  resultMap: ReadonlyMap<string, ReadonlyArray<IndexedToolResultState>>,
): ReadonlyMap<string, ToolResultState> => {
  const pairings = new Map<string, ToolResultState>()
  const callsById = indexedToolCalls(messages)
  for (const [toolCallId, calls] of callsById) {
    const results = resultMap.get(toolCallId) ?? []
    let resultIndex = 0
    for (const call of calls) {
      while (resultIndex < results.length) {
        const candidate = results[resultIndex]
        if (Predicate.isUndefined(candidate) || comparePosition(candidate, call.position) > 0) break
        resultIndex++
      }
      const result = results[resultIndex]
      if (Predicate.isUndefined(result)) continue
      pairings.set(`${call.position.messageIndex}:${call.position.partIndex}`, result)
      resultIndex++
    }
  }
  return pairings
}

const findResultForToolCall = (
  callMessageIndex: number,
  callPartIndex: number,
  pairings: ReadonlyMap<string, ToolResultState>,
): Option.Option<ToolResultState> =>
  Option.fromUndefinedOr(pairings.get(`${callMessageIndex}:${callPartIndex}`))

/** What a branch's tool receipts add to its messages: durations, and the calls each cell admitted. */
interface ToolCallReceipts {
  readonly durations: ReadonlyMap<ToolCallId, number>
  /** Keyed by `callKey` of the admitting cell, in start order. */
  readonly operations: ReadonlyMap<string, ReadonlyArray<ToolOperation>>
}

/**
 * A call's identity in a branch: the assistant message that holds it plus its
 * id, as cell storage keys a cell. A provider can reuse a call id across
 * steps. Historical receipts carry no message id and key by the call id alone.
 */
const callKey = (assistantMessageId: Option.Option<MessageId>, toolCallId: string): string =>
  `${Option.getOrElse(assistantMessageId, () => "")}\u0000${toolCallId}`

/**
 * An operation's input as its collapsed row reads it: top-level scalar fields,
 * each string cut to the summary bound. Nested values stay on the branch.
 */
// oxlint-disable-next-line effect/noNullish -- ToolInteraction.input is an UndefinedOr wire field; absent input stays absent.
type BoundedInput = string | Readonly<Record<string, string | number | boolean>> | undefined

// oxlint-disable-next-line effect/noUnknownParameters -- Tool input is an external model value; only its scalar fields are kept.
const boundedInput = (input: unknown): BoundedInput => {
  if (Predicate.isString(input)) return clipSummary(input)
  if (!Predicate.isObject(input) || Array.isArray(input))
    return Option.getOrUndefined(Option.none<string>())
  const kept: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(input)) {
    if (Predicate.isString(value)) kept[key] = clipSummary(value)
    else if (Predicate.isNumber(value) || Predicate.isBoolean(value)) kept[key] = value
  }
  return kept
}

const noReceipts: ToolCallReceipts = { durations: new Map(), operations: new Map() }

/**
 * One fold over a branch's tool receipts. A duration is the gap from a call's
 * started receipt to its terminal one. A receipt with a `parentToolCallId` is
 * a call a cell admitted; it lands under that cell with its own input and
 * result, as the live feed draws it.
 */
/** Where an admitted operation sits: under its cell's key, at its start order. */
interface OperationSlot {
  readonly parent: string
  readonly index: number
}

/** Place one admitted call under its cell. The snapshot carries what the collapsed op row draws; the full output stays on the branch. */
const admitOperation = (
  event: ToolCallStarted,
  operations: Map<string, Array<ToolOperation>>,
  slots: Map<string, OperationSlot>,
): void => {
  if (Predicate.isUndefined(event.parentToolCallId)) return
  const message = Option.fromUndefinedOr(event.assistantMessageId)
  const key = callKey(message, event.toolCallId)
  if (slots.has(key)) return
  const parent = callKey(message, event.parentToolCallId)
  const siblings = operations.get(parent) ?? []
  slots.set(key, { parent, index: siblings.length })
  siblings.push({
    id: event.toolCallId,
    toolName: event.toolName,
    status: "running",
    input: boundedInput(event.input),
    summary: Option.getOrUndefined(Option.none<string>()),
    output: Option.getOrUndefined(Option.none<string>()),
    durationMs: Option.getOrUndefined(Option.none<number>()),
  })
  operations.set(parent, siblings)
}

export const toolCallReceipts = (events: ReadonlyArray<EventEnvelope>): ToolCallReceipts => {
  const started = new Map<ToolCallId, number>()
  const durations = new Map<ToolCallId, number>()
  const operations = new Map<string, Array<ToolOperation>>()
  const slots = new Map<string, OperationSlot>()
  for (const envelope of events) {
    const event = envelope.event
    if (event._tag === "ToolCallStarted") {
      started.set(event.toolCallId, envelope.createdAt)
      admitOperation(event, operations, slots)
      continue
    }
    if (event._tag !== "ToolCallSucceeded" && event._tag !== "ToolCallFailed") continue
    const startedAt = started.get(event.toolCallId)
    const durationMs = Option.getOrUndefined(
      Option.map(Option.fromUndefinedOr(startedAt), (at) => Math.max(0, envelope.createdAt - at)),
    )
    if (Predicate.isNotUndefined(durationMs)) durations.set(event.toolCallId, durationMs)
    const position = slots.get(
      callKey(Option.fromUndefinedOr(event.assistantMessageId), event.toolCallId),
    )
    if (Predicate.isUndefined(position)) continue
    const siblings = operations.get(position.parent)
    const current = siblings?.[position.index]
    if (Predicate.isUndefined(siblings) || Predicate.isUndefined(current)) continue
    let status: ToolOperation["status"] = "completed"
    if (event._tag === "ToolCallFailed") status = "error"
    siblings[position.index] = {
      ...current,
      status,
      summary: Option.getOrUndefined(
        Option.map(Option.fromUndefinedOr(event.summary), clipSummary),
      ),
      durationMs,
    }
  }
  return { durations, operations }
}

/** A settled cell's operation with no terminal receipt ended with the cell: it failed, it is not running. */
const settledOperations = (
  operations: ReadonlyArray<ToolOperation>,
  parentStatus: ToolInteraction["status"],
): ReadonlyArray<ToolOperation> => {
  if (parentStatus === "running") return operations
  return operations.map((operation) => {
    if (operation.status !== "running") return operation
    return { ...operation, status: "error" }
  })
}

const messagePartsToolInteractions = (
  messageId: MessageId,
  parts: ReadonlyArray<MessagePart>,
  resultForToolCall: (partIndex: number) => Option.Option<ToolResultState>,
  receipts: ToolCallReceipts,
): ReadonlyArray<ToolInteraction> => {
  const interactions: ToolInteraction[] = []
  for (const [partIndex, part] of parts.entries()) {
    const toolCall = messagePartToolCall(part)
    if (Predicate.isUndefined(toolCall)) continue
    const id = ToolCallId.make(toolCall.id)
    const result = resultForToolCall(partIndex)
    let status: ToolInteraction["status"] = "running"
    if (Option.isSome(result)) {
      status = "completed"
      if (result.value.isError) status = "error"
    }
    const operations = Option.fromUndefinedOr(
      receipts.operations.get(callKey(Option.some(messageId), id)),
    ).pipe(
      Option.orElse(() =>
        Option.fromUndefinedOr(receipts.operations.get(callKey(Option.none(), id))),
      ),
      Option.map((found) => settledOperations(found, status)),
    )
    interactions.push({
      id,
      toolName: toolCall.toolName,
      status,
      input: toolCall.input,
      summary: Option.getOrUndefined(Option.map(result, (value) => value.summary)),
      output: Option.getOrUndefined(Option.map(result, (value) => value.output)),
      durationMs: receipts.durations.get(id),
      ...Option.match(operations, {
        onNone: () => ({}),
        onSome: (value) => ({ operations: value }),
      }),
    })
  }
  return interactions
}

export const projectMessagesWithToolInteractions = (
  messages: ReadonlyArray<Message>,
  receipts: ToolCallReceipts = noReceipts,
): ReadonlyArray<ProjectedMessage> => {
  const resultMap = buildToolResultMapFromMessages(messages)
  const pairings = buildToolResultPairings(messages, resultMap)
  return messages.map((message, index) =>
    projectMessage(
      message,
      messagePartsToolInteractions(
        message.id,
        message.parts,
        (partIndex) => findResultForToolCall(index, partIndex, pairings),
        receipts,
      ),
    ),
  )
}

/**
 * Human-readable transcript display. Renders user-visible text plus tool
 * calls/results; reasoning and images stay available through focused helpers.
 */
export const messagePartsDisplayText = (
  parts: ReadonlyArray<MessagePart>,
  options: MessagePartsDisplayTextOptions = {},
): string => {
  const maxToolChars = options.maxToolChars ?? 500
  const chunks: string[] = []

  for (const part of parts) {
    const text = messagePartText(part)
    if (!Predicate.isUndefined(text)) {
      chunks.push(text)
      continue
    }

    const toolCall = messagePartToolCall(part)
    if (!Predicate.isUndefined(toolCall)) {
      chunks.push(
        `### tool: ${toolCall.toolName}\n${clipChars(
          stringifyDisplayValue(toolCall.input),
          maxToolChars,
        )}`,
      )
      continue
    }

    const toolResult = messagePartToolResult(part)
    if (!Predicate.isUndefined(toolResult)) {
      chunks.push(`result: ${clipChars(toolResult.text, maxToolChars)}`)
    }
  }

  return chunks.join("\n")
}

/** One durable message part as text for a model; `context.read` and summary prompts share it. */
export const partToText = (part: MessagePart): string => {
  switch (part.type) {
    case "text":
      return part.text
    case "reasoning":
      return `[reasoning] ${part.text}`
    case "tool-call":
      return `[tool-call ${part.name} ${part.id}] ${encodeToolOutput(part.params)}`
    case "tool-result":
      return `[tool-result ${part.name} ${part.id}] ${encodeToolOutput(part.result)}`
    case "file":
      return `[file ${part.mediaType}]`
    case "tool-approval-request":
      return `[tool-approval-request ${part.toolCallId}]`
    case "tool-approval-response": {
      let status = "denied"
      if (part.approved) status = "approved"
      return `[tool-approval-response ${part.approvalId}] ${status}`
    }
  }
}

// ── queue ───────────────────────────────────────────────────────────────────

const QueueEntryFields = {
  id: MessageId,
  content: Schema.String,
  createdAt: Schema.Finite,
  agentOverride: Schema.optional(AgentName),
}

const SteeringEntry = Schema.TaggedStruct("Steering", QueueEntryFields)
const FollowUpEntry = Schema.TaggedStruct("FollowUp", QueueEntryFields)

export const QueueEntryInfo = Schema.Union([SteeringEntry, FollowUpEntry]).pipe(
  Schema.toTaggedUnion("_tag"),
)
export type QueueEntryInfo = typeof QueueEntryInfo.Type

export const SteeringQueueEntryInfo = QueueEntryInfo.cases.Steering
export type SteeringQueueEntryInfo = typeof QueueEntryInfo.cases.Steering.Type
export const FollowUpQueueEntryInfo = QueueEntryInfo.cases.FollowUp
export type FollowUpQueueEntryInfo = typeof QueueEntryInfo.cases.FollowUp.Type

export class QueueSnapshot extends Schema.Class<QueueSnapshot>("QueueSnapshot")({
  steering: Schema.Array(QueueEntryInfo),
  followUp: Schema.Array(QueueEntryInfo),
}) {}

export const emptyQueueSnapshot = (): QueueSnapshot =>
  new QueueSnapshot({ steering: [], followUp: [] })

// ── Persisted queue ──
//
// The on-disk format of `agent_loop_queues.queue_json`. A row written by any
// shipped build must still decode, so no field here is renamed, re-shaped, or
// promoted from optional to required. `runtime/agent/loop-inbox.ts` is the
// only module that interprets these values; this file declares their shape.

export const QueuedTurnItem = Schema.Struct({
  message: Message,
  agentOverride: Schema.optional(AgentName),
  runSpec: Schema.optional(RunSpecSchema),
  /**
   * `false` withholds the tools that ask the user, which a child turn has no
   * one to answer. Only `false` is read, so absent and `true` mean the same
   * thing, and only the `@gent/delegate` extension writes it.
   *
   * It stays optional under this name because a queue row on disk may predate
   * any change: a required field rejects a row whose key is absent, and a
   * renamed one drops a stored `false` and hands the child the tools it was
   * denied. Both were measured, not assumed.
   */
  interactive: Schema.optional(Schema.Boolean),
  /**
   * The admitter asked for a turn even when the branch has no prior history.
   *
   * A row written before this field set shrank may still carry `keyed`. The
   * struct ignores keys it does not declare, so such a row decodes and the
   * next write drops the key.
   */
  wake: Schema.optional(Schema.Boolean),
})
export type QueuedTurnItem = typeof QueuedTurnItem.Type

export const LoopQueueState = Schema.Struct({
  steering: Schema.Array(QueuedTurnItem),
  followUp: Schema.Array(QueuedTurnItem),
  inFlight: Schema.optional(QueuedTurnItem),
})
export type LoopQueueState = typeof LoopQueueState.Type

export const emptyLoopQueueState = (): LoopQueueState => ({
  steering: [],
  followUp: [],
})

// ── response-part-normalization ─────────────────────────────────────────────

const appendNormalizedTextPart = (parts: Array<Response.AnyPart>, text: string): void => {
  if (text === "") return
  const last = parts.at(-1)
  if (last?.type === "text") {
    parts[parts.length - 1] = Response.makePart("text", { text: `${last.text}${text}` })
    return
  }
  parts.push(Response.makePart("text", { text }))
}

const appendNormalizedReasoningPart = (parts: Array<Response.AnyPart>, text: string): void => {
  if (text === "") return
  const last = parts.at(-1)
  if (last?.type === "reasoning") {
    parts[parts.length - 1] = Response.makePart("reasoning", {
      text: `${last.text}${text}`,
    })
    return
  }
  parts.push(Response.makePart("reasoning", { text }))
}

interface NormalizedResponseState {
  readonly normalized: Array<Response.AnyPart>
  readonly activeTextDeltas: Map<string, string>
  readonly activeReasoningDeltas: Map<string, string>
  readonly toolCallIds: Set<string>
  readonly toolResultIds: Set<string>
}

type TextResponsePart = Extract<
  Response.AnyPart,
  { readonly type: "text" | "text-start" | "text-delta" | "text-end" }
>

type ReasoningResponsePart = Extract<
  Response.AnyPart,
  { readonly type: "reasoning" | "reasoning-start" | "reasoning-delta" | "reasoning-end" }
>

const normalizeTextResponsePart = (
  state: NormalizedResponseState,
  part: TextResponsePart,
): void => {
  switch (part.type) {
    case "text":
      appendNormalizedTextPart(state.normalized, part.text)
      return
    case "text-start":
      state.activeTextDeltas.set(part.id, "")
      return
    case "text-delta":
      if (state.activeTextDeltas.has(part.id)) {
        state.activeTextDeltas.set(
          part.id,
          `${state.activeTextDeltas.get(part.id) ?? ""}${part.delta}`,
        )
      } else {
        appendNormalizedTextPart(state.normalized, part.delta)
      }
      return
    case "text-end":
      appendNormalizedTextPart(state.normalized, state.activeTextDeltas.get(part.id) ?? "")
      state.activeTextDeltas.delete(part.id)
      return
  }
}

const normalizeReasoningResponsePart = (
  state: NormalizedResponseState,
  part: ReasoningResponsePart,
): void => {
  switch (part.type) {
    case "reasoning":
      appendNormalizedReasoningPart(state.normalized, part.text)
      return
    case "reasoning-start":
      state.activeReasoningDeltas.set(part.id, "")
      return
    case "reasoning-delta":
      if (state.activeReasoningDeltas.has(part.id)) {
        state.activeReasoningDeltas.set(
          part.id,
          `${state.activeReasoningDeltas.get(part.id) ?? ""}${part.delta}`,
        )
      } else {
        appendNormalizedReasoningPart(state.normalized, part.delta)
      }
      return
    case "reasoning-end":
      appendNormalizedReasoningPart(
        state.normalized,
        state.activeReasoningDeltas.get(part.id) ?? "",
      )
      state.activeReasoningDeltas.delete(part.id)
      return
  }
}

const normalizePassthroughResponsePart = (
  state: NormalizedResponseState,
  part: Response.AnyPart,
): void => {
  switch (part.type) {
    case "tool-result":
      if (part.preliminary === true || state.toolResultIds.has(part.id)) return
      state.toolResultIds.add(part.id)
      state.normalized.push(part)
      return
    case "tool-call":
      if (!state.toolCallIds.has(part.id)) {
        state.toolCallIds.add(part.id)
        state.normalized.push(part)
      }
      return
    case "file":
    case "tool-approval-request":
    case "source":
    case "response-metadata":
    case "finish":
      state.normalized.push(part)
      return
    default:
      return
  }
}

export const normalizeResponseParts = (
  parts: ReadonlyArray<Response.AnyPart>,
): ReadonlyArray<Response.AnyPart> => {
  const state: NormalizedResponseState = {
    normalized: [],
    activeTextDeltas: new Map<string, string>(),
    activeReasoningDeltas: new Map<string, string>(),
    toolCallIds: new Set<string>(),
    toolResultIds: new Set<string>(),
  }

  for (const part of parts) {
    if (
      part.type === "text" ||
      part.type === "text-start" ||
      part.type === "text-delta" ||
      part.type === "text-end"
    ) {
      normalizeTextResponsePart(state, part)
      continue
    }

    if (
      part.type === "reasoning" ||
      part.type === "reasoning-start" ||
      part.type === "reasoning-delta" ||
      part.type === "reasoning-end"
    ) {
      normalizeReasoningResponsePart(state, part)
      continue
    }

    normalizePassthroughResponsePart(state, part)
  }

  for (const text of state.activeTextDeltas.values()) {
    appendNormalizedTextPart(state.normalized, text)
  }
  for (const text of state.activeReasoningDeltas.values()) {
    appendNormalizedReasoningPart(state.normalized, text)
  }

  return state.normalized
}

// ── response-to-prompt ──────────────────────────────────────────────────────

export const responseUsage = (usage: Response.FinishPart["usage"]): Option.Option<Usage> => {
  const inputTokens = usage?.inputTokens?.total
  const outputTokens = usage?.outputTokens?.total
  if (
    Predicate.isUndefined(inputTokens) ||
    Predicate.isUndefined(outputTokens) ||
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(outputTokens) ||
    inputTokens < 0 ||
    outputTokens < 0
  )
    return Option.none()
  const cacheReadTokens = Option.fromUndefinedOr(usage.inputTokens.cacheRead).pipe(
    Option.filter((count) => Number.isSafeInteger(count) && count >= 0),
  )
  const cacheWriteTokens = Option.fromUndefinedOr(usage.inputTokens.cacheWrite).pipe(
    Option.filter((count) => Number.isSafeInteger(count) && count >= 0),
  )
  return Option.some({
    inputTokens,
    outputTokens,
    cacheReadTokens: Option.getOrUndefined(cacheReadTokens),
    cacheWriteTokens: Option.getOrUndefined(cacheWriteTokens),
  })
}

type AssistantMessagePart =
  | Prompt.TextPart
  | Prompt.ReasoningPart
  | Prompt.FilePart
  | Prompt.ToolCallPart
  | Prompt.ToolApprovalRequestPart

interface MessagePartProjection {
  readonly assistant: ReadonlyArray<AssistantMessagePart>
  readonly tool: ReadonlyArray<Prompt.ToolResultPart | Prompt.ToolApprovalResponsePart>
}

const responsePartToAssistantMessagePart = (
  part: Response.AnyPart,
): Option.Option<AssistantMessagePart> => {
  switch (part.type) {
    case "text":
      return Option.some(Prompt.textPart({ text: part.text }))
    case "reasoning":
      return Option.some(Prompt.reasoningPart({ text: part.text }))
    case "file":
      // Only images replay into the transcript; the provider gets a data URL back.
      if (!part.mediaType.startsWith("image/")) return Option.none()
      return Option.some(
        Prompt.filePart({
          data: `data:${part.mediaType};base64,${Buffer.from(part.data).toString("base64")}`,
          mediaType: part.mediaType,
        }),
      )
    case "tool-call":
      return Option.some(
        Prompt.toolCallPart({
          id: part.id,
          name: part.name,
          params: part.params,
          providerExecuted: part.providerExecuted,
        }),
      )
    case "tool-approval-request":
      return Option.some(
        Prompt.toolApprovalRequestPart({
          approvalId: part.approvalId,
          toolCallId: part.toolCallId,
        }),
      )
    default:
      return Option.none()
  }
}

const responsePartToToolResultPart = (
  part: Response.AnyPart,
): Option.Option<Prompt.ToolResultPart> => {
  if (part.type !== "tool-result" || part.preliminary === true) return Option.none()
  return Option.some(
    Prompt.toolResultPart({
      id: part.id,
      name: part.name,
      isFailure: part.isFailure,
      providerExecuted: false,
      result: part.encodedResult,
    }),
  )
}

export const projectResponsePartsToMessageParts = (
  parts: ReadonlyArray<Response.AnyPart>,
): MessagePartProjection => {
  const normalized = normalizeResponseParts(parts)
  const assistant: Array<AssistantMessagePart> = []
  const tool: Array<Prompt.ToolResultPart | Prompt.ToolApprovalResponsePart> = []

  for (const part of normalized) {
    const assistantPart = responsePartToAssistantMessagePart(part)
    if (Option.isSome(assistantPart)) {
      assistant.push(assistantPart.value)
      continue
    }
    const toolPart = responsePartToToolResultPart(part)
    if (Option.isSome(toolPart)) tool.push(toolPart.value)
  }

  return { assistant, tool }
}
