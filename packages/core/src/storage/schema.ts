import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { StorageError } from "../domain/storage-error.js"
import {
  SESSION_PARENT_BRANCH_CHECK,
  MESSAGES_FTS_SCHEMA_VERSION,
  backfillMessageSearchIndex,
} from "./sqlite/rows.js"

const CORE_SCHEMA_META_KEY = "core_schema_version"
const CORE_SCHEMA_VERSION = "1"

const assertForeignKeyIntegrity = Effect.fn("Storage.assertForeignKeyIntegrity")(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    table: string
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

export const configureSqliteConnection = Effect.fn("Storage.configureSqliteConnection")(
  function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`PRAGMA journal_mode = WAL`)
    yield* sql.unsafe(`PRAGMA synchronous = NORMAL`)
    yield* sql.unsafe(`PRAGMA busy_timeout = 5000`)
    yield* sql.unsafe(`PRAGMA wal_autocheckpoint = 1000`)
    yield* sql.unsafe(`PRAGMA foreign_keys = ON`)
  },
)

const createStorageMetaTable = Effect.fn("Storage.createStorageMetaTable")(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS storage_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)
})

const tableExists = Effect.fn("Storage.tableExists")(function* (table: string) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    name: string
  }>`SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ${table}`
  return rows.length > 0
})

const quoteIdentifier = (name: string): string => `"${name.replaceAll(`"`, `""`)}"`

const dropStorageObjects = Effect.fn("Storage.dropStorageObjects")(function* () {
  const sql = yield* SqlClient.SqlClient
  const objects = yield* sql<{
    name: string
    type: "table" | "trigger" | "view"
    sql: string | null
  }>`SELECT name, type, sql FROM sqlite_schema WHERE type IN (${"table"}, ${"trigger"}, ${"view"})`

  const appObjects = objects.filter((object) => !object.name.startsWith("sqlite_"))
  const triggers = appObjects.filter((object) => object.type === "trigger")
  const views = appObjects.filter((object) => object.type === "view")
  const virtualTables = appObjects.filter(
    (object) => object.type === "table" && object.sql?.startsWith("CREATE VIRTUAL TABLE"),
  )
  const virtualShadowPrefixes = virtualTables.map((table) => `${table.name}_`)
  const tables = appObjects.filter(
    (object) =>
      object.type === "table" &&
      !virtualTables.some((table) => table.name === object.name) &&
      !virtualShadowPrefixes.some((prefix) => object.name.startsWith(prefix)),
  )

  yield* Effect.forEach(
    triggers,
    (trigger) => sql.unsafe(`DROP TRIGGER IF EXISTS ${quoteIdentifier(trigger.name)}`),
    { discard: true },
  )
  yield* Effect.forEach(
    views,
    (view) => sql.unsafe(`DROP VIEW IF EXISTS ${quoteIdentifier(view.name)}`),
    { discard: true },
  )
  yield* Effect.forEach(
    virtualTables,
    (table) => sql.unsafe(`DROP TABLE IF EXISTS ${quoteIdentifier(table.name)}`),
    { discard: true },
  )
  yield* Effect.forEach(
    tables,
    (table) => sql.unsafe(`DROP TABLE IF EXISTS ${quoteIdentifier(table.name)}`),
    { discard: true },
  )
})

const resetIncompatibleStorageSchema = Effect.fn("Storage.resetIncompatibleStorageSchema")(
  function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{
      name: string
    }>`SELECT name FROM sqlite_schema WHERE type IN (${"table"}, ${"trigger"}, ${"view"}) AND name NOT LIKE ${"sqlite_%"} AND name != ${"storage_meta"}`
    if (rows.length === 0) return

    const hasMeta = yield* tableExists("storage_meta")
    const version = hasMeta ? yield* getStorageMeta(CORE_SCHEMA_META_KEY) : undefined
    if (version === CORE_SCHEMA_VERSION) return

    yield* Effect.acquireUseRelease(
      sql.unsafe(`PRAGMA foreign_keys = OFF`),
      () => sql.withTransaction(dropStorageObjects()),
      () => sql.unsafe(`PRAGMA foreign_keys = ON`),
    )
  },
)

const getStorageMeta = Effect.fn("Storage.getStorageMeta")(function* (key: string) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    value: string
  }>`SELECT value FROM storage_meta WHERE key = ${key}`
  return rows[0]?.value
})

const setStorageMeta = Effect.fn("Storage.setStorageMeta")(function* (key: string, value: string) {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO storage_meta (key, value) VALUES (${key}, ${value}) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
})

const createMessageFtsTable = Effect.fn("Storage.createMessageFtsTable")(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(
    `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, message_id UNINDEXED, session_id UNINDEXED, branch_id UNINDEXED, role UNINDEXED)`,
  )
})

const migrateMessageSearchIndex = Effect.fn("Storage.migrateMessageSearchIndex")(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* createStorageMetaTable()
  const version = yield* getStorageMeta("messages_fts_schema_version")
  const hasFtsTable = yield* tableExists("messages_fts")

  if (version === MESSAGES_FTS_SCHEMA_VERSION && hasFtsTable) return

  yield* sql.unsafe(`DROP TRIGGER IF EXISTS messages_fts_ai`).pipe(Effect.ignoreCause)
  yield* sql.unsafe(`DROP TABLE IF EXISTS messages_fts`).pipe(Effect.ignoreCause)
  yield* createMessageFtsTable()
  yield* backfillMessageSearchIndex()
  yield* setStorageMeta("messages_fts_schema_version", MESSAGES_FTS_SCHEMA_VERSION)
})

export const initSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* resetIncompatibleStorageSchema()

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

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      kind TEXT,
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      turn_duration_ms INTEGER,
      metadata TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (branch_id, session_id) REFERENCES branches(id, session_id) ON DELETE CASCADE
    )
  `)

  yield* sql.unsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_branches_id_session ON branches(id, session_id)`,
  )
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

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS events (
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

  yield* assertForeignKeyIntegrity()

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
  yield* sql.unsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_interaction_requests_pending_singleton ON interaction_requests(session_id, branch_id) WHERE status = 'pending'`,
  )

  yield* migrateMessageSearchIndex()
  yield* setStorageMeta(CORE_SCHEMA_META_KEY, CORE_SCHEMA_VERSION)
})
