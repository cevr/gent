import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { StorageError } from "../domain/storage-error.js"
import {
  SESSION_PARENT_BRANCH_CHECK,
  hasSessionParentBranchCheck,
  MESSAGES_FTS_SCHEMA_VERSION,
  backfillMessageSearchIndex,
  backfillMessageContentChunks,
  backfillMessageReceivedEvents,
  type ForeignKeyListRow,
} from "./sqlite/rows.js"

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

const repairDuplicatePendingInteractions = Effect.fn("Storage.repairDuplicatePendingInteractions")(
  function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
    UPDATE interaction_requests
    SET status = 'resolved'
    WHERE status = 'pending'
      AND request_id IN (
        SELECT request_id
        FROM (
          SELECT
            request_id,
            ROW_NUMBER() OVER (
              PARTITION BY session_id, branch_id
              ORDER BY created_at DESC, request_id DESC
            ) AS pending_rank
          FROM interaction_requests
          WHERE status = 'pending'
        )
        WHERE pending_rank > 1
      )
  `
  },
)

export const initSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

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
  yield* repairDuplicatePendingInteractions()
  yield* sql.unsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_interaction_requests_pending_singleton ON interaction_requests(session_id, branch_id) WHERE status = 'pending'`,
  )

  yield* migrateMessageSearchIndex()
})
