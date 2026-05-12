import { Effect, Option, Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { Message, Branch, MessageMetadata, Session, dateFromMillis } from "../../domain/message.js"
import { messagePartsSearchText } from "../../domain/message-part-projection.js"
import { AgentEvent, EventId } from "../../domain/event.js"
import { BranchId, MessageId, SessionId } from "../../domain/ids.js"
import { ReasoningEffort } from "../../domain/agent.js"
import { GentPlatform } from "../../runtime/gent-platform.js"
import { SqlClient } from "effect/unstable/sql"

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
export const decodeMessageMetadata = Schema.decodeUnknownOption(MessageMetadataJson)
export const encodeMessageMetadata = Schema.encodeSync(MessageMetadataJson)

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
  created_at: Schema.Number,
  updated_at: Schema.Number,
})
export type SessionRow = typeof SessionRow.Type

export const BranchRow = Schema.Struct({
  id: BranchId,
  session_id: SessionId,
  parent_branch_id: Schema.NullOr(BranchId),
  parent_message_id: Schema.NullOr(MessageId),
  name: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
  created_at: Schema.Number,
})
export type BranchRow = typeof BranchRow.Type

export const MessageRow = Schema.Struct({
  id: MessageId,
  session_id: SessionId,
  branch_id: BranchId,
  kind: Schema.NullOr(Schema.Literals(["regular", "interjection"])),
  role: Schema.Literals(["user", "assistant", "system", "tool"]),
  created_at: Schema.Number,
  turn_duration_ms: Schema.NullOr(Schema.Number),
  metadata: Schema.NullOr(Schema.String),
})
export type MessageRow = typeof MessageRow.Type

export const MessageChunkRow = Schema.Struct({
  ...MessageRow.fields,
  chunk_ordinal: Schema.NullOr(Schema.Number),
  chunk_part_json: Schema.NullOr(Schema.String),
})
export type MessageChunkRow = typeof MessageChunkRow.Type

export const EventRow = Schema.Struct({
  id: EventId,
  event_json: Schema.String,
  created_at: Schema.Number,
  trace_id: Schema.NullOr(Schema.String),
})
export type EventRow = typeof EventRow.Type

export const decodeMessageRow = Schema.decodeUnknownEffect(MessageRow)
export const decodeMessageChunkRow = Schema.decodeUnknownEffect(MessageChunkRow)
export const decodeEventRow = Schema.decodeUnknownEffect(EventRow)

export const SESSION_PARENT_BRANCH_CHECK =
  "CHECK (parent_branch_id IS NULL OR parent_session_id IS NOT NULL)"

export const isReasoningEffort = Schema.is(ReasoningEffort)

const rowToSession = (row: SessionRow) =>
  new Session({
    id: row.id,
    name: row.name ?? undefined,
    cwd: row.cwd ?? undefined,
    reasoningLevel:
      row.reasoning_level !== null && isReasoningEffort(row.reasoning_level)
        ? row.reasoning_level
        : undefined,
    activeBranchId: row.active_branch_id ?? undefined,
    parentSessionId: row.parent_session_id ?? undefined,
    parentBranchId: row.parent_branch_id ?? undefined,
    createdAt: dateFromMillis(row.created_at),
    updatedAt: dateFromMillis(row.updated_at),
  })

const decodeSessionRow = Schema.decodeUnknownSync(SessionRow)

export const sessionFromRow = (row: SessionRow): Session => rowToSession(decodeSessionRow(row))

const rowToBranch = (row: BranchRow) =>
  new Branch({
    id: row.id,
    sessionId: row.session_id,
    parentBranchId: row.parent_branch_id ?? undefined,
    parentMessageId: row.parent_message_id ?? undefined,
    name: row.name ?? undefined,
    summary: row.summary ?? undefined,
    createdAt: dateFromMillis(row.created_at),
  })

const decodeBranchRow = Schema.decodeUnknownSync(BranchRow)

export const branchFromRow = (row: BranchRow): Branch => rowToBranch(decodeBranchRow(row))

export const decodeStoredMessage = (row: MessageRow, partJsons: ReadonlyArray<string>) =>
  Effect.map(
    Effect.forEach(partJsons, (partJson) => decodeStoredPromptPart(partJson)),
    (parts) => {
      const fields = {
        id: row.id,
        sessionId: row.session_id,
        branchId: row.branch_id,
        role: row.role,
        parts,
        createdAt: dateFromMillis(row.created_at),
        turnDurationMs: row.turn_duration_ms ?? undefined,
        metadata:
          row.metadata === null
            ? undefined
            : Option.getOrUndefined(decodeMessageMetadata(row.metadata)),
      }
      return row.kind === "interjection"
        ? Message.cases.interjection.make({ ...fields, role: "user" })
        : Message.cases.regular.make(fields)
    },
  )

export const encodeStoredMessage = (message: Message) =>
  Effect.gen(function* () {
    const partJsons = yield* Effect.forEach(message.parts, (part) => encodeStoredPromptPart(part))
    return {
      partJsons,
      metadataJson: message.metadata !== undefined ? encodeMessageMetadata(message.metadata) : null,
    }
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
    if (entry === undefined) {
      entry = { row, parts: [] }
      grouped.set(row.id, entry)
    }
    if (row.chunk_ordinal !== null && row.chunk_part_json !== null) {
      entry.parts.push({ ordinal: row.chunk_ordinal, json: row.chunk_part_json })
    }
  }

  return [...grouped.values()].map((entry) => ({
    row: entry.row,
    partJsons: entry.parts.sort((a, b) => a.ordinal - b.ordinal).map((part) => part.json),
  }))
}

export const insertMessageContent = Effect.fn("Storage.insertMessageContent")(function* (
  messageId: MessageId,
  partJsons: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient
  const platform = yield* GentPlatform
  yield* sql`DELETE FROM message_chunks WHERE message_id = ${messageId}`
  yield* Effect.forEach(
    partJsons,
    (partJson, ordinal) =>
      Effect.gen(function* () {
        const chunkId = platform.hash("sha256", partJson)
        const part = yield* decodeStoredPromptPart(partJson)
        yield* sql`INSERT OR IGNORE INTO content_chunks (id, part_type, part_json) VALUES (${chunkId}, ${part.type}, ${partJson})`
        yield* sql`INSERT INTO message_chunks (message_id, ordinal, chunk_id) VALUES (${messageId}, ${ordinal}, ${chunkId})`
      }),
    { discard: true },
  )
  yield* sql`DELETE FROM content_chunks WHERE id NOT IN (SELECT chunk_id FROM message_chunks)`
})

export const indexMessageSearch = Effect.fn("Storage.indexMessageSearch")(function* (
  message: Pick<Message, "id" | "sessionId" | "branchId" | "role" | "parts">,
) {
  const sql = yield* SqlClient.SqlClient
  yield* sql`DELETE FROM messages_fts WHERE message_id = ${message.id}`
  yield* sql`INSERT INTO messages_fts(content, message_id, session_id, branch_id, role) VALUES (${messageSearchText(message.parts)}, ${message.id}, ${message.sessionId}, ${message.branchId}, ${message.role})`
})
