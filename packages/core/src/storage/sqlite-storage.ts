import type { PlatformError } from "effect"
import { Clock, ServiceMap, Effect, Layer, Schema, FileSystem, Path } from "effect"
import { Message, Session, Branch, MessagePart } from "../domain/message.js"
import { AgentEvent, EventEnvelope, getEventSessionId } from "../domain/event.js"
import type { SessionId, BranchId, MessageId } from "../domain/ids.js"
import type { ReasoningEffort } from "../domain/agent.js"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"

// Schema decoders - Effect-based (no sync throws)
const MessagePartsJson = Schema.fromJsonString(Schema.Array(MessagePart))
const decodeMessageParts = Schema.decodeUnknownEffect(MessagePartsJson)
const encodeMessageParts = Schema.encodeEffect(MessagePartsJson)
const EventJson = Schema.fromJsonString(AgentEvent)
const decodeEvent = Schema.decodeUnknownEffect(EventJson)
const encodeEvent = Schema.encodeEffect(EventJson)
const MetadataJson = Schema.fromJsonString(Schema.Unknown)
const encodeMetadataJson = Schema.encodeSync(MetadataJson)
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

  // Extension state persistence
  readonly saveExtensionState: (params: {
    sessionId: SessionId
    extensionId: string
    stateJson: string
    version: number
  }) => Effect.Effect<void, StorageError>
  readonly loadExtensionState: (params: {
    sessionId: SessionId
    extensionId: string
  }) => Effect.Effect<{ stateJson: string; version: number } | undefined, StorageError>
}

const mapError = (message: string) => (e: unknown) => new StorageError({ message, cause: e })

// Row types
interface SessionRow {
  id: SessionId
  name: string | null
  cwd: string | null
  bypass: number | null
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

interface EventRow {
  id: number
  event_json: string
  created_at: number
  trace_id: string | null
}

const VALID_REASONING = new Set(["none", "minimal", "low", "medium", "high", "xhigh"])

const sessionFromRow = (row: SessionRow) =>
  new Session({
    id: row.id,
    name: row.name ?? undefined,
    cwd: row.cwd ?? undefined,
    bypass: typeof row.bypass === "number" ? row.bypass === 1 : undefined,
    reasoningLevel:
      row.reasoning_level !== null && VALID_REASONING.has(row.reasoning_level)
        ? (row.reasoning_level as ReasoningEffort)
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
    metadata:
      row.metadata !== null ? (safeJsonParse(row.metadata) as Message["metadata"]) : undefined,
  })

const safeJsonParse = (s: string): unknown => {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

const initSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT,
      cwd TEXT,
      bypass INTEGER,
      reasoning_level TEXT,
      parent_session_id TEXT,
      parent_branch_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  // Migrations
  yield* sql.unsafe(`ALTER TABLE sessions ADD COLUMN cwd TEXT`).pipe(Effect.ignoreCause)
  yield* sql.unsafe(`ALTER TABLE sessions ADD COLUMN bypass INTEGER`).pipe(Effect.ignoreCause)
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
  yield* sql.unsafe(`ALTER TABLE messages ADD COLUMN metadata TEXT`).pipe(Effect.ignoreCause)

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

  yield* sql.unsafe(`ALTER TABLE events ADD COLUMN trace_id TEXT`).pipe(Effect.ignoreCause)

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
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
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
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
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

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      owner TEXT,
      agent_type TEXT,
      prompt TEXT,
      cwd TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `)

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS task_deps (
      task_id TEXT NOT NULL,
      blocked_by_id TEXT NOT NULL,
      PRIMARY KEY (task_id, blocked_by_id),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (blocked_by_id) REFERENCES tasks(id) ON DELETE CASCADE
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
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `)

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS extension_state (
      session_id TEXT NOT NULL,
      extension_id TEXT NOT NULL,
      state_json TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, extension_id),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
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
  yield* sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_todos_branch ON todos(branch_id)`)
  yield* sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id)`)
  yield* sql.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_tasks_session_branch ON tasks(session_id, branch_id)`,
  )
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

  yield* sql
    .unsafe(
      `CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(content, message_id, session_id, branch_id, role) VALUES (new.parts, new.id, new.session_id, new.branch_id, new.role); END`,
    )
    .pipe(Effect.ignoreCause)

  // Backfill FTS from existing messages
  yield* sql
    .unsafe(
      `INSERT INTO messages_fts(content, message_id, session_id, branch_id, role) SELECT parts, id, session_id, branch_id, role FROM messages WHERE id NOT IN (SELECT message_id FROM messages_fts)`,
    )
    .pipe(Effect.ignoreCause)
})

const makeStorage = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* Effect.orDie(initSchema)

  return {
    // Sessions
    createSession: Effect.fn("Storage.createSession")(
      function* (session) {
        let bypass: 0 | 1 | null = null
        if (session.bypass !== undefined) bypass = session.bypass ? 1 : 0
        yield* sql`INSERT INTO sessions (id, name, cwd, bypass, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at) VALUES (${session.id}, ${session.name ?? null}, ${session.cwd ?? null}, ${bypass}, ${session.reasoningLevel ?? null}, ${session.activeBranchId ?? null}, ${session.parentSessionId ?? null}, ${session.parentBranchId ?? null}, ${session.createdAt.getTime()}, ${session.updatedAt.getTime()})`
        return session
      },
      Effect.mapError(mapError("Failed to create session")),
    ),

    getSession: Effect.fn("Storage.getSession")(
      function* (id) {
        const rows =
          yield* sql<SessionRow>`SELECT id, name, cwd, bypass, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at FROM sessions WHERE id = ${id}`
        const row = rows[0]
        if (row === undefined) return undefined
        return sessionFromRow(row)
      },
      Effect.mapError(mapError("Failed to get session")),
    ),

    getLastSessionByCwd: Effect.fn("Storage.getLastSessionByCwd")(
      function* (cwd) {
        const rows =
          yield* sql<SessionRow>`SELECT id, name, cwd, bypass, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at FROM sessions WHERE cwd = ${cwd} ORDER BY updated_at DESC LIMIT 1`
        const row = rows[0]
        if (row === undefined) return undefined
        return sessionFromRow(row)
      },
      Effect.mapError(mapError("Failed to get last session by cwd")),
    ),

    listSessions: Effect.fn("Storage.listSessions")(
      function* () {
        const rows =
          yield* sql<SessionRow>`SELECT id, name, cwd, bypass, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at FROM sessions ORDER BY updated_at DESC`
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
        let bypass: 0 | 1 | null = null
        if (session.bypass !== undefined) bypass = session.bypass ? 1 : 0
        yield* sql`UPDATE sessions SET name = ${session.name ?? null}, bypass = ${bypass}, reasoning_level = ${session.reasoningLevel ?? null}, active_branch_id = ${session.activeBranchId ?? null}, updated_at = ${session.updatedAt.getTime()} WHERE id = ${session.id}`
        return session
      },
      Effect.mapError(mapError("Failed to update session")),
    ),

    deleteSession: (id) =>
      sql`DELETE FROM sessions WHERE id = ${id}`.pipe(
        Effect.asVoid,
        Effect.mapError(mapError("Failed to delete session")),
        Effect.withSpan("Storage.deleteSession"),
      ),

    // Branches
    createBranch: Effect.fn("Storage.createBranch")(
      function* (branch) {
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
        const partsJson = yield* encodeMessageParts([...message.parts])
        const metadataJson =
          message.metadata !== undefined ? encodeMetadataJson(message.metadata) : null
        yield* sql`INSERT INTO messages (id, session_id, branch_id, kind, role, parts, created_at, turn_duration_ms, metadata) VALUES (${message.id}, ${message.sessionId}, ${message.branchId}, ${message.kind ?? null}, ${message.role}, ${partsJson}, ${message.createdAt.getTime()}, ${message.turnDurationMs ?? null}, ${metadataJson})`
        yield* sql`UPDATE sessions SET updated_at = ${message.createdAt.getTime()} WHERE id = ${message.sessionId}`
        return message
      },
      Effect.mapError(mapError("Failed to create message")),
    ),

    createMessageIfAbsent: Effect.fn("Storage.createMessageIfAbsent")(
      function* (message) {
        const partsJson = yield* encodeMessageParts([...message.parts])
        const metadataJson =
          message.metadata !== undefined ? encodeMetadataJson(message.metadata) : null
        yield* sql`INSERT OR IGNORE INTO messages (id, session_id, branch_id, kind, role, parts, created_at, turn_duration_ms, metadata) VALUES (${message.id}, ${message.sessionId}, ${message.branchId}, ${message.kind ?? null}, ${message.role}, ${partsJson}, ${message.createdAt.getTime()}, ${message.turnDurationMs ?? null}, ${metadataJson})`
        yield* sql`UPDATE sessions SET updated_at = ${message.createdAt.getTime()} WHERE id = ${message.sessionId}`
        return message
      },
      Effect.mapError(mapError("Failed to create message if absent")),
    ),

    getMessage: Effect.fn("Storage.getMessage")(
      function* (id) {
        const rows =
          yield* sql<MessageRow>`SELECT id, session_id, branch_id, kind, role, parts, created_at, turn_duration_ms, metadata FROM messages WHERE id = ${id}`
        const row = rows[0]
        if (row === undefined) return undefined
        const parts = yield* decodeMessageParts(row.parts)
        return messageFromRow(row, parts)
      },
      Effect.mapError(mapError("Failed to get message")),
    ),

    listMessages: Effect.fn("Storage.listMessages")(
      function* (branchId) {
        const rows =
          yield* sql<MessageRow>`SELECT id, session_id, branch_id, kind, role, parts, created_at, turn_duration_ms, metadata FROM messages WHERE branch_id = ${branchId} ORDER BY created_at ASC, id ASC`
        return yield* Effect.forEach(rows, (row) =>
          Effect.map(decodeMessageParts(row.parts), (parts) => messageFromRow(row, parts)),
        )
      },
      Effect.mapError(mapError("Failed to list messages")),
    ),

    deleteMessages: Effect.fn("Storage.deleteMessages")(
      function* (branchId, afterMessageId) {
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
        const branchId = "branchId" in event ? (event.branchId as string | undefined) : undefined
        const createdAt = yield* Clock.currentTimeMillis
        const traceId = options?.traceId
        const eventJson = yield* encodeEvent(event)
        yield* sql`INSERT INTO events (session_id, branch_id, event_tag, event_json, created_at, trace_id) VALUES (${sessionId}, ${branchId ?? null}, ${event._tag}, ${eventJson}, ${createdAt}, ${traceId ?? null})`
        const rows = yield* sql<{ id: number }>`SELECT last_insert_rowid() as id`
        const id = rows[0]?.id ?? 0
        return new EventEnvelope({
          id: id as EventEnvelope["id"],
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
              new EventEnvelope({
                id: row.id as EventEnvelope["id"],
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
        const rows = yield* sql<{
          event_tag: string
        }>`SELECT event_tag FROM events WHERE session_id = ${sessionId} AND branch_id = ${branchId} AND event_tag IN ${sql.in(tags)} ORDER BY id DESC LIMIT 1`
        return rows[0]?.event_tag
      },
      Effect.mapError(mapError("Failed to get latest event tag")),
    ),

    getLatestEvent: Effect.fn("Storage.getLatestEvent")(
      function* ({ sessionId, branchId, tags }) {
        if (tags.length === 0) return undefined
        const rows = yield* sql<{
          event_json: string
        }>`SELECT event_json FROM events WHERE session_id = ${sessionId} AND branch_id = ${branchId} AND event_tag IN ${sql.in(tags)} ORDER BY id DESC LIMIT 1`
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
          yield* sql<SessionRow>`SELECT id, name, cwd, bypass, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at FROM sessions WHERE parent_session_id = ${parentSessionId} ORDER BY created_at ASC`
        return rows.map(sessionFromRow)
      },
      Effect.mapError(mapError("Failed to get child sessions")),
    ),

    getSessionAncestors: Effect.fn("Storage.getSessionAncestors")(
      function* (sessionId) {
        const rows = yield* sql.unsafe<SessionRow>(
          `WITH RECURSIVE ancestors(id, name, cwd, bypass, reasoning_level, parent_session_id, parent_branch_id, created_at, updated_at, depth) AS (
            SELECT id, name, cwd, bypass, reasoning_level, parent_session_id, parent_branch_id, created_at, updated_at, 0
            FROM sessions WHERE id = '${sessionId.replace(/'/g, "''")}'
            UNION ALL
            SELECT s.id, s.name, s.cwd, s.bypass, s.reasoning_level, s.parent_session_id, s.parent_branch_id, s.created_at, s.updated_at, a.depth + 1
            FROM sessions s
            JOIN ancestors a ON s.id = a.parent_session_id
            WHERE a.depth < 20
          )
          SELECT id, name, cwd, bypass, reasoning_level, parent_session_id, parent_branch_id, created_at, updated_at
          FROM ancestors
          ORDER BY depth ASC`,
        )
        return rows.map(sessionFromRow)
      },
      Effect.mapError(mapError("Failed to get session ancestors")),
    ),

    getSessionDetail: Effect.fn("Storage.getSessionDetail")(
      function* (sessionId) {
        // Get session
        const sessionRows =
          yield* sql<SessionRow>`SELECT id, name, cwd, bypass, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at FROM sessions WHERE id = ${sessionId}`
        const sessionRow = sessionRows[0]
        if (sessionRow === undefined) {
          return yield* new StorageError({ message: `Session not found: ${sessionId}` })
        }
        const session = sessionFromRow(sessionRow)

        // Get all branches
        const branchRows =
          yield* sql<BranchRow>`SELECT id, session_id, parent_branch_id, parent_message_id, name, summary, created_at FROM branches WHERE session_id = ${sessionId} ORDER BY created_at ASC`
        const branches = branchRows.map(branchFromRow)

        // Get messages per branch
        const result = yield* Effect.forEach(branches, (branch) =>
          Effect.gen(function* () {
            const msgRows =
              yield* sql<MessageRow>`SELECT id, session_id, branch_id, kind, role, parts, created_at, turn_duration_ms, metadata FROM messages WHERE branch_id = ${branch.id} ORDER BY created_at ASC, id ASC`
            const messages = yield* Effect.forEach(msgRows, (row) =>
              Effect.map(decodeMessageParts(row.parts), (parts) => messageFromRow(row, parts)),
            )
            return { branch, messages }
          }),
        )

        return { session, branches: result }
      },
      Effect.mapError(mapError("Failed to get session detail")),
    ),

    saveExtensionState: Effect.fn("Storage.saveExtensionState")(
      function* (params: {
        sessionId: SessionId
        extensionId: string
        stateJson: string
        version: number
      }) {
        const updatedAt = yield* Clock.currentTimeMillis
        yield* sql`INSERT OR REPLACE INTO extension_state (session_id, extension_id, state_json, version, updated_at) VALUES (${params.sessionId}, ${params.extensionId}, ${params.stateJson}, ${params.version}, ${updatedAt})`
      },
      Effect.mapError(mapError("Failed to save extension state")),
    ),

    loadExtensionState: Effect.fn("Storage.loadExtensionState")(
      function* (params: { sessionId: SessionId; extensionId: string }) {
        const rows = yield* sql<{
          state_json: string
          version: number
        }>`SELECT state_json, version FROM extension_state WHERE session_id = ${params.sessionId} AND extension_id = ${params.extensionId}`
        const row = rows[0]
        if (row === undefined) return undefined
        return { stateJson: row.state_json, version: row.version }
      },
      Effect.mapError(mapError("Failed to load extension state")),
    ),
  } satisfies StorageService
})

export class Storage extends ServiceMap.Service<Storage, StorageService>()(
  "@gent/core/src/storage/sqlite-storage/Storage",
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

  /** Live layer that also exposes SqlClient (for extension layers that need SQL access) */
  static LiveWithSql = (
    dbPath: string,
  ): Layer.Layer<
    Storage | SqlClient.SqlClient,
    PlatformError.PlatformError,
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
    ).pipe(Layer.provideMerge(Layer.orDie(SqliteClient.layer({ filename: dbPath }))))

  static Memory = (): Layer.Layer<Storage> =>
    Layer.effect(Storage, makeStorage).pipe(
      Layer.provide(Layer.orDie(SqliteClient.layer({ filename: ":memory:" }))),
    )

  /** Memory layer that also exposes SqlClient (for extension layers that need SQL access) */
  static MemoryWithSql = (): Layer.Layer<Storage | SqlClient.SqlClient> =>
    Layer.effect(Storage, makeStorage).pipe(
      Layer.provideMerge(Layer.orDie(SqliteClient.layer({ filename: ":memory:" }))),
    )

  static Test = (): Layer.Layer<Storage> => Storage.Memory()

  /** Test layer that also exposes SqlClient for raw SQL in tests */
  static TestWithSql = (): Layer.Layer<Storage | SqlClient.SqlClient> =>
    Layer.effect(Storage, makeStorage).pipe(
      Layer.provideMerge(Layer.orDie(SqliteClient.layer({ filename: ":memory:" }))),
    )
}
