import { Effect, Layer, Option, Predicate, Schema } from "effect"
import {
  Branch,
  decodeDateFromMillis,
  Message,
  MessageMetadata,
  MessagePart,
  Session,
  SessionAdmission,
} from "../domain/message.js"
import { AgentEvent, EventId } from "../domain/event.js"
import { isReasoningEffort, ModelId } from "../domain/agent.js"
import { BranchId, MessageId, SessionId } from "../domain/ids.js"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { storageError, StorageError } from "../domain/errors.js"

// ── stored rows ─────────────────────────────────────────────────────────────

// A stored row decodes through its schema; a row that does not fit fails as a StorageError.
const StoredPromptPartJson = Schema.fromJsonString(MessagePart)
export const decodeStoredPromptPart = Schema.decodeUnknownEffect(StoredPromptPartJson)
const encodeStoredPromptPart = Schema.encodeEffect(StoredPromptPartJson)
const EventJson = Schema.fromJsonString(Schema.Unknown)
const decodeEventJson = Schema.decodeUnknownEffect(EventJson)
const encodeEventJson = Schema.encodeEffect(EventJson)
export const encodeEvent = (event: AgentEvent) =>
  Schema.encodeEffect(AgentEvent)(event).pipe(Effect.flatMap(encodeEventJson))
const MessageMetadataJson = Schema.fromJsonString(MessageMetadata)
const decodeMessageMetadata = Schema.decodeUnknownEffect(MessageMetadataJson)
const encodeMessageMetadata = Schema.encodeEffect(MessageMetadataJson)

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
  model_id: Schema.NullOr(ModelId),
  // Text: `auto` or a reasoning level (see rowToSession).
  reasoning_level: Schema.NullOr(Schema.String),
  active_branch_id: Schema.NullOr(BranchId),
  parent_session_id: Schema.NullOr(SessionId),
  parent_branch_id: Schema.NullOr(BranchId),
  thread_id: Schema.NullOr(SessionId),
  admission_json: Schema.NullOr(Schema.String),
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
  created_at: Schema.Finite,
})
export type BranchRow = typeof BranchRow.Type

const MessageRow = Schema.Struct({
  id: MessageId,
  session_id: SessionId,
  branch_id: BranchId,
  kind: Schema.NullOr(Schema.Literals(["regular", "interjection"])),
  role: Schema.Literals(["user", "assistant", "system", "tool"]),
  created_at: Schema.Finite,
  turn_duration_ms: Schema.NullOr(Schema.Finite),
  metadata: Schema.NullOr(Schema.String),
})
type MessageRow = typeof MessageRow.Type

export const MessageChunkRow = Schema.Struct({
  ...MessageRow.fields,
  chunk_ordinal: Schema.NullOr(Schema.Finite),
  chunk_part_json: Schema.NullOr(Schema.String),
})
export type MessageChunkRow = typeof MessageChunkRow.Type

const EventRow = Schema.Struct({
  id: EventId,
  event_json: Schema.String,
  created_at: Schema.Finite,
  trace_id: Schema.NullOr(Schema.String),
})
type EventRow = typeof EventRow.Type

export const decodeMessageChunkRow = Schema.decodeUnknownEffect(MessageChunkRow)
export const decodeEventRow = Schema.decodeUnknownEffect(EventRow)

const SESSION_PARENT_BRANCH_CHECK =
  "CHECK (parent_branch_id IS NULL OR parent_session_id IS NOT NULL)"

export const SESSION_COLUMNS =
  "id, name, cwd, model_id, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, thread_id, admission_json, created_at, updated_at"

/** The branch columns, read through the alias `b`. Interpolate with `sql.literal`. */
export const BRANCH_COLUMNS =
  "b.id, b.session_id, b.parent_branch_id, b.parent_message_id, b.name, b.created_at"

/** One message row per content chunk, scoped through the owning session. Interpolate with `sql.literal`. */
export const MESSAGE_CHUNK_SELECT = `SELECT m.id, m.session_id, m.branch_id, m.kind, m.role, m.created_at, m.turn_duration_ms, m.metadata,
  mc.ordinal as chunk_ordinal, c.part_json as chunk_part_json
  FROM messages m
  LEFT JOIN message_chunks mc ON mc.message_id = m.id
  LEFT JOIN content_chunks c ON c.id = mc.chunk_id
  JOIN sessions s ON s.id = m.session_id`

const decodeAdmission = Schema.decodeEffect(Schema.fromJsonString(SessionAdmission))

/** The `reasoning_level` of a session on `/effort auto`: not a `ReasoningEffort`. */
const REASONING_AUTO = "auto"

/** The `reasoning_level` a session stores: `auto`, its level, or none. */
export const storedReasoningLevel = (
  session: Pick<Session, "reasoningLevel" | "reasoningAuto">,
): Option.Option<string> =>
  Option.orElse(
    Option.liftPredicate(REASONING_AUTO, () => session.reasoningAuto === true),
    () => Option.fromUndefinedOr(session.reasoningLevel),
  )

const rowToSession = (row: SessionRow) =>
  Effect.gen(function* () {
    const createdAt = yield* decodeDateFromMillis(row.created_at)
    const updatedAt = yield* decodeDateFromMillis(row.updated_at)
    const admission = yield* Option.match(Option.fromNullishOr(row.admission_json), {
      onNone: () => Effect.succeedNone,
      onSome: (json) => Effect.asSome(decodeAdmission(json)),
    })
    return new Session({
      id: row.id,
      name: Option.getOrUndefined(Option.fromNullishOr(row.name)),
      cwd: Option.getOrUndefined(Option.fromNullishOr(row.cwd)),
      modelId: Option.getOrUndefined(Option.fromNullishOr(row.model_id)),
      reasoningLevel: Option.getOrUndefined(
        Option.fromNullishOr(row.reasoning_level).pipe(Option.filter(isReasoningEffort)),
      ),
      reasoningAuto: Option.getOrUndefined(
        Option.liftPredicate(true as const, () => row.reasoning_level === REASONING_AUTO),
      ),
      activeBranchId: Option.getOrUndefined(Option.fromNullishOr(row.active_branch_id)),
      parentSessionId: Option.getOrUndefined(Option.fromNullishOr(row.parent_session_id)),
      parentBranchId: Option.getOrUndefined(Option.fromNullishOr(row.parent_branch_id)),
      threadId: Option.getOrUndefined(Option.fromNullishOr(row.thread_id)),
      admission: Option.getOrUndefined(admission),
      createdAt,
      updatedAt,
    })
  })

// `sql<SessionRow>` is a cast, not a check: this decode is the boundary.
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
      createdAt,
    })
  })

// `sql<BranchRow>` is a cast, not a check: this decode is the boundary.
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

// ── schema ──────────────────────────────────────────────────────────────────

const assertForeignKeyIntegrity = Effect.fn("Storage.assertForeignKeyIntegrity")(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    table: string
    // oxlint-disable-next-line effect/noNullish -- SQLite reports a missing foreign-key rowid as NULL.
    rowid: number | null
    parent: string
    fkid: number
  }>`PRAGMA foreign_key_check`
  if (rows.length === 0) return

  const details = rows
    .slice(0, 10)
    .map((row) => `${row.table}:${row.rowid ?? "unknown"} -> ${row.parent}#${row.fkid}`)
    .join(", ")
  return yield* new StorageError({
    message: `SQLite foreign key integrity check failed: ${details}`,
  })
})

/**
 * The version of the kernel's tables and of every JSON shape they store.
 * Gent keeps no migrations while it has no users: a change to a table or to
 * a stored shape bumps this, and a database at another version is wiped and
 * built again when it opens.
 */
export const KERNEL_SCHEMA_VERSION = 5

/** The schema owner the kernel's row names; an extension's row names its id. */
export const KERNEL_SCHEMA_OWNER = "kernel"

/** Each schema owner's version, one row per owner. */
const createSchemaVersions = `
  CREATE TABLE IF NOT EXISTS gent_schema (
    owner TEXT PRIMARY KEY,
    version INTEGER NOT NULL
  )
`

const SchemaVersionRows = Schema.Array(Schema.Struct({ version: Schema.Finite }))
const TableRows = Schema.Array(Schema.Struct({ name: Schema.String }))

const storedVersion = (owner: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* Schema.decodeUnknownEffect(SchemaVersionRows)(
      yield* sql`SELECT version FROM gent_schema WHERE owner = ${owner}`,
    )
    return Option.map(Option.fromUndefinedOr(rows[0]), (row) => row.version)
  })

/** Every table in the database but SQLite's own. */
const everyTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* Schema.decodeUnknownEffect(TableRows)(
    yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  )
  return rows.map((row) => row.name)
})

const ReferenceRows = Schema.Array(Schema.Struct({ child: Schema.String, parent: Schema.String }))

/**
 * `tables` in an order that drops each one after every table that references
 * it. A drop of a table whose parent is already gone fails ("no such table").
 * Tables left in a reference cycle come last, in the order given.
 */
const dropOrder = (
  tables: ReadonlyArray<string>,
  references: typeof ReferenceRows.Type,
): ReadonlyArray<string> => {
  const order: Array<string> = []
  let remaining = tables
  while (remaining.length > 0) {
    const left = remaining
    const referenced = new Set(
      references
        .filter((row) => row.child !== row.parent && left.includes(row.child))
        .map((row) => row.parent),
    )
    const free = left.filter((table) => !referenced.has(table))
    if (free.length === 0) return [...order, ...left]
    order.push(...free)
    remaining = left.filter((table) => referenced.has(table))
  }
  return order
}

const dropTables = (tables: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const references = yield* Schema.decodeUnknownEffect(ReferenceRows)(
      yield* sql`SELECT m.name AS child, f."table" AS parent
        FROM sqlite_master m, pragma_foreign_key_list(m.name) f
        WHERE m.type = 'table'`,
    )
    for (const table of dropOrder(tables, references))
      yield* sql.unsafe(`DROP TABLE IF EXISTS "${table}"`)
  })

/**
 * Keep `owner`'s tables at `version`: a database that records another
 * version, or none, loses them (`drop`) and gets them again (`create`).
 * One transaction, so a second process opening the same file waits and then
 * finds the version recorded. Foreign keys stay on, since Durable Object
 * storage refuses `PRAGMA foreign_keys`: the drop orders the tables instead
 * (`dropOrder`).
 */
const ensureVersion = <E, R>(params: {
  readonly owner: string
  readonly version: number
  readonly drop: Effect.Effect<void, SqlError | Schema.SchemaError, SqlClient.SqlClient>
  readonly create: Effect.Effect<void, E | SqlError, R | SqlClient.SqlClient>
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* Effect.gen(function* () {
      yield* sql.unsafe(createSchemaVersions)
      if (Option.contains(yield* storedVersion(params.owner), params.version)) return
      yield* params.drop
      yield* sql.unsafe(createSchemaVersions)
      yield* params.create
      yield* sql`INSERT INTO gent_schema (owner, version) VALUES (${params.owner}, ${params.version})
        ON CONFLICT(owner) DO UPDATE SET version = excluded.version`
    }).pipe(sql.withTransaction)
  })

/**
 * The tables an extension owns, kept at its own version. A database at
 * another version loses `tables` and runs `create`, which makes them as the
 * extension's code reads them now; the kernel's rows stay. A kernel version
 * change wipes every table, the extension's included.
 */
export const ensureExtensionTables = <E, R>(params: {
  readonly owner: string
  readonly version: number
  readonly tables: ReadonlyArray<string>
  readonly create: Effect.Effect<void, E | SqlError, R | SqlClient.SqlClient>
}) =>
  ensureVersion({
    owner: params.owner,
    version: params.version,
    drop: dropTables(params.tables),
    create: params.create,
  })

const createKernelTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // `workspace_id` scopes a session to the project that opened it.
  // `thread_id` is the thread the session belongs to: a compaction handoff
  // continues its parent's thread, a spawn (a delegate run, a `/btw` fork)
  // starts its own. `admission_json` is the agent its turns run as, with the
  // run overrides, set when the session is created; NULL runs the default agent.
  yield* sql.unsafe(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT,
      cwd TEXT,
      model_id TEXT,
      reasoning_level TEXT,
      active_branch_id TEXT,
      parent_session_id TEXT,
      parent_branch_id TEXT,
      thread_id TEXT,
      admission_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ${SESSION_PARENT_BRANCH_CHECK},
      FOREIGN KEY (parent_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (active_branch_id, id) REFERENCES branches(id, session_id) DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY (parent_branch_id, parent_session_id) REFERENCES branches(id, session_id) DEFERRABLE INITIALLY DEFERRED
    )
  `)
  yield* sql.unsafe(`CREATE INDEX idx_sessions_parent ON sessions(parent_session_id)`)
  yield* sql.unsafe(`CREATE INDEX idx_sessions_workspace ON sessions(workspace_id, updated_at)`)
  yield* sql.unsafe(`CREATE INDEX idx_sessions_thread ON sessions(workspace_id, thread_id)`)

  yield* sql.unsafe(`
    CREATE TABLE branches (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      parent_branch_id TEXT,
      parent_message_id TEXT,
      name TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE (id, session_id),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_branch_id, session_id) REFERENCES branches(id, session_id) DEFERRABLE INITIALLY DEFERRED
    )
  `)
  yield* sql.unsafe(`CREATE INDEX idx_branches_session ON branches(session_id)`)

  // `insertion_order` breaks a `created_at` tie: a rowid can change when
  // SQLite runs VACUUM. The trigger numbers a row inserted without one.
  yield* sql.unsafe(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      kind TEXT,
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      turn_duration_ms INTEGER,
      metadata TEXT,
      insertion_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (branch_id, session_id) REFERENCES branches(id, session_id) ON DELETE CASCADE
    )
  `)
  yield* sql.unsafe(`CREATE UNIQUE INDEX idx_messages_insertion_order ON messages(insertion_order)`)
  yield* sql.unsafe(
    `CREATE INDEX idx_messages_branch_created ON messages(branch_id, created_at, insertion_order)`,
  )
  yield* sql.unsafe(`
    CREATE TRIGGER messages_assign_insertion_order AFTER INSERT ON messages
    WHEN NEW.insertion_order = 0
    BEGIN
      UPDATE messages
      SET insertion_order = (SELECT COALESCE(MAX(insertion_order), 0) + 1 FROM messages)
      WHERE id = NEW.id;
    END
  `)

  yield* sql.unsafe(`
    CREATE TABLE content_chunks (
      id TEXT PRIMARY KEY,
      part_json TEXT NOT NULL
    )
  `)
  yield* sql.unsafe(`
    CREATE TABLE message_chunks (
      message_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      chunk_id TEXT NOT NULL,
      PRIMARY KEY (message_id, ordinal),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (chunk_id) REFERENCES content_chunks(id)
    )
  `)
  yield* sql.unsafe(`CREATE INDEX idx_message_chunks_chunk ON message_chunks(chunk_id)`)

  yield* sql.unsafe(`
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
  `)
  yield* sql.unsafe(`CREATE INDEX idx_events_session ON events(session_id, id)`)
  yield* sql.unsafe(`CREATE INDEX idx_events_session_branch ON events(session_id, branch_id, id)`)
  yield* sql.unsafe(`CREATE INDEX idx_events_session_tag ON events(session_id, event_tag, id)`)

  // The owner columns name the call that asked, so an answer goes back to it
  // after a restart; a request no call owns leaves them NULL.
  yield* sql.unsafe(`
    CREATE TABLE interaction_requests (
      request_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      params_json TEXT NOT NULL,
      decision_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      owner_tool_call_id TEXT,
      owner_occurrence INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (branch_id, session_id) REFERENCES branches(id, session_id) ON DELETE CASCADE
    )
  `)
  yield* sql.unsafe(`CREATE INDEX idx_interaction_requests_status ON interaction_requests(status)`)
  yield* sql.unsafe(
    `CREATE UNIQUE INDEX idx_interaction_requests_pending_singleton ON interaction_requests(session_id, branch_id) WHERE status = 'pending'`,
  )

  yield* sql.unsafe(`
    CREATE TABLE durable_operations (
      workspace_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      request_id TEXT NOT NULL,
      result_json TEXT NOT NULL,
      subject_session_id TEXT NOT NULL,
      subject_branch_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, operation, request_id),
      FOREIGN KEY (subject_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (subject_branch_id, subject_session_id) REFERENCES branches(id, session_id) ON DELETE CASCADE
    )
  `)
  yield* sql.unsafe(`CREATE INDEX idx_durable_operations_created ON durable_operations(created_at)`)

  yield* sql.unsafe(`
    CREATE TABLE agent_loop_queues (
      workspace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      queue_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, session_id, branch_id),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (branch_id, session_id) REFERENCES branches(id, session_id) ON DELETE CASCADE
    )
  `)

  yield* sql.unsafe(`
    CREATE TABLE tool_call_bindings (
      assistant_message_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      binding_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (assistant_message_id, tool_call_id),
      FOREIGN KEY (assistant_message_id) REFERENCES messages(id) ON DELETE CASCADE
    )
  `)

  yield* sql.unsafe(`
    CREATE TABLE turn_records (
      session_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      step INTEGER NOT NULL,
      continuations INTEGER NOT NULL,
      pending_tool_calls_json TEXT NOT NULL,
      lane_sabbath_json TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, branch_id, message_id),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (branch_id, session_id) REFERENCES branches(id, session_id) ON DELETE CASCADE
    )
  `)

  // The models.dev catalog as served: one row per source (`api.json`, and
  // `api.json?type=decision`), with the raw body and its ETag, so a parser
  // change re-reads the row with no refetch and a revalidation sends
  // `If-None-Match`. `fetched_at` is when the body arrived (a 200),
  // `checked_at` the last 200 or 304.
  yield* sql.unsafe(`
    CREATE TABLE model_catalog_snapshots (
      source TEXT PRIMARY KEY,
      body TEXT NOT NULL,
      etag TEXT,
      fetched_at INTEGER NOT NULL,
      checked_at INTEGER NOT NULL
    )
  `)

  // One row for each tool image a stored message references, so the blob
  // sweep keeps every image some message still holds. An image is content
  // addressed and shared: the rows count its references.
  yield* sql.unsafe(`
    CREATE TABLE tool_image_references (
      sha256 TEXT NOT NULL,
      message_id TEXT NOT NULL,
      PRIMARY KEY (sha256, message_id),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    )
  `)
  yield* sql.unsafe(
    `CREATE INDEX idx_tool_image_references_message ON tool_image_references(message_id)`,
  )

  // The durable wake records an extension arms with `Session.wakeAt`: one row
  // per branch, extension and source. `at` is when the record fires (epoch
  // ms); a NULL `at` fires only at the next server start. `version` grows
  // with every arm, and every write after a fire names the version it read,
  // so a newer arm during the fire stands. `incarnation` never repeats,
  // deletes included (AUTOINCREMENT): a record cancelled and armed again is a
  // new one, which a write after an older fire cannot reach. `armed_boot` is
  // the server start that inserted the record (`branch_wake_boots`), so a
  // start fires the start-only records an earlier start armed and none of its own.
  yield* sql.unsafe(`
    CREATE TABLE branch_wakes (
      incarnation INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      extension_id TEXT NOT NULL,
      source_id TEXT NOT NULL CHECK (length(source_id) <= 200),
      at INTEGER,
      version INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      armed_boot INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (session_id, branch_id, extension_id, source_id),
      FOREIGN KEY (branch_id, session_id) REFERENCES branches(id, session_id) ON DELETE CASCADE
    )
  `)
  yield* sql.unsafe(`CREATE INDEX idx_branch_wakes_due ON branch_wakes(at) WHERE at IS NOT NULL`)
  yield* sql.unsafe(`
    CREATE TABLE branch_wake_boots (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      boot INTEGER NOT NULL
    )
  `)
})

// Init is portable DDL over any SQLite `SqlClient`. The connection's PRAGMAs
// belong to the client layer that opens the connection (`storage.ts`); a
// hosted client's platform owns them. A kernel version change wipes every
// table, an extension's and the cluster's included: they are built again
// after this, by their own owners.
const StorageSchemaLive: Layer.Layer<never, StorageError, SqlClient.SqlClient> =
  Layer.effectDiscard(
    ensureVersion({
      owner: KERNEL_SCHEMA_OWNER,
      version: KERNEL_SCHEMA_VERSION,
      drop: Effect.flatMap(everyTable, dropTables),
      create: createKernelTables,
    }).pipe(Effect.mapError(storageError("Storage schema setup failed"))),
  )

const StorageIntegrityLive: Layer.Layer<never, StorageError, SqlClient.SqlClient> =
  Layer.effectDiscard(
    assertForeignKeyIntegrity().pipe(
      Effect.mapError(storageError("Storage integrity check failed")),
    ),
  )

export const StorageInitLive: Layer.Layer<never, StorageError, SqlClient.SqlClient> =
  StorageIntegrityLive.pipe(Layer.provideMerge(StorageSchemaLive))
