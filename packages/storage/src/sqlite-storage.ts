import type { PlatformError } from "effect"
import { ServiceMap, Effect, Layer, Schema, FileSystem, Path } from "effect"
import {
  Message,
  Session,
  Branch,
  CompactionCheckpoint,
  PlanCheckpoint,
  MessagePart,
  TodoItem,
  AgentEvent,
  EventEnvelope,
  getEventSessionId,
  type Checkpoint,
  type SessionId,
  type BranchId,
  type MessageId,
} from "@gent/core"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"

// Schema decoders - Effect-based (no sync throws)
const MessagePartsJson = Schema.fromJsonString(Schema.Array(MessagePart))
const decodeMessageParts = Schema.decodeUnknownEffect(MessagePartsJson)
const encodeMessageParts = Schema.encodeEffect(MessagePartsJson)
const decodeTodoItem = Schema.decodeUnknownEffect(TodoItem)
const EventJson = Schema.fromJsonString(AgentEvent)
const decodeEvent = Schema.decodeUnknownEffect(EventJson)
const encodeEvent = Schema.encodeEffect(EventJson)
// Storage Error

export class StorageError extends Schema.TaggedErrorClass<StorageError>()("StorageError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

// Storage Service Interface

export interface StorageService {
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
  readonly deleteSession: (id: SessionId) => Effect.Effect<void, StorageError>

  // Branches
  readonly createBranch: (branch: Branch) => Effect.Effect<Branch, StorageError>
  readonly getBranch: (id: BranchId) => Effect.Effect<Branch | undefined, StorageError>
  readonly listBranches: (
    sessionId: SessionId,
  ) => Effect.Effect<ReadonlyArray<Branch>, StorageError>
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
  readonly appendEvent: (event: AgentEvent) => Effect.Effect<EventEnvelope, StorageError>
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

  // Checkpoints
  readonly createCheckpoint: (checkpoint: Checkpoint) => Effect.Effect<Checkpoint, StorageError>
  readonly getLatestCheckpoint: (
    branchId: BranchId,
  ) => Effect.Effect<Checkpoint | undefined, StorageError>
  readonly listMessagesAfter: (
    branchId: BranchId,
    afterMessageId: MessageId,
  ) => Effect.Effect<ReadonlyArray<Message>, StorageError>
  readonly listMessagesSince: (
    branchId: BranchId,
    sinceTimestamp: Date,
  ) => Effect.Effect<ReadonlyArray<Message>, StorageError>

  // Todos
  readonly listTodos: (branchId: BranchId) => Effect.Effect<ReadonlyArray<TodoItem>, StorageError>
  readonly replaceTodos: (
    branchId: BranchId,
    todos: ReadonlyArray<TodoItem>,
  ) => Effect.Effect<void, StorageError>
}

const mapError = (message: string) => (e: unknown) => new StorageError({ message, cause: e })

// Row types
interface SessionRow {
  id: SessionId
  name: string | null
  cwd: string | null
  bypass: number | null
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
}

interface EventRow {
  id: number
  event_json: string
  created_at: number
}

interface CheckpointRow {
  id: string
  branch_id: BranchId
  _tag: string
  summary: string | null
  plan_path: string | null
  first_kept_message_id: MessageId | null
  message_count: number
  token_count: number
  created_at: number
}

const sessionFromRow = (row: SessionRow) =>
  new Session({
    id: row.id,
    name: row.name ?? undefined,
    cwd: row.cwd ?? undefined,
    bypass: typeof row.bypass === "number" ? row.bypass === 1 : undefined,
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

const messageFromRow = (row: MessageRow, parts: ReadonlyArray<MessagePart>) =>
  new Message({
    id: row.id,
    sessionId: row.session_id,
    branchId: row.branch_id,
    kind: row.kind ?? undefined,
    role: row.role,
    parts,
    createdAt: new Date(row.created_at),
    turnDurationMs: row.turn_duration_ms ?? undefined,
  })

const initSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT,
      cwd TEXT,
      bypass INTEGER,
      parent_session_id TEXT,
      parent_branch_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  // Migrations
  yield* sql.unsafe(`ALTER TABLE sessions ADD COLUMN cwd TEXT`).pipe(Effect.ignoreCause)
  yield* sql.unsafe(`ALTER TABLE sessions ADD COLUMN bypass INTEGER`).pipe(Effect.ignoreCause)
  yield* sql.unsafe(`ALTER TABLE sessions ADD COLUMN parent_session_id TEXT`).pipe(Effect.ignoreCause)
  yield* sql.unsafe(`ALTER TABLE sessions ADD COLUMN parent_branch_id TEXT`).pipe(Effect.ignoreCause)

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS branches (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      parent_branch_id TEXT,
      parent_message_id TEXT,
      name TEXT,
      summary TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
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
      FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE
    )
  `)

  yield* sql.unsafe(`ALTER TABLE messages ADD COLUMN kind TEXT`).pipe(Effect.ignoreCause)

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      branch_id TEXT,
      event_tag TEXT NOT NULL,
      event_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `)

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      _tag TEXT NOT NULL,
      summary TEXT,
      plan_path TEXT,
      first_kept_message_id TEXT,
      message_count INTEGER NOT NULL,
      token_count INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE
    )
  `)

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE
    )
  `)

  yield* sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_messages_branch ON messages(branch_id)`)
  yield* sql.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_messages_branch_created ON messages(branch_id, created_at, id)`,
  )
  yield* sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, id)`)
  yield* sql.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_events_session_branch ON events(session_id, branch_id, id)`,
  )
  yield* sql.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_events_session_tag ON events(session_id, event_tag, id)`,
  )
  yield* sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_branches_session ON branches(session_id)`)
  yield* sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_checkpoints_branch ON checkpoints(branch_id)`)
  yield* sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_todos_branch ON todos(branch_id)`)
})

const makeStorage = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* Effect.orDie(initSchema)

  return {
    // Sessions
    createSession: (session) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO sessions (id, name, cwd, bypass, parent_session_id, parent_branch_id, created_at, updated_at) VALUES (${session.id}, ${session.name ?? null}, ${session.cwd ?? null}, ${session.bypass === undefined ? null : session.bypass ? 1 : 0}, ${session.parentSessionId ?? null}, ${session.parentBranchId ?? null}, ${session.createdAt.getTime()}, ${session.updatedAt.getTime()})`
        return session
      }).pipe(
        Effect.mapError(mapError("Failed to create session")),
        Effect.withSpan("Storage.createSession"),
      ),

    getSession: (id) =>
      Effect.gen(function* () {
        const rows =
          yield* sql<SessionRow>`SELECT id, name, cwd, bypass, parent_session_id, parent_branch_id, created_at, updated_at FROM sessions WHERE id = ${id}`
        const row = rows[0]
        if (row === undefined) return undefined
        return sessionFromRow(row)
      }).pipe(
        Effect.mapError(mapError("Failed to get session")),
        Effect.withSpan("Storage.getSession"),
      ),

    getLastSessionByCwd: (cwd) =>
      Effect.gen(function* () {
        const rows =
          yield* sql<SessionRow>`SELECT id, name, cwd, bypass, parent_session_id, parent_branch_id, created_at, updated_at FROM sessions WHERE cwd = ${cwd} ORDER BY updated_at DESC LIMIT 1`
        const row = rows[0]
        if (row === undefined) return undefined
        return sessionFromRow(row)
      }).pipe(
        Effect.mapError(mapError("Failed to get last session by cwd")),
        Effect.withSpan("Storage.getLastSessionByCwd"),
      ),

    listSessions: () =>
      Effect.gen(function* () {
        const rows =
          yield* sql<SessionRow>`SELECT id, name, cwd, bypass, parent_session_id, parent_branch_id, created_at, updated_at FROM sessions ORDER BY updated_at DESC`
        return rows.map(sessionFromRow)
      }).pipe(
        Effect.mapError(mapError("Failed to list sessions")),
        Effect.withSpan("Storage.listSessions"),
      ),

    listFirstBranches: () =>
      Effect.gen(function* () {
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
      }).pipe(
        Effect.mapError(mapError("Failed to list first branches")),
        Effect.withSpan("Storage.listFirstBranches"),
      ),

    updateSession: (session) =>
      Effect.gen(function* () {
        yield* sql`UPDATE sessions SET name = ${session.name ?? null}, bypass = ${session.bypass === undefined ? null : session.bypass ? 1 : 0}, updated_at = ${session.updatedAt.getTime()} WHERE id = ${session.id}`
        return session
      }).pipe(
        Effect.mapError(mapError("Failed to update session")),
        Effect.withSpan("Storage.updateSession"),
      ),

    deleteSession: (id) =>
      sql`DELETE FROM sessions WHERE id = ${id}`.pipe(
        Effect.asVoid,
        Effect.mapError(mapError("Failed to delete session")),
        Effect.withSpan("Storage.deleteSession"),
      ),

    // Branches
    createBranch: (branch) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO branches (id, session_id, parent_branch_id, parent_message_id, name, summary, created_at) VALUES (${branch.id}, ${branch.sessionId}, ${branch.parentBranchId ?? null}, ${branch.parentMessageId ?? null}, ${branch.name ?? null}, ${branch.summary ?? null}, ${branch.createdAt.getTime()})`
        return branch
      }).pipe(
        Effect.mapError(mapError("Failed to create branch")),
        Effect.withSpan("Storage.createBranch"),
      ),

    getBranch: (id) =>
      Effect.gen(function* () {
        const rows =
          yield* sql<BranchRow>`SELECT id, session_id, parent_branch_id, parent_message_id, name, summary, created_at FROM branches WHERE id = ${id}`
        const row = rows[0]
        if (row === undefined) return undefined
        return branchFromRow(row)
      }).pipe(
        Effect.mapError(mapError("Failed to get branch")),
        Effect.withSpan("Storage.getBranch"),
      ),

    listBranches: (sessionId) =>
      Effect.gen(function* () {
        const rows =
          yield* sql<BranchRow>`SELECT id, session_id, parent_branch_id, parent_message_id, name, summary, created_at FROM branches WHERE session_id = ${sessionId} ORDER BY created_at ASC`
        return rows.map(branchFromRow)
      }).pipe(
        Effect.mapError(mapError("Failed to list branches")),
        Effect.withSpan("Storage.listBranches"),
      ),

    updateBranchSummary: (branchId, summary) =>
      sql`UPDATE branches SET summary = ${summary} WHERE id = ${branchId}`.pipe(
        Effect.asVoid,
        Effect.mapError(mapError("Failed to update branch summary")),
        Effect.withSpan("Storage.updateBranchSummary"),
      ),

    countMessages: (branchId) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          count: number
        }>`SELECT COUNT(*) as count FROM messages WHERE branch_id = ${branchId}`
        return rows[0]?.count ?? 0
      }).pipe(
        Effect.mapError(mapError("Failed to count messages")),
        Effect.withSpan("Storage.countMessages"),
      ),

    countMessagesByBranches: (branchIds) =>
      Effect.gen(function* () {
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
      }).pipe(
        Effect.mapError(mapError("Failed to count messages by branches")),
        Effect.withSpan("Storage.countMessagesByBranches"),
      ),

    // Messages
    createMessage: (message) =>
      Effect.gen(function* () {
        const partsJson = yield* encodeMessageParts([...message.parts])
        yield* sql`INSERT INTO messages (id, session_id, branch_id, kind, role, parts, created_at, turn_duration_ms) VALUES (${message.id}, ${message.sessionId}, ${message.branchId}, ${message.kind ?? null}, ${message.role}, ${partsJson}, ${message.createdAt.getTime()}, ${message.turnDurationMs ?? null})`
        yield* sql`UPDATE sessions SET updated_at = ${message.createdAt.getTime()} WHERE id = ${message.sessionId}`
        return message
      }).pipe(
        Effect.mapError(mapError("Failed to create message")),
        Effect.withSpan("Storage.createMessage"),
      ),

    getMessage: (id) =>
      Effect.gen(function* () {
        const rows =
          yield* sql<MessageRow>`SELECT id, session_id, branch_id, kind, role, parts, created_at, turn_duration_ms FROM messages WHERE id = ${id}`
        const row = rows[0]
        if (row === undefined) return undefined
        const parts = yield* decodeMessageParts(row.parts)
        return messageFromRow(row, parts)
      }).pipe(
        Effect.mapError(mapError("Failed to get message")),
        Effect.withSpan("Storage.getMessage"),
      ),

    listMessages: (branchId) =>
      Effect.gen(function* () {
        const rows =
          yield* sql<MessageRow>`SELECT id, session_id, branch_id, kind, role, parts, created_at, turn_duration_ms FROM messages WHERE branch_id = ${branchId} ORDER BY created_at ASC, id ASC`
        return yield* Effect.forEach(rows, (row) =>
          Effect.map(decodeMessageParts(row.parts), (parts) => messageFromRow(row, parts)),
        )
      }).pipe(
        Effect.mapError(mapError("Failed to list messages")),
        Effect.withSpan("Storage.listMessages"),
      ),

    deleteMessages: (branchId, afterMessageId) =>
      Effect.gen(function* () {
        if (afterMessageId !== undefined) {
          const msgs = yield* sql<{
            id: string
            created_at: number
          }>`SELECT id, created_at FROM messages WHERE id = ${afterMessageId}`
          const msg = msgs[0]
          if (msg !== undefined) {
            yield* sql`DELETE FROM messages WHERE branch_id = ${branchId} AND (created_at > ${msg.created_at} OR (created_at = ${msg.created_at} AND id > ${msg.id}))`
          }
        } else {
          yield* sql`DELETE FROM messages WHERE branch_id = ${branchId}`
        }
      }).pipe(
        Effect.mapError(mapError("Failed to delete messages")),
        Effect.withSpan("Storage.deleteMessages"),
      ),

    updateMessageTurnDuration: (messageId, durationMs) =>
      sql`UPDATE messages SET turn_duration_ms = ${durationMs} WHERE id = ${messageId}`.pipe(
        Effect.asVoid,
        Effect.mapError(mapError("Failed to update message turn duration")),
        Effect.withSpan("Storage.updateMessageTurnDuration"),
      ),

    // Events
    appendEvent: (event) =>
      Effect.gen(function* () {
        const sessionId = getEventSessionId(event)
        if (sessionId === undefined) {
          return yield* new StorageError({ message: "Event missing sessionId" })
        }
        const branchId = "branchId" in event ? (event.branchId as string | undefined) : undefined
        const createdAt = Date.now()
        const eventJson = yield* encodeEvent(event)
        yield* sql`INSERT INTO events (session_id, branch_id, event_tag, event_json, created_at) VALUES (${sessionId}, ${branchId ?? null}, ${event._tag}, ${eventJson}, ${createdAt})`
        const rows = yield* sql<{ id: number }>`SELECT last_insert_rowid() as id`
        const id = rows[0]?.id ?? 0
        return new EventEnvelope({
          id: id as EventEnvelope["id"],
          event,
          createdAt,
        })
      }).pipe(
        Effect.mapError(mapError("Failed to append event")),
        Effect.withSpan("Storage.appendEvent"),
      ),

    listEvents: ({ sessionId, branchId, afterId }) =>
      Effect.gen(function* () {
        const sinceId = afterId ?? 0
        const rows =
          branchId !== undefined
            ? yield* sql<EventRow>`SELECT id, event_json, created_at FROM events WHERE session_id = ${sessionId} AND (branch_id = ${branchId} OR branch_id IS NULL) AND id > ${sinceId} ORDER BY id ASC`
            : yield* sql<EventRow>`SELECT id, event_json, created_at FROM events WHERE session_id = ${sessionId} AND id > ${sinceId} ORDER BY id ASC`
        return yield* Effect.forEach(rows, (row) =>
          Effect.map(
            decodeEvent(row.event_json),
            (event) =>
              new EventEnvelope({
                id: row.id as EventEnvelope["id"],
                event,
                createdAt: row.created_at,
              }),
          ),
        )
      }).pipe(
        Effect.mapError(mapError("Failed to list events")),
        Effect.withSpan("Storage.listEvents"),
      ),

    getLatestEventId: ({ sessionId, branchId }) =>
      Effect.gen(function* () {
        const rows =
          branchId !== undefined
            ? yield* sql<{
                id: number
              }>`SELECT id FROM events WHERE session_id = ${sessionId} AND (branch_id = ${branchId} OR branch_id IS NULL) ORDER BY id DESC LIMIT 1`
            : yield* sql<{
                id: number
              }>`SELECT id FROM events WHERE session_id = ${sessionId} ORDER BY id DESC LIMIT 1`
        return rows[0]?.id
      }).pipe(
        Effect.mapError(mapError("Failed to get latest event id")),
        Effect.withSpan("Storage.getLatestEventId"),
      ),

    getLatestEventTag: ({ sessionId, branchId, tags }) =>
      Effect.gen(function* () {
        if (tags.length === 0) return undefined
        const rows = yield* sql<{
          event_tag: string
        }>`SELECT event_tag FROM events WHERE session_id = ${sessionId} AND branch_id = ${branchId} AND event_tag IN ${sql.in(tags)} ORDER BY id DESC LIMIT 1`
        return rows[0]?.event_tag
      }).pipe(
        Effect.mapError(mapError("Failed to get latest event tag")),
        Effect.withSpan("Storage.getLatestEventTag"),
      ),

    getLatestEvent: ({ sessionId, branchId, tags }) =>
      Effect.gen(function* () {
        if (tags.length === 0) return undefined
        const rows = yield* sql<{
          event_json: string
        }>`SELECT event_json FROM events WHERE session_id = ${sessionId} AND branch_id = ${branchId} AND event_tag IN ${sql.in(tags)} ORDER BY id DESC LIMIT 1`
        const row = rows[0]
        if (row === undefined) return undefined
        return yield* decodeEvent(row.event_json)
      }).pipe(
        Effect.mapError(mapError("Failed to get latest event")),
        Effect.withSpan("Storage.getLatestEvent"),
      ),

    // Checkpoints
    createCheckpoint: (checkpoint) =>
      Effect.gen(function* () {
        if (checkpoint._tag === "CompactionCheckpoint") {
          yield* sql`INSERT INTO checkpoints (id, branch_id, _tag, summary, first_kept_message_id, message_count, token_count, created_at) VALUES (${checkpoint.id}, ${checkpoint.branchId}, ${checkpoint._tag}, ${checkpoint.summary}, ${checkpoint.firstKeptMessageId}, ${checkpoint.messageCount}, ${checkpoint.tokenCount}, ${checkpoint.createdAt.getTime()})`
        } else {
          yield* sql`INSERT INTO checkpoints (id, branch_id, _tag, plan_path, message_count, token_count, created_at) VALUES (${checkpoint.id}, ${checkpoint.branchId}, ${checkpoint._tag}, ${checkpoint.planPath}, ${checkpoint.messageCount}, ${checkpoint.tokenCount}, ${checkpoint.createdAt.getTime()})`
        }
        return checkpoint
      }).pipe(
        Effect.mapError(mapError("Failed to create checkpoint")),
        Effect.withSpan("Storage.createCheckpoint"),
      ),

    getLatestCheckpoint: (branchId) =>
      Effect.gen(function* () {
        const rows =
          yield* sql<CheckpointRow>`SELECT id, branch_id, _tag, summary, plan_path, first_kept_message_id, message_count, token_count, created_at FROM checkpoints WHERE branch_id = ${branchId} ORDER BY created_at DESC LIMIT 1`
        const row = rows[0]
        if (row === undefined) return undefined
        if (row._tag === "CompactionCheckpoint") {
          if (row.summary === null || row.first_kept_message_id === null) {
            return yield* new StorageError({
              message: "Corrupt CompactionCheckpoint: missing summary or firstKeptMessageId",
            })
          }
          return new CompactionCheckpoint({
            id: row.id,
            branchId: row.branch_id,
            summary: row.summary,
            firstKeptMessageId: row.first_kept_message_id,
            messageCount: row.message_count,
            tokenCount: row.token_count,
            createdAt: new Date(row.created_at),
          })
        } else {
          if (row.plan_path === null) {
            return yield* new StorageError({
              message: "Corrupt PlanCheckpoint: missing planPath",
            })
          }
          return new PlanCheckpoint({
            id: row.id,
            branchId: row.branch_id,
            planPath: row.plan_path,
            messageCount: row.message_count,
            tokenCount: row.token_count,
            createdAt: new Date(row.created_at),
          })
        }
      }).pipe(
        Effect.mapError(mapError("Failed to get latest checkpoint")),
        Effect.withSpan("Storage.getLatestCheckpoint"),
      ),

    listMessagesAfter: (branchId, afterMessageId) =>
      Effect.gen(function* () {
        const afterMsgs = yield* sql<{
          id: string
          created_at: number
        }>`SELECT id, created_at FROM messages WHERE id = ${afterMessageId}`
        const afterMsg = afterMsgs[0]
        if (afterMsg === undefined) return []
        const rows =
          yield* sql<MessageRow>`SELECT id, session_id, branch_id, kind, role, parts, created_at, turn_duration_ms FROM messages WHERE branch_id = ${branchId} AND (created_at > ${afterMsg.created_at} OR (created_at = ${afterMsg.created_at} AND id > ${afterMsg.id})) ORDER BY created_at ASC, id ASC`
        return yield* Effect.forEach(rows, (row) =>
          Effect.map(decodeMessageParts(row.parts), (parts) => messageFromRow(row, parts)),
        )
      }).pipe(
        Effect.mapError(mapError("Failed to list messages after")),
        Effect.withSpan("Storage.listMessagesAfter"),
      ),

    listMessagesSince: (branchId, sinceTimestamp) =>
      Effect.gen(function* () {
        const rows =
          yield* sql<MessageRow>`SELECT id, session_id, branch_id, kind, role, parts, created_at, turn_duration_ms FROM messages WHERE branch_id = ${branchId} AND created_at > ${sinceTimestamp.getTime()} ORDER BY created_at ASC, id ASC`
        return yield* Effect.forEach(rows, (row) =>
          Effect.map(decodeMessageParts(row.parts), (parts) => messageFromRow(row, parts)),
        )
      }).pipe(
        Effect.mapError(mapError("Failed to list messages since")),
        Effect.withSpan("Storage.listMessagesSince"),
      ),

    // Todos
    listTodos: (branchId) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          id: string
          content: string
          status: string
          priority: string | null
          created_at: number
          updated_at: number
        }>`SELECT id, content, status, priority, created_at, updated_at FROM todos WHERE branch_id = ${branchId} ORDER BY created_at ASC`
        return yield* Effect.forEach(rows, (row) =>
          decodeTodoItem({
            id: row.id,
            content: row.content,
            status: row.status,
            priority: row.priority ?? undefined,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          }),
        )
      }).pipe(
        Effect.mapError(mapError("Failed to list todos")),
        Effect.withSpan("Storage.listTodos"),
      ),

    replaceTodos: (branchId, todos) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM todos WHERE branch_id = ${branchId}`
            for (const todo of todos) {
              yield* sql`INSERT INTO todos (id, branch_id, content, status, priority, created_at, updated_at) VALUES (${todo.id}, ${branchId}, ${todo.content}, ${todo.status}, ${todo.priority ?? null}, ${todo.createdAt.getTime()}, ${todo.updatedAt.getTime()})`
            }
          }),
        )
        .pipe(
          Effect.mapError(mapError("Failed to replace todos")),
          Effect.withSpan("Storage.replaceTodos"),
        ),
  } satisfies StorageService
})

export class Storage extends ServiceMap.Service<Storage, StorageService>()(
  "@gent/storage/src/sqlite-storage/Storage",
) {
  static Live = (
    dbPath: string,
  ): Layer.Layer<Storage, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
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

  static Test = (): Layer.Layer<Storage> =>
    Layer.effect(Storage, makeStorage).pipe(
      Layer.provide(Layer.orDie(SqliteClient.layer({ filename: ":memory:" }))),
    )
}
