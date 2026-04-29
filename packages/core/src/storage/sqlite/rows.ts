import { createHash } from "node:crypto"
import { Effect, Option, Schema } from "effect"
import { Message, Branch, MessagePart, MessageMetadata, Session } from "../../domain/message.js"
import { AgentEvent } from "../../domain/event.js"
import type { BranchId, MessageId, SessionId } from "../../domain/ids.js"
import { ReasoningEffort } from "../../domain/agent.js"
import { isRecord } from "../../domain/guards.js"
import { SqlClient } from "effect/unstable/sql"

// Schema decoders - Effect-based (no sync throws)
export const MessagePartsJson = Schema.fromJsonString(Schema.Array(MessagePart))
export const decodeMessageParts = Schema.decodeUnknownEffect(MessagePartsJson)
export const encodeMessageParts = Schema.encodeEffect(MessagePartsJson)
export const MessagePartJson = Schema.fromJsonString(MessagePart)
export const decodeMessagePart = Schema.decodeUnknownEffect(MessagePartJson)
export const encodeMessagePart = Schema.encodeEffect(MessagePartJson)
export const EventJson = Schema.fromJsonString(Schema.Unknown)
export const decodeEventJson = Schema.decodeUnknownEffect(EventJson)
export const encodeEventJson = Schema.encodeEffect(EventJson)
export const encodeEvent = (event: AgentEvent) =>
  Schema.encodeEffect(AgentEvent)(event).pipe(Effect.flatMap(encodeEventJson))
export const MessageMetadataJson = Schema.fromJsonString(MessageMetadata)
export const decodeMessageMetadata = Schema.decodeUnknownOption(MessageMetadataJson)
export const encodeMessageMetadata = Schema.encodeSync(MessageMetadataJson)

export const LEGACY_EVENT_TAGS = {
  AgentRunSpawned: ["AgentRunSpawned", "SubagentSpawned"],
  AgentRunSucceeded: ["AgentRunSucceeded", "SubagentSucceeded"],
  AgentRunFailed: ["AgentRunFailed", "SubagentFailed"],
} as const satisfies Record<string, readonly string[]>

export const MESSAGES_FTS_SCHEMA_VERSION = "1"

export const normalizeLegacyAgentEvent = (value: unknown): unknown => {
  if (!isRecord(value)) return value
  const record = value
  switch (record["_tag"]) {
    case "SubagentSpawned":
      return { ...record, _tag: "AgentRunSpawned" }
    case "SubagentSucceeded":
      return { ...record, _tag: "AgentRunSucceeded" }
    case "SubagentFailed":
      return { ...record, _tag: "AgentRunFailed" }
    default:
      return value
  }
}

export const decodeEvent = (json: string) =>
  decodeEventJson(json).pipe(
    Effect.map(normalizeLegacyAgentEvent),
    Effect.flatMap(Schema.decodeUnknownEffect(AgentEvent)),
  )

export const expandEventTags = (tags: ReadonlyArray<string>) => [
  ...new Set(
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- legacy tag lookup narrows string to known alias keys
    tags.flatMap((tag) => LEGACY_EVENT_TAGS[tag as keyof typeof LEGACY_EVENT_TAGS] ?? [tag]),
  ),
]
// Row types
export interface SessionRow {
  id: SessionId
  name: string | null
  cwd: string | null
  reasoning_level: string | null
  active_branch_id: BranchId | null
  parent_session_id: SessionId | null
  parent_branch_id: BranchId | null
  created_at: number
  updated_at: number
}

export interface BranchRow {
  id: BranchId
  session_id: SessionId
  parent_branch_id: BranchId | null
  parent_message_id: MessageId | null
  name: string | null
  summary: string | null
  created_at: number
}

export interface MessageRow {
  id: MessageId
  session_id: SessionId
  branch_id: BranchId
  kind: "regular" | "interjection" | null
  role: "user" | "assistant" | "system" | "tool"
  parts: string
  created_at: number
  turn_duration_ms: number | null
  metadata: string | null
}

export interface MessageChunkRow extends MessageRow {
  chunk_ordinal: number | null
  chunk_part_json: string | null
}

export interface EventRow {
  id: number
  event_json: string
  created_at: number
  trace_id: string | null
}

export interface ForeignKeyListRow {
  id: number
  seq: number
  table: string
  from: string
  to: string | null
  on_update: string
  on_delete: string
  match: string
}

export const SESSION_PARENT_BRANCH_CHECK =
  "CHECK (parent_branch_id IS NULL OR parent_session_id IS NOT NULL)"

export const hasSessionParentBranchCheck = (createSql: string): boolean =>
  createSql.replace(/\s+/g, " ").toUpperCase().includes(SESSION_PARENT_BRANCH_CHECK.toUpperCase())

export const isReasoningEffort = Schema.is(ReasoningEffort)

export const sessionFromRow = (row: SessionRow) =>
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
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  })

export const branchFromRow = (row: BranchRow) =>
  new Branch({
    id: row.id,
    sessionId: row.session_id,
    parentBranchId: row.parent_branch_id ?? undefined,
    parentMessageId: row.parent_message_id ?? undefined,
    name: row.name ?? undefined,
    summary: row.summary ?? undefined,
    createdAt: new Date(row.created_at),
  })

export const decodeStoredMessage = (row: MessageRow, partJsons: ReadonlyArray<string>) =>
  Effect.map(
    Effect.forEach(partJsons, (partJson) => decodeMessagePart(partJson)),
    (parts) => {
      const fields = {
        id: row.id,
        sessionId: row.session_id,
        branchId: row.branch_id,
        role: row.role,
        parts,
        createdAt: new Date(row.created_at),
        turnDurationMs: row.turn_duration_ms ?? undefined,
        metadata:
          row.metadata === null
            ? undefined
            : Option.getOrUndefined(decodeMessageMetadata(row.metadata)),
      }
      return row.kind === "interjection"
        ? Message.Interjection.make({ ...fields, role: "user" })
        : Message.Regular.make(fields)
    },
  )

export const encodeStoredMessage = (message: Message) =>
  Effect.gen(function* () {
    const partJsons = yield* Effect.forEach(message.parts, (part) => encodeMessagePart(part))
    return {
      legacyPartsJson: yield* encodeMessageParts([]),
      partJsons,
      metadataJson: message.metadata !== undefined ? encodeMessageMetadata(message.metadata) : null,
    }
  })

export const contentChunkId = (partJson: string): string =>
  createHash("sha256").update(partJson).digest("hex")

export const stringifySearchValue = (value: unknown): string => {
  if (typeof value === "string") return value
  if (value === undefined) return ""
  const encoded = JSON.stringify(value)
  return encoded === undefined ? "" : encoded
}

export const messagePartSearchText = (part: MessagePart): string => {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text
    case "image":
      return [part.mediaType, part.image].filter((value) => value !== undefined).join(" ")
    case "tool-call":
      return [part.toolName, stringifySearchValue(part.input)]
        .filter((text) => text !== "")
        .join(" ")
    case "tool-result":
      return [part.toolName, stringifySearchValue(part.output.value)]
        .filter((text) => text !== "")
        .join(" ")
  }
}

export const messageSearchText = (parts: ReadonlyArray<MessagePart>): string =>
  parts
    .map(messagePartSearchText)
    .filter((text) => text.length > 0)
    .join("\n")

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
  yield* sql`DELETE FROM message_chunks WHERE message_id = ${messageId}`
  yield* Effect.forEach(
    partJsons,
    (partJson, ordinal) =>
      Effect.gen(function* () {
        const chunkId = contentChunkId(partJson)
        const part = yield* decodeMessagePart(partJson)
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

export const backfillMessageContentChunks = Effect.fn("Storage.backfillMessageContentChunks")(
  function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<
      Pick<MessageRow, "id" | "parts">
    >`SELECT id, parts FROM messages WHERE parts != ${"[]"}`
    yield* sql.withTransaction(
      Effect.forEach(
        rows,
        (row) =>
          Effect.gen(function* () {
            const parts = yield* decodeMessageParts(row.parts)
            const partJsons = yield* Effect.forEach(parts, (part) => encodeMessagePart(part))
            const emptyPartsJson = yield* encodeMessageParts([])
            yield* insertMessageContent(row.id, partJsons)
            yield* sql`UPDATE messages SET parts = ${emptyPartsJson} WHERE id = ${row.id}`
          }),
        { discard: true },
      ),
    )
  },
)

export const backfillMessageReceivedEvents = Effect.fn("Storage.backfillMessageReceivedEvents")(
  function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{
      id: number
      event_json: string
    }>`SELECT id, event_json FROM events WHERE event_tag = ${"MessageReceived"}`

    yield* Effect.forEach(
      rows,
      (row) =>
        Effect.gen(function* () {
          const decoded = yield* decodeEventJson(row.event_json).pipe(Effect.option)
          if (decoded._tag === "None") return
          const event = normalizeLegacyAgentEvent(decoded.value)
          if (!isRecord(event)) return
          if (event["_tag"] !== "MessageReceived") return
          if ("message" in event) return
          const messageId = event["messageId"]
          if (typeof messageId !== "string") return

          const messageRows = yield* sql<MessageChunkRow>`SELECT
              m.id,
              m.session_id,
              m.branch_id,
              m.kind,
              m.role,
              m.parts,
              m.created_at,
              m.turn_duration_ms,
              m.metadata,
              mc.ordinal as chunk_ordinal,
              c.part_json as chunk_part_json
            FROM messages m
            LEFT JOIN message_chunks mc ON mc.message_id = m.id
            LEFT JOIN content_chunks c ON c.id = mc.chunk_id
            WHERE m.id = ${messageId}
            ORDER BY mc.ordinal ASC`
          const entry = groupMessageChunkRows(messageRows)[0]
          if (entry === undefined) return
          const message = yield* decodeStoredMessage(entry.row, entry.partJsons)
          const eventJson = yield* encodeEvent(AgentEvent.MessageReceived.make({ message }))
          yield* sql`UPDATE events SET event_json = ${eventJson}, branch_id = ${message.branchId} WHERE id = ${row.id}`
        }),
      { discard: true },
    )
  },
)

export const backfillMessageSearchIndex = Effect.fn("Storage.backfillMessageSearchIndex")(
  function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<MessageChunkRow>`SELECT
      m.id,
      m.session_id,
      m.branch_id,
      m.kind,
      m.role,
      m.parts,
      m.created_at,
      m.turn_duration_ms,
      m.metadata,
      mc.ordinal as chunk_ordinal,
      c.part_json as chunk_part_json
    FROM messages m
    LEFT JOIN message_chunks mc ON mc.message_id = m.id
    LEFT JOIN content_chunks c ON c.id = mc.chunk_id
    ORDER BY m.created_at ASC, m.id ASC, mc.ordinal ASC`
    const messages = yield* Effect.forEach(groupMessageChunkRows(rows), ({ row, partJsons }) =>
      decodeStoredMessage(row, partJsons),
    )
    yield* Effect.forEach(messages, (message) => indexMessageSearch(message), { discard: true })
  },
)
