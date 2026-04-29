import type { PlatformError } from "effect"
import { createHash } from "node:crypto"
import { Clock, Context, Effect, Layer, Option, Schema, FileSystem, Path } from "effect"
import { Message, Session, Branch, MessagePart, MessageMetadata } from "../domain/message.js"
import {
  AgentEvent,
  EventEnvelope,
  EventId,
  getEventBranchId,
  getEventSessionId,
} from "../domain/event.js"
import type { SessionId, BranchId, MessageId } from "../domain/ids.js"
import { ReasoningEffort } from "../domain/agent.js"
import { isRecord } from "../domain/guards.js"
import { SqlClient, SqlError } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { CheckpointStorage } from "./checkpoint-storage.js"
import { InteractionStorage } from "./interaction-storage.js"
import { InteractionPendingReader } from "./interaction-pending-reader.js"
import { SearchStorage } from "./search-storage.js"
import { SessionStorage } from "./session-storage.js"
import { BranchStorage } from "./branch-storage.js"
import { MessageStorage } from "./message-storage.js"
import { EventStorage } from "./event-storage.js"
import { RelationshipStorage } from "./relationship-storage.js"
import { ActorPersistenceStorage } from "./actor-persistence-storage.js"
import { StorageError } from "../domain/storage-error.js"

// Schema decoders - Effect-based (no sync throws)
const MessagePartsJson = Schema.fromJsonString(Schema.Array(MessagePart))
const decodeMessageParts = Schema.decodeUnknownEffect(MessagePartsJson)
const encodeMessageParts = Schema.encodeEffect(MessagePartsJson)
const MessagePartJson = Schema.fromJsonString(MessagePart)
const decodeMessagePart = Schema.decodeUnknownEffect(MessagePartJson)
const encodeMessagePart = Schema.encodeEffect(MessagePartJson)
const EventJson = Schema.fromJsonString(Schema.Unknown)
const decodeEventJson = Schema.decodeUnknownEffect(EventJson)
const encodeEventJson = Schema.encodeEffect(EventJson)
const encodeEvent = (event: AgentEvent) =>
  Schema.encodeEffect(AgentEvent)(event).pipe(Effect.flatMap(encodeEventJson))
const MessageMetadataJson = Schema.fromJsonString(MessageMetadata)
const decodeMessageMetadata = Schema.decodeUnknownOption(MessageMetadataJson)
const encodeMessageMetadata = Schema.encodeSync(MessageMetadataJson)

const LEGACY_EVENT_TAGS = {
  AgentRunSpawned: ["AgentRunSpawned", "SubagentSpawned"],
  AgentRunSucceeded: ["AgentRunSucceeded", "SubagentSucceeded"],
  AgentRunFailed: ["AgentRunFailed", "SubagentFailed"],
} as const satisfies Record<string, readonly string[]>

const normalizeLegacyAgentEvent = (value: unknown): unknown => {
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

const decodeEvent = (json: string) =>
  decodeEventJson(json).pipe(
    Effect.map(normalizeLegacyAgentEvent),
    Effect.flatMap(Schema.decodeUnknownEffect(AgentEvent)),
  )

const expandEventTags = (tags: ReadonlyArray<string>) => [
  ...new Set(
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- legacy tag lookup narrows string to known alias keys
    tags.flatMap((tag) => LEGACY_EVENT_TAGS[tag as keyof typeof LEGACY_EVENT_TAGS] ?? [tag]),
  ),
]
// Storage Error — definition lives in domain/ to keep the brand single-sourced.
// `domain/session-mutations.ts` (and other domain interfaces) reference this
// type; importing from infra would invert the dependency direction.

export { StorageError }

// Storage Service Interface

export interface StorageService {
  readonly withTransaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | StorageError, R>

  // Sessions
  readonly createSession: (session: Session) => Effect.Effect<Session, StorageError>
  readonly getSession: (id: SessionId) => Effect.Effect<Session | undefined, StorageError>
  readonly getLastSessionByCwd: (cwd: string) => Effect.Effect<Session | undefined, StorageError>
  readonly listSessions: () => Effect.Effect<ReadonlyArray<Session>, StorageError>
  readonly listFirstBranches: () => Effect.Effect<
    ReadonlyArray<{ sessionId: SessionId; branchId: BranchId | undefined }>,
    StorageError
  >
  readonly updateSession: (session: Session) => Effect.Effect<Session, StorageError>
  /**
   * Deletes the session and every descendant. SELECT + DELETE execute inside
   * the same transaction so a child created mid-delete is either picked up
   * (commits before the tx) or rejected by the missing-parent FK (commits
   * after). Returns the full set of session ids the cascade actually removed
   * so in-memory cleanup uses the same snapshot.
   */
  readonly deleteSession: (id: SessionId) => Effect.Effect<ReadonlyArray<SessionId>, StorageError>

  // Branches
  readonly createBranch: (branch: Branch) => Effect.Effect<Branch, StorageError>
  readonly getBranch: (id: BranchId) => Effect.Effect<Branch | undefined, StorageError>
  readonly listBranches: (
    sessionId: SessionId,
  ) => Effect.Effect<ReadonlyArray<Branch>, StorageError>
  readonly deleteBranch: (id: BranchId) => Effect.Effect<void, StorageError>
  readonly updateBranchSummary: (
    branchId: BranchId,
    summary: string,
  ) => Effect.Effect<void, StorageError>
  readonly countMessages: (branchId: BranchId) => Effect.Effect<number, StorageError>
  readonly countMessagesByBranches: (
    branchIds: readonly BranchId[],
  ) => Effect.Effect<ReadonlyMap<BranchId, number>, StorageError>

  // Messages
  readonly createMessage: (message: Message) => Effect.Effect<Message, StorageError>
  readonly createMessageIfAbsent: (message: Message) => Effect.Effect<Message, StorageError>
  readonly getMessage: (id: MessageId) => Effect.Effect<Message | undefined, StorageError>
  readonly listMessages: (branchId: BranchId) => Effect.Effect<ReadonlyArray<Message>, StorageError>
  readonly deleteMessages: (
    branchId: BranchId,
    afterMessageId?: MessageId,
  ) => Effect.Effect<void, StorageError>
  readonly updateMessageTurnDuration: (
    messageId: MessageId,
    durationMs: number,
  ) => Effect.Effect<void, StorageError>

  // Events
  readonly appendEvent: (
    event: AgentEvent,
    options?: { traceId?: string },
  ) => Effect.Effect<EventEnvelope, StorageError>
  readonly listEvents: (params: {
    sessionId: SessionId
    branchId?: BranchId
    afterId?: number
  }) => Effect.Effect<ReadonlyArray<EventEnvelope>, StorageError>
  readonly getLatestEventId: (params: {
    sessionId: SessionId
    branchId?: BranchId
  }) => Effect.Effect<number | undefined, StorageError>
  readonly getLatestEventTag: (params: {
    sessionId: SessionId
    branchId: BranchId
    tags: ReadonlyArray<string>
  }) => Effect.Effect<string | undefined, StorageError>
  readonly getLatestEvent: (params: {
    sessionId: SessionId
    branchId: BranchId
    tags: ReadonlyArray<string>
  }) => Effect.Effect<AgentEvent | undefined, StorageError>

  // Session tree
  readonly getChildSessions: (
    parentSessionId: SessionId,
  ) => Effect.Effect<ReadonlyArray<Session>, StorageError>

  readonly getSessionAncestors: (
    sessionId: SessionId,
  ) => Effect.Effect<ReadonlyArray<Session>, StorageError>

  /** Returns branches + messages within a single session (not cross-session tree) */
  readonly getSessionDetail: (sessionId: SessionId) => Effect.Effect<
    {
      session: Session
      branches: ReadonlyArray<{
        branch: Branch
        messages: ReadonlyArray<Message>
      }>
    },
    StorageError
  >

  // Actor persistence (profile-scoped, key-namespaced).
  readonly saveActorState: (params: {
    profileId: string
    persistenceKey: string
    stateJson: string
  }) => Effect.Effect<void, StorageError>
  readonly loadActorState: (params: {
    profileId: string
    persistenceKey: string
  }) => Effect.Effect<{ stateJson: string; updatedAt: number } | undefined, StorageError>
  readonly listActorStatesForProfile: (profileId: string) => Effect.Effect<
    ReadonlyArray<{
      profileId: string
      persistenceKey: string
      stateJson: string
      updatedAt: number
    }>,
    StorageError
  >
  readonly deleteActorStatesForProfile: (profileId: string) => Effect.Effect<void, StorageError>
}

const mapError = (message: string) => (e: unknown) => new StorageError({ message, cause: e })

// Row types
interface SessionRow {
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

interface BranchRow {
  id: BranchId
  session_id: SessionId
  parent_branch_id: BranchId | null
  parent_message_id: MessageId | null
  name: string | null
  summary: string | null
  created_at: number
}

interface MessageRow {
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

interface MessageChunkRow extends MessageRow {
  chunk_ordinal: number | null
  chunk_part_json: string | null
}

interface EventRow {
  id: number
  event_json: string
  created_at: number
  trace_id: string | null
}

interface ForeignKeyListRow {
  id: number
  seq: number
  table: string
  from: string
  to: string | null
  on_update: string
  on_delete: string
  match: string
}

const SESSION_PARENT_BRANCH_CHECK =
  "CHECK (parent_branch_id IS NULL OR parent_session_id IS NOT NULL)"

const hasSessionParentBranchCheck = (createSql: string): boolean =>
  createSql.replace(/\s+/g, " ").toUpperCase().includes(SESSION_PARENT_BRANCH_CHECK.toUpperCase())

const isReasoningEffort = Schema.is(ReasoningEffort)

const sessionFromRow = (row: SessionRow) =>
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

const branchFromRow = (row: BranchRow) =>
  new Branch({
    id: row.id,
    sessionId: row.session_id,
    parentBranchId: row.parent_branch_id ?? undefined,
    parentMessageId: row.parent_message_id ?? undefined,
    name: row.name ?? undefined,
    summary: row.summary ?? undefined,
    createdAt: new Date(row.created_at),
  })

const decodeStoredMessage = (row: MessageRow, partJsons: ReadonlyArray<string>) =>
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

const encodeStoredMessage = (message: Message) =>
  Effect.gen(function* () {
    const partJsons = yield* Effect.forEach(message.parts, (part) => encodeMessagePart(part))
    return {
      legacyPartsJson: yield* encodeMessageParts([]),
      partJsons,
      metadataJson: message.metadata !== undefined ? encodeMessageMetadata(message.metadata) : null,
    }
  })

const contentChunkId = (partJson: string): string =>
  createHash("sha256").update(partJson).digest("hex")

const stringifySearchValue = (value: unknown): string => {
  if (typeof value === "string") return value
  if (value === undefined) return ""
  const encoded = JSON.stringify(value)
  return encoded === undefined ? "" : encoded
}

const messagePartSearchText = (part: MessagePart): string => {
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

const messageSearchText = (parts: ReadonlyArray<MessagePart>): string =>
  parts
    .map(messagePartSearchText)
    .filter((text) => text.length > 0)
    .join("\n")

const groupMessageChunkRows = (rows: ReadonlyArray<MessageChunkRow>) => {
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

const insertMessageContent = Effect.fn("Storage.insertMessageContent")(function* (
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

const indexMessageSearch = Effect.fn("Storage.indexMessageSearch")(function* (
  message: Pick<Message, "id" | "sessionId" | "branchId" | "role" | "parts">,
) {
  const sql = yield* SqlClient.SqlClient
  yield* sql`DELETE FROM messages_fts WHERE message_id = ${message.id}`
  yield* sql`INSERT INTO messages_fts(content, message_id, session_id, branch_id, role) VALUES (${messageSearchText(message.parts)}, ${message.id}, ${message.sessionId}, ${message.branchId}, ${message.role})`
})

const backfillMessageContentChunks = Effect.fn("Storage.backfillMessageContentChunks")(
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

const backfillMessageReceivedEvents = Effect.fn("Storage.backfillMessageReceivedEvents")(
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

const backfillMessageSearchIndex = Effect.fn("Storage.backfillMessageSearchIndex")(function* () {
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
})

const dropRetiredTables = Effect.fn("Storage.dropRetiredTables")(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`DROP INDEX IF EXISTS idx_todos_branch`).pipe(Effect.ignoreCause)
  yield* sql.unsafe(`DROP TABLE IF EXISTS todos`).pipe(Effect.ignoreCause)
  yield* sql.unsafe(`DROP TABLE IF EXISTS extension_state`).pipe(Effect.ignoreCause)
})

const foreignKeys = Effect.fn("Storage.foreignKeys")(function* (table: string) {
  const sql = yield* SqlClient.SqlClient
  return yield* sql.unsafe<ForeignKeyListRow>(`PRAGMA foreign_key_list(${table})`)
})

const migrateTableForeignKeys = Effect.fn("Storage.migrateTableForeignKeys")(function* (params: {
  readonly table: string
  readonly columns: ReadonlyArray<string>
  readonly expectedParents: ReadonlyArray<string>
  readonly createSql: string
  readonly shouldMigrate?: (foreignKeys: ReadonlyArray<ForeignKeyListRow>) => boolean
  readonly shouldMigrateSql?: (createSql: string) => boolean
}) {
  const sql = yield* SqlClient.SqlClient
  const keys = yield* foreignKeys(params.table)
  const parents = new Set(keys.map((row) => row.table))
  const schemaRows = yield* sql<{ sql: string | null }>`
    SELECT sql FROM sqlite_schema WHERE type = ${"table"} AND name = ${params.table}
  `
  const tableSql = schemaRows[0]?.sql ?? ""
  const needsMigration =
    params.expectedParents.some((parent) => !parents.has(parent)) ||
    (params.shouldMigrate?.(keys) ?? false) ||
    (params.shouldMigrateSql?.(tableSql) ?? false)

  if (!needsMigration) return

  const legacyTable = `${params.table}__legacy_fk_migration`
  const columnList = params.columns.join(", ")

  yield* sql.unsafe(`DROP TABLE IF EXISTS ${legacyTable}`)
  yield* sql.unsafe(`ALTER TABLE ${params.table} RENAME TO ${legacyTable}`)
  yield* sql.unsafe(params.createSql)
  yield* sql.unsafe(
    `INSERT INTO ${params.table} (${columnList}) SELECT ${columnList} FROM ${legacyTable}`,
  )
  yield* sql.unsafe(`DROP TABLE ${legacyTable}`)
})

const migrateForeignKeyConstraints = Effect.fn("Storage.migrateForeignKeyConstraints")(
  function* () {
    const sql = yield* SqlClient.SqlClient

    // Flip `foreign_keys` OFF so we can rebuild parent tables, then ALWAYS
    // restore ON — including on transaction failure — via acquireUseRelease.
    yield* Effect.acquireUseRelease(
      sql.unsafe(`PRAGMA foreign_keys = OFF`),
      () =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql.unsafe(
              `CREATE UNIQUE INDEX IF NOT EXISTS idx_branches_id_session ON branches(id, session_id)`,
            )
            yield* migrateTableForeignKeys({
              table: "sessions",
              columns: [
                "id",
                "name",
                "cwd",
                "reasoning_level",
                "active_branch_id",
                "parent_session_id",
                "parent_branch_id",
                "created_at",
                "updated_at",
              ],
              expectedParents: ["branches", "sessions"],
              createSql: `
          CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            name TEXT,
            cwd TEXT,
            reasoning_level TEXT,
            active_branch_id TEXT,
            parent_session_id TEXT,
            parent_branch_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            ${SESSION_PARENT_BRANCH_CHECK},
            FOREIGN KEY (parent_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
            FOREIGN KEY (active_branch_id, id) REFERENCES branches(id, session_id) DEFERRABLE INITIALLY DEFERRED,
            FOREIGN KEY (parent_branch_id, parent_session_id) REFERENCES branches(id, session_id) DEFERRABLE INITIALLY DEFERRED
          )
        `,
              shouldMigrate: (keys) =>
                keys.some(
                  (key) =>
                    key.table === "branches" &&
                    key.from === "parent_branch_id" &&
                    key.on_delete.toUpperCase() === "CASCADE",
                ),
              shouldMigrateSql: (createSql) => !hasSessionParentBranchCheck(createSql),
            })
            yield* migrateTableForeignKeys({
              table: "branches",
              columns: [
                "id",
                "session_id",
                "parent_branch_id",
                "parent_message_id",
                "name",
                "summary",
                "created_at",
              ],
              expectedParents: ["sessions", "branches"],
              createSql: `
          CREATE TABLE branches (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            parent_branch_id TEXT,
            parent_message_id TEXT,
            name TEXT,
            summary TEXT,
            created_at INTEGER NOT NULL,
            UNIQUE (id, session_id),
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
            FOREIGN KEY (parent_branch_id, session_id) REFERENCES branches(id, session_id) DEFERRABLE INITIALLY DEFERRED
          )
        `,
            })
            yield* sql.unsafe(
              `CREATE UNIQUE INDEX IF NOT EXISTS idx_branches_id_session ON branches(id, session_id)`,
            )
            yield* migrateTableForeignKeys({
              table: "messages",
              columns: [
                "id",
                "session_id",
                "branch_id",
                "kind",
                "role",
                "parts",
                "created_at",
                "turn_duration_ms",
                "metadata",
              ],
              expectedParents: ["branches", "sessions"],
              createSql: `
          CREATE TABLE messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            branch_id TEXT NOT NULL,
            kind TEXT,
            role TEXT NOT NULL,
            parts TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            turn_duration_ms INTEGER,
            metadata TEXT,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
            FOREIGN KEY (branch_id, session_id) REFERENCES branches(id, session_id) ON DELETE CASCADE
          )
        `,
            })
            yield* migrateTableForeignKeys({
              table: "message_chunks",
              columns: ["message_id", "ordinal", "chunk_id"],
              expectedParents: ["messages", "content_chunks"],
              createSql: `
          CREATE TABLE message_chunks (
            message_id TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            chunk_id TEXT NOT NULL,
            PRIMARY KEY (message_id, ordinal),
            FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
            FOREIGN KEY (chunk_id) REFERENCES content_chunks(id)
          )
        `,
            })
            yield* migrateTableForeignKeys({
              table: "events",
              columns: [
                "id",
                "session_id",
                "branch_id",
                "event_tag",
                "event_json",
                "created_at",
                "trace_id",
              ],
              expectedParents: ["branches", "sessions"],
              createSql: `
          CREATE TABLE events (
            id INTEGER PRIMARY KEY,
            session_id TEXT NOT NULL,
            branch_id TEXT,
            event_tag TEXT NOT NULL,
            event_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            trace_id TEXT,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
            FOREIGN KEY (branch_id, session_id) REFERENCES branches(id, session_id) ON DELETE CASCADE
          )
        `,
            })
            yield* migrateTableForeignKeys({
              table: "actor_inbox",
              columns: [
                "command_id",
                "session_id",
                "branch_id",
                "command_kind",
                "payload_json",
                "status",
                "attempts",
                "created_at",
                "updated_at",
                "started_at",
                "completed_at",
                "last_error",
              ],
              expectedParents: ["branches", "sessions"],
              createSql: `
          CREATE TABLE actor_inbox (
            command_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            branch_id TEXT NOT NULL,
            command_kind TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            status TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            started_at INTEGER,
            completed_at INTEGER,
            last_error TEXT,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
            FOREIGN KEY (branch_id, session_id) REFERENCES branches(id, session_id) ON DELETE CASCADE
          )
        `,
            })
            yield* migrateTableForeignKeys({
              table: "agent_loop_checkpoints",
              columns: [
                "session_id",
                "branch_id",
                "version",
                "state_tag",
                "state_json",
                "updated_at",
              ],
              expectedParents: ["branches", "sessions"],
              createSql: `
          CREATE TABLE agent_loop_checkpoints (
            session_id TEXT NOT NULL,
            branch_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            state_tag TEXT NOT NULL,
            state_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (session_id, branch_id),
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
            FOREIGN KEY (branch_id, session_id) REFERENCES branches(id, session_id) ON DELETE CASCADE
          )
        `,
            })
            yield* migrateTableForeignKeys({
              table: "interaction_requests",
              columns: [
                "request_id",
                "type",
                "session_id",
                "branch_id",
                "params_json",
                "status",
                "created_at",
              ],
              expectedParents: ["branches", "sessions"],
              createSql: `
          CREATE TABLE interaction_requests (
            request_id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            session_id TEXT NOT NULL,
            branch_id TEXT NOT NULL,
            params_json TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at INTEGER NOT NULL,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
            FOREIGN KEY (branch_id, session_id) REFERENCES branches(id, session_id) ON DELETE CASCADE
          )
        `,
            })
          }),
        ),
      () => sql.unsafe(`PRAGMA foreign_keys = ON`),
    )
  },
)

const assertForeignKeyIntegrity = Effect.fn("Storage.assertForeignKeyIntegrity")(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    table: string
    rowid: number | null
    parent: string
    fkid: number
  }>`PRAGMA foreign_key_check`
  const activeRows = rows.filter((row) => row.table !== "extension_state" && row.table !== "todos")

  if (activeRows.length === 0) return

  const details = activeRows
    .slice(0, 10)
    .map((row) => `${row.table}:${row.rowid ?? "unknown"} -> ${row.parent}#${row.fkid}`)
    .join(", ")
  return yield* new StorageError({
    message: `SQLite foreign key integrity check failed: ${details}`,
  })
})

const initSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`PRAGMA foreign_keys = ON`)

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT,
      cwd TEXT,
      reasoning_level TEXT,
      active_branch_id TEXT,
      parent_session_id TEXT,
      parent_branch_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ${SESSION_PARENT_BRANCH_CHECK},
      FOREIGN KEY (parent_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (active_branch_id, id) REFERENCES branches(id, session_id) DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY (parent_branch_id, parent_session_id) REFERENCES branches(id, session_id) DEFERRABLE INITIALLY DEFERRED
    )
  `)

  // Migrations
  yield* sql.unsafe(`ALTER TABLE sessions ADD COLUMN cwd TEXT`).pipe(Effect.ignoreCause)
  yield* sql.unsafe(`ALTER TABLE sessions ADD COLUMN reasoning_level TEXT`).pipe(Effect.ignoreCause)
  yield* sql
    .unsafe(`ALTER TABLE sessions ADD COLUMN active_branch_id TEXT`)
    .pipe(Effect.ignoreCause)
  yield* sql
    .unsafe(`ALTER TABLE sessions ADD COLUMN parent_session_id TEXT`)
    .pipe(Effect.ignoreCause)
  yield* sql
    .unsafe(`ALTER TABLE sessions ADD COLUMN parent_branch_id TEXT`)
    .pipe(Effect.ignoreCause)

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS branches (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      parent_branch_id TEXT,
      parent_message_id TEXT,
      name TEXT,
      summary TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE (id, session_id),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_branch_id, session_id) REFERENCES branches(id, session_id) DEFERRABLE INITIALLY DEFERRED
    )
  `)

  yield* sql.unsafe(`ALTER TABLE branches ADD COLUMN summary TEXT`).pipe(Effect.ignoreCause)

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      kind TEXT,
      role TEXT NOT NULL,
      parts TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      turn_duration_ms INTEGER,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (branch_id, session_id) REFERENCES branches(id, session_id) ON DELETE CASCADE
    )
  `)

  yield* sql.unsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_branches_id_session ON branches(id, session_id)`,
  )
  yield* sql.unsafe(`ALTER TABLE messages ADD COLUMN kind TEXT`).pipe(Effect.ignoreCause)
  yield* sql.unsafe(`ALTER TABLE messages ADD COLUMN metadata TEXT`).pipe(Effect.ignoreCause)

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS content_chunks (
      id TEXT PRIMARY KEY,
      part_type TEXT NOT NULL,
      part_json TEXT NOT NULL
    )
  `)

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS message_chunks (
      message_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      chunk_id TEXT NOT NULL,
      PRIMARY KEY (message_id, ordinal),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (chunk_id) REFERENCES content_chunks(id)
    )
  `)

  yield* backfillMessageContentChunks()

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      branch_id TEXT,
      event_tag TEXT NOT NULL,
      event_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (branch_id, session_id) REFERENCES branches(id, session_id) ON DELETE CASCADE
    )
  `)

  yield* sql.unsafe(`ALTER TABLE events ADD COLUMN trace_id TEXT`).pipe(Effect.ignoreCause)
  yield* backfillMessageReceivedEvents()

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS actor_inbox (
      command_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      command_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      last_error TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (branch_id, session_id) REFERENCES branches(id, session_id) ON DELETE CASCADE
    )
  `)

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS agent_loop_checkpoints (
      session_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      state_tag TEXT NOT NULL,
      state_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, branch_id),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (branch_id, session_id) REFERENCES branches(id, session_id) ON DELETE CASCADE
    )
  `)

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS interaction_requests (
      request_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      session_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      params_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (branch_id, session_id) REFERENCES branches(id, session_id) ON DELETE CASCADE
    )
  `)

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS actor_persistence (
      profile_id TEXT NOT NULL,
      persistence_key TEXT NOT NULL,
      state_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (profile_id, persistence_key)
    )
  `)

  yield* migrateForeignKeyConstraints()
  yield* assertForeignKeyIntegrity()
  yield* dropRetiredTables()

  yield* sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_messages_branch ON messages(branch_id)`)
  yield* sql.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_messages_branch_created ON messages(branch_id, created_at, id)`,
  )
  yield* sql.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_message_chunks_chunk ON message_chunks(chunk_id)`,
  )
  yield* sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, id)`)
  yield* sql.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_events_session_branch ON events(session_id, branch_id, id)`,
  )
  yield* sql.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_events_session_tag ON events(session_id, event_tag, id)`,
  )
  yield* sql.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_actor_inbox_status ON actor_inbox(status, updated_at)`,
  )
  yield* sql.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_actor_inbox_target ON actor_inbox(session_id, branch_id, status)`,
  )
  yield* sql.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_agent_loop_checkpoints_updated ON agent_loop_checkpoints(updated_at)`,
  )
  yield* sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_branches_session ON branches(session_id)`)
  yield* sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id)`)
  yield* sql.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_interaction_requests_status ON interaction_requests(status)`,
  )

  // FTS5 for message search (standalone — no content-sync)
  // Migration: drop old content-sync FTS table if it exists (had column mismatch bug)
  yield* sql.unsafe(`DROP TRIGGER IF EXISTS messages_fts_ai`).pipe(Effect.ignoreCause)
  yield* sql.unsafe(`DROP TABLE IF EXISTS messages_fts`).pipe(Effect.ignoreCause)

  yield* sql
    .unsafe(
      `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, message_id UNINDEXED, session_id UNINDEXED, branch_id UNINDEXED, role UNINDEXED)`,
    )
    .pipe(Effect.ignoreCause)

  yield* backfillMessageSearchIndex()
})

const makeStorageImpl = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // PRAGMA foreign_keys is connection-state, not stored in the DB blob.
  // Deserialized DBs come up with FKs OFF — re-enable on every connection.
  // Idempotent, cheap; runs before any user query.
  yield* Effect.orDie(sql.unsafe(`PRAGMA foreign_keys = ON`))
  const insertContent = (messageId: MessageId, partJsons: ReadonlyArray<string>) =>
    insertMessageContent(messageId, partJsons).pipe(Effect.provideService(SqlClient.SqlClient, sql))
  const indexSearch = (
    message: Pick<Message, "id" | "sessionId" | "branchId" | "role" | "parts">,
  ) => indexMessageSearch(message).pipe(Effect.provideService(SqlClient.SqlClient, sql))

  return {
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      sql
        .withTransaction(effect)
        .pipe(
          Effect.catchIf(SqlError.isSqlError, (error) =>
            Effect.fail(
              new StorageError({ message: "Failed to run storage transaction", cause: error }),
            ),
          ),
        ),

    // Sessions
    createSession: Effect.fn("Storage.createSession")(
      function* (session) {
        if (session.parentBranchId !== undefined && session.parentSessionId === undefined) {
          return yield* new StorageError({
            message: "Cannot create session with parentBranchId without parentSessionId",
          })
        }
        if (session.parentBranchId !== undefined && session.parentSessionId !== undefined) {
          const parentRows = yield* sql<{
            id: BranchId
          }>`SELECT id FROM branches WHERE id = ${session.parentBranchId} AND session_id = ${session.parentSessionId}`
          if (parentRows.length === 0) {
            return yield* new StorageError({
              message: `Parent branch not found in parent session: ${session.parentBranchId}`,
            })
          }
        }
        yield* sql`INSERT INTO sessions (id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at) VALUES (${session.id}, ${session.name ?? null}, ${session.cwd ?? null}, ${session.reasoningLevel ?? null}, ${session.activeBranchId ?? null}, ${session.parentSessionId ?? null}, ${session.parentBranchId ?? null}, ${session.createdAt.getTime()}, ${session.updatedAt.getTime()})`
        return session
      },
      Effect.mapError(mapError("Failed to create session")),
    ),

    getSession: Effect.fn("Storage.getSession")(
      function* (id) {
        const rows =
          yield* sql<SessionRow>`SELECT id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at FROM sessions WHERE id = ${id}`
        const row = rows[0]
        if (row === undefined) return undefined
        return sessionFromRow(row)
      },
      Effect.mapError(mapError("Failed to get session")),
    ),

    getLastSessionByCwd: Effect.fn("Storage.getLastSessionByCwd")(
      function* (cwd) {
        const rows =
          yield* sql<SessionRow>`SELECT id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at FROM sessions WHERE cwd = ${cwd} ORDER BY updated_at DESC LIMIT 1`
        const row = rows[0]
        if (row === undefined) return undefined
        return sessionFromRow(row)
      },
      Effect.mapError(mapError("Failed to get last session by cwd")),
    ),

    listSessions: Effect.fn("Storage.listSessions")(
      function* () {
        const rows =
          yield* sql<SessionRow>`SELECT id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at FROM sessions ORDER BY updated_at DESC`
        return rows.map(sessionFromRow)
      },
      Effect.mapError(mapError("Failed to list sessions")),
    ),

    listFirstBranches: Effect.fn("Storage.listFirstBranches")(
      function* () {
        const rows = yield* sql<{
          session_id: SessionId
          branch_id: BranchId | null
        }>`SELECT s.id AS session_id, b.id AS branch_id
         FROM sessions s
         LEFT JOIN branches b
           ON b.session_id = s.id
           AND b.created_at = (
             SELECT MIN(created_at) FROM branches WHERE session_id = s.id
           )
         ORDER BY s.updated_at DESC`
        return rows.map((row) => ({
          sessionId: row.session_id,
          branchId: row.branch_id ?? undefined,
        }))
      },
      Effect.mapError(mapError("Failed to list first branches")),
    ),

    updateSession: Effect.fn("Storage.updateSession")(
      function* (session) {
        yield* sql`UPDATE sessions SET name = ${session.name ?? null}, reasoning_level = ${session.reasoningLevel ?? null}, active_branch_id = ${session.activeBranchId ?? null}, updated_at = ${session.updatedAt.getTime()} WHERE id = ${session.id}`
        return session
      },
      Effect.mapError(mapError("Failed to update session")),
    ),

    deleteSession: (id) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            // SELECT + DELETE inside one tx keeps the descendant set consistent
            // with the durable cascade. A child created after the tx begins
            // violates the parent FK when it tries to commit, so either it's
            // in our SELECT or it never durably lands. Returning the set lets
            // the caller clean runtime state for exactly the same ids the DB
            // removed — no ghost loops / streams / cwd-registry entries.
            const descendantRows = yield* sql<{ id: SessionId }>`
              WITH RECURSIVE descendants(id) AS (
                SELECT id FROM sessions WHERE id = ${id}
                UNION
                SELECT sessions.id
                FROM sessions
                JOIN descendants ON sessions.parent_session_id = descendants.id
              )
              SELECT id FROM descendants
            `
            const cascadedIds = descendantRows.map((row) => row.id)
            if (cascadedIds.length === 0) return cascadedIds
            yield* sql`DELETE FROM messages_fts WHERE session_id IN ${sql.in(cascadedIds)}`
            yield* sql`DELETE FROM sessions WHERE id IN ${sql.in(cascadedIds)}`
            yield* sql`DELETE FROM content_chunks WHERE id NOT IN (SELECT chunk_id FROM message_chunks)`
            return cascadedIds
          }),
        )
        .pipe(
          Effect.mapError(mapError("Failed to delete session")),
          Effect.withSpan("Storage.deleteSession"),
        ),

    // Branches
    createBranch: Effect.fn("Storage.createBranch")(
      function* (branch) {
        if (branch.parentBranchId !== undefined) {
          const parentRows = yield* sql<{
            id: BranchId
          }>`SELECT id FROM branches WHERE id = ${branch.parentBranchId} AND session_id = ${branch.sessionId}`
          if (parentRows.length === 0) {
            return yield* new StorageError({
              message: `Parent branch not found in session: ${branch.parentBranchId}`,
            })
          }
        }
        yield* sql`INSERT INTO branches (id, session_id, parent_branch_id, parent_message_id, name, summary, created_at) VALUES (${branch.id}, ${branch.sessionId}, ${branch.parentBranchId ?? null}, ${branch.parentMessageId ?? null}, ${branch.name ?? null}, ${branch.summary ?? null}, ${branch.createdAt.getTime()})`
        return branch
      },
      Effect.mapError(mapError("Failed to create branch")),
    ),

    getBranch: Effect.fn("Storage.getBranch")(
      function* (id) {
        const rows =
          yield* sql<BranchRow>`SELECT id, session_id, parent_branch_id, parent_message_id, name, summary, created_at FROM branches WHERE id = ${id}`
        const row = rows[0]
        if (row === undefined) return undefined
        return branchFromRow(row)
      },
      Effect.mapError(mapError("Failed to get branch")),
    ),

    listBranches: Effect.fn("Storage.listBranches")(
      function* (sessionId) {
        const rows =
          yield* sql<BranchRow>`SELECT id, session_id, parent_branch_id, parent_message_id, name, summary, created_at FROM branches WHERE session_id = ${sessionId} ORDER BY created_at ASC`
        return rows.map(branchFromRow)
      },
      Effect.mapError(mapError("Failed to list branches")),
    ),

    updateBranchSummary: (branchId, summary) =>
      sql`UPDATE branches SET summary = ${summary} WHERE id = ${branchId}`.pipe(
        Effect.asVoid,
        Effect.mapError(mapError("Failed to update branch summary")),
        Effect.withSpan("Storage.updateBranchSummary"),
      ),

    deleteBranch: Effect.fn("Storage.deleteBranch")(
      function* (id) {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const childBranches = yield* sql<{
              count: number
            }>`SELECT COUNT(*) as count FROM branches WHERE parent_branch_id = ${id}`
            if ((childBranches[0]?.count ?? 0) > 0) {
              return yield* new StorageError({
                message: `Cannot delete branch with child branches: ${id}`,
              })
            }

            const childSessions = yield* sql<{
              count: number
            }>`SELECT COUNT(*) as count FROM sessions WHERE parent_branch_id = ${id}`
            if ((childSessions[0]?.count ?? 0) > 0) {
              return yield* new StorageError({
                message: `Cannot delete branch with child sessions: ${id}`,
              })
            }

            const messageRows = yield* sql<{
              id: MessageId
            }>`SELECT id FROM messages WHERE branch_id = ${id}`
            const messageIds = messageRows.map((row) => row.id)
            if (messageIds.length > 0) {
              yield* sql`DELETE FROM messages_fts WHERE message_id IN ${sql.in(messageIds)}`
            }
            yield* sql`DELETE FROM branches WHERE id = ${id}`
            yield* sql`DELETE FROM content_chunks WHERE id NOT IN (SELECT chunk_id FROM message_chunks)`
          }),
        )
      },
      Effect.mapError(mapError("Failed to delete branch")),
    ),

    countMessages: Effect.fn("Storage.countMessages")(
      function* (branchId) {
        const rows = yield* sql<{
          count: number
        }>`SELECT COUNT(*) as count FROM messages WHERE branch_id = ${branchId}`
        return rows[0]?.count ?? 0
      },
      Effect.mapError(mapError("Failed to count messages")),
    ),

    countMessagesByBranches: Effect.fn("Storage.countMessagesByBranches")(
      function* (branchIds) {
        if (branchIds.length === 0) return new Map<BranchId, number>()
        const rows = yield* sql<{
          branch_id: BranchId
          count: number
        }>`SELECT branch_id, COUNT(*) as count FROM messages WHERE branch_id IN ${sql.in(branchIds)} GROUP BY branch_id`
        const result = new Map<BranchId, number>()
        for (const row of rows) {
          result.set(row.branch_id, row.count)
        }
        return result
      },
      Effect.mapError(mapError("Failed to count messages by branches")),
    ),

    // Messages
    createMessage: Effect.fn("Storage.createMessage")(
      function* (message) {
        const { legacyPartsJson, partJsons, metadataJson } = yield* encodeStoredMessage(message)
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO messages (id, session_id, branch_id, kind, role, parts, created_at, turn_duration_ms, metadata) VALUES (${message.id}, ${message.sessionId}, ${message.branchId}, ${message._tag}, ${message.role}, ${legacyPartsJson}, ${message.createdAt.getTime()}, ${message.turnDurationMs ?? null}, ${metadataJson})`
            yield* insertContent(message.id, partJsons)
            yield* indexSearch(message)
            yield* sql`UPDATE sessions SET updated_at = ${message.createdAt.getTime()} WHERE id = ${message.sessionId}`
          }),
        )
        return message
      },
      Effect.mapError(mapError("Failed to create message")),
    ),

    createMessageIfAbsent: Effect.fn("Storage.createMessageIfAbsent")(
      function* (message) {
        const { legacyPartsJson, partJsons, metadataJson } = yield* encodeStoredMessage(message)
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT OR IGNORE INTO messages (id, session_id, branch_id, kind, role, parts, created_at, turn_duration_ms, metadata) VALUES (${message.id}, ${message.sessionId}, ${message.branchId}, ${message._tag}, ${message.role}, ${legacyPartsJson}, ${message.createdAt.getTime()}, ${message.turnDurationMs ?? null}, ${metadataJson})`
            const rows = yield* sql<{
              changed: number
            }>`SELECT changes() as changed`
            if ((rows[0]?.changed ?? 0) > 0) {
              yield* insertContent(message.id, partJsons)
              yield* indexSearch(message)
              yield* sql`UPDATE sessions SET updated_at = ${message.createdAt.getTime()} WHERE id = ${message.sessionId}`
            }
          }),
        )
        return message
      },
      Effect.mapError(mapError("Failed to create message if absent")),
    ),

    getMessage: Effect.fn("Storage.getMessage")(
      function* (id) {
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
          WHERE m.id = ${id}
          ORDER BY mc.ordinal ASC`
        const grouped = groupMessageChunkRows(rows)
        const entry = grouped[0]
        if (entry === undefined) return undefined
        return yield* decodeStoredMessage(entry.row, entry.partJsons)
      },
      Effect.mapError(mapError("Failed to get message")),
    ),

    listMessages: Effect.fn("Storage.listMessages")(
      function* (branchId) {
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
          WHERE m.branch_id = ${branchId}
          ORDER BY m.created_at ASC, m.id ASC, mc.ordinal ASC`
        return yield* Effect.forEach(groupMessageChunkRows(rows), ({ row, partJsons }) =>
          decodeStoredMessage(row, partJsons),
        )
      },
      Effect.mapError(mapError("Failed to list messages")),
    ),

    deleteMessages: Effect.fn("Storage.deleteMessages")(
      function* (branchId, afterMessageId) {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const messageIds: MessageId[] = []
            if (afterMessageId !== undefined) {
              const msgs = yield* sql<{
                id: MessageId
                created_at: number
              }>`SELECT id, created_at FROM messages WHERE id = ${afterMessageId}`
              const msg = msgs[0]
              if (msg !== undefined) {
                const rows = yield* sql<{
                  id: MessageId
                }>`SELECT id FROM messages WHERE branch_id = ${branchId} AND (created_at > ${msg.created_at} OR (created_at = ${msg.created_at} AND id > ${msg.id}))`
                messageIds.push(...rows.map((row) => row.id))
              }
            } else {
              const rows = yield* sql<{
                id: MessageId
              }>`SELECT id FROM messages WHERE branch_id = ${branchId}`
              messageIds.push(...rows.map((row) => row.id))
            }
            if (messageIds.length === 0) return
            yield* sql`DELETE FROM messages_fts WHERE message_id IN ${sql.in(messageIds)}`
            yield* sql`DELETE FROM message_chunks WHERE message_id IN ${sql.in(messageIds)}`
            yield* sql`DELETE FROM messages WHERE id IN ${sql.in(messageIds)}`
            yield* sql`DELETE FROM content_chunks WHERE id NOT IN (SELECT chunk_id FROM message_chunks)`
          }),
        )
      },
      Effect.mapError(mapError("Failed to delete messages")),
    ),

    updateMessageTurnDuration: (messageId, durationMs) =>
      sql`UPDATE messages SET turn_duration_ms = ${durationMs} WHERE id = ${messageId}`.pipe(
        Effect.asVoid,
        Effect.mapError(mapError("Failed to update message turn duration")),
        Effect.withSpan("Storage.updateMessageTurnDuration"),
      ),

    // Events
    appendEvent: Effect.fn("Storage.appendEvent")(
      function* (event, options) {
        const sessionId = getEventSessionId(event)
        if (sessionId === undefined) {
          return yield* new StorageError({ message: "Event missing sessionId" })
        }
        const branchId = getEventBranchId(event)
        const createdAt = yield* Clock.currentTimeMillis
        const traceId = options?.traceId
        const eventJson = yield* encodeEvent(event)
        const id = yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO events (session_id, branch_id, event_tag, event_json, created_at, trace_id) VALUES (${sessionId}, ${branchId ?? null}, ${event._tag}, ${eventJson}, ${createdAt}, ${traceId ?? null})`
            const rows = yield* sql<{ id: number }>`SELECT last_insert_rowid() as id`
            return rows[0]?.id ?? 0
          }),
        )
        return EventEnvelope.make({
          id: EventId.make(id),
          event,
          createdAt,
          ...(traceId !== undefined ? { traceId } : {}),
        })
      },
      Effect.mapError(mapError("Failed to append event")),
    ),
    listEvents: Effect.fn("Storage.listEvents")(
      function* ({ sessionId, branchId, afterId }) {
        const sinceId = afterId ?? 0
        const rows =
          branchId !== undefined
            ? yield* sql<EventRow>`SELECT id, event_json, created_at, trace_id FROM events WHERE session_id = ${sessionId} AND (branch_id = ${branchId} OR branch_id IS NULL) AND id > ${sinceId} ORDER BY id ASC`
            : yield* sql<EventRow>`SELECT id, event_json, created_at, trace_id FROM events WHERE session_id = ${sessionId} AND id > ${sinceId} ORDER BY id ASC`
        const envelopes: EventEnvelope[] = []
        for (const row of rows) {
          const decoded = yield* decodeEvent(row.event_json).pipe(Effect.option)
          if (decoded._tag === "Some") {
            envelopes.push(
              EventEnvelope.make({
                id: EventId.make(row.id),
                event: decoded.value,
                createdAt: row.created_at,
                ...(row.trace_id !== null ? { traceId: row.trace_id } : {}),
              }),
            )
          }
        }
        return envelopes
      },
      Effect.mapError(mapError("Failed to list events")),
    ),

    getLatestEventId: Effect.fn("Storage.getLatestEventId")(
      function* ({ sessionId, branchId }) {
        const rows =
          branchId !== undefined
            ? yield* sql<{
                id: number
              }>`SELECT id FROM events WHERE session_id = ${sessionId} AND (branch_id = ${branchId} OR branch_id IS NULL) ORDER BY id DESC LIMIT 1`
            : yield* sql<{
                id: number
              }>`SELECT id FROM events WHERE session_id = ${sessionId} ORDER BY id DESC LIMIT 1`
        return rows[0]?.id
      },
      Effect.mapError(mapError("Failed to get latest event id")),
    ),

    getLatestEventTag: Effect.fn("Storage.getLatestEventTag")(
      function* ({ sessionId, branchId, tags }) {
        if (tags.length === 0) return undefined
        const expandedTags = expandEventTags(tags)
        const rows = yield* sql<{
          event_tag: string
        }>`SELECT event_tag FROM events WHERE session_id = ${sessionId} AND (branch_id = ${branchId} OR branch_id IS NULL) AND event_tag IN ${sql.in(expandedTags)} ORDER BY id DESC LIMIT 1`
        const eventTag = rows[0]?.event_tag
        switch (eventTag) {
          case "SubagentSpawned":
            return "AgentRunSpawned"
          case "SubagentSucceeded":
            return "AgentRunSucceeded"
          case "SubagentFailed":
            return "AgentRunFailed"
          default:
            return eventTag
        }
      },
      Effect.mapError(mapError("Failed to get latest event tag")),
    ),

    getLatestEvent: Effect.fn("Storage.getLatestEvent")(
      function* ({ sessionId, branchId, tags }) {
        if (tags.length === 0) return undefined
        const expandedTags = expandEventTags(tags)
        const rows = yield* sql<{
          event_json: string
        }>`SELECT event_json FROM events WHERE session_id = ${sessionId} AND (branch_id = ${branchId} OR branch_id IS NULL) AND event_tag IN ${sql.in(expandedTags)} ORDER BY id DESC LIMIT 1`
        const row = rows[0]
        if (row === undefined) return undefined
        const decoded = yield* decodeEvent(row.event_json).pipe(Effect.option)
        return decoded._tag === "Some" ? decoded.value : undefined
      },
      Effect.mapError(mapError("Failed to get latest event")),
    ),

    // Session tree

    getChildSessions: Effect.fn("Storage.getChildSessions")(
      function* (parentSessionId) {
        const rows =
          yield* sql<SessionRow>`SELECT id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at FROM sessions WHERE parent_session_id = ${parentSessionId} ORDER BY created_at ASC`
        return rows.map(sessionFromRow)
      },
      Effect.mapError(mapError("Failed to get child sessions")),
    ),

    getSessionAncestors: Effect.fn("Storage.getSessionAncestors")(
      function* (sessionId) {
        const rows =
          yield* sql<SessionRow>`WITH RECURSIVE ancestors(id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at, depth) AS (
          SELECT id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at, 0
          FROM sessions WHERE id = ${sessionId}
          UNION ALL
          SELECT s.id, s.name, s.cwd, s.reasoning_level, s.active_branch_id, s.parent_session_id, s.parent_branch_id, s.created_at, s.updated_at, a.depth + 1
          FROM sessions s
          JOIN ancestors a ON s.id = a.parent_session_id
          WHERE a.depth < 20
        )
        SELECT id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at
        FROM ancestors
        ORDER BY depth ASC`
        return rows.map(sessionFromRow)
      },
      Effect.mapError(mapError("Failed to get session ancestors")),
    ),

    getSessionDetail: Effect.fn("Storage.getSessionDetail")(
      function* (sessionId) {
        const sessionRows =
          yield* sql<SessionRow>`SELECT id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at FROM sessions WHERE id = ${sessionId}`
        const sessionRow = sessionRows[0]
        if (sessionRow === undefined) {
          return yield* new StorageError({ message: `Session not found: ${sessionId}` })
        }
        const session = sessionFromRow(sessionRow)

        const branchRows =
          yield* sql<BranchRow>`SELECT id, session_id, parent_branch_id, parent_message_id, name, summary, created_at FROM branches WHERE session_id = ${sessionId} ORDER BY created_at ASC`
        const branches = branchRows.map(branchFromRow)

        if (branches.length === 0) {
          return { session, branches: [] }
        }

        const branchIds = branches.map((b) => b.id)
        const allMsgRows = yield* sql<MessageChunkRow>`SELECT
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
          WHERE m.branch_id IN ${sql.in(branchIds)}
          ORDER BY m.created_at ASC, m.id ASC, mc.ordinal ASC`

        const rowsByBranch = new Map<BranchId, Array<MessageChunkRow>>()
        for (const branch of branches) rowsByBranch.set(branch.id, [])
        for (const row of allMsgRows) {
          const bucket = rowsByBranch.get(row.branch_id as BranchId)
          if (bucket !== undefined) bucket.push(row)
        }

        const result = yield* Effect.forEach(branches, (branch) =>
          Effect.gen(function* () {
            const msgRows = rowsByBranch.get(branch.id) ?? []
            const messages = yield* Effect.forEach(
              groupMessageChunkRows(msgRows),
              ({ row, partJsons }) => decodeStoredMessage(row, partJsons),
            )
            return { branch, messages }
          }),
        )

        return { session, branches: result }
      },
      Effect.mapError(mapError("Failed to get session detail")),
    ),

    saveActorState: Effect.fn("Storage.saveActorState")(
      function* (params: { profileId: string; persistenceKey: string; stateJson: string }) {
        const updatedAt = yield* Clock.currentTimeMillis
        yield* sql`INSERT OR REPLACE INTO actor_persistence (profile_id, persistence_key, state_json, updated_at) VALUES (${params.profileId}, ${params.persistenceKey}, ${params.stateJson}, ${updatedAt})`
      },
      Effect.mapError(mapError("Failed to save actor state")),
    ),

    loadActorState: Effect.fn("Storage.loadActorState")(
      function* (params: { profileId: string; persistenceKey: string }) {
        const rows = yield* sql<{
          state_json: string
          updated_at: number
        }>`SELECT state_json, updated_at FROM actor_persistence WHERE profile_id = ${params.profileId} AND persistence_key = ${params.persistenceKey}`
        const row = rows[0]
        if (row === undefined) return undefined
        return { stateJson: row.state_json, updatedAt: row.updated_at }
      },
      Effect.mapError(mapError("Failed to load actor state")),
    ),

    listActorStatesForProfile: Effect.fn("Storage.listActorStatesForProfile")(
      function* (profileId: string) {
        const rows = yield* sql<{
          profile_id: string
          persistence_key: string
          state_json: string
          updated_at: number
        }>`SELECT profile_id, persistence_key, state_json, updated_at FROM actor_persistence WHERE profile_id = ${profileId}`
        return rows.map((r) => ({
          profileId: r.profile_id,
          persistenceKey: r.persistence_key,
          stateJson: r.state_json,
          updatedAt: r.updated_at,
        }))
      },
      Effect.mapError(mapError("Failed to list actor states")),
    ),

    deleteActorStatesForProfile: Effect.fn("Storage.deleteActorStatesForProfile")(
      function* (profileId: string) {
        yield* sql`DELETE FROM actor_persistence WHERE profile_id = ${profileId}`
      },
      Effect.mapError(mapError("Failed to delete actor states")),
    ),
  } satisfies StorageService
})

const mapStartupError = (error: unknown): StorageError =>
  Schema.is(StorageError)(error)
    ? error
    : new StorageError({ message: "Failed to initialize SQLite storage", cause: error })

const makeStorage = Effect.gen(function* () {
  yield* initSchema.pipe(Effect.mapError(mapStartupError))
  return yield* makeStorageImpl
})

const memorySqliteClientLayer: Layer.Layer<SqliteClient.SqliteClient | SqlClient.SqlClient, never> =
  Layer.orDie(SqliteClient.layer({ filename: ":memory:" }))

/**
 * Build focused sub-Tag layers from a layer that provides Storage.
 * Called at composition roots (dependencies.ts, test layers) to wire
 * sub-Tags alongside the existing Storage Tag. NOT wired inside Storage
 * class methods to prevent ephemeral compositor leakage.
 */
/** Build focused sub-Tag layers from a StorageService value (no extra scope). */
const subTagLayersFromService = (
  s: StorageService,
): Layer.Layer<
  | SessionStorage
  | BranchStorage
  | MessageStorage
  | EventStorage
  | RelationshipStorage
  | ActorPersistenceStorage
> =>
  Layer.mergeAll(
    SessionStorage.fromStorage(s),
    BranchStorage.fromStorage(s),
    MessageStorage.fromStorage(s),
    EventStorage.fromStorage(s),
    RelationshipStorage.fromStorage(s),
    ActorPersistenceStorage.fromStorage(s),
  )

/**
 * Build focused sub-Tag layers from a layer that provides Storage.
 * Called at composition roots (dependencies.ts, test layers) to wire
 * sub-Tags alongside the existing Storage Tag.
 */
export const subTagLayers = <E, R>(
  base: Layer.Layer<Storage, E, R>,
): Layer.Layer<
  | SessionStorage
  | BranchStorage
  | MessageStorage
  | EventStorage
  | RelationshipStorage
  | ActorPersistenceStorage,
  E,
  R
> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const s = yield* Storage
      return subTagLayersFromService(s)
    }).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off — layer composition helper, not a runtime call
      Effect.provide(base),
    ),
  )

/**
 * Layer that derives sub-Tags from Storage already in context.
 * Use with `Layer.provideMerge` when Storage is already provided — this
 * avoids double-instantiating the base layer (no `base` argument needed).
 */
const subTagsFromContext: Layer.Layer<
  | SessionStorage
  | BranchStorage
  | MessageStorage
  | EventStorage
  | RelationshipStorage
  | ActorPersistenceStorage,
  never,
  Storage
> = Layer.unwrap(
  Effect.gen(function* () {
    const s = yield* Storage
    return subTagLayersFromService(s)
  }),
)

export class Storage extends Context.Service<Storage, StorageService>()(
  "@gent/core/src/storage/sqlite-storage/Storage",
) {
  static Live = (
    dbPath: string,
  ): Layer.Layer<
    Storage,
    StorageError | PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
  > =>
    Layer.effect(
      Storage,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = path.dirname(dbPath)
        yield* fs.makeDirectory(dir, { recursive: true })
        return yield* makeStorage
      }),
    ).pipe(Layer.provide(Layer.orDie(SqliteClient.layer({ filename: dbPath }))))
  // Load-bearing: `deleteSession`'s atomic SELECT+DELETE relies on @effect/sql-sqlite-bun's
  // single-connection + Semaphore(1) serialization. If this layer is ever swapped for a
  // pooled/multi-connection driver, the cascade tx must switch to BEGIN IMMEDIATE (or an
  // equivalent write-lock) to preserve the invariant that no child row is committed between
  // the recursive SELECT and the DELETE.

  /** Live layer that also exposes SqlClient and focused storage services */
  static LiveWithSql = (
    dbPath: string,
  ): Layer.Layer<
    | Storage
    | SqlClient.SqlClient
    | CheckpointStorage
    | InteractionStorage
    | SearchStorage
    | SessionStorage
    | BranchStorage
    | MessageStorage
    | EventStorage
    | RelationshipStorage
    | ActorPersistenceStorage,
    StorageError | PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
  > => {
    const base = Layer.effect(
      Storage,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = path.dirname(dbPath)
        yield* fs.makeDirectory(dir, { recursive: true })
        return yield* makeStorage
      }),
    ).pipe(Layer.provideMerge(Layer.orDie(SqliteClient.layer({ filename: dbPath }))))
    const interactionStorage = Layer.provide(InteractionStorage.Live, base)
    return Layer.mergeAll(
      base,
      Layer.provide(subTagsFromContext, base),
      Layer.provide(CheckpointStorage.Live, base),
      interactionStorage,
      Layer.provide(InteractionPendingReader.Live, interactionStorage),
      Layer.provide(SearchStorage.Live, base),
    )
  }

  static Memory = (): Layer.Layer<Storage, StorageError> =>
    Layer.effect(Storage, makeStorage).pipe(Layer.provide(memorySqliteClientLayer))

  /** Memory layer that also exposes SqlClient and focused storage services */
  static MemoryWithSql = (): Layer.Layer<
    | Storage
    | SqlClient.SqlClient
    | CheckpointStorage
    | InteractionStorage
    | SearchStorage
    | SessionStorage
    | BranchStorage
    | MessageStorage
    | EventStorage
    | RelationshipStorage
    | ActorPersistenceStorage,
    StorageError
  > => {
    const base = Layer.effect(Storage, makeStorage).pipe(
      Layer.provideMerge(memorySqliteClientLayer),
    )
    const interactionStorage = Layer.provide(InteractionStorage.Live, base)
    return Layer.mergeAll(
      base,
      Layer.provide(subTagsFromContext, base),
      Layer.provide(CheckpointStorage.Live, base),
      interactionStorage,
      Layer.provide(InteractionPendingReader.Live, interactionStorage),
      Layer.provide(SearchStorage.Live, base),
    )
  }

  static Test = (): Layer.Layer<Storage, StorageError> => Storage.Memory()

  /** Test layer that also exposes SqlClient and focused storage services */
  static TestWithSql = (): Layer.Layer<
    | Storage
    | SqlClient.SqlClient
    | CheckpointStorage
    | InteractionStorage
    | SearchStorage
    | SessionStorage
    | BranchStorage
    | MessageStorage
    | EventStorage
    | RelationshipStorage
    | ActorPersistenceStorage,
    StorageError
  > => Storage.MemoryWithSql()
}
