import { describe, expect, it } from "effect-bun-test"
import { BunSqlite } from "../../src/runtime/gent-platform-bun"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { SessionStorage, SqliteStorage } from "../../src/storage/storage"
import { BunServices } from "@effect/platform-bun"
import { Database } from "bun:sqlite"
import { GentPlatform } from "../../src/runtime/gent-platform"
import { dateFromMillis, Session } from "../../src/domain/message"
import { AgentName } from "../../src/domain/agent"
import { SessionId, CurrentWorkspaceId } from "../../src/domain/ids"
import { makeTempDirectoryScoped, testSqliteStorage } from "../../src/test-utils/harness"
import {
  ensureExtensionTables,
  KERNEL_SCHEMA_OWNER,
  KERNEL_SCHEMA_VERSION,
} from "../../src/storage/schema"

// ── schema version ──────────────────────────────────────────────────────────

/**
 * Gent keeps no migrations: a database at another kernel schema version, or
 * at none (a database from the migration era), is wiped and built again when
 * it opens. These tests open real files, as a server start does.
 */

const WORKSPACE = "a".repeat(64)
const FIXED_NOW = dateFromMillis(1_767_225_600_000)

const fileStorage = (dbPath: string) =>
  SqliteStorage.WithSql(BunSqlite.file(dbPath)).pipe(
    Layer.provide(GentPlatform.Test()),
    Layer.provide(BunServices.layer),
  )

const kernelVersion = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    version: number
  }>`SELECT version FROM gent_schema WHERE owner = ${KERNEL_SCHEMA_OWNER}`
  return rows.map((row) => row.version)
})

const createSessionNamed = (id: string) =>
  Effect.gen(function* () {
    const sessions = yield* SessionStorage
    yield* sessions.createSession(
      new Session({ id: SessionId.make(id), createdAt: FIXED_NOW, updatedAt: FIXED_NOW }),
    )
  })

const sessionExists = (id: string) =>
  Effect.gen(function* () {
    const sessions = yield* SessionStorage
    return (yield* sessions.getSession(SessionId.make(id)))?.id === id
  })

describe("schema version", () => {
  it.scopedLive("a database keeps its rows while it is at the current version", () =>
    Effect.gen(function* () {
      const dir = yield* makeTempDirectoryScoped("gent-schema-keep-")
      const storage = fileStorage(`${dir}/data.db`)

      yield* createSessionNamed("kept").pipe(
        Effect.provideService(CurrentWorkspaceId, WORKSPACE),
        Effect.provide(storage),
      )
      yield* Effect.gen(function* () {
        expect(yield* kernelVersion).toEqual([KERNEL_SCHEMA_VERSION])
        expect(yield* sessionExists("kept")).toBe(true)
      }).pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE), Effect.provide(storage))
    }),
  )

  it.scopedLive("a database at another version is wiped and built again", () =>
    Effect.gen(function* () {
      const dir = yield* makeTempDirectoryScoped("gent-schema-wipe-")
      const storage = fileStorage(`${dir}/data.db`)

      yield* Effect.gen(function* () {
        yield* createSessionNamed("stale")
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE gent_schema SET version = ${KERNEL_SCHEMA_VERSION + 1} WHERE owner = ${KERNEL_SCHEMA_OWNER}`
      }).pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE), Effect.provide(storage))

      yield* Effect.gen(function* () {
        expect(yield* kernelVersion).toEqual([KERNEL_SCHEMA_VERSION])
        expect(yield* sessionExists("stale")).toBe(false)
        yield* createSessionNamed("fresh")
        expect(yield* sessionExists("fresh")).toBe(true)
      }).pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE), Effect.provide(storage))
    }),
  )

  it.scopedLive("a database from the migration era is wiped and built again", () =>
    Effect.gen(function* () {
      const dir = yield* makeTempDirectoryScoped("gent-schema-ledger-")
      const dbPath = `${dir}/data.db`

      // The shape a build with migrations left: its ledger, and a sessions
      // table that lacks the columns added since, with a row.
      yield* Effect.sync(() => {
        const db = new Database(dbPath)
        db.run(
          `CREATE TABLE gent_storage_migrations (migration_id INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL)`,
        )
        db.run(`INSERT INTO gent_storage_migrations (migration_id, name) VALUES (1, 'initial')`)
        db.run(
          `CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
        )
        db.run(`INSERT INTO sessions (id, created_at, updated_at) VALUES ('old', 1, 1)`)
        db.close()
      })

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const ledger = yield* sql<{
          name: string
        }>`SELECT name FROM sqlite_master WHERE name = 'gent_storage_migrations'`
        expect(ledger).toEqual([])
        expect(yield* kernelVersion).toEqual([KERNEL_SCHEMA_VERSION])
        expect(yield* sessionExists("old")).toBe(false)
        yield* createSessionNamed("fresh")
        expect(yield* sessionExists("fresh")).toBe(true)
      }).pipe(
        Effect.provideService(CurrentWorkspaceId, WORKSPACE),
        Effect.provide(fileStorage(dbPath)),
      )
    }),
  )

  it.scopedLive("an extension's version change rebuilds its tables and keeps the kernel's", () =>
    Effect.gen(function* () {
      const dir = yield* makeTempDirectoryScoped("gent-schema-extension-")
      const storage = fileStorage(`${dir}/data.db`)
      const ensureNotes = (version: number) =>
        ensureExtensionTables({
          owner: "@test/notes",
          version,
          tables: ["test_notes"],
          create: Effect.flatMap(SqlClient.SqlClient, (sql) =>
            sql.unsafe(`CREATE TABLE test_notes (id TEXT PRIMARY KEY)`),
          ),
        })
      const notes = Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql<{ id: string }>`SELECT id FROM test_notes`,
      )

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* createSessionNamed("kernel-row")
        yield* ensureNotes(1)
        yield* sql`INSERT INTO test_notes (id) VALUES ('note')`
        // The same version leaves the table as it is.
        yield* ensureNotes(1)
        expect(yield* notes).toEqual([{ id: "note" }])
        // Another version drops it and makes it again.
        yield* ensureNotes(2)
        expect(yield* notes).toEqual([])
        expect(yield* sessionExists("kernel-row")).toBe(true)
      }).pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE), Effect.provide(storage))
    }),
  )
})

describe("session admission", () => {
  it.scopedLive("a session keeps the admission it was created with", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const sessionId = SessionId.make("admitted-session")
      const admission = {
        agent: AgentName.make("helper"),
        runSpec: { overrides: { tools: ["*", "!delegate.start"] } },
      }
      yield* sessions.createSession(
        new Session({ id: sessionId, admission, createdAt: FIXED_NOW, updatedAt: FIXED_NOW }),
      )
      expect((yield* sessions.getSession(sessionId))?.admission).toEqual(admission)
      const plain = SessionId.make("plain-session")
      yield* sessions.createSession(
        new Session({ id: plain, createdAt: FIXED_NOW, updatedAt: FIXED_NOW }),
      )
      expect((yield* sessions.getSession(plain))?.admission).toBeUndefined()
    }).pipe(
      Effect.provideService(CurrentWorkspaceId, WORKSPACE),
      Effect.provide(testSqliteStorage),
    ),
  )
})
