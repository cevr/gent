import { Effect, Option, Predicate, Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import {
  Message,
  Branch,
  MessageMetadata,
  Session,
  decodeDateFromMillis,
} from "../../domain/message.js"
import { messagePartsSearchText } from "../../domain/message-part-projection.js"
import { AgentEvent, EventId } from "../../domain/event.js"
import { BranchId, MessageId, SessionId } from "../../domain/ids.js"
import { ReasoningEffort } from "../../domain/agent.js"

// Schema decoders - Effect-based (no sync throws)
export const StoredPromptPart = Schema.Union([
  Prompt.TextPart,
  Prompt.FilePart,
  Prompt.ToolCallPart,
  Prompt.ToolResultPart,
  Prompt.ReasoningPart,
  Prompt.ToolApprovalRequestPart,
  Prompt.ToolApprovalResponsePart,
])
export const StoredPromptPartJson = Schema.fromJsonString(StoredPromptPart)
export const decodeStoredPromptPart = Schema.decodeUnknownEffect(StoredPromptPartJson)
export const encodeStoredPromptPart = Schema.encodeEffect(StoredPromptPartJson)
export const EventJson = Schema.fromJsonString(Schema.Unknown)
export const decodeEventJson = Schema.decodeUnknownEffect(EventJson)
export const encodeEventJson = Schema.encodeEffect(EventJson)
export const encodeEvent = (event: AgentEvent) =>
  Schema.encodeEffect(AgentEvent)(event).pipe(Effect.flatMap(encodeEventJson))
export const MessageMetadataJson = Schema.fromJsonString(MessageMetadata)
export const decodeMessageMetadata = Schema.decodeUnknownEffect(MessageMetadataJson)
export const encodeMessageMetadata = Schema.encodeEffect(MessageMetadataJson)

/** Encode an absent domain field as SQLite NULL at the storage boundary. */
export const toSqlNull = <A>(value?: A) =>
  // oxlint-disable-next-line effect/noNullish -- SQLite represents absent optional fields as NULL.
  Option.getOrElse(Option.fromUndefinedOr(value), () => null)

export const decodeEvent = (json: string) =>
  decodeEventJson(json).pipe(Effect.flatMap(Schema.decodeUnknownEffect(AgentEvent)))
// Row types
export const SessionRow = Schema.Struct({
  id: SessionId,
  name: Schema.NullOr(Schema.String),
  cwd: Schema.NullOr(Schema.String),
  reasoning_level: Schema.NullOr(Schema.String),
  active_branch_id: Schema.NullOr(BranchId),
  parent_session_id: Schema.NullOr(SessionId),
  parent_branch_id: Schema.NullOr(BranchId),
  created_at: Schema.Finite,
  updated_at: Schema.Finite,
})
export type SessionRow = typeof SessionRow.Type

export const BranchRow = Schema.Struct({
  id: BranchId,
  session_id: SessionId,
  parent_branch_id: Schema.NullOr(BranchId),
  parent_message_id: Schema.NullOr(MessageId),
  name: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
  created_at: Schema.Finite,
})
export type BranchRow = typeof BranchRow.Type

export const MessageRow = Schema.Struct({
  id: MessageId,
  session_id: SessionId,
  branch_id: BranchId,
  kind: Schema.NullOr(Schema.Literals(["regular", "interjection"])),
  role: Schema.Literals(["user", "assistant", "system", "tool"]),
  created_at: Schema.Finite,
  turn_duration_ms: Schema.NullOr(Schema.Finite),
  metadata: Schema.NullOr(Schema.String),
})
export type MessageRow = typeof MessageRow.Type

export const MessageChunkRow = Schema.Struct({
  ...MessageRow.fields,
  chunk_ordinal: Schema.NullOr(Schema.Finite),
  chunk_part_json: Schema.NullOr(Schema.String),
})
export type MessageChunkRow = typeof MessageChunkRow.Type

export const EventRow = Schema.Struct({
  id: EventId,
  event_json: Schema.String,
  created_at: Schema.Finite,
  trace_id: Schema.NullOr(Schema.String),
})
export type EventRow = typeof EventRow.Type

export const decodeMessageChunkRow = Schema.decodeUnknownEffect(MessageChunkRow)
export const decodeEventRow = Schema.decodeUnknownEffect(EventRow)

export const SESSION_PARENT_BRANCH_CHECK =
  "CHECK (parent_branch_id IS NULL OR parent_session_id IS NOT NULL)"

export const isReasoningEffort = Schema.is(ReasoningEffort)

const rowToSession = (row: SessionRow) =>
  Effect.gen(function* () {
    const createdAt = yield* decodeDateFromMillis(row.created_at)
    const updatedAt = yield* decodeDateFromMillis(row.updated_at)
    return new Session({
      id: row.id,
      name: Option.getOrUndefined(Option.fromNullishOr(row.name)),
      cwd: Option.getOrUndefined(Option.fromNullishOr(row.cwd)),
      reasoningLevel: Option.getOrUndefined(
        Option.fromNullishOr(row.reasoning_level).pipe(Option.filter(isReasoningEffort)),
      ),
      activeBranchId: Option.getOrUndefined(Option.fromNullishOr(row.active_branch_id)),
      parentSessionId: Option.getOrUndefined(Option.fromNullishOr(row.parent_session_id)),
      parentBranchId: Option.getOrUndefined(Option.fromNullishOr(row.parent_branch_id)),
      createdAt,
      updatedAt,
    })
  })

const decodeSessionRow = Schema.decodeUnknownEffect(SessionRow)

export const sessionFromRow = (row: SessionRow) =>
  decodeSessionRow(row).pipe(Effect.flatMap(rowToSession))

const rowToBranch = (row: BranchRow) =>
  Effect.gen(function* () {
    const createdAt = yield* decodeDateFromMillis(row.created_at)
    return new Branch({
      id: row.id,
      sessionId: row.session_id,
      parentBranchId: Option.getOrUndefined(Option.fromNullishOr(row.parent_branch_id)),
      parentMessageId: Option.getOrUndefined(Option.fromNullishOr(row.parent_message_id)),
      name: Option.getOrUndefined(Option.fromNullishOr(row.name)),
      summary: Option.getOrUndefined(Option.fromNullishOr(row.summary)),
      createdAt,
    })
  })

const decodeBranchRow = Schema.decodeUnknownEffect(BranchRow)

export const branchFromRow = (row: BranchRow) =>
  decodeBranchRow(row).pipe(Effect.flatMap(rowToBranch))

export const decodeStoredMessage = (row: MessageRow, partJsons: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const parts = yield* Effect.forEach(partJsons, (partJson) => decodeStoredPromptPart(partJson))
    const metadata = yield* Option.match(Option.fromNullishOr(row.metadata), {
      onNone: () => Effect.succeed(Option.none<MessageMetadata>()),
      onSome: (json) => decodeMessageMetadata(json).pipe(Effect.asSome),
    })
    const fields = {
      id: row.id,
      sessionId: row.session_id,
      branchId: row.branch_id,
      role: row.role,
      parts,
      createdAt: yield* decodeDateFromMillis(row.created_at),
      turnDurationMs: Option.getOrUndefined(Option.fromNullishOr(row.turn_duration_ms)),
      metadata: Option.getOrUndefined(metadata),
    }
    if (row.kind === "interjection") {
      return Message.cases.interjection.make({ ...fields, role: "user" })
    }
    return Message.cases.regular.make(fields)
  })

export const encodeStoredMessage = (message: Message) =>
  Effect.gen(function* () {
    const partJsons = yield* Effect.forEach(message.parts, (part) => encodeStoredPromptPart(part))
    const metadataJson = yield* Option.match(Option.fromUndefinedOr(message.metadata), {
      // oxlint-disable-next-line effect/noNullish -- SQLite stores an absent metadata value as NULL at this persistence boundary.
      onNone: () => Effect.succeed(null),
      onSome: encodeMessageMetadata,
    })
    return { partJsons, metadataJson }
  })

export const messageSearchText = messagePartsSearchText

export const groupMessageChunkRows = (rows: ReadonlyArray<MessageChunkRow>) => {
  const grouped = new Map<
    MessageId,
    {
      row: MessageRow
      parts: Array<{ ordinal: number; json: string }>
    }
  >()

  for (const row of rows) {
    let entry = grouped.get(row.id)
    if (Predicate.isUndefined(entry)) {
      entry = { row, parts: [] }
      grouped.set(row.id, entry)
    }
    if (!Predicate.isNull(row.chunk_ordinal) && !Predicate.isNull(row.chunk_part_json)) {
      entry.parts.push({ ordinal: row.chunk_ordinal, json: row.chunk_part_json })
    }
  }

  return [...grouped.values()].map((entry) => ({
    row: entry.row,
    partJsons: entry.parts.sort((a, b) => a.ordinal - b.ordinal).map((part) => part.json),
  }))
}
