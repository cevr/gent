import { describe, it, expect, test } from "effect-bun-test"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Database } from "bun:sqlite"
import { Cause, Effect, Exit, Layer, Ref } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Storage, StorageError } from "@gent/core/storage/sqlite-storage"
import {
  Session,
  Branch,
  Message,
  TextPart,
  ImagePart,
  ReasoningPart,
  ToolCallPart,
  ToolResultPart,
} from "@gent/core/domain/message"
import { AgentSwitched, SessionStarted } from "@gent/core/domain/event"
import { BranchId, ExtensionId, MessageId, SessionId, ToolCallId } from "@gent/core/domain/ids"
import { AgentName } from "@gent/core/domain/agent"
import { messageToInfo } from "../../src/server/session-utils"
import { repairSqliteForeignKeyOrphans } from "../../src/storage/sqlite-repair"

interface SchemaRow {
  type: string
  name: string
  tbl_name: string
  sql: string | null
}

const schemaProjection = Effect.fn("schemaProjection")(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<SchemaRow>`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE name NOT LIKE ${"sqlite_%"}
      AND name NOT LIKE ${"messages_fts_%"}
      AND name != ${"messages_fts"}
    ORDER BY type, name
  `
  return rows.map((row) => ({
    ...row,
    sql: row.sql?.replace(/\s+/g, " ").trim() ?? null,
  }))
})

const createLegacyStorageSchema = (dbPath: string) =>
  Effect.sync(() => {
    const db = new Database(dbPath)
    db.run(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        name TEXT,
        cwd TEXT,
        reasoning_level TEXT,
        active_branch_id TEXT,
        parent_session_id TEXT,
        parent_branch_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    db.run(`
      CREATE TABLE branches (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        parent_branch_id TEXT,
        parent_message_id TEXT,
        name TEXT,
        created_at INTEGER NOT NULL
      )
    `)
    db.run(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        role TEXT NOT NULL,
        parts TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        turn_duration_ms INTEGER
      )
    `)
    db.run(`
      CREATE TABLE content_chunks (
        id TEXT PRIMARY KEY,
        part_type TEXT NOT NULL,
        part_json TEXT NOT NULL
      )
    `)
    db.run(`
      CREATE TABLE message_chunks (
        message_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        chunk_id TEXT NOT NULL,
        PRIMARY KEY (message_id, ordinal)
      )
    `)
    db.run(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        branch_id TEXT,
        event_tag TEXT NOT NULL,
        event_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `)
    db.run(`
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
        last_error TEXT
      )
    `)
    db.run(`
      CREATE TABLE agent_loop_checkpoints (
        session_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        state_tag TEXT NOT NULL,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, branch_id)
      )
    `)
    db.run(`
      CREATE TABLE interaction_requests (
        request_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        session_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        params_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL
      )
    `)
    db.close()
  })

describe("Storage", () => {
  describe("Sessions", () => {
    it.live("creates and retrieves a session", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const session = new Session({
          id: SessionId.make("test-session"),
          name: "Test Session",
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        yield* storage.createSession(session)
        const retrieved = yield* storage.getSession(SessionId.make("test-session"))
        expect(retrieved).toBeDefined()
        expect(retrieved?.id).toBe(SessionId.make("test-session"))
        expect(retrieved?.name).toBe("Test Session")
      }).pipe(Effect.provide(Storage.Test())),
    )
    it.live("lists sessions", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.createSession(
          new Session({
            id: SessionId.make("s1"),
            name: "Session 1",
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* storage.createSession(
          new Session({
            id: SessionId.make("s2"),
            name: "Session 2",
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        const sessions = yield* storage.listSessions()
        expect(sessions.length).toBe(2)
      }).pipe(Effect.provide(Storage.Test())),
    )
    it.live("lists first branch per session", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const now = Date.now()
        yield* storage.createSession(
          new Session({
            id: SessionId.make("s1"),
            createdAt: new Date(now),
            updatedAt: new Date(now),
          }),
        )
        yield* storage.createSession(
          new Session({
            id: SessionId.make("s2"),
            createdAt: new Date(now + 1),
            updatedAt: new Date(now + 1),
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: BranchId.make("s1-b1"),
            sessionId: SessionId.make("s1"),
            createdAt: new Date(now + 10),
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: BranchId.make("s1-b0"),
            sessionId: SessionId.make("s1"),
            createdAt: new Date(now),
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: BranchId.make("s2-b1"),
            sessionId: SessionId.make("s2"),
            createdAt: new Date(now + 5),
          }),
        )
        const firstBranches = yield* storage.listFirstBranches()
        const map = new Map(firstBranches.map((row) => [row.sessionId, row.branchId]))
        expect(map.get(SessionId.make("s1"))).toBe(BranchId.make("s1-b0"))
        expect(map.get(SessionId.make("s2"))).toBe(BranchId.make("s2-b1"))
      }).pipe(Effect.provide(Storage.Test())),
    )
    it.live("updates a session", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const session = new Session({
          id: SessionId.make("update-test"),
          name: "Original",
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        yield* storage.createSession(session)
        yield* storage.updateSession(new Session({ ...session, name: "Updated" }))
        const retrieved = yield* storage.getSession(SessionId.make("update-test"))
        expect(retrieved?.name).toBe("Updated")
      }).pipe(Effect.provide(Storage.Test())),
    )
    it.live("deletes a session", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.createSession(
          new Session({
            id: SessionId.make("delete-test"),
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* storage.deleteSession(SessionId.make("delete-test"))
        const retrieved = yield* storage.getSession(SessionId.make("delete-test"))
        expect(retrieved).toBeUndefined()
      }).pipe(Effect.provide(Storage.Test())),
    )
    it.live("enables sqlite foreign key enforcement", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql<{
          foreign_keys: number
        }>`PRAGMA foreign_keys`
        expect(rows[0]?.foreign_keys).toBe(1)
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    it.scoped("configures file-backed sqlite durability pragmas", () =>
      Effect.gen(function* () {
        const dir = yield* Effect.acquireRelease(
          Effect.sync(() => mkdtempSync(join(tmpdir(), "gent-storage-pragmas-"))),
          (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
        )
        const layer = Storage.LiveWithSql(join(dir, "gent.db")).pipe(
          Layer.provide(BunFileSystem.layer),
          Layer.provide(BunServices.layer),
        )
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const journal = yield* sql<{
            journal_mode: string
          }>`PRAGMA journal_mode`
          const synchronous = yield* sql<{
            synchronous: number
          }>`PRAGMA synchronous`
          const busyTimeout = yield* sql<{
            timeout: number
          }>`PRAGMA busy_timeout`
          const walAutocheckpoint = yield* sql<{
            wal_autocheckpoint: number
          }>`PRAGMA wal_autocheckpoint`
          const foreignKeys = yield* sql<{
            foreign_keys: number
          }>`PRAGMA foreign_keys`
          expect(journal[0]?.journal_mode).toBe("wal")
          expect(synchronous[0]?.synchronous).toBe(1)
          expect(busyTimeout[0]?.timeout).toBe(5000)
          expect(walAutocheckpoint[0]?.wal_autocheckpoint).toBe(1000)
          expect(foreignKeys[0]?.foreign_keys).toBe(1)
        }).pipe(Effect.provide(layer))
      }),
    )
    it.scoped("does not rebuild current-version FTS projection on every startup", () =>
      Effect.gen(function* () {
        const dir = yield* Effect.acquireRelease(
          Effect.sync(() => mkdtempSync(join(tmpdir(), "gent-storage-fts-version-"))),
          (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
        )
        const dbPath = join(dir, "gent.db")
        const layer = Storage.LiveWithSql(dbPath).pipe(
          Layer.provide(BunFileSystem.layer),
          Layer.provide(BunServices.layer),
        )
        const sessionId = SessionId.make("fts-version-session")
        const branchId = BranchId.make("fts-version-branch")
        const messageId = MessageId.make("fts-version-message")
        yield* Effect.gen(function* () {
          const storage = yield* Storage
          yield* storage.createSession(
            new Session({
              id: sessionId,
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
          )
          yield* storage.createBranch(
            new Branch({
              id: branchId,
              sessionId,
              createdAt: new Date(),
            }),
          )
          yield* storage.createMessage(
            Message.Regular.make({
              id: messageId,
              sessionId,
              branchId,
              role: "user",
              parts: [new TextPart({ type: "text", text: "versioned fts projection" })],
              createdAt: new Date(),
            }),
          )
          const sql = yield* SqlClient.SqlClient
          const version = yield* sql<{
            value: string
          }>`SELECT value FROM storage_meta WHERE key = ${"messages_fts_schema_version"}`
          expect(version[0]?.value).toBe("1")
        }).pipe(Effect.provide(layer))

        const db = new Database(dbPath)
        db.query(`DELETE FROM messages_fts WHERE message_id = ?`).run(messageId)
        db.close()

        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const version = yield* sql<{
            value: string
          }>`SELECT value FROM storage_meta WHERE key = ${"messages_fts_schema_version"}`
          const ftsRows = yield* sql<{
            count: number
          }>`SELECT COUNT(*) as count FROM messages_fts WHERE message_id = ${messageId}`
          expect(version[0]?.value).toBe("1")
          expect(ftsRows[0]?.count).toBe(0)
        }).pipe(Effect.provide(layer))
      }),
    )
    it.live("rejects orphan branch, message, and event rows", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const sql = yield* SqlClient.SqlClient
        const now = Date.now()
        const branchExit = yield* Effect.exit(
          sql`INSERT INTO branches (id, session_id, name, created_at) VALUES (${"orphan-branch"}, ${"missing-session"}, ${null}, ${now})`,
        )
        expect(branchExit._tag).toBe("Failure")
        yield* storage.createSession(
          new Session({
            id: SessionId.make("fk-session"),
            createdAt: new Date(now),
            updatedAt: new Date(now),
          }),
        )
        const messageExit = yield* Effect.exit(
          sql`INSERT INTO messages (id, session_id, branch_id, role, parts, created_at, turn_duration_ms) VALUES (${"orphan-message"}, ${"fk-session"}, ${"missing-branch"}, ${"user"}, ${"[]"}, ${now}, ${null})`,
        )
        expect(messageExit._tag).toBe("Failure")
        const eventExit = yield* Effect.exit(
          sql`INSERT INTO events (session_id, branch_id, event_tag, event_json, created_at) VALUES (${"missing-session"}, NULL, ${"SessionStarted"}, ${"{}"}, ${now})`,
        )
        expect(eventExit._tag).toBe("Failure")
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    it.live("rejects invalid session parent and active branch relationships", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const sql = yield* SqlClient.SqlClient
        const now = new Date()
        yield* storage.createSession(
          new Session({ id: SessionId.make("parent-a"), createdAt: now, updatedAt: now }),
        )
        yield* storage.createBranch(
          new Branch({
            id: BranchId.make("parent-a-branch"),
            sessionId: SessionId.make("parent-a"),
            createdAt: now,
          }),
        )
        yield* storage.createSession(
          new Session({ id: SessionId.make("parent-b"), createdAt: now, updatedAt: now }),
        )
        yield* storage.createBranch(
          new Branch({
            id: BranchId.make("parent-b-branch"),
            sessionId: SessionId.make("parent-b"),
            createdAt: now,
          }),
        )
        const orphanParentExit = yield* Effect.exit(
          sql`INSERT INTO sessions (id, parent_session_id, created_at, updated_at) VALUES (${"orphan-child"}, ${"missing-parent"}, ${now.getTime()}, ${now.getTime()})`,
        )
        expect(orphanParentExit._tag).toBe("Failure")
        const wrongParentBranchExit = yield* Effect.exit(
          sql`INSERT INTO sessions (id, parent_session_id, parent_branch_id, created_at, updated_at) VALUES (${"wrong-parent-branch"}, ${"parent-a"}, ${"parent-b-branch"}, ${now.getTime()}, ${now.getTime()})`,
        )
        expect(wrongParentBranchExit._tag).toBe("Failure")
        const danglingParentBranchExit = yield* Effect.exit(
          sql`INSERT INTO sessions (id, parent_branch_id, created_at, updated_at) VALUES (${"dangling-parent-branch"}, ${"parent-a-branch"}, ${now.getTime()}, ${now.getTime()})`,
        )
        expect(danglingParentBranchExit._tag).toBe("Failure")
        const missingActiveBranchExit = yield* Effect.exit(
          sql`INSERT INTO sessions (id, active_branch_id, created_at, updated_at) VALUES (${"missing-active"}, ${"missing-branch"}, ${now.getTime()}, ${now.getTime()})`,
        )
        expect(missingActiveBranchExit._tag).toBe("Failure")
        const wrongActiveBranchExit = yield* Effect.exit(
          sql`INSERT INTO sessions (id, active_branch_id, created_at, updated_at) VALUES (${"wrong-active"}, ${"parent-b-branch"}, ${now.getTime()}, ${now.getTime()})`,
        )
        expect(wrongActiveBranchExit._tag).toBe("Failure")
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    it.live("rejects parent branch without parent session through storage service", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const now = new Date()
        const exit = yield* Effect.exit(
          storage.createSession(
            new Session({
              id: SessionId.make("storage-dangling-parent-branch"),
              parentBranchId: BranchId.make("missing-parent-branch"),
              createdAt: now,
              updatedAt: now,
            }),
          ),
        )
        expect(exit._tag).toBe("Failure")
        expect(
          yield* storage.getSession(SessionId.make("storage-dangling-parent-branch")),
        ).toBeUndefined()
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    it.live("rejects branch creation with a parent branch outside the same session", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const sql = yield* SqlClient.SqlClient
        const now = new Date()
        yield* storage.createSession(
          new Session({ id: SessionId.make("branch-parent-a"), createdAt: now, updatedAt: now }),
        )
        yield* storage.createSession(
          new Session({ id: SessionId.make("branch-parent-b"), createdAt: now, updatedAt: now }),
        )
        yield* storage.createBranch(
          new Branch({
            id: BranchId.make("branch-parent-a-root"),
            sessionId: SessionId.make("branch-parent-a"),
            createdAt: now,
          }),
        )
        const exit = yield* Effect.exit(
          storage.createBranch(
            new Branch({
              id: BranchId.make("branch-parent-b-child"),
              sessionId: SessionId.make("branch-parent-b"),
              parentBranchId: BranchId.make("branch-parent-a-root"),
              createdAt: now,
            }),
          ),
        )
        expect(exit._tag).toBe("Failure")
        expect(yield* storage.getBranch(BranchId.make("branch-parent-b-child"))).toBeUndefined()
        const directInsertExit = yield* Effect.exit(
          sql`INSERT INTO branches (id, session_id, parent_branch_id, created_at) VALUES (${"branch-parent-b-direct-child"}, ${"branch-parent-b"}, ${"branch-parent-a-root"}, ${now.getTime()})`,
        )
        expect(directInsertExit._tag).toBe("Failure")
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    it.live("rejects deleting branches that own child branches or child sessions", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const sql = yield* SqlClient.SqlClient
        const now = new Date()
        yield* storage.createSession(
          new Session({
            id: SessionId.make("delete-parent-session"),
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: BranchId.make("delete-parent-root"),
            sessionId: SessionId.make("delete-parent-session"),
            createdAt: now,
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: BranchId.make("delete-parent-child"),
            sessionId: SessionId.make("delete-parent-session"),
            parentBranchId: BranchId.make("delete-parent-root"),
            createdAt: now,
          }),
        )
        const childBranchExit = yield* Effect.exit(
          storage.deleteBranch(BranchId.make("delete-parent-root")),
        )
        expect(childBranchExit._tag).toBe("Failure")
        expect(yield* storage.getBranch(BranchId.make("delete-parent-root"))).toBeDefined()
        const directChildBranchExit = yield* Effect.exit(
          sql`DELETE FROM branches WHERE id = ${"delete-parent-root"}`,
        )
        expect(directChildBranchExit._tag).toBe("Failure")
        expect(yield* storage.getBranch(BranchId.make("delete-parent-root"))).toBeDefined()
        yield* storage.createSession(
          new Session({
            id: SessionId.make("delete-child-session"),
            parentSessionId: SessionId.make("delete-parent-session"),
            parentBranchId: BranchId.make("delete-parent-child"),
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: BranchId.make("delete-child-session-branch"),
            sessionId: SessionId.make("delete-child-session"),
            createdAt: now,
          }),
        )
        const childSessionExit = yield* Effect.exit(
          storage.deleteBranch(BranchId.make("delete-parent-child")),
        )
        expect(childSessionExit._tag).toBe("Failure")
        expect(yield* storage.getBranch(BranchId.make("delete-parent-child"))).toBeDefined()
        expect(yield* storage.getSession(SessionId.make("delete-child-session"))).toBeDefined()
        const directChildSessionExit = yield* Effect.exit(
          sql`DELETE FROM branches WHERE id = ${"delete-parent-child"}`,
        )
        expect(directChildSessionExit._tag).toBe("Failure")
        expect(yield* storage.getBranch(BranchId.make("delete-parent-child"))).toBeDefined()
        expect(yield* storage.getSession(SessionId.make("delete-child-session"))).toBeDefined()
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    it.live("deletes session children and storage projections", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const sql = yield* SqlClient.SqlClient
        const now = new Date()
        const sessionId = SessionId.make("cascade-session")
        const branchId = BranchId.make("cascade-branch")
        const childSessionId = SessionId.make("cascade-child-session")
        const childBranchId = BranchId.make("cascade-child-branch")
        yield* storage.createSession(
          new Session({
            id: sessionId,
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: branchId,
            sessionId,
            createdAt: now,
          }),
        )
        yield* storage.createSession(
          new Session({
            id: childSessionId,
            parentSessionId: sessionId,
            parentBranchId: branchId,
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: childBranchId,
            sessionId: childSessionId,
            createdAt: now,
          }),
        )
        yield* storage.createMessage(
          Message.Regular.make({
            id: MessageId.make("cascade-message"),
            sessionId,
            branchId,
            role: "user",
            parts: [new TextPart({ type: "text", text: "cascade projection" })],
            createdAt: now,
          }),
        )
        yield* storage.createMessage(
          Message.Regular.make({
            id: MessageId.make("cascade-child-message"),
            sessionId: childSessionId,
            branchId: childBranchId,
            role: "user",
            parts: [new TextPart({ type: "text", text: "cascade child projection" })],
            createdAt: now,
          }),
        )
        yield* storage.appendEvent(
          AgentSwitched.make({
            sessionId,
            branchId,
            fromAgent: "cowork",
            toAgent: "deepwork",
          }),
        )
        const cascadedIds = yield* storage.deleteSession(sessionId)
        const sessions = yield* sql<{
          count: number
        }>`SELECT COUNT(*) as count FROM sessions`
        const branches = yield* sql<{
          count: number
        }>`SELECT COUNT(*) as count FROM branches`
        const messages = yield* sql<{
          count: number
        }>`SELECT COUNT(*) as count FROM messages`
        const events = yield* sql<{
          count: number
        }>`SELECT COUNT(*) as count FROM events`
        const refs = yield* sql<{
          count: number
        }>`SELECT COUNT(*) as count FROM message_chunks`
        const chunks = yield* sql<{
          count: number
        }>`SELECT COUNT(*) as count FROM content_chunks`
        const fts = yield* sql<{
          count: number
        }>`SELECT COUNT(*) as count FROM messages_fts`
        expect(sessions[0]?.count).toBe(0)
        expect(branches[0]?.count).toBe(0)
        expect(messages[0]?.count).toBe(0)
        expect(events[0]?.count).toBe(0)
        expect(refs[0]?.count).toBe(0)
        expect(chunks[0]?.count).toBe(0)
        expect(fts[0]?.count).toBe(0)
        expect([...cascadedIds].sort()).toEqual([sessionId, childSessionId].sort())
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    it.live("returns the cascade set for a no-op delete of an already-removed session", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const cascadedIds = yield* storage.deleteSession(SessionId.make("never-existed"))
        expect(cascadedIds).toEqual([])
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    // Observable post-state contract (sqlite-storage.ts:1204-1209):
    // when `deleteSession(parent)` races with concurrent
    // `createSession(child of parent)`, the durable state must satisfy:
    //   1. parent is gone;
    //   2. parent appears in the returned `cascadedIds`;
    //   3. no row in `sessions` has `parent_session_id = parent`;
    //   4. every id in `cascadedIds` is actually absent from `sessions` —
    //      callers use this set to clean runtime state (loops, streams,
    //      cwd-registry) and a divergence would leak ghost entries;
    //   5. every child create that *succeeded* is either in `cascadedIds`
    //      or still present in the DB — a partial-cascade bug that
    //      silently drops a child from the returned set without leaving
    //      it in the DB would fail this invariant.
    // The bun:sqlite driver serializes SQL calls, so this test cannot
    // independently prove the `withTransaction` boundary is load-bearing
    // (FK enforcement does most of the heavy lifting). It pins the public
    // contract: a regression that returned a stale or partial cascade set
    // while still completing the delete would fail invariants 2, 4, or 5.
    it.live("deleteSession racing with concurrent child createSession leaves no orphan rows", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const sql = yield* SqlClient.SqlClient
        const now = new Date()
        const parentId = SessionId.make("race-parent")
        const parentBranchId = BranchId.make("race-parent-branch")
        yield* storage.createSession(new Session({ id: parentId, createdAt: now, updatedAt: now }))
        yield* storage.createBranch(
          new Branch({ id: parentBranchId, sessionId: parentId, createdAt: now }),
        )
        // Pre-create K children before the race so the cascade has a
        // non-vacuous set to return. These MUST appear in cascadedIds
        // (they exist when the delete tx's SELECT runs).
        const K = 8
        const preChildIds = Array.from({ length: K }, (_, i) =>
          SessionId.make(`race-pre-child-${i}`),
        )
        for (const id of preChildIds) {
          yield* storage.createSession(
            new Session({
              id,
              parentSessionId: parentId,
              parentBranchId,
              createdAt: now,
              updatedAt: now,
            }),
          )
        }
        const N = 24
        const childIds = Array.from({ length: N }, (_, i) => SessionId.make(`race-child-${i}`))
        // Race the delete against N concurrent child creates. Each child
        // create may either:
        //   (a) commit before the delete tx's SELECT — gets cascaded;
        //   (b) commit after the delete tx finishes — survives, parent gone
        //       (FK violation: should fail at commit time);
        //   (c) commit while delete tx is in flight — serialized by sqlite.
        // Use Effect.exit so individual failures (FK violations) don't
        // short-circuit the race; we'll inspect the durable state directly.
        const createChild = (id: SessionId) =>
          Effect.exit(
            storage.createSession(
              new Session({
                id,
                parentSessionId: parentId,
                parentBranchId,
                createdAt: now,
                updatedAt: now,
              }),
            ),
          )
        const [cascadedIds, childExits] = yield* Effect.all(
          [
            storage.deleteSession(parentId),
            Effect.forEach(childIds, createChild, { concurrency: "unbounded" }),
          ],
          { concurrency: "unbounded" },
        )
        // Invariant 1+2: parent is gone, and parent is in the returned set.
        const parentRows = yield* sql<{
          count: number
        }>`SELECT COUNT(*) as count FROM sessions WHERE id = ${parentId}`
        expect(parentRows[0]?.count).toBe(0)
        expect(cascadedIds).toContain(parentId)
        // Invariant 2b: every pre-existing child must be in cascadedIds.
        // These rows existed when the delete tx began, so the recursive
        // descendant SELECT must have seen them. A partial-cascade bug
        // that returned only `[parentId]` while still cascading children
        // via FK would fail this — callers would never know to clean
        // those children's runtime state.
        for (const id of preChildIds) {
          expect(cascadedIds).toContain(id)
        }
        // Invariant 3: no child row points at the removed parent. Children
        // that landed before the delete were cascaded; children that tried
        // to land after were rejected by the FK or cascaded together.
        const orphanRows = yield* sql<{
          count: number
        }>`SELECT COUNT(*) as count FROM sessions WHERE parent_session_id = ${parentId}`
        expect(orphanRows[0]?.count).toBe(0)
        // Invariant 4: every id the storage layer reports as cascaded is
        // gone from the DB. The caller uses this set to clean runtime
        // state (loops, streams, cwd-registry) — a divergence here would
        // leak ghost entries pointing at deleted sessions.
        for (const id of cascadedIds) {
          const rows = yield* sql<{
            count: number
          }>`SELECT COUNT(*) as count FROM sessions WHERE id = ${id}`
          expect(rows[0]?.count).toBe(0)
        }
        // Invariant 5: every child create that *succeeded* is either in
        // `cascadedIds` (the storage layer reported it as cascaded) or
        // still present in the DB. A partial-cascade bug that silently
        // dropped a successfully-created child from the returned set
        // without leaving the row in the DB would fail this check —
        // callers would never know to clean its runtime state.
        const cascadedSet = new Set<SessionId>(cascadedIds)
        for (let i = 0; i < childIds.length; i++) {
          const childId = childIds[i]!
          const exit = childExits[i]!
          if (Exit.isSuccess(exit)) {
            const inCascade = cascadedSet.has(childId)
            const dbRows = yield* sql<{
              count: number
            }>`SELECT COUNT(*) as count FROM sessions WHERE id = ${childId}`
            const inDb = (dbRows[0]?.count ?? 0) > 0
            expect(inCascade || inDb).toBe(true)
          }
        }
      }).pipe(Effect.timeout("5 seconds"), Effect.provide(Storage.TestWithSql())),
    )
    it.live("migrates legacy storage tables to enforced foreign keys", () =>
      Effect.gen(function* () {
        const dir = mkdtempSync(join(tmpdir(), "gent-fk-migration-"))
        const dbPath = join(dir, "gent.db")
        yield* Effect.acquireUseRelease(
          Effect.void,
          () =>
            Effect.gen(function* () {
              const db = new Database(dbPath)
              db.run(`
          CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            name TEXT,
            cwd TEXT,
            bypass INTEGER,
            reasoning_level TEXT,
            active_branch_id TEXT,
            parent_session_id TEXT,
            parent_branch_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `)
              db.run(`
          CREATE TABLE branches (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            parent_branch_id TEXT,
            parent_message_id TEXT,
            name TEXT,
            created_at INTEGER NOT NULL
          )
        `)
              db.run(`
          CREATE TABLE messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            branch_id TEXT NOT NULL,
            role TEXT NOT NULL,
            parts TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            turn_duration_ms INTEGER
          )
        `)
              db.run(`
          CREATE TABLE content_chunks (
            id TEXT PRIMARY KEY,
            part_type TEXT NOT NULL,
            part_json TEXT NOT NULL
          )
        `)
              db.run(`
          CREATE TABLE message_chunks (
            message_id TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            chunk_id TEXT NOT NULL,
            PRIMARY KEY (message_id, ordinal)
          )
        `)
              db.run(`
          CREATE TABLE events (
            id INTEGER PRIMARY KEY,
            session_id TEXT NOT NULL,
            branch_id TEXT,
            event_tag TEXT NOT NULL,
            event_json TEXT NOT NULL,
            created_at INTEGER NOT NULL
          )
        `)
              db.run(`
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
            last_error TEXT
          )
        `)
              db.run(`
          CREATE TABLE agent_loop_checkpoints (
            session_id TEXT NOT NULL,
            branch_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            state_tag TEXT NOT NULL,
            state_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (session_id, branch_id)
          )
        `)
              db.run(`
	          CREATE TABLE interaction_requests (
	            request_id TEXT PRIMARY KEY,
	            type TEXT NOT NULL,
            session_id TEXT NOT NULL,
            branch_id TEXT NOT NULL,
            params_json TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
	            created_at INTEGER NOT NULL
	          )
	        `)
              db.run(`
	          CREATE TABLE extension_state (
	            session_id TEXT NOT NULL,
	            extension_id TEXT NOT NULL,
	            state_json TEXT NOT NULL,
	            updated_at INTEGER NOT NULL,
	            PRIMARY KEY (session_id, extension_id),
	            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
	          )
	        `)
              db.run(
                `INSERT INTO sessions (id, name, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                  "legacy-session",
                  "legacy",
                  "missing-active",
                  "missing-parent",
                  "missing-branch",
                  0,
                  0,
                ],
              )
              db.run(
                `INSERT INTO sessions (id, name, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                ["other-session", "other", null, null, null, 0, 0],
              )
              db.run(
                `INSERT INTO branches (id, session_id, name, created_at) VALUES (?, ?, ?, ?)`,
                ["valid-branch", "legacy-session", "main", 0],
              )
              db.run(
                `INSERT INTO branches (id, session_id, name, created_at) VALUES (?, ?, ?, ?)`,
                ["other-branch", "other-session", "other", 0],
              )
              db.run(
                `INSERT INTO branches (id, session_id, parent_branch_id, name, created_at) VALUES (?, ?, ?, ?, ?)`,
                ["missing-parent-child", "legacy-session", "missing-parent-branch", "child", 0],
              )
              db.run(
                `INSERT INTO branches (id, session_id, parent_branch_id, name, created_at) VALUES (?, ?, ?, ?, ?)`,
                ["cross-session-child", "legacy-session", "other-branch", "cross", 0],
              )
              db.run(
                `INSERT INTO branches (id, session_id, name, created_at) VALUES (?, ?, ?, ?)`,
                ["orphan-branch", "missing-session", "orphan", 0],
              )
              db.run(
                `INSERT INTO messages (id, session_id, branch_id, role, parts, created_at, turn_duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                  "valid-message",
                  "legacy-session",
                  "valid-branch",
                  "user",
                  JSON.stringify([{ type: "text", text: "survives migration" }]),
                  1,
                  null,
                ],
              )
              db.run(
                `INSERT INTO messages (id, session_id, branch_id, role, parts, created_at, turn_duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                ["orphan-message", "legacy-session", "missing-branch", "user", "[]", 2, null],
              )
              db.run(
                `INSERT INTO messages (id, session_id, branch_id, role, parts, created_at, turn_duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                ["mismatched-message", "other-session", "valid-branch", "user", "[]", 3, null],
              )
              db.run(`INSERT INTO content_chunks (id, part_type, part_json) VALUES (?, ?, ?)`, [
                "orphan-chunk",
                "text",
                JSON.stringify({ type: "text", text: "orphan" }),
              ])
              db.run(
                `INSERT INTO message_chunks (message_id, ordinal, chunk_id) VALUES (?, ?, ?)`,
                ["missing-message", 0, "orphan-chunk"],
              )
              db.run(
                `INSERT INTO events (session_id, branch_id, event_tag, event_json, created_at) VALUES (?, ?, ?, ?, ?)`,
                ["legacy-session", "valid-branch", "AgentSwitched", "{}", 4],
              )
              db.run(
                `INSERT INTO events (session_id, branch_id, event_tag, event_json, created_at) VALUES (?, ?, ?, ?, ?)`,
                ["missing-session", null, "AgentSwitched", "{}", 5],
              )
              db.run(
                `INSERT INTO events (session_id, branch_id, event_tag, event_json, created_at) VALUES (?, ?, ?, ?, ?)`,
                ["legacy-session", "missing-branch", "AgentSwitched", "{}", 6],
              )
              db.run(
                `INSERT INTO actor_inbox (command_id, session_id, branch_id, command_kind, payload_json, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  "valid-command",
                  "legacy-session",
                  "valid-branch",
                  "test",
                  "{}",
                  "pending",
                  0,
                  7,
                  7,
                ],
              )
              db.run(
                `INSERT INTO actor_inbox (command_id, session_id, branch_id, command_kind, payload_json, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  "missing-branch-command",
                  "legacy-session",
                  "missing-branch",
                  "test",
                  "{}",
                  "pending",
                  0,
                  8,
                  8,
                ],
              )
              db.run(
                `INSERT INTO actor_inbox (command_id, session_id, branch_id, command_kind, payload_json, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  "mismatched-command",
                  "legacy-session",
                  "other-branch",
                  "test",
                  "{}",
                  "pending",
                  0,
                  9,
                  9,
                ],
              )
              db.run(
                `INSERT INTO agent_loop_checkpoints (session_id, branch_id, version, state_tag, state_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
                ["legacy-session", "valid-branch", 1, "Idle", "{}", 10],
              )
              db.run(
                `INSERT INTO agent_loop_checkpoints (session_id, branch_id, version, state_tag, state_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
                ["legacy-session", "missing-branch", 1, "Idle", "{}", 11],
              )
              db.run(
                `INSERT INTO agent_loop_checkpoints (session_id, branch_id, version, state_tag, state_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
                ["other-session", "valid-branch", 1, "Idle", "{}", 12],
              )
              db.run(
                `INSERT INTO interaction_requests (request_id, type, session_id, branch_id, params_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                  "valid-request",
                  "approval",
                  "legacy-session",
                  "valid-branch",
                  "{}",
                  "pending",
                  13,
                ],
              )
              db.run(
                `INSERT INTO interaction_requests (request_id, type, session_id, branch_id, params_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                  "missing-branch-request",
                  "approval",
                  "legacy-session",
                  "missing-branch",
                  "{}",
                  "pending",
                  14,
                ],
              )
              db.run(
                `INSERT INTO interaction_requests (request_id, type, session_id, branch_id, params_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                  "mismatched-request",
                  "approval",
                  "legacy-session",
                  "other-branch",
                  "{}",
                  "pending",
                  15,
                ],
              )
              db.run(
                `INSERT INTO extension_state (session_id, extension_id, state_json, updated_at) VALUES (?, ?, ?, ?)`,
                ["missing-session", "legacy-extension", "{}", 16],
              )
              db.close()
              const unpreparedDbPath = join(dir, "unprepared.db")
              copyFileSync(dbPath, unpreparedDbPath)
              const unpreparedLayer = Storage.LiveWithSql(unpreparedDbPath).pipe(
                Layer.provide(BunFileSystem.layer),
                Layer.provide(BunServices.layer),
              )
              const unpreparedOpen = yield* Effect.exit(
                Effect.gen(function* () {
                  yield* Storage
                }).pipe(Effect.provide(unpreparedLayer)),
              )
              expect(unpreparedOpen._tag).toBe("Failure")
              if (unpreparedOpen._tag === "Failure") {
                const fail = unpreparedOpen.cause.reasons.find(Cause.isFailReason)
                expect(fail?.error).toBeInstanceOf(StorageError)
                expect(fail?.error.message).toContain("SQLite foreign key integrity check failed")
              }
              const orphanBeforeRepair = new Database(unpreparedDbPath)
              const orphanBeforeRepairRows = orphanBeforeRepair
                .query<{ count: number }, []>(
                  `SELECT COUNT(*) as count FROM branches WHERE id = 'orphan-branch'`,
                )
                .all()
              expect(orphanBeforeRepairRows[0]?.count).toBe(1)
              const retiredBeforeRepairRows = orphanBeforeRepair
                .query<{ count: number }, []>(
                  `SELECT COUNT(*) as count FROM sqlite_schema WHERE type = 'table' AND name = 'extension_state'`,
                )
                .all()
              expect(retiredBeforeRepairRows[0]?.count).toBe(1)
              orphanBeforeRepair.close()
              yield* repairSqliteForeignKeyOrphans.pipe(
                Effect.provide(Layer.orDie(SqliteClient.layer({ filename: dbPath }))),
              )
              const layer = Storage.LiveWithSql(dbPath).pipe(
                Layer.provide(BunFileSystem.layer),
                Layer.provide(BunServices.layer),
              )
              yield* Effect.gen(function* () {
                const storage = yield* Storage
                const sql = yield* SqlClient.SqlClient
                const session = yield* storage.getSession(SessionId.make("legacy-session"))
                expect(session?.activeBranchId).toBeUndefined()
                expect(session?.parentSessionId).toBeUndefined()
                expect(session?.parentBranchId).toBeUndefined()
                const repairedBranches = yield* storage.listBranches(
                  SessionId.make("legacy-session"),
                )
                expect(
                  repairedBranches.find((branch) => branch.id === "missing-parent-child")
                    ?.parentBranchId,
                ).toBeUndefined()
                expect(
                  repairedBranches.find((branch) => branch.id === "cross-session-child")
                    ?.parentBranchId,
                ).toBeUndefined()
                const message = yield* storage.getMessage(MessageId.make("valid-message"))
                expect(message?.parts).toEqual([
                  new TextPart({ type: "text", text: "survives migration" }),
                ])
                const fkCheck = yield* sql<{
                  table: string
                  rowid: number | null
                  parent: string
                  fkid: number
                }>`PRAGMA foreign_key_check`
                expect(fkCheck).toEqual([])
                const branchParents = yield* sql<{
                  table: string
                }>`PRAGMA foreign_key_list(branches)`
                const messageParents = yield* sql<{
                  table: string
                }>`PRAGMA foreign_key_list(messages)`
                const eventParents = yield* sql<{
                  table: string
                }>`PRAGMA foreign_key_list(events)`
                const sessionParents = yield* sql<{
                  table: string
                }>`PRAGMA foreign_key_list(sessions)`
                const sessionSchema = yield* sql<{
                  sql: string | null
                }>`
              SELECT sql FROM sqlite_schema WHERE type = ${"table"} AND name = ${"sessions"}
            `
                expect(sessionParents.map((row) => row.table)).toEqual(
                  expect.arrayContaining(["branches", "sessions"]),
                )
                expect(sessionSchema[0]?.sql ?? "").toContain(
                  "CHECK (parent_branch_id IS NULL OR parent_session_id IS NOT NULL)",
                )
                expect(branchParents.map((row) => row.table)).toContain("sessions")
                expect(branchParents.map((row) => row.table)).toContain("branches")
                expect(messageParents.map((row) => row.table)).toEqual(
                  expect.arrayContaining(["branches", "sessions"]),
                )
                expect(eventParents.map((row) => row.table)).toEqual(
                  expect.arrayContaining(["branches", "sessions"]),
                )
                const orphanBranches = yield* sql<{
                  count: number
                }>`SELECT COUNT(*) as count FROM branches WHERE id = ${"orphan-branch"}`
                const orphanMessages = yield* sql<{
                  count: number
                }>`SELECT COUNT(*) as count FROM messages WHERE id IN (${"orphan-message"}, ${"mismatched-message"})`
                const orphanChunks = yield* sql<{
                  count: number
                }>`SELECT COUNT(*) as count FROM content_chunks WHERE id = ${"orphan-chunk"}`
                const orphanEvents = yield* sql<{
                  count: number
                }>`SELECT COUNT(*) as count FROM events WHERE created_at IN (${5}, ${6})`
                const orphanActorInbox = yield* sql<{
                  count: number
                }>`SELECT COUNT(*) as count FROM actor_inbox WHERE command_id IN (${"missing-branch-command"}, ${"mismatched-command"})`
                const orphanCheckpoints = yield* sql<{
                  count: number
                }>`SELECT COUNT(*) as count FROM agent_loop_checkpoints WHERE updated_at IN (${11}, ${12})`
                const orphanInteractions = yield* sql<{
                  count: number
                }>`SELECT COUNT(*) as count FROM interaction_requests WHERE request_id IN (${"missing-branch-request"}, ${"mismatched-request"})`
                const retiredExtensionState = yield* sql<{
                  count: number
                }>`SELECT COUNT(*) as count FROM sqlite_schema WHERE type = ${"table"} AND name = ${"extension_state"}`
                expect(orphanBranches[0]?.count).toBe(0)
                expect(orphanMessages[0]?.count).toBe(0)
                expect(orphanChunks[0]?.count).toBe(0)
                expect(orphanEvents[0]?.count).toBe(0)
                expect(orphanActorInbox[0]?.count).toBe(0)
                expect(orphanCheckpoints[0]?.count).toBe(0)
                expect(orphanInteractions[0]?.count).toBe(0)
                expect(retiredExtensionState[0]?.count).toBe(0)
                const rejected = yield* Effect.exit(
                  sql`INSERT INTO messages (id, session_id, branch_id, role, parts, created_at, turn_duration_ms) VALUES (${"new-orphan"}, ${"legacy-session"}, ${"missing-branch"}, ${"user"}, ${"[]"}, ${7}, ${null})`,
                )
                expect(rejected._tag).toBe("Failure")
                const invalidSession = yield* Effect.exit(
                  sql`INSERT INTO sessions (id, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at) VALUES (${"new-invalid-session"}, ${"valid-branch"}, ${"other-session"}, ${"valid-branch"}, ${8}, ${8})`,
                )
                expect(invalidSession._tag).toBe("Failure")
                const danglingParentBranch = yield* Effect.exit(
                  sql`INSERT INTO sessions (id, parent_branch_id, created_at, updated_at) VALUES (${"new-dangling-parent-branch"}, ${"valid-branch"}, ${8}, ${8})`,
                )
                expect(danglingParentBranch._tag).toBe("Failure")
                const invalidBranch = yield* Effect.exit(
                  sql`INSERT INTO branches (id, session_id, parent_branch_id, created_at) VALUES (${"new-invalid-branch"}, ${"legacy-session"}, ${"other-branch"}, ${8})`,
                )
                expect(invalidBranch._tag).toBe("Failure")
                yield* sql.withTransaction(
                  Effect.gen(function* () {
                    yield* sql`INSERT INTO sessions (id, active_branch_id, created_at, updated_at) VALUES (${"new-valid-session"}, ${"new-valid-branch"}, ${9}, ${9})`
                    yield* sql`INSERT INTO branches (id, session_id, created_at) VALUES (${"new-valid-branch"}, ${"new-valid-session"}, ${9})`
                  }),
                )
                const validSession = yield* storage.getSession(SessionId.make("new-valid-session"))
                expect(validSession?.activeBranchId).toBe(BranchId.make("new-valid-branch"))
              }).pipe(Effect.provide(layer))
            }),
          () =>
            Effect.sync(() => {
              rmSync(dir, { recursive: true, force: true })
            }),
        )
      }),
    )
    it.live("migrated legacy schema matches fresh schema", () =>
      Effect.gen(function* () {
        const freshSchema = yield* schemaProjection().pipe(Effect.provide(Storage.TestWithSql()))
        const dir = mkdtempSync(join(tmpdir(), "gent-schema-equivalence-"))
        const dbPath = join(dir, "gent.db")
        yield* Effect.acquireUseRelease(
          createLegacyStorageSchema(dbPath),
          () =>
            Effect.gen(function* () {
              const migratedLayer = Storage.LiveWithSql(dbPath).pipe(
                Layer.provide(BunFileSystem.layer),
                Layer.provide(BunServices.layer),
              )
              const migratedSchema = yield* schemaProjection().pipe(Effect.provide(migratedLayer))
              expect(migratedSchema).toEqual(freshSchema)
            }),
          () => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
        )
      }),
    )
    it.live("deletes cyclic legacy child sessions without recursive CTE loops", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const sql = yield* SqlClient.SqlClient
        yield* sql`PRAGMA foreign_keys = OFF`
        yield* sql`INSERT INTO sessions (id, parent_session_id, created_at, updated_at) VALUES (${"cycle-a"}, ${"cycle-b"}, ${0}, ${0})`
        yield* sql`INSERT INTO sessions (id, parent_session_id, created_at, updated_at) VALUES (${"cycle-b"}, ${"cycle-a"}, ${0}, ${0})`
        yield* sql`PRAGMA foreign_keys = ON`
        yield* storage.deleteSession(SessionId.make("cycle-a")).pipe(Effect.timeout("1 second"))
        const remaining = yield* sql<{
          count: number
        }>`SELECT COUNT(*) as count FROM sessions`
        expect(remaining[0]?.count).toBe(0)
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    it.live("migrates duplicate pending interactions to one pending row per session branch", () =>
      Effect.gen(function* () {
        yield* Effect.acquireUseRelease(
          Effect.sync(() => mkdtempSync(join(tmpdir(), "gent-interaction-singleton-"))),
          (dir) =>
            Effect.gen(function* () {
              const dbPath = join(dir, "legacy.db")
              const layer = Storage.LiveWithSql(dbPath).pipe(
                Layer.provide(BunFileSystem.layer),
                Layer.provide(BunServices.layer),
              )
              yield* Effect.gen(function* () {
                const storage = yield* Storage
                const sql = yield* SqlClient.SqlClient
                yield* storage.createSession(
                  new Session({
                    id: SessionId.make("legacy-interaction-session"),
                    name: "legacy",
                    createdAt: new Date(0),
                    updatedAt: new Date(0),
                  }),
                )
                yield* storage.createBranch(
                  new Branch({
                    id: BranchId.make("legacy-interaction-branch"),
                    sessionId: SessionId.make("legacy-interaction-session"),
                    name: "main",
                    createdAt: new Date(0),
                  }),
                )
                yield* sql.unsafe(`DROP INDEX idx_interaction_requests_pending_singleton`)
                yield* sql`INSERT INTO interaction_requests (request_id, type, session_id, branch_id, params_json, status, created_at) VALUES (${"old-pending"}, ${"approval"}, ${"legacy-interaction-session"}, ${"legacy-interaction-branch"}, ${"{}"}, ${"pending"}, ${1})`
                yield* sql`INSERT INTO interaction_requests (request_id, type, session_id, branch_id, params_json, status, created_at) VALUES (${"new-pending"}, ${"approval"}, ${"legacy-interaction-session"}, ${"legacy-interaction-branch"}, ${"{}"}, ${"pending"}, ${2})`
              }).pipe(Effect.provide(layer))

              yield* Effect.gen(function* () {
                yield* Storage
                const sql = yield* SqlClient.SqlClient
                const rows = yield* sql<{
                  request_id: string
                  status: string
                }>`SELECT request_id, status FROM interaction_requests ORDER BY request_id`
                expect(rows).toEqual([
                  { request_id: "new-pending", status: "pending" },
                  { request_id: "old-pending", status: "resolved" },
                ])
                const duplicate = yield* Effect.exit(
                  sql`INSERT INTO interaction_requests (request_id, type, session_id, branch_id, params_json, status, created_at) VALUES (${"third-pending"}, ${"approval"}, ${"legacy-interaction-session"}, ${"legacy-interaction-branch"}, ${"{}"}, ${"pending"}, ${3})`,
                )
                expect(duplicate._tag).toBe("Failure")
              }).pipe(Effect.provide(layer))
            }),
          (dir) =>
            Effect.sync(() => {
              rmSync(dir, { recursive: true, force: true })
            }),
        )
      }),
    )
  })
  describe("Events", () => {
    it.live("getLatestEvent returns latest event by tag", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const session = new Session({
          id: SessionId.make("event-session"),
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        const branch = new Branch({
          id: BranchId.make("event-branch"),
          sessionId: SessionId.make("event-session"),
          createdAt: new Date(),
        })
        yield* storage.createSession(session)
        yield* storage.createBranch(branch)
        yield* storage.appendEvent(
          AgentSwitched.make({
            sessionId: session.id,
            branchId: branch.id,
            fromAgent: "cowork",
            toAgent: "deepwork",
          }),
        )
        yield* storage.appendEvent(
          AgentSwitched.make({
            sessionId: session.id,
            branchId: branch.id,
            fromAgent: "deepwork",
            toAgent: "cowork",
          }),
        )
        const latest = yield* storage.getLatestEvent({
          sessionId: session.id,
          branchId: branch.id,
          tags: ["AgentSwitched"],
        })
        expect(latest?._tag).toBe("AgentSwitched")
        if (latest && latest._tag === "AgentSwitched") {
          expect(latest.toAgent).toBe(AgentName.make("cowork"))
        }
      }).pipe(Effect.provide(Storage.Test())),
    )
  })
  describe("Branches", () => {
    it.live("creates and retrieves a branch", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.createSession(
          new Session({
            id: SessionId.make("branch-session"),
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        const branch = new Branch({
          id: BranchId.make("test-branch"),
          sessionId: SessionId.make("branch-session"),
          createdAt: new Date(),
        })
        yield* storage.createBranch(branch)
        const retrieved = yield* storage.getBranch(BranchId.make("test-branch"))
        expect(retrieved).toBeDefined()
        expect(retrieved?.sessionId).toBe(SessionId.make("branch-session"))
      }).pipe(Effect.provide(Storage.Test())),
    )
    it.live("lists branches for a session", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.createSession(
          new Session({
            id: SessionId.make("multi-branch"),
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: BranchId.make("b1"),
            sessionId: SessionId.make("multi-branch"),
            createdAt: new Date(),
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: BranchId.make("b2"),
            sessionId: SessionId.make("multi-branch"),
            parentBranchId: BranchId.make("b1"),
            createdAt: new Date(),
          }),
        )
        const branches = yield* storage.listBranches(SessionId.make("multi-branch"))
        expect(branches.length).toBe(2)
      }).pipe(Effect.provide(Storage.Test())),
    )
    it.live("updates branch summary", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.createSession(
          new Session({
            id: SessionId.make("summary-session"),
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: BranchId.make("summary-branch"),
            sessionId: SessionId.make("summary-session"),
            createdAt: new Date(),
          }),
        )
        yield* storage.updateBranchSummary(BranchId.make("summary-branch"), "Short summary")
        const retrieved = yield* storage.getBranch(BranchId.make("summary-branch"))
        expect(retrieved?.summary).toBe("Short summary")
      }).pipe(Effect.provide(Storage.Test())),
    )
  })
  describe("Messages", () => {
    it.live("creates and retrieves messages", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.createSession(
          new Session({
            id: SessionId.make("msg-session"),
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: BranchId.make("msg-branch"),
            sessionId: SessionId.make("msg-session"),
            createdAt: new Date(),
          }),
        )
        const message = Message.Regular.make({
          id: "msg-1",
          sessionId: SessionId.make("msg-session"),
          branchId: BranchId.make("msg-branch"),
          role: "user",
          parts: [new TextPart({ type: "text", text: "Hello" })],
          createdAt: new Date(),
        })
        yield* storage.createMessage(message)
        const retrieved = yield* storage.getMessage(MessageId.make("msg-1"))
        expect(retrieved).toBeDefined()
        expect(retrieved?.role).toBe("user")
        expect(retrieved?.parts[0]?.type).toBe("text")
      }).pipe(Effect.provide(Storage.Test())),
    )
    it.live("round-trips all persisted transcript part types", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const toolCallId = ToolCallId.make("all-parts-tc")
        yield* storage.createSession(
          new Session({
            id: SessionId.make("all-parts-session"),
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: BranchId.make("all-parts-branch"),
            sessionId: SessionId.make("all-parts-session"),
            createdAt: new Date(),
          }),
        )
        yield* storage.createMessage(
          Message.Regular.make({
            id: "all-parts-msg",
            sessionId: SessionId.make("all-parts-session"),
            branchId: BranchId.make("all-parts-branch"),
            role: "assistant",
            parts: [
              new TextPart({ type: "text", text: "hello" }),
              new ReasoningPart({ type: "reasoning", text: "thinking" }),
              new ImagePart({
                type: "image",
                image: "data:image/webp;base64,abc",
                mediaType: "image/webp",
              }),
              new ToolCallPart({
                type: "tool-call",
                toolCallId,
                toolName: "inspect",
                input: { target: "image" },
              }),
              new ToolResultPart({
                type: "tool-result",
                toolCallId,
                toolName: "inspect",
                output: { type: "json", value: { ok: true } },
              }),
            ],
            createdAt: new Date(),
          }),
        )
        const retrieved = yield* storage.getMessage(MessageId.make("all-parts-msg"))
        expect(retrieved?.parts.map((part) => part.type)).toEqual([
          "text",
          "reasoning",
          "image",
          "tool-call",
          "tool-result",
        ])
        expect(retrieved?.parts[2]).toEqual(
          expect.objectContaining({
            type: "image",
            image: "data:image/webp;base64,abc",
            mediaType: "image/webp",
          }),
        )
        expect(retrieved?.parts[3]).toEqual(
          expect.objectContaining({
            type: "tool-call",
            toolCallId,
            toolName: "inspect",
            input: { target: "image" },
          }),
        )
        expect(retrieved?.parts[4]).toEqual(
          expect.objectContaining({
            type: "tool-result",
            toolCallId,
            toolName: "inspect",
            output: { type: "json", value: { ok: true } },
          }),
        )
      }).pipe(Effect.provide(Storage.Test())),
    )
    it.live("stores message parts in shared content chunks", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const sql = yield* SqlClient.SqlClient
        const sharedPart = new TextPart({ type: "text", text: "dedupe me" })
        yield* storage.createSession(
          new Session({
            id: SessionId.make("chunk-s"),
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: BranchId.make("chunk-b"),
            sessionId: SessionId.make("chunk-s"),
            createdAt: new Date(),
          }),
        )
        yield* storage.createMessage(
          Message.Regular.make({
            id: "chunk-a",
            sessionId: SessionId.make("chunk-s"),
            branchId: BranchId.make("chunk-b"),
            role: "user",
            parts: [sharedPart],
            createdAt: new Date(1000),
          }),
        )
        yield* storage.createMessage(
          Message.Regular.make({
            id: "chunk-b-msg",
            sessionId: SessionId.make("chunk-s"),
            branchId: BranchId.make("chunk-b"),
            role: "assistant",
            parts: [sharedPart],
            createdAt: new Date(2000),
          }),
        )
        const chunkRows = yield* sql<{
          count: number
        }>`SELECT COUNT(*) as count FROM content_chunks`
        const refRows = yield* sql<{
          count: number
        }>`SELECT COUNT(*) as count FROM message_chunks`
        const legacyRows = yield* sql<{
          parts: string
        }>`SELECT parts FROM messages WHERE id = ${"chunk-a"}`
        const messages = yield* storage.listMessages(BranchId.make("chunk-b"))
        expect(chunkRows[0]?.count).toBe(1)
        expect(refRows[0]?.count).toBe(2)
        expect(legacyRows[0]?.parts).toBe("[]")
        expect(messages.map((message) => message.parts)).toEqual([[sharedPart], [sharedPart]])
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    it.live("backfills legacy message blobs into content chunks on startup", () =>
      Effect.gen(function* () {
        const dir = mkdtempSync(join(tmpdir(), "gent-content-chunks-"))
        const dbPath = join(dir, "gent.db")
        yield* Effect.acquireUseRelease(
          Effect.void,
          () =>
            Effect.gen(function* () {
              const db = new Database(dbPath)
              db.run(`
          CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            name TEXT,
            cwd TEXT,
            bypass INTEGER,
            reasoning_level TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `)
              db.run(`
          CREATE TABLE branches (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            parent_branch_id TEXT,
            parent_message_id TEXT,
            name TEXT,
            created_at INTEGER NOT NULL
          )
        `)
              db.run(`
          CREATE TABLE messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            branch_id TEXT NOT NULL,
            role TEXT NOT NULL,
            parts TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            turn_duration_ms INTEGER
          )
        `)
              db.run(`
          CREATE TABLE content_chunks (
            id TEXT PRIMARY KEY,
            part_type TEXT NOT NULL,
            part_json TEXT NOT NULL
          )
        `)
              db.run(`
          CREATE TABLE message_chunks (
            message_id TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            chunk_id TEXT NOT NULL,
            PRIMARY KEY (message_id, ordinal)
          )
        `)
              db.run(
                `INSERT INTO sessions (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
                ["legacy-s", "legacy", 0, 0],
              )
              db.run(
                `INSERT INTO branches (id, session_id, name, created_at) VALUES (?, ?, ?, ?)`,
                ["legacy-b", "legacy-s", "main", 0],
              )
              const firstLegacyPart = { type: "text", text: "legacy searchable content" }
              const secondLegacyPart = { type: "text", text: "second recovered content" }
              db.run(
                `INSERT INTO messages (id, session_id, branch_id, role, parts, created_at, turn_duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                  "legacy-m",
                  "legacy-s",
                  "legacy-b",
                  "user",
                  JSON.stringify([firstLegacyPart, secondLegacyPart]),
                  1000,
                  null,
                ],
              )
              db.run(`INSERT INTO content_chunks (id, part_type, part_json) VALUES (?, ?, ?)`, [
                "partial-chunk",
                "text",
                JSON.stringify(firstLegacyPart),
              ])
              db.run(
                `INSERT INTO message_chunks (message_id, ordinal, chunk_id) VALUES (?, ?, ?)`,
                ["legacy-m", 0, "partial-chunk"],
              )
              db.close()
              const layer = Storage.LiveWithSql(dbPath).pipe(
                Layer.provide(BunFileSystem.layer),
                Layer.provide(BunServices.layer),
              )
              yield* Effect.gen(function* () {
                const storage = yield* Storage
                const sql = yield* SqlClient.SqlClient
                const message = yield* storage.getMessage(MessageId.make("legacy-m"))
                expect(message?.parts).toEqual([
                  new TextPart({ type: "text", text: "legacy searchable content" }),
                  new TextPart({ type: "text", text: "second recovered content" }),
                ])
                const chunkRows = yield* sql<{
                  count: number
                }>`SELECT COUNT(*) as count FROM content_chunks`
                const ftsRows = yield* sql<{
                  count: number
                }>`SELECT COUNT(*) as count FROM messages_fts WHERE messages_fts MATCH ${"recovered"}`
                const legacyRows = yield* sql<{
                  parts: string
                }>`SELECT parts FROM messages WHERE id = ${"legacy-m"}`
                expect(chunkRows[0]?.count).toBe(2)
                expect(ftsRows[0]?.count).toBe(1)
                expect(legacyRows[0]?.parts).toBe("[]")
              }).pipe(Effect.provide(layer))
            }),
          () =>
            Effect.sync(() => {
              rmSync(dir, { recursive: true, force: true })
            }),
        )
      }),
    )
    it.live("backfills legacy MessageReceived events from stored message variants on startup", () =>
      Effect.gen(function* () {
        const dir = mkdtempSync(join(tmpdir(), "gent-message-received-events-"))
        const dbPath = join(dir, "gent.db")
        yield* Effect.acquireUseRelease(
          Effect.void,
          () =>
            Effect.gen(function* () {
              const db = new Database(dbPath)
              db.run(`
          CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            name TEXT,
            cwd TEXT,
            bypass INTEGER,
            reasoning_level TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `)
              db.run(`
          CREATE TABLE branches (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            parent_branch_id TEXT,
            parent_message_id TEXT,
            name TEXT,
            created_at INTEGER NOT NULL
          )
        `)
              db.run(`
          CREATE TABLE messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            branch_id TEXT NOT NULL,
            kind TEXT,
            role TEXT NOT NULL,
            parts TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            turn_duration_ms INTEGER
          )
        `)
              db.run(`
          CREATE TABLE events (
            id INTEGER PRIMARY KEY,
            session_id TEXT NOT NULL,
            branch_id TEXT,
            event_tag TEXT NOT NULL,
            event_json TEXT NOT NULL,
            created_at INTEGER NOT NULL
          )
        `)
              db.run(
                `INSERT INTO sessions (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
                ["legacy-event-s", "legacy-event", 0, 0],
              )
              db.run(
                `INSERT INTO branches (id, session_id, name, created_at) VALUES (?, ?, ?, ?)`,
                ["legacy-event-b", "legacy-event-s", "main", 0],
              )
              db.run(
                `INSERT INTO messages (id, session_id, branch_id, kind, role, parts, created_at, turn_duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  "legacy-event-m",
                  "legacy-event-s",
                  "legacy-event-b",
                  "interjection",
                  "user",
                  JSON.stringify([{ type: "text", text: "interrupt" }]),
                  1000,
                  null,
                ],
              )
              db.run(
                `INSERT INTO events (session_id, branch_id, event_tag, event_json, created_at) VALUES (?, ?, ?, ?, ?)`,
                [
                  "legacy-event-s",
                  null,
                  "MessageReceived",
                  JSON.stringify({
                    _tag: "MessageReceived",
                    sessionId: SessionId.make("legacy-event-s"),
                    branchId: BranchId.make("legacy-event-b"),
                    messageId: MessageId.make("legacy-event-m"),
                    role: "user",
                  }),
                  1001,
                ],
              )
              db.close()
              const layer = Storage.LiveWithSql(dbPath).pipe(
                Layer.provide(BunFileSystem.layer),
                Layer.provide(BunServices.layer),
              )
              yield* Effect.gen(function* () {
                const storage = yield* Storage
                const events = yield* storage.listEvents({
                  sessionId: SessionId.make("legacy-event-s"),
                  branchId: BranchId.make("legacy-event-b"),
                })
                expect(events).toHaveLength(1)
                const event = events[0]?.event
                expect(event?._tag).toBe("MessageReceived")
                if (event?._tag !== "MessageReceived") return
                expect(event.message._tag).toBe("interjection")
                expect(event.message.id).toBe(MessageId.make("legacy-event-m"))
              }).pipe(Effect.provide(layer))
            }),
          () =>
            Effect.sync(() => {
              rmSync(dir, { recursive: true, force: true })
            }),
        )
      }),
    )
    it.live("counts messages in a branch", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.createSession(
          new Session({
            id: SessionId.make("count-session"),
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: BranchId.make("count-branch"),
            sessionId: SessionId.make("count-session"),
            createdAt: new Date(),
          }),
        )
        yield* storage.createMessage(
          Message.Regular.make({
            id: "count-msg-1",
            sessionId: SessionId.make("count-session"),
            branchId: BranchId.make("count-branch"),
            role: "user",
            parts: [new TextPart({ type: "text", text: "one" })],
            createdAt: new Date(),
          }),
        )
        yield* storage.createMessage(
          Message.Regular.make({
            id: "count-msg-2",
            sessionId: SessionId.make("count-session"),
            branchId: BranchId.make("count-branch"),
            role: "assistant",
            parts: [new TextPart({ type: "text", text: "two" })],
            createdAt: new Date(),
          }),
        )
        const count = yield* storage.countMessages(BranchId.make("count-branch"))
        expect(count).toBe(2)
      }).pipe(Effect.provide(Storage.Test())),
    )
    it.live("lists messages for a branch", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.createSession(
          new Session({
            id: SessionId.make("list-msg-session"),
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: BranchId.make("list-msg-branch"),
            sessionId: SessionId.make("list-msg-session"),
            createdAt: new Date(),
          }),
        )
        yield* storage.createMessage(
          Message.Regular.make({
            id: "lm1",
            sessionId: SessionId.make("list-msg-session"),
            branchId: BranchId.make("list-msg-branch"),
            role: "user",
            parts: [new TextPart({ type: "text", text: "First" })],
            createdAt: new Date(),
          }),
        )
        yield* storage.createMessage(
          Message.Regular.make({
            id: "lm2",
            sessionId: SessionId.make("list-msg-session"),
            branchId: BranchId.make("list-msg-branch"),
            role: "assistant",
            parts: [new TextPart({ type: "text", text: "Response" })],
            createdAt: new Date(),
          }),
        )
        const messages = yield* storage.listMessages(BranchId.make("list-msg-branch"))
        expect(messages.length).toBe(2)
        expect(messages[0]?.role).toBe("user")
        expect(messages[1]?.role).toBe("assistant")
      }).pipe(Effect.provide(Storage.Test())),
    )
    it.live("deletes message chunk refs and search projection rows", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const sql = yield* SqlClient.SqlClient
        yield* storage.createSession(
          new Session({
            id: SessionId.make("delete-projection-session"),
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: BranchId.make("delete-projection-branch"),
            sessionId: SessionId.make("delete-projection-session"),
            createdAt: new Date(),
          }),
        )
        yield* storage.createMessage(
          Message.Regular.make({
            id: "delete-projection-a",
            sessionId: SessionId.make("delete-projection-session"),
            branchId: BranchId.make("delete-projection-branch"),
            role: "user",
            parts: [new TextPart({ type: "text", text: "delete projection alpha" })],
            createdAt: new Date(1000),
          }),
        )
        yield* storage.createMessage(
          Message.Regular.make({
            id: "delete-projection-b",
            sessionId: SessionId.make("delete-projection-session"),
            branchId: BranchId.make("delete-projection-branch"),
            role: "assistant",
            parts: [new TextPart({ type: "text", text: "delete projection beta" })],
            createdAt: new Date(2000),
          }),
        )
        yield* storage.deleteMessages(BranchId.make("delete-projection-branch"))
        const messages = yield* sql<{
          count: number
        }>`SELECT COUNT(*) as count FROM messages`
        const refs = yield* sql<{
          count: number
        }>`SELECT COUNT(*) as count FROM message_chunks`
        const chunks = yield* sql<{
          count: number
        }>`SELECT COUNT(*) as count FROM content_chunks`
        const fts = yield* sql<{
          count: number
        }>`SELECT COUNT(*) as count FROM messages_fts`
        expect(messages[0]?.count).toBe(0)
        expect(refs[0]?.count).toBe(0)
        expect(chunks[0]?.count).toBe(0)
        expect(fts[0]?.count).toBe(0)
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    it.live("updates session updatedAt when creating message", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const start = new Date(0)
        const messageTime = new Date(1000)
        yield* storage.createSession(
          new Session({
            id: SessionId.make("session-updated-at"),
            createdAt: start,
            updatedAt: start,
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: BranchId.make("branch-updated-at"),
            sessionId: SessionId.make("session-updated-at"),
            createdAt: start,
          }),
        )
        yield* storage.createMessage(
          Message.Regular.make({
            id: "msg-updated-at",
            sessionId: SessionId.make("session-updated-at"),
            branchId: BranchId.make("branch-updated-at"),
            role: "user",
            parts: [new TextPart({ type: "text", text: "Ping" })],
            createdAt: messageTime,
          }),
        )
        const session = yield* storage.getSession(SessionId.make("session-updated-at"))
        expect(session?.updatedAt.getTime()).toBe(messageTime.getTime())
      }).pipe(Effect.provide(Storage.Test())),
    )
    it.live("rolls back message insert when session timestamp update fails", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const sql = yield* SqlClient.SqlClient
        const start = new Date(0)
        const messageTime = new Date(1000)
        yield* storage.createSession(
          new Session({
            id: SessionId.make("tx-message-session"),
            createdAt: start,
            updatedAt: start,
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: BranchId.make("tx-message-branch"),
            sessionId: SessionId.make("tx-message-session"),
            createdAt: start,
          }),
        )
        yield* sql.unsafe(`
          CREATE TRIGGER tx_fail_session_update
          BEFORE UPDATE ON sessions
          WHEN old.id = 'tx-message-session'
          BEGIN
            SELECT RAISE(ABORT, 'forced session update failure');
          END
        `)
        const error = yield* Effect.flip(
          storage.createMessage(
            Message.Regular.make({
              id: "tx-message",
              sessionId: SessionId.make("tx-message-session"),
              branchId: BranchId.make("tx-message-branch"),
              role: "user",
              parts: [new TextPart({ type: "text", text: "rollback" })],
              createdAt: messageTime,
            }),
          ),
        )
        expect(error._tag).toBe("StorageError")
        expect(yield* storage.getMessage(MessageId.make("tx-message"))).toBeUndefined()
        const session = yield* storage.getSession(SessionId.make("tx-message-session"))
        expect(session?.updatedAt.getTime()).toBe(start.getTime())
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    it.live("createMessageIfAbsent leaves session timestamp unchanged when insert is ignored", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const start = new Date(0)
        const firstTime = new Date(1000)
        const duplicateTime = new Date(2000)
        yield* storage.createSession(
          new Session({
            id: SessionId.make("if-absent-session"),
            createdAt: start,
            updatedAt: start,
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: BranchId.make("if-absent-branch"),
            sessionId: SessionId.make("if-absent-session"),
            createdAt: start,
          }),
        )
        yield* storage.createMessageIfAbsent(
          Message.Regular.make({
            id: "if-absent-message",
            sessionId: SessionId.make("if-absent-session"),
            branchId: BranchId.make("if-absent-branch"),
            role: "user",
            parts: [new TextPart({ type: "text", text: "first" })],
            createdAt: firstTime,
          }),
        )
        yield* storage.createMessageIfAbsent(
          Message.Regular.make({
            id: "if-absent-message",
            sessionId: SessionId.make("if-absent-session"),
            branchId: BranchId.make("if-absent-branch"),
            role: "user",
            parts: [new TextPart({ type: "text", text: "duplicate" })],
            createdAt: duplicateTime,
          }),
        )
        const session = yield* storage.getSession(SessionId.make("if-absent-session"))
        expect(session?.updatedAt.getTime()).toBe(firstTime.getTime())
        const message = yield* storage.getMessage(MessageId.make("if-absent-message"))
        expect(message?.parts).toEqual([new TextPart({ type: "text", text: "first" })])
      }).pipe(Effect.provide(Storage.Test())),
    )
    it.live("orders messages by createdAt then id", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const timestamp = new Date()
        yield* storage.createSession(
          new Session({
            id: SessionId.make("order-session"),
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: BranchId.make("order-branch"),
            sessionId: SessionId.make("order-session"),
            createdAt: timestamp,
          }),
        )
        yield* storage.createMessage(
          Message.Regular.make({
            id: "b",
            sessionId: SessionId.make("order-session"),
            branchId: BranchId.make("order-branch"),
            role: "user",
            parts: [new TextPart({ type: "text", text: "Second" })],
            createdAt: timestamp,
          }),
        )
        yield* storage.createMessage(
          Message.Regular.make({
            id: "a",
            sessionId: SessionId.make("order-session"),
            branchId: BranchId.make("order-branch"),
            role: "user",
            parts: [new TextPart({ type: "text", text: "First" })],
            createdAt: timestamp,
          }),
        )
        const messages = yield* storage.listMessages(BranchId.make("order-branch"))
        expect(messages[0]?.id).toBe(MessageId.make("a"))
        expect(messages[1]?.id).toBe(MessageId.make("b"))
      }).pipe(Effect.provide(Storage.Test())),
    )
  })
  describe("Message Metadata", () => {
    it.live("metadata round-trips through storage", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.createSession(
          new Session({
            id: SessionId.make("meta-s"),
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: BranchId.make("meta-b"),
            sessionId: SessionId.make("meta-s"),
            createdAt: new Date(),
          }),
        )
        const message = Message.Regular.make({
          id: "meta-msg-1",
          sessionId: SessionId.make("meta-s"),
          branchId: BranchId.make("meta-b"),
          role: "user",
          parts: [new TextPart({ type: "text", text: "hello" })],
          createdAt: new Date(),
          metadata: {
            customType: "review-status",
            extensionId: ExtensionId.make("review-loop"),
            hidden: true,
            details: { iteration: 3 },
          },
        })
        yield* storage.createMessage(message)
        const messages = yield* storage.listMessages(BranchId.make("meta-b"))
        expect(messages.length).toBe(1)
        const m = messages[0]!
        expect(m.metadata).toBeDefined()
        expect(m.metadata!.customType).toBe("review-status")
        expect(m.metadata!.extensionId).toBe("review-loop")
        expect(m.metadata!.hidden).toBe(true)
        expect(
          (
            m.metadata!.details as {
              iteration: number
            }
          ).iteration,
        ).toBe(3)
      }).pipe(Effect.provide(Storage.Test())),
    )
    it.live("createMessageIfAbsent preserves metadata", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.createSession(
          new Session({
            id: SessionId.make("upsert-s"),
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: BranchId.make("upsert-b"),
            sessionId: SessionId.make("upsert-s"),
            createdAt: new Date(),
          }),
        )
        const message = Message.Regular.make({
          id: "upsert-msg",
          sessionId: SessionId.make("upsert-s"),
          branchId: BranchId.make("upsert-b"),
          role: "user",
          parts: [new TextPart({ type: "text", text: "follow-up" })],
          createdAt: new Date(),
          metadata: { hidden: true, extensionId: ExtensionId.make("review-loop") },
        })
        yield* storage.createMessageIfAbsent(message)
        const messages = yield* storage.listMessages(BranchId.make("upsert-b"))
        expect(messages.length).toBe(1)
        expect(messages[0]!.metadata).toBeDefined()
        expect(messages[0]!.metadata!.hidden).toBe(true)
        expect(messages[0]!.metadata!.extensionId).toBe("review-loop")
      }).pipe(Effect.provide(Storage.Test())),
    )
    it.live("messages without metadata have undefined metadata", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.createSession(
          new Session({
            id: SessionId.make("no-meta-s"),
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: BranchId.make("no-meta-b"),
            sessionId: SessionId.make("no-meta-s"),
            createdAt: new Date(),
          }),
        )
        yield* storage.createMessage(
          Message.Regular.make({
            id: "no-meta-msg",
            sessionId: SessionId.make("no-meta-s"),
            branchId: BranchId.make("no-meta-b"),
            role: "user",
            parts: [new TextPart({ type: "text", text: "plain" })],
            createdAt: new Date(),
          }),
        )
        const messages = yield* storage.listMessages(BranchId.make("no-meta-b"))
        expect(messages[0]!.metadata).toBeUndefined()
      }).pipe(Effect.provide(Storage.Test())),
    )
    it.live("invalid stored metadata decodes to undefined across read surfaces", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const sql = yield* SqlClient.SqlClient
        yield* storage.createSession(
          new Session({
            id: SessionId.make("bad-meta-s"),
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: BranchId.make("bad-meta-b"),
            sessionId: SessionId.make("bad-meta-s"),
            createdAt: new Date(),
          }),
        )
        yield* sql`INSERT INTO messages (id, session_id, branch_id, kind, role, parts, created_at, turn_duration_ms, metadata) VALUES (${"bad-meta-msg"}, ${"bad-meta-s"}, ${"bad-meta-b"}, ${null}, ${"assistant"}, ${JSON.stringify([{ type: "text", text: "hello" }])}, ${Date.now()}, ${null}, ${'{"customType":1}'})`
        const messages = yield* storage.listMessages(BranchId.make("bad-meta-b"))
        expect(messages).toHaveLength(1)
        expect(messages[0]!.metadata).toBeUndefined()
        const message = yield* storage.getMessage(MessageId.make("bad-meta-msg"))
        expect(message?.metadata).toBeUndefined()
        const detail = yield* storage.getSessionDetail(SessionId.make("bad-meta-s"))
        expect(detail.branches).toHaveLength(1)
        expect(detail.branches[0]!.messages).toHaveLength(1)
        expect(detail.branches[0]!.messages[0]!.metadata).toBeUndefined()
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    test("messageToInfo preserves metadata for transport", () => {
      const message = Message.Regular.make({
        id: "info-msg",
        sessionId: SessionId.make("info-s"),
        branchId: BranchId.make("info-b"),
        role: "assistant",
        parts: [new TextPart({ type: "text", text: "response" })],
        createdAt: new Date(),
        metadata: { customType: "review-status", hidden: true },
      })
      const info = messageToInfo(message)
      expect(info.metadata).toBeDefined()
      expect(info.metadata!.customType).toBe("review-status")
      expect(info.metadata!.hidden).toBe(true)
    })
    it.live("interjection messages round-trip as explicit variants", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.createSession(
          new Session({
            id: SessionId.make("interjection-s"),
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: BranchId.make("interjection-b"),
            sessionId: SessionId.make("interjection-s"),
            createdAt: new Date(),
          }),
        )
        yield* storage.createMessage(
          Message.Interjection.make({
            id: "interjection-msg",
            sessionId: SessionId.make("interjection-s"),
            branchId: BranchId.make("interjection-b"),
            role: "user",
            parts: [new TextPart({ type: "text", text: "steer now" })],
            createdAt: new Date(),
          }),
        )
        const stored = yield* storage.getMessage(MessageId.make("interjection-msg"))
        if (stored === undefined) throw new Error("expected interjection message")
        expect(stored._tag).toBe("interjection")
        const info = messageToInfo(stored)
        expect(info._tag).toBe("interjection")
        expect(info.role).toBe("user")
      }).pipe(Effect.provide(Storage.Test())),
    )
    test("messageToInfo omits metadata when absent", () => {
      const message = Message.Regular.make({
        id: "plain-msg",
        sessionId: SessionId.make("plain-s"),
        branchId: BranchId.make("plain-b"),
        role: "user",
        parts: [new TextPart({ type: "text", text: "hi" })],
        createdAt: new Date(),
      })
      const info = messageToInfo(message)
      expect(info.metadata).toBeUndefined()
    })
  })
  describe("Event backward compatibility", () => {
    const layer = Storage.TestWithSql()
    it.live("listEvents skips events with unknown _tag instead of crashing", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const sql = yield* SqlClient.SqlClient
        const sessionId = SessionId.make("compat-session")
        const branchId = BranchId.make("compat-branch")
        yield* storage.createSession(
          new Session({
            id: sessionId,
            name: "compat",
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* storage.createBranch(new Branch({ id: branchId, sessionId, createdAt: new Date() }))
        yield* storage.appendEvent(SessionStarted.make({ sessionId, branchId }))
        // Simulate old DB row with a deleted event type
        yield* sql`INSERT INTO events (session_id, branch_id, event_tag, event_json, created_at) VALUES (${sessionId}, ${branchId}, 'ToolCallCompleted', ${JSON.stringify({ _tag: "ToolCallCompleted", sessionId, branchId, toolCallId: ToolCallId.make("tc-1"), toolName: "bash" })}, ${Date.now()})`
        yield* storage.appendEvent(SessionStarted.make({ sessionId, branchId }))
        const events = yield* storage.listEvents({ sessionId, branchId })
        expect(events.length).toBe(2)
        expect(events.every((e) => e.event._tag === "SessionStarted")).toBe(true)
      }).pipe(Effect.provide(layer)),
    )
    it.live("getLatestEvent returns undefined for undecodable events", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const sql = yield* SqlClient.SqlClient
        const sessionId = SessionId.make("compat-latest")
        const branchId = BranchId.make("compat-latest-b")
        yield* storage.createSession(
          new Session({
            id: sessionId,
            name: "compat-latest",
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* storage.createBranch(new Branch({ id: branchId, sessionId, createdAt: new Date() }))
        yield* sql`INSERT INTO events (session_id, branch_id, event_tag, event_json, created_at) VALUES (${sessionId}, ${branchId}, 'SubagentCompleted', ${JSON.stringify({ _tag: "SubagentCompleted", sessionId, branchId })}, ${Date.now()})`
        const latest = yield* storage.getLatestEvent({
          sessionId,
          branchId,
          tags: ["SubagentCompleted"],
        })
        expect(latest).toBeUndefined()
      }).pipe(Effect.provide(layer)),
    )
    it.live("listEvents rewrites legacy subagent rows to AgentRun events", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const sql = yield* SqlClient.SqlClient
        const sessionId = SessionId.make("compat-agent-run")
        const branchId = BranchId.make("compat-agent-run-b")
        const childSessionId = SessionId.make("compat-agent-run-child")
        yield* storage.createSession(
          new Session({
            id: sessionId,
            name: "compat-agent-run",
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* storage.createBranch(new Branch({ id: branchId, sessionId, createdAt: new Date() }))
        yield* sql`INSERT INTO events (session_id, branch_id, event_tag, event_json, created_at) VALUES (${sessionId}, ${branchId}, 'SubagentSpawned', ${JSON.stringify({ _tag: "SubagentSpawned", parentSessionId: sessionId, childSessionId, agentName: AgentName.make("reviewer"), prompt: "inspect", branchId })}, ${Date.now()})`
        const events = yield* storage.listEvents({ sessionId, branchId })
        expect(events).toHaveLength(1)
        expect(events[0]?.event._tag).toBe("AgentRunSpawned")
      }).pipe(Effect.provide(layer)),
    )
    it.live("getLatestEvent resolves legacy subagent tags when queried by AgentRun tag", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const sql = yield* SqlClient.SqlClient
        const sessionId = SessionId.make("compat-agent-run-latest")
        const branchId = BranchId.make("compat-agent-run-latest-b")
        const childSessionId = SessionId.make("compat-agent-run-latest-child")
        yield* storage.createSession(
          new Session({
            id: sessionId,
            name: "compat-agent-run-latest",
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* storage.createBranch(new Branch({ id: branchId, sessionId, createdAt: new Date() }))
        yield* sql`INSERT INTO events (session_id, branch_id, event_tag, event_json, created_at) VALUES (${sessionId}, ${branchId}, 'SubagentSucceeded', ${JSON.stringify({ _tag: "SubagentSucceeded", parentSessionId: sessionId, childSessionId, agentName: AgentName.make("reviewer"), branchId })}, ${Date.now()})`
        const latest = yield* storage.getLatestEvent({
          sessionId,
          branchId,
          tags: ["AgentRunSucceeded"],
        })
        expect(latest?._tag).toBe("AgentRunSucceeded")
      }).pipe(Effect.provide(layer)),
    )
    it.live("getLatestEventTag includes branchless legacy subagent rows for branch queries", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const sql = yield* SqlClient.SqlClient
        const sessionId = SessionId.make("compat-agent-run-tagless")
        const branchId = BranchId.make("compat-agent-run-tagless-b")
        const childSessionId = SessionId.make("compat-agent-run-tagless-child")
        yield* storage.createSession(
          new Session({
            id: sessionId,
            name: "compat-agent-run-tagless",
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* sql`INSERT INTO events (session_id, branch_id, event_tag, event_json, created_at) VALUES (${sessionId}, NULL, 'SubagentSucceeded', ${JSON.stringify({ _tag: "SubagentSucceeded", parentSessionId: sessionId, childSessionId, agentName: AgentName.make("reviewer") })}, ${Date.now()})`
        const latestTag = yield* storage.getLatestEventTag({
          sessionId,
          branchId,
          tags: ["AgentRunSucceeded"],
        })
        expect(latestTag).toBe("AgentRunSucceeded")
      }).pipe(Effect.provide(layer)),
    )
    it.live("getLatestEvent includes branchless legacy subagent rows for branch queries", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const sql = yield* SqlClient.SqlClient
        const sessionId = SessionId.make("compat-agent-run-branchless")
        const branchId = BranchId.make("compat-agent-run-branchless-b")
        const childSessionId = SessionId.make("compat-agent-run-branchless-child")
        yield* storage.createSession(
          new Session({
            id: sessionId,
            name: "compat-agent-run-branchless",
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* sql`INSERT INTO events (session_id, branch_id, event_tag, event_json, created_at) VALUES (${sessionId}, NULL, 'SubagentFailed', ${JSON.stringify({ _tag: "SubagentFailed", parentSessionId: sessionId, childSessionId, agentName: AgentName.make("reviewer") })}, ${Date.now()})`
        const latest = yield* storage.getLatestEvent({
          sessionId,
          branchId,
          tags: ["AgentRunFailed"],
        })
        expect(latest?._tag).toBe("AgentRunFailed")
      }).pipe(Effect.provide(layer)),
    )
  })
  describe("Concurrent writes", () => {
    // The storage layer adds no in-memory locking on top of the SQL
    // client; the contract under test is that N concurrent calls through
    // the Effect surface produce N committed rows with no lost writes.
    //
    // Negative control: each test wraps the per-item write with a
    // `maxConcurrent` Ref counter — increment-on-enter, decrement-on-exit
    // — and asserts the observed peak was > 1. If a future refactor
    // accidentally drops `concurrency: "unbounded"` to `1`, the peak
    // collapses to 1 and the assertion fails. This proves the test
    // exercises real fiber interleaving rather than accidental
    // serialization.
    const trackedConcurrency = <A, E, R>(
      active: Ref.Ref<number>,
      peak: Ref.Ref<number>,
      body: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.acquireUseRelease(
        Effect.gen(function* () {
          const n = yield* Ref.updateAndGet(active, (m) => m + 1)
          yield* Ref.update(peak, (p) => (n > p ? n : p))
          // Yield to the scheduler so peer fibers in `Effect.forEach`
          // get a chance to enter before this one completes its body.
          // Without this, bun:sqlite's synchronous calls cause each
          // fiber to run start-to-finish on the event loop, collapsing
          // observed concurrency to 1.
          yield* Effect.yieldNow
        }),
        () => body,
        () => Ref.update(active, (n) => n - 1),
      )
    it.live("createSession with N concurrent fibers produces N independent rows", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const N = 16
        const ids = Array.from({ length: N }, (_, i) => SessionId.make(`cs-${i}`))
        const active = yield* Ref.make(0)
        const peak = yield* Ref.make(0)
        yield* Effect.forEach(
          ids,
          (id) =>
            trackedConcurrency(
              active,
              peak,
              storage.createSession(
                new Session({ id, createdAt: new Date(), updatedAt: new Date() }),
              ),
            ),
          { concurrency: "unbounded" },
        )
        const sessions = yield* storage.listSessions()
        const seen = new Set(sessions.map((s) => s.id))
        for (const id of ids) {
          expect(seen.has(id)).toBe(true)
        }
        // Negative control: real interleaving, not accidental serialization.
        expect(yield* Ref.get(peak)).toBeGreaterThan(1)
      }).pipe(Effect.timeout("5 seconds"), Effect.provide(Storage.Test())),
    )
    it.live("appendEvent with N concurrent fibers produces N envelopes with unique ids", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const sessionId = SessionId.make("ce-session")
        const branchId = BranchId.make("ce-branch")
        yield* storage.createSession(
          new Session({ id: sessionId, createdAt: new Date(), updatedAt: new Date() }),
        )
        yield* storage.createBranch(new Branch({ id: branchId, sessionId, createdAt: new Date() }))
        const N = 32
        const active = yield* Ref.make(0)
        const peak = yield* Ref.make(0)
        const envelopes = yield* Effect.forEach(
          Array.from({ length: N }, () => 0),
          () =>
            trackedConcurrency(
              active,
              peak,
              storage.appendEvent(SessionStarted.make({ sessionId, branchId })),
            ),
          { concurrency: "unbounded" },
        )
        expect(envelopes.length).toBe(N)
        const idSet = new Set(envelopes.map((e) => e.id))
        expect(idSet.size).toBe(N)
        const persisted = yield* storage.listEvents({ sessionId, branchId })
        expect(persisted.length).toBe(N)
        expect(yield* Ref.get(peak)).toBeGreaterThan(1)
      }).pipe(Effect.timeout("5 seconds"), Effect.provide(Storage.Test())),
    )
    it.live("createMessage with N concurrent fibers produces N rows with no lost writes", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const sessionId = SessionId.make("cm-session")
        const branchId = BranchId.make("cm-branch")
        yield* storage.createSession(
          new Session({ id: sessionId, createdAt: new Date(), updatedAt: new Date() }),
        )
        yield* storage.createBranch(new Branch({ id: branchId, sessionId, createdAt: new Date() }))
        const N = 24
        const ids = Array.from({ length: N }, (_, i) => MessageId.make(`cm-${i}`))
        const active = yield* Ref.make(0)
        const peak = yield* Ref.make(0)
        yield* Effect.forEach(
          ids,
          (id) =>
            trackedConcurrency(
              active,
              peak,
              storage.createMessage(
                Message.Regular.make({
                  id,
                  sessionId,
                  branchId,
                  role: "user",
                  parts: [new TextPart({ type: "text", text: id })],
                  createdAt: new Date(),
                }),
              ),
            ),
          { concurrency: "unbounded" },
        )
        const persisted = yield* storage.listMessages(branchId)
        expect(persisted.length).toBe(N)
        const seen = new Set(persisted.map((m) => m.id))
        for (const id of ids) {
          expect(seen.has(id)).toBe(true)
        }
        expect(yield* Ref.get(peak)).toBeGreaterThan(1)
      }).pipe(Effect.timeout("5 seconds"), Effect.provide(Storage.Test())),
    )
  })
})
