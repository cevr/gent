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
  /** The characters of `text`'s source the cut left out; 0 when uncut. */
  readonly omittedChars: number
}

/**
 * Truncate an array to head + tail, `maxItems` in all; an odd limit gives
 * the extra item to the head. For when all items are known upfront.
 */
export function headTail<T>(items: readonly T[], maxItems: number = 100): HeadTailResult<T> {
  const total = items.length
  if (total <= maxItems) {
    return { head: [...items], tail: [], truncatedCount: 0 }
  }

  const headCount = Math.ceil(maxItems / 2)
  const tailCount = maxItems - headCount
  const head = items.slice(0, headCount)
  // Not `slice(-tailCount)`: `slice(-0)` is every item.
  const tail = items.slice(total - tailCount)

  return { head, tail, truncatedCount: total - maxItems }
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
 * Truncate raw text to head + tail by characters. The result, marker
 * included, is at most `maxChars` UTF-16 units, and it never splits a code
 * point.
 */
export function headTailChars(text: string, maxChars: number = 64_000): HeadTailCharsResult {
  const total = text.length
  if (total <= maxChars) {
    return { text, truncated: false, totalChars: total, omittedChars: 0 }
  }
  const marker = (cut: number) => `\n\n... [${cut} characters truncated] ...\n\n`
  // The widest marker this text can need; a smaller count only shortens it.
  const room = maxChars - marker(total).length
  if (room < 0) {
    const head = headWithin(text, maxChars, utf16Units)
    return { text: head, truncated: true, totalChars: total, omittedChars: total - head.length }
  }
  const head = headWithin(text, Math.floor(room / 2), utf16Units)
  const tail = tailWithin(text, room - head.length, utf16Units)
  const omittedChars = total - head.length - tail.length
  return {
    text: `${head}${marker(omittedChars)}${tail}`,
    truncated: true,
    totalChars: total,
    omittedChars,
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

/**
 * Where a projected output value was cut to fit the snapshot. Wire only; the
 * snapshot derives it from the stored events on every read.
 *
 * - `Text`: the excerpt holds the string's head, one marker line, then its
 *   tail. `lines` is the whole string's line count by the `splitLines` rule
 *   (a final newline ends the last line), `tailLine` the 1-based line its tail
 *   starts on, and `chars` the code points left out. A head or tail that keeps
 *   nothing is left out of the excerpt; a tail that keeps nothing has
 *   `tailLine` one past the last line. Head and
 *   tail keep whole lines; a piece with no line break is a fragment of the one
 *   line it sits in, so `tailLine` equals the head's last line when the cut
 *   falls inside a single line. `headCut` says the head's last line stops
 *   before its line break; `tailCut` says the tail's first line starts after
 *   its line's start. `field` is absent when the output is plain text.
 * - `Items`: the array keeps its head items, then its tail items from the
 *   1-based `tailItem`; `items` is the whole array's length. `files` is the
 *   count of distinct `file` values over the whole array, present when its
 *   items name files, as a search result's matches do.
 *
 * A field with no room even for the marker is kept empty, its cut counting
 * all it left out: its tail starts past its end (`tailItem` one past the last
 * item, `tailLine` one past the last line).
 */
export const OutputCut = Schema.TaggedUnion({
  Text: {
    field: Schema.optional(Schema.String),
    lines: Schema.Finite,
    tailLine: Schema.Finite,
    chars: Schema.Finite,
    headCut: Schema.optional(Schema.Literal(true)),
    tailCut: Schema.optional(Schema.Literal(true)),
  },
  Items: {
    field: Schema.String,
    items: Schema.Finite,
    tailItem: Schema.Finite,
    files: Schema.optional(Schema.Finite),
  },
})
export type OutputCut = typeof OutputCut.Type

/** One call a cell admitted, read from its stored tool receipts. */
const ToolOperation = Schema.Struct({
  ...ToolInteractionFields,
  /** Where its output strings were cut to fit the snapshot; absent when none was. */
  cuts: Schema.optional(Schema.Array(OutputCut)),
})
type ToolOperation = typeof ToolOperation.Type

export class ToolInteraction extends Schema.Class<ToolInteraction>("ToolInteraction")({
  ...ToolInteractionFields,
  /**
   * The calls a cell admitted, from the branch's tool receipts. Wire only,
   * never stored. Each carries what its collapsed row draws, within one
   * encoded budget: its scalar input fields, the summary, and a bounded
   * output (top-level scalars; a string too large is cut to head and tail,
   * with its `cuts` record). Absent when the branch has no receipts for
   * them, as on a fork, which copies messages but not events.
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
  /**
   * The extension that authored this message. `Session.send` sets it on
   * every message an extension admits (a child's task, a parent's message, a
   * wake, a monitor). A client's message never carries it: the server removes
   * it at the RPC boundary.
   */
  extensionId: Schema.optional(Schema.String),
  /**
   * Set by the server on every message a client sends (`clientMetadata`),
   * over any value the client gave; an extension's `Session.send` removes it,
   * except that a client's extension request sends to its own branch as the
   * client while it runs (`clientRequestGrant` in `extension-host.ts`).
   * A turn such a message opens has a user watching it (`turnCanAsk`).
   */
  fromClient: Schema.optional(Schema.Boolean),
  /** If true, message is excluded from LLM context but visible in transcript */
  hidden: Schema.optional(Schema.Boolean),
  /**
   * Set by the loop on an interjection delivered at a step boundary. The turn
   * it joined answers it, and it never gets a `TurnCompleted` of its own, so
   * recovery must not read it as a turn. An interjection that woke an idle
   * branch is a turn in its own right, carries no mark, and still recovers.
   * No client or extension can set it (`clientMetadata`, `extensionMetadata`).
   */
  joinedTurn: Schema.optional(Schema.Boolean),
  /** Arbitrary structured details for the custom message */
  details: Schema.optional(Schema.Unknown),
})
export type MessageMetadata = typeof MessageMetadata.Type

/**
 * The envelope of a message a client sends: the server's client origin over
 * whatever the client set, no extension author, and none of the marks the
 * loop and extensions own (`joinedTurn`, `customType`). Only the server calls
 * this, at the RPC boundary, so no client can forge any of them.
 */
export const clientMetadata = (metadata?: MessageMetadata): MessageMetadata => {
  const {
    extensionId: _author,
    joinedTurn: _joined,
    customType: _type,
    ...rest
  } = Option.getOrElse(Option.fromUndefinedOr(metadata), (): MessageMetadata => ({}))
  return { ...rest, fromClient: true }
}

/**
 * The envelope of a message an extension sends: its own id as the author
 * over whatever it set, no client origin (only the server stamps one), and
 * none of the loop's marks: no `joinedTurn`, and no runtime custom type
 * (`RuntimeUserMessageType`). Either would make recovery skip the turn the
 * message opens. An extension keeps its own custom types.
 */
export const extensionMetadata = (
  extensionId: string,
  metadata?: MessageMetadata,
): MessageMetadata => {
  const {
    fromClient: _origin,
    joinedTurn: _joined,
    customType,
    ...rest
  } = Option.getOrElse(Option.fromUndefinedOr(metadata), (): MessageMetadata => ({}))
  return {
    ...rest,
    ...(Predicate.isNotUndefined(customType) &&
      !isRuntimeUserMessageType(customType) && { customType }),
    extensionId,
  }
}

/**
 * Whether a turn can ask its user. A session its user drives (a top-level
 * session, or a handoff that continues its thread) always has its user
 * watching, so its wake, monitor, child-completion and slash-command turns
 * ask too. A spawned session's turn (`isSpawnedSession`) asks only when a
 * client opened it: no one watches a turn its parent, a wake or a monitor
 * opened, so an approval there declines at once. A spawned row stored before
 * the client origin existed has no stamp, so it declines. The answer comes
 * from the turn's opening message and the stored session, so it holds for
 * the turn's whole life, a restart included.
 */
export const turnCanAsk = (turn: {
  readonly sessionIsSpawned: boolean
  readonly openedByClient: boolean
}): boolean => !turn.sessionIsSpawned || turn.openedByClient

/** Whether a client sent the message that opens a turn (`clientMetadata`). */
export const openedByClient = (opening: Message): boolean => opening.metadata?.fromClient === true

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
      // An OpenAI reasoning item without a summary is stored for replay only.
      if (part.text !== "") {
        segments.push(MessageSegment.cases.Reasoning.make({ content: part.text }))
      }
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

/**
 * What every turn of a session runs as: the agent and the run's overrides.
 * It is fixed when the session is created, so a later turn -- a wake, a
 * completed background job, a parent's message -- runs as the session's
 * agent, never as the default one. Every field is optional: a plain session
 * and a row stored before this existed run as the default agent.
 *
 * Whether a turn can ask its user is not stored here: it comes from the
 * turn's origin (`turnCanAsk`). A row stored while this carried
 * `interactive` still decodes: the struct ignores keys it does not declare,
 * and the next write drops the key.
 */
export const SessionAdmission = Schema.Struct({
  agent: Schema.optional(AgentName),
  runSpec: Schema.optional(RunSpecSchema),
})
export type SessionAdmission = typeof SessionAdmission.Type

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
  admission: Schema.optional(SessionAdmission),
  createdAt: DateFromNumber,
  updatedAt: DateFromNumber,
}) {}

/** The thread a session belongs to: its stored thread, else its own. */
export const sessionThread = (session: Pick<Session, "id" | "threadId">): SessionId =>
  session.threadId ?? session.id

/**
 * A spawned session: one with a parent that starts its own thread (a
 * delegate child, a `/btw` fork). A handoff also has a parent, but it joins
 * the parent's thread, so it is the same user's conversation, not a spawn.
 * One rule for spawn depth (`getSessionDepth`) and for who can answer in a
 * session's turns (`turnCanAsk`).
 */
export const isSpawnedSession = (
  session: Pick<Session, "id" | "threadId" | "parentSessionId">,
): boolean =>
  Predicate.isNotUndefined(session.parentSessionId) && sessionThread(session) === session.id

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

/**
 * One-line tool summary for transcripts and the tool row: the first line, cut
 * to 100 characters with an ASCII marker for plain terminals. A multi-line
 * author summary would break every surface that draws one row per call.
 */
export const clipSummary = (text: string): string =>
  clipChars(text.trim().split("\n")[0]?.trimEnd() ?? "", 100, "...")

// oxlint-disable-next-line effect/noUnknownParameters -- Tool output is an external provider value parsed by the JSON codec below.
export const summarizeOutput = (value: unknown): string => {
  if (Predicate.isString(value)) return clipSummary(value)
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
  /** Keyed by `callKey`, like operations: a provider can reuse a call id across steps. */
  readonly durations: ReadonlyMap<string, number>
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

/** Encoded characters one projected operation takes on the wire, keys and scalars included. */
const OPERATION_BUDGET = 8_192

/** The most of the budget the input takes; the output takes what is left. */
const OPERATION_INPUT_SHARE = 4_096

/** The most a tool name takes, encoded: a name is a label, not a body. */
const TOOL_NAME_BUDGET = 256

/** The marker line between a cut string's head and tail. */
const CUT_MARKER = "…"

/** The encoded size of one code point: once for an input field, twice for an output string (JSON in a JSON string). */
type CodePointCost = (codePoint: string) => number
const utf16Units: CodePointCost = (codePoint) => codePoint.length
/** A string as JSON writes it inside quotes: the escaped text, quotes left off. */
const jsonStringBody = (text: string): string => encodeJson(text).slice(1, -1)
/**
 * The cost of one code point under `encode`, encoded once per kind, not per
 * code point: a projection costs every code point of each operation's text.
 * JSON escapes the ASCII controls, `"` and `\` (a table), and above ASCII only
 * a lone surrogate (all escape to one width); every other code point is itself.
 */
const tabledCost = (encode: (text: string) => string): CodePointCost => {
  const ascii = Array.from({ length: 128 }, (_, unit) => encode(String.fromCharCode(unit)).length)
  const loneSurrogate = encode("\ud800").length
  return (codePoint) => {
    const unit = codePoint.charCodeAt(0)
    if (unit < ascii.length) return ascii[unit] ?? codePoint.length
    if (codePoint.length === 1 && unit >= 0xd800 && unit <= 0xdfff) return loneSurrogate
    return codePoint.length
  }
}
const encodedOnce: CodePointCost = tabledCost(jsonStringBody)
const encodedTwice: CodePointCost = tabledCost((text) => jsonStringBody(jsonStringBody(text)))

/** The cost of `text`, or the first cost past `limit` once it is known to exceed it. */
const costUpTo = (text: string, cost: CodePointCost, limit: number): number => {
  let used = 0
  for (const codePoint of text) {
    used += cost(codePoint)
    if (used > limit) return used
  }
  return used
}

/** The longest prefix of whole code points that costs at most `budget`. */
const headWithin = (text: string, budget: number, cost: CodePointCost): string => {
  let used = 0
  let end = 0
  for (const codePoint of text) {
    used += cost(codePoint)
    if (used > budget) break
    end += codePoint.length
  }
  return text.slice(0, end)
}

const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff
const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff

/** The longest suffix of whole code points that costs at most `budget`. */
const tailWithin = (text: string, budget: number, cost: CodePointCost): string => {
  let used = 0
  let start = text.length
  while (start > 0) {
    let width = 1
    if (
      start >= 2 &&
      isLowSurrogate(text.charCodeAt(start - 1)) &&
      isHighSurrogate(text.charCodeAt(start - 2))
    )
      width = 2
    used += cost(text.slice(start - width, start))
    if (used > budget) break
    start -= width
  }
  return text.slice(start)
}

/**
 * A text's lines: a final newline ends the last line and starts none. The one
 * line rule every count and every cut record uses.
 */
export const splitLines = (text: string): Array<string> => {
  if (text.length === 0) return []
  return text.replace(/\n$/, "").split("\n")
}

/** How many lines a text holds, by the {@link splitLines} rule. */
export const lineCount = (text: string): number => splitLines(text).length

/** The number of the line that starts at `offset`, which follows a line break or is 0. */
const lineNumberAt = (text: string, offset: number): number =>
  text.slice(0, offset).split("\n").length

/** The encoded size of a `Text` cut's record, with the widest numbers it can hold. */
const textCutCost = (field: Option.Option<string>): number =>
  encodeJson(
    OutputCut.cases.Text.make({
      ...Option.match(field, { onNone: () => ({}), onSome: (name) => ({ field: name }) }),
      lines: Number.MAX_SAFE_INTEGER,
      tailLine: Number.MAX_SAFE_INTEGER,
      chars: Number.MAX_SAFE_INTEGER,
      headCut: true,
      tailCut: true,
    }),
  ).length + 1

/** The encoded size of an `Items` cut's record, with the widest numbers it can hold. */
const itemsCutCost = (field: string): number =>
  encodeJson(
    OutputCut.cases.Items.make({
      field,
      items: Number.MAX_SAFE_INTEGER,
      tailItem: Number.MAX_SAFE_INTEGER,
      files: Number.MAX_SAFE_INTEGER,
    }),
  ).length + 1

type TextCut = Omit<Extract<OutputCut, { readonly _tag: "Text" }>, "_tag" | "field">

interface Excerpt {
  readonly text: string
  readonly cut: Option.Option<TextCut>
}

/** `head` back to its last line break, unless it already ends a line or holds no break: then it is a fragment of line 1. */
const wholeHeadLines = (text: string, head: string): string => {
  if (text.charAt(head.length) === "\n") return head
  const end = head.lastIndexOf("\n")
  if (end < 0) return head
  return head.slice(0, end)
}

/** `tail` forward past its first line break, unless it already starts a line or holds no break: then it is a fragment of the last line. */
const wholeTailLines = (text: string, tail: string): string => {
  if (text.charAt(text.length - tail.length - 1) === "\n") return tail
  const start = tail.indexOf("\n")
  if (start < 0) return tail
  return tail.slice(start + 1)
}

/**
 * `text` whole within `budget`, else its head, the marker line and its tail,
 * with the marker counted. Head and tail keep whole lines; a piece with no
 * line break is cut at code points inside its one line. A piece that keeps
 * nothing is left out: the excerpt starts at the marker, or ends after it
 * with `tailLine` one past the last line. `None` when not even the marker fits.
 */
const excerptWithin = (
  text: string,
  budget: number,
  cost: CodePointCost,
): Option.Option<Excerpt> => {
  if (costUpTo(text, cost, budget) <= budget) return Option.some({ text, cut: Option.none() })
  const room = budget - costUpTo(`\n${CUT_MARKER}\n`, cost, Infinity)
  if (room < 0) return Option.none()
  const head = wholeHeadLines(text, headWithin(text, Math.floor(room / 2), cost))
  const tail = wholeTailLines(text, tailWithin(text, room - costUpTo(head, cost, Infinity), cost))
  const tailStart = text.length - tail.length
  const lines = lineCount(text)
  let tailLine = lines + 1
  if (tail.length > 0) tailLine = lineNumberAt(text, tailStart)
  let cut: TextCut = { lines, tailLine, chars: [...text.slice(head.length, tailStart)].length }
  if (head.length > 0 && text.charAt(head.length) !== "\n") cut = { ...cut, headCut: true }
  if (tail.length > 0 && text.charAt(tailStart - 1) !== "\n") cut = { ...cut, tailCut: true }
  // An empty head is line 1 only when line 1 is empty; else it kept nothing.
  let excerpt = `${CUT_MARKER}\n${tail}`
  if (head.length > 0 || text.startsWith("\n")) excerpt = `${head}\n${excerpt}`
  return Option.some({ text: excerpt, cut: Option.some(cut) })
}

type Scalar = string | number | boolean

/** One array item as a collapsed row reads it: a scalar, or an object's scalar fields. */
type Item = Scalar | Readonly<Record<string, Scalar>>

/** The encoded size of `"key":value,` in an object. */
const fieldCost = (
  name: string,
  value: Scalar | ReadonlyArray<Item>,
  cost: CodePointCost,
): number =>
  costUpTo(encodeJson(name), cost, Infinity) + 1 + costUpTo(encodeJson(value), cost, Infinity) + 1

/**
 * An operation's input as its collapsed row reads it: top-level scalar fields.
 * Every field is kept whole or not at all, cheapest first, within `budget`,
 * keys counted: a cut `oldString` draws a wrong diff and a cut path a broken
 * link, so a missing field is the honest answer. Nested values stay on the
 * branch.
 */
// oxlint-disable-next-line effect/noNullish -- ToolInteraction.input is an UndefinedOr wire field; absent input stays absent.
type BoundedInput = string | Readonly<Record<string, Scalar>> | undefined

// oxlint-disable-next-line effect/noUnknownParameters -- Tool input is an external model value; only its scalar fields are kept.
const boundedInput = (input: unknown, budget: number): BoundedInput => {
  if (Predicate.isString(input)) {
    if (costUpTo(input, encodedOnce, budget) + 2 <= budget) return input
    return Option.getOrUndefined(Option.none<string>())
  }
  if (!Predicate.isObject(input) || Array.isArray(input))
    return Option.getOrUndefined(Option.none<string>())
  const fields = Object.entries(input)
    .filter((entry): entry is [string, Scalar] => isScalar(entry[1]))
    .map(([key, value]) => ({ key, value, cost: fieldCost(key, value, encodedOnce) }))
    .toSorted((left, right) => left.cost - right.cost)
  let left = budget - 2
  const kept: Record<string, Scalar> = {}
  for (const field of fields) {
    if (field.cost > left) break
    left -= field.cost
    kept[field.key] = field.value
  }
  return kept
}

// oxlint-disable-next-line effect/noUnknownParameters -- A decoded JSON field is an external value; only scalars are kept.
const isScalar = (value: unknown): value is Scalar =>
  Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBoolean(value)

/** An array's items as its collapsed row reads them; `None` when an item is neither a scalar nor an object. */
const scalarItems = (values: ReadonlyArray<unknown>): Option.Option<ReadonlyArray<Item>> => {
  const items: Array<Item> = []
  for (const value of values) {
    if (isScalar(value)) {
      items.push(value)
      continue
    }
    if (!Predicate.isObject(value) || Array.isArray(value)) return Option.none()
    items.push(
      Object.fromEntries(
        Object.entries(value).filter((entry): entry is [string, Scalar] => isScalar(entry[1])),
      ),
    )
  }
  return Option.some(items)
}

interface ItemsExcerpt {
  readonly items: ReadonlyArray<Item>
  readonly cut: Option.Option<{
    readonly items: number
    readonly tailItem: number
    readonly files?: number
  }>
}

/** Distinct `file` values over `items`; `None` when no item names a file. */
const distinctFiles = (items: ReadonlyArray<Item>): Option.Option<number> => {
  const files = new Set<string>()
  for (const item of items) {
    if (!Predicate.isObject(item)) continue
    const file = item["file"]
    if (Predicate.isString(file)) files.add(file)
  }
  if (files.size === 0) return Option.none()
  return Option.some(files.size)
}

/** `items` whole within `budget`, else the head items and tail items that fit, each whole. */
const itemsWithin = (
  items: ReadonlyArray<Item>,
  budget: number,
  cost: CodePointCost,
): ItemsExcerpt => {
  // Each item with its comma.
  const costs = items.map((item) => costUpTo(encodeJson(item), cost, Infinity) + 1)
  if (costs.reduce((sum, itemCost) => sum + itemCost, 0) <= budget) {
    return { items, cut: Option.none() }
  }
  let used = 0
  let headEnd = 0
  while (headEnd < items.length && used + (costs[headEnd] ?? Infinity) <= budget / 2) {
    used += costs[headEnd] ?? 0
    headEnd += 1
  }
  let tailStart = items.length
  while (tailStart > headEnd && used + (costs[tailStart - 1] ?? Infinity) <= budget) {
    used += costs[tailStart - 1] ?? 0
    tailStart -= 1
  }
  return {
    items: [...items.slice(0, headEnd), ...items.slice(tailStart)],
    cut: Option.some({
      items: items.length,
      tailItem: tailStart + 1,
      ...Option.match(distinctFiles(items), {
        onNone: () => ({}),
        onSome: (files) => ({ files }),
      }),
    }),
  }
}

interface BoundedOutput {
  // oxlint-disable-next-line effect/noNullish -- ToolInteraction.output is an UndefinedOr wire field; absent output stays absent.
  readonly output: string | undefined
  readonly cuts: ReadonlyArray<OutputCut>
}

const noOutput: BoundedOutput = { output: Option.getOrUndefined(Option.none()), cuts: [] }

/** A cuttable field's value within its share, and the record of its cut. */
interface FittedField {
  readonly value: string | ReadonlyArray<Item>
  readonly cut: Option.Option<OutputCut>
}

/** A top-level output field that is cut to fit rather than kept whole. */
interface CuttableField {
  readonly key: string
  /** The least share that keeps the value whole: key, value, and room for a cut record. */
  readonly need: number
  /** What the field costs emptied: its key, an empty value, and its cut record. */
  readonly emptyCost: number
  /** The value within `share` of the budget, key and cut record counted; `None` when not even its marker fits. */
  readonly fit: (share: number) => Option.Option<FittedField>
  /** The field emptied, with a cut record that counts all it left out: nothing is dropped unmarked. */
  readonly emptied: FittedField
}

/** A string field: whole, or its head and tail around a marker line. */
const textField = (key: string, text: string): CuttableField => {
  const overhead = fieldCost(key, "", encodedTwice) + textCutCost(Option.some(key))
  const lines = lineCount(text)
  return {
    key,
    need: overhead + costUpTo(text, encodedTwice, OPERATION_BUDGET),
    emptyCost: overhead,
    fit: (share) =>
      Option.map(excerptWithin(text, share - overhead, encodedTwice), (excerpt) => ({
        value: excerpt.text,
        cut: Option.map(excerpt.cut, (cut) => OutputCut.cases.Text.make({ field: key, ...cut })),
      })),
    emptied: {
      value: "",
      cut: Option.some(
        OutputCut.cases.Text.make({
          field: key,
          lines,
          tailLine: lines + 1,
          chars: [...text].length,
        }),
      ),
    },
  }
}

/** An array field: every item, or its head and tail items, each whole. */
const itemsField = (key: string, items: ReadonlyArray<Item>): CuttableField => {
  const overhead = fieldCost(key, [], encodedTwice) + itemsCutCost(key)
  return {
    key,
    // Each item with its comma, as `itemsWithin` counts them.
    need:
      overhead +
      Math.min(
        OPERATION_BUDGET,
        costUpTo(encodeJson(items), encodedTwice, OPERATION_BUDGET) - 2 + items.length,
      ),
    emptyCost: overhead,
    // Emptied, the tail starts past the last item.
    emptied: {
      value: [],
      cut: Option.some(
        OutputCut.cases.Items.make({
          field: key,
          items: items.length,
          tailItem: items.length + 1,
          ...Option.match(distinctFiles(items), {
            onNone: () => ({}),
            onSome: (files) => ({ files }),
          }),
        }),
      ),
    },
    fit: (share) => {
      const room = share - overhead
      if (room < 0) return Option.none()
      const excerpt = itemsWithin(items, room, encodedTwice)
      return Option.some({
        value: excerpt.items,
        cut: Option.map(excerpt.cut, (cut) => OutputCut.cases.Items.make({ field: key, ...cut })),
      })
    },
  }
}

/**
 * An operation's output, planned once: `room` is the least budget that keeps
 * it whole, cut records and their array counted, so the input grows only into
 * space the output does not need. `fit` bounds it within a budget.
 */
interface OutputPlan {
  readonly room: number
  readonly fit: (budget: number) => BoundedOutput
}

const noOutputPlan: OutputPlan = { room: 0, fit: () => noOutput }

/**
 * An operation's output as its collapsed row reads it, within `budget` encoded
 * characters on the wire. A JSON object keeps its top-level numbers and
 * booleans, cheapest first, then shares what is left among its strings and
 * arrays. A string is kept whole or cut to head and tail; an array keeps its
 * items whole, or its head and tail items; each cut is recorded. A text result
 * is cut like a string. Nested values stay on the branch.
 */
// oxlint-disable-next-line effect/noNullish -- ToolInteraction.output is an UndefinedOr wire field; absent output stays absent.
const planOutput = (output: string | undefined): OutputPlan => {
  if (Predicate.isUndefined(output)) return noOutputPlan
  const decoded = decodeToolOutput(output)
  if (Option.isNone(decoded) || Predicate.isString(decoded.value)) {
    const text = Option.getOrElse(Option.filter(decoded, Predicate.isString), () => output)
    // The output string's quotes and the room for the record of its cut.
    const overhead = 2 + textCutCost(Option.none())
    return {
      room: overhead + costUpTo(text, encodedOnce, OPERATION_BUDGET),
      fit: (budget) =>
        Option.match(excerptWithin(text, budget - overhead, encodedOnce), {
          onNone: () => noOutput,
          onSome: (excerpt) => ({
            output: excerpt.text,
            cuts: Option.toArray(Option.map(excerpt.cut, (cut) => OutputCut.cases.Text.make(cut))),
          }),
        }),
    }
  }
  const value = decoded.value
  if (!Predicate.isObject(value) || Array.isArray(value)) return noOutputPlan
  // The output string's quotes, its braces, and the `cuts` array around the records.
  const frame = 2 + costUpTo("{}", encodedTwice, Infinity) + encodeJson({ cuts: [] }).length
  const numbers = Object.entries(value)
    .filter(
      (entry): entry is [string, number | boolean] =>
        Predicate.isNumber(entry[1]) || Predicate.isBoolean(entry[1]),
    )
    .map(([key, field]) => ({ key, field, cost: fieldCost(key, field, encodedTwice) }))
    .toSorted((a, b) => a.cost - b.cost)
  // Cheapest value first: a field's share is its own reserve plus an even
  // part of the spare. When every field's need fits, the spare left at field
  // i is at least the sum of the remaining values, and those are sorted, so
  // each even part covers its own value and the whole output stays whole.
  const cuttable = Object.entries(value)
    .flatMap(([key, field]): ReadonlyArray<CuttableField> => {
      if (Predicate.isString(field)) return [textField(key, field)]
      if (!Array.isArray(field)) return []
      return Option.toArray(Option.map(scalarItems(field), (items) => itemsField(key, items)))
    })
    .toSorted((a, b) => a.need - a.emptyCost - (b.need - b.emptyCost))
  const sum = (costs: ReadonlyArray<number>) => costs.reduce((total, cost) => total + cost, 0)
  return {
    room:
      frame + sum(numbers.map((entry) => entry.cost)) + sum(cuttable.map((entry) => entry.need)),
    fit: (budget) => {
      // Each string or array keeps room to be emptied with its cut record,
      // so a field that cannot fit is still marked, never dropped silently.
      // An output with no room for that is left out whole.
      let left = budget - frame - sum(cuttable.map((entry) => entry.emptyCost))
      if (left < 0) return noOutput
      const kept: Record<string, Scalar | ReadonlyArray<Item>> = {}
      for (const entry of numbers) {
        if (entry.cost > left) break
        left -= entry.cost
        kept[entry.key] = entry.field
      }
      const cuts: Array<OutputCut> = []
      for (const [index, entry] of cuttable.entries()) {
        // The spare is what is left beyond every field's reserve. This
        // field's share: its reserve (its key, its quotes or brackets, its
        // comma, and room for the record of its cut) and an even part of it.
        const share = entry.emptyCost + Math.floor(left / (cuttable.length - index))
        left += entry.emptyCost
        const fitted = Option.getOrElse(entry.fit(share), () => entry.emptied)
        kept[entry.key] = fitted.value
        left -= fieldCost(entry.key, fitted.value, encodedTwice)
        if (Option.isSome(fitted.cut)) {
          cuts.push(fitted.cut.value)
          left -= encodeJson(fitted.cut.value).length + 1
        }
      }
      return { output: encodeJson(kept), cuts }
    },
  }
}

interface OperationRaw {
  readonly id: ToolCallId
  readonly toolName: string
  readonly status: ToolOperation["status"]
  readonly input: unknown
  // oxlint-disable-next-line effect/noNullish -- Absent until the terminal receipt.
  readonly summary: string | undefined
  // oxlint-disable-next-line effect/noNullish -- Absent until the terminal receipt.
  readonly output: string | undefined
  // oxlint-disable-next-line effect/noNullish -- Absent while running.
  readonly durationMs: number | undefined
}

/**
 * One operation as the snapshot carries it: within `OPERATION_BUDGET` encoded
 * characters. The fixed fields come first: the tool name clipped to
 * `TOOL_NAME_BUDGET`, the summary already clipped, and the id whole when it
 * fits, else its head. Then the input, then the output in what is left. The
 * input takes up to `OPERATION_INPUT_SHARE`, or all the room the whole output
 * does not need: an edit's body is its diff strings, and its output is a path
 * and a count.
 */
const fitOperation = (raw: OperationRaw): ToolOperation => {
  const unnamed: ToolOperation = {
    id: ToolCallId.make(""),
    toolName: headWithin(raw.toolName, TOOL_NAME_BUDGET, encodedOnce),
    status: raw.status,
    input: Option.getOrUndefined(Option.none()),
    summary: raw.summary,
    output: Option.getOrUndefined(Option.none()),
    durationMs: raw.durationMs,
  }
  // `"input":` and `"output":` with their commas.
  const labels = encodeJson("input").length + encodeJson("output").length + 4
  const idRoom = OPERATION_BUDGET - encodeJson(unnamed).length - labels
  const fixed: ToolOperation = {
    ...unnamed,
    id: ToolCallId.make(headWithin(raw.id, idRoom, encodedOnce)),
  }
  let left = OPERATION_BUDGET - encodeJson(fixed).length - labels
  const plan = planOutput(raw.output)
  const input = boundedInput(
    raw.input,
    Math.min(left, Math.max(OPERATION_INPUT_SHARE, left - plan.room)),
  )
  left -= Option.match(Option.fromUndefinedOr(input), {
    onNone: () => 0,
    onSome: (kept) => encodeJson(kept).length,
  })
  const { output, cuts } = plan.fit(left)
  if (cuts.length === 0) return { ...fixed, input, output }
  return { ...fixed, input, output, cuts }
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
  /** The whole input, refit with the output when the terminal receipt lands. */
  readonly input: unknown
}

/** Place one admitted call under its cell. The snapshot carries what the collapsed op row draws; the full input and output stay on the branch. */
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
  slots.set(key, { parent, index: siblings.length, input: event.input })
  siblings.push(
    fitOperation({
      id: event.toolCallId,
      toolName: event.toolName,
      status: "running",
      input: event.input,
      summary: Option.getOrUndefined(Option.none<string>()),
      output: Option.getOrUndefined(Option.none<string>()),
      durationMs: Option.getOrUndefined(Option.none<number>()),
    }),
  )
  operations.set(parent, siblings)
}

export const toolCallReceipts = (events: ReadonlyArray<EventEnvelope>): ToolCallReceipts => {
  const started = new Map<string, number>()
  const durations = new Map<string, number>()
  const operations = new Map<string, Array<ToolOperation>>()
  const slots = new Map<string, OperationSlot>()
  for (const envelope of events) {
    const event = envelope.event
    if (event._tag === "ToolCallStarted") {
      started.set(
        callKey(Option.fromUndefinedOr(event.assistantMessageId), event.toolCallId),
        envelope.createdAt,
      )
      admitOperation(event, operations, slots)
      continue
    }
    if (event._tag !== "ToolCallSucceeded" && event._tag !== "ToolCallFailed") continue
    const key = callKey(Option.fromUndefinedOr(event.assistantMessageId), event.toolCallId)
    const startedAt = started.get(key)
    const durationMs = Option.getOrUndefined(
      Option.map(Option.fromUndefinedOr(startedAt), (at) => Math.max(0, envelope.createdAt - at)),
    )
    if (Predicate.isNotUndefined(durationMs)) durations.set(key, durationMs)
    const position = slots.get(key)
    if (Predicate.isUndefined(position)) continue
    const siblings = operations.get(position.parent)
    const current = siblings?.[position.index]
    if (Predicate.isUndefined(siblings) || Predicate.isUndefined(current)) continue
    let status: ToolOperation["status"] = "completed"
    if (event._tag === "ToolCallFailed") status = "error"
    siblings[position.index] = fitOperation({
      id: current.id,
      toolName: current.toolName,
      status,
      input: position.input,
      summary: Option.getOrUndefined(
        Option.map(Option.fromUndefinedOr(event.summary), clipSummary),
      ),
      output: event.output,
      durationMs,
    })
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
      durationMs: Option.getOrUndefined(
        Option.orElse(
          Option.fromUndefinedOr(receipts.durations.get(callKey(Option.some(messageId), id))),
          () => Option.fromUndefinedOr(receipts.durations.get(callKey(Option.none(), id))),
        ),
      ),
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

/**
 * A branch that asks another branch for something: it steers that branch, or
 * it stops what a message opens there. A stop from a branch takes back the
 * steers the same branch sent into the turn it stops.
 */
export const RequesterBranch = Schema.Struct({ sessionId: SessionId, branchId: BranchId })
export type RequesterBranch = typeof RequesterBranch.Type
export const requesterBranchKey = (branch: RequesterBranch): string =>
  `${branch.sessionId}/${branch.branchId}`

/**
 * One turn waiting in a branch's queue. A row written before admission moved
 * onto the session may still carry `agentOverride`, `runSpec` or
 * `interactive`; the struct ignores keys it does not declare, so the row
 * decodes, and migration 023 copied that admission onto its session.
 */
export const QueuedTurnItem = Schema.Struct({
  message: Message,
  /**
   * The other branch that steered this item in. A stop that branch asks for
   * takes the item back with the turn it waited to join. Absent on the
   * branch's own items and on rows written before the field.
   */
  sender: Schema.optional(RequesterBranch),
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

const isJsonRecord = Schema.is(Schema.Record(Schema.String, Schema.Json))

/** One provider's entry: two objects merge by field, later winning; anything else is replaced. */
const mergeProviderEntry = (
  previous: Option.Option<Response.ProviderMetadata[string]>,
  next: Response.ProviderMetadata[string],
): Response.ProviderMetadata[string] => {
  if (Option.isNone(previous) || !isJsonRecord(previous.value) || !isJsonRecord(next)) return next
  return Object.fromEntries([...Object.entries(previous.value), ...Object.entries(next)])
}

/**
 * Provider metadata folded per provider key, later fields winning: the rule
 * `Prompt.fromResponseParts` applies to a streamed part.
 */
const mergeProviderMetadata = (
  left: Response.ProviderMetadata,
  right: Response.ProviderMetadata,
): Response.ProviderMetadata => {
  const merged = { ...left }
  for (const [provider, value] of Object.entries(right)) {
    merged[provider] = mergeProviderEntry(Option.fromUndefinedOr(merged[provider]), value)
  }
  return merged
}

const hasProviderMetadata = (metadata: Response.ProviderMetadata): boolean =>
  Object.keys(metadata).length > 0

/**
 * Text and reasoning a provider streams, as whole parts. A part that carries
 * provider metadata stays whole and keeps it: the metadata (an OpenAI item id
 * and encrypted reasoning, an Anthropic thinking signature) belongs to exactly
 * that text, and a later step sends it back. Such a part is kept even with no
 * text, as an OpenAI reasoning item without a summary is. Chunks without
 * metadata join the previous part of their kind.
 */
const appendNormalizedTextPart = (
  parts: Array<Response.AnyPart>,
  text: string,
  metadata: Response.ProviderMetadata = {},
): void => {
  const keep = hasProviderMetadata(metadata)
  if (text === "" && !keep) return
  const last = parts.at(-1)
  if (!keep && last?.type === "text" && !hasProviderMetadata(last.metadata)) {
    parts[parts.length - 1] = Response.makePart("text", { text: `${last.text}${text}` })
    return
  }
  parts.push(Response.makePart("text", { text, metadata }))
}

const appendNormalizedReasoningPart = (
  parts: Array<Response.AnyPart>,
  text: string,
  metadata: Response.ProviderMetadata = {},
): void => {
  const keep = hasProviderMetadata(metadata)
  if (text === "" && !keep) return
  const last = parts.at(-1)
  if (!keep && last?.type === "reasoning" && !hasProviderMetadata(last.metadata)) {
    parts[parts.length - 1] = Response.makePart("reasoning", { text: `${last.text}${text}` })
    return
  }
  parts.push(Response.makePart("reasoning", { text, metadata }))
}

/** A streamed part between its start and its end. */
interface ActiveDelta {
  readonly text: string
  readonly metadata: Response.ProviderMetadata
}

interface NormalizedResponseState {
  readonly normalized: Array<Response.AnyPart>
  readonly activeTextDeltas: Map<string, ActiveDelta>
  readonly activeReasoningDeltas: Map<string, ActiveDelta>
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

/** Fold one streamed chunk into its active part; `false` when no part with that id started. */
const foldActiveDelta = (
  active: Map<string, ActiveDelta>,
  id: string,
  delta: string,
  metadata: Response.ProviderMetadata,
): boolean => {
  const current = active.get(id)
  if (Predicate.isUndefined(current)) return false
  active.set(id, {
    text: `${current.text}${delta}`,
    metadata: mergeProviderMetadata(current.metadata, metadata),
  })
  return true
}

/** The finished part for `id`, with the end chunk's metadata folded in; `None` when it never started. */
const takeActiveDelta = (
  active: Map<string, ActiveDelta>,
  id: string,
  metadata: Response.ProviderMetadata,
): Option.Option<ActiveDelta> => {
  const current = active.get(id)
  if (Predicate.isUndefined(current)) return Option.none()
  active.delete(id)
  return Option.some({
    text: current.text,
    metadata: mergeProviderMetadata(current.metadata, metadata),
  })
}

const normalizeTextResponsePart = (
  state: NormalizedResponseState,
  part: TextResponsePart,
): void => {
  switch (part.type) {
    case "text":
      appendNormalizedTextPart(state.normalized, part.text, part.metadata)
      return
    case "text-start":
      state.activeTextDeltas.set(part.id, { text: "", metadata: part.metadata })
      return
    case "text-delta":
      if (!foldActiveDelta(state.activeTextDeltas, part.id, part.delta, part.metadata)) {
        appendNormalizedTextPart(state.normalized, part.delta, part.metadata)
      }
      return
    case "text-end": {
      const done = takeActiveDelta(state.activeTextDeltas, part.id, part.metadata)
      if (Option.isSome(done)) {
        appendNormalizedTextPart(state.normalized, done.value.text, done.value.metadata)
      }
      return
    }
  }
}

const normalizeReasoningResponsePart = (
  state: NormalizedResponseState,
  part: ReasoningResponsePart,
): void => {
  switch (part.type) {
    case "reasoning":
      appendNormalizedReasoningPart(state.normalized, part.text, part.metadata)
      return
    case "reasoning-start":
      state.activeReasoningDeltas.set(part.id, { text: "", metadata: part.metadata })
      return
    case "reasoning-delta":
      if (!foldActiveDelta(state.activeReasoningDeltas, part.id, part.delta, part.metadata)) {
        appendNormalizedReasoningPart(state.normalized, part.delta, part.metadata)
      }
      return
    case "reasoning-end": {
      const done = takeActiveDelta(state.activeReasoningDeltas, part.id, part.metadata)
      if (Option.isSome(done)) {
        appendNormalizedReasoningPart(state.normalized, done.value.text, done.value.metadata)
      }
      return
    }
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
    activeTextDeltas: new Map<string, ActiveDelta>(),
    activeReasoningDeltas: new Map<string, ActiveDelta>(),
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

  for (const active of state.activeTextDeltas.values()) {
    appendNormalizedTextPart(state.normalized, active.text, active.metadata)
  }
  for (const active of state.activeReasoningDeltas.values()) {
    appendNormalizedReasoningPart(state.normalized, active.text, active.metadata)
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
    // Provider metadata becomes the part's options, which the SDK reads when
    // it sends the part back: an OpenAI item id and encrypted reasoning, an
    // Anthropic thinking signature. Stored rows written before this carry `{}`.
    case "text":
      return Option.some(Prompt.textPart({ text: part.text, options: part.metadata }))
    case "reasoning":
      return Option.some(Prompt.reasoningPart({ text: part.text, options: part.metadata }))
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
          options: part.metadata,
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
