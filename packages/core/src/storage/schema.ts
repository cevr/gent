import { Effect, Layer, Schema } from "effect"
import { Migrator, SqlClient } from "effect/unstable/sql"
import { SqliteMigrator } from "@effect/sql-sqlite-bun"
import { StorageError } from "../domain/storage-error.js"
import { SESSION_PARENT_BRANCH_CHECK } from "./sqlite/rows.js"
import { DefaultWorkspaceId } from "../server/workspace-rpc.js"

const isStorageError = Schema.is(StorageError)

const configureSqliteConnection = Effect.fn("Storage.configureSqliteConnection")(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`PRAGMA journal_mode = WAL`)
  yield* sql.unsafe(`PRAGMA synchronous = NORMAL`)
  yield* sql.unsafe(`PRAGMA busy_timeout = 5000`)
  yield* sql.unsafe(`PRAGMA wal_autocheckpoint = 1000`)
  yield* sql.unsafe(`PRAGMA foreign_keys = ON`)
})

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

const initialMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql.unsafe(`
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
  `)

  yield* sql.unsafe(`
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
  `)

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
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (branch_id, session_id) REFERENCES branches(id, session_id) ON DELETE CASCADE
    )
  `)

  yield* sql.unsafe(`CREATE UNIQUE INDEX idx_branches_id_session ON branches(id, session_id)`)

  yield* sql.unsafe(`
    CREATE TABLE content_chunks (
      id TEXT PRIMARY KEY,
      part_type TEXT NOT NULL,
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

  yield* sql.unsafe(`
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
  `)

  yield* sql.unsafe(`CREATE INDEX idx_messages_branch ON messages(branch_id)`)
  yield* sql.unsafe(
    `CREATE INDEX idx_messages_branch_created ON messages(branch_id, created_at, id)`,
  )
  yield* sql.unsafe(`CREATE INDEX idx_message_chunks_chunk ON message_chunks(chunk_id)`)
  yield* sql.unsafe(`CREATE INDEX idx_events_session ON events(session_id, id)`)
  yield* sql.unsafe(`CREATE INDEX idx_events_session_branch ON events(session_id, branch_id, id)`)
  yield* sql.unsafe(`CREATE INDEX idx_events_session_tag ON events(session_id, event_tag, id)`)
  yield* sql.unsafe(`CREATE INDEX idx_branches_session ON branches(session_id)`)
  yield* sql.unsafe(`CREATE INDEX idx_sessions_parent ON sessions(parent_session_id)`)
  yield* sql.unsafe(`CREATE INDEX idx_interaction_requests_status ON interaction_requests(status)`)
  yield* sql.unsafe(
    `CREATE UNIQUE INDEX idx_interaction_requests_pending_singleton ON interaction_requests(session_id, branch_id) WHERE status = 'pending'`,
  )

  yield* sql.unsafe(
    `CREATE VIRTUAL TABLE messages_fts USING fts5(content, message_id UNINDEXED, session_id UNINDEXED, branch_id UNINDEXED, role UNINDEXED)`,
  )
})

const agentLoopQueueMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql.unsafe(`
    CREATE TABLE agent_loop_queues (
      session_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      queue_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, branch_id)
    )
  `)
})

const sessionWorkspaceMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql.unsafe(
    `ALTER TABLE sessions ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '${DefaultWorkspaceId}'`,
  )
  yield* sql.unsafe(`CREATE INDEX idx_sessions_workspace ON sessions(workspace_id, updated_at)`)
})

const agentLoopQueueWorkspaceMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql.unsafe(`
    CREATE TABLE agent_loop_queues_next (
      workspace_id TEXT NOT NULL DEFAULT '${DefaultWorkspaceId}',
      session_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      queue_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, session_id, branch_id)
    )
  `)
  yield* sql.unsafe(`
    INSERT INTO agent_loop_queues_next (workspace_id, session_id, branch_id, queue_json, updated_at)
    SELECT '${DefaultWorkspaceId}', session_id, branch_id, queue_json, updated_at
    FROM agent_loop_queues
  `)
  yield* sql.unsafe(`DROP TABLE agent_loop_queues`)
  yield* sql.unsafe(`ALTER TABLE agent_loop_queues_next RENAME TO agent_loop_queues`)
})

const wrapMigrationError = (error: unknown): StorageError =>
  new StorageError({ message: "Storage migration failed", cause: error })

const wrapPragmaError = (error: unknown): StorageError =>
  new StorageError({ message: "Storage pragma initialization failed", cause: error })

const StoragePragmaLive: Layer.Layer<never, StorageError, SqlClient.SqlClient> =
  Layer.effectDiscard(configureSqliteConnection().pipe(Effect.mapError(wrapPragmaError)))

const StorageMigratorLive: Layer.Layer<never, StorageError, SqlClient.SqlClient> =
  SqliteMigrator.layer({
    loader: Migrator.fromRecord({
      "001_init": initialMigration,
      "002_agent_loop_queue": agentLoopQueueMigration,
      "003_session_workspace": sessionWorkspaceMigration,
      "004_agent_loop_queue_workspace": agentLoopQueueWorkspaceMigration,
    }),
    table: "gent_storage_migrations",
  }).pipe(
    Layer.catch((error) => Layer.effectDiscard(Effect.fail(wrapMigrationError(error)))),
    Layer.provideMerge(StoragePragmaLive),
  )

const StorageIntegrityLive: Layer.Layer<never, StorageError, SqlClient.SqlClient> =
  Layer.effectDiscard(
    assertForeignKeyIntegrity().pipe(
      Effect.mapError((error) =>
        isStorageError(error)
          ? error
          : new StorageError({ message: "Storage integrity check failed", cause: error }),
      ),
    ),
  )

export const StorageInitLive: Layer.Layer<never, StorageError, SqlClient.SqlClient> =
  StorageIntegrityLive.pipe(Layer.provideMerge(StorageMigratorLive))
