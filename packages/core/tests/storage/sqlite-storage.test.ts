import { describe, it, expect, test } from "effect-bun-test"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { Database } from "bun:sqlite"
import { Effect, Exit, Layer, Ref } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { RelationshipStorage } from "@gent/core/storage/relationship-storage"
import { EventStorage } from "@gent/core/storage/event-storage"
import { MessageStorage } from "@gent/core/storage/message-storage"
import { BranchStorage } from "@gent/core/storage/branch-storage"
import { SessionStorage } from "@gent/core/storage/session-storage"
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

describe("Storage", () => {
  describe("Sessions", () => {
    it.live("creates and retrieves a session", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const session = new Session({
          id: SessionId.make("test-session"),
          name: "Test Session",
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        yield* sessions.createSession(session)
        const retrieved = yield* sessions.getSession(SessionId.make("test-session"))
        expect(retrieved).toBeDefined()
        expect(retrieved?.id).toBe(SessionId.make("test-session"))
        expect(retrieved?.name).toBe("Test Session")
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    it.live("lists sessions", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("s1"),
            name: "Session 1",
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("s2"),
            name: "Session 2",
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        const sessionsResult = yield* sessions.listSessions()
        expect(sessionsResult.length).toBe(2)
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    it.live("lists first branch per session", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const now = Date.now()
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("s1"),
            createdAt: new Date(now),
            updatedAt: new Date(now),
          }),
        )
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("s2"),
            createdAt: new Date(now + 1),
            updatedAt: new Date(now + 1),
          }),
        )
        const sessionsResult = yield* sessions.listSessions()
        expect(sessionsResult.map((session) => session.id)).toEqual([
          SessionId.make("s2"),
          SessionId.make("s1"),
        ])
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    it.live("updates a session", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const session = new Session({
          id: SessionId.make("update-test"),
          name: "Original",
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        yield* sessions.createSession(session)
        yield* sessions.updateSession(new Session({ ...session, name: "Updated" }))
        const retrieved = yield* sessions.getSession(SessionId.make("update-test"))
        expect(retrieved?.name).toBe("Updated")
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    it.live("deletes a session", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("delete-test"),
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* sessions.deleteSession(SessionId.make("delete-test"))
        const retrieved = yield* sessions.getSession(SessionId.make("delete-test"))
        expect(retrieved).toBeUndefined()
      }).pipe(Effect.provide(Storage.TestWithSql())),
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
    it.scoped("resets incompatible storage schemas before accepting writes", () =>
      Effect.gen(function* () {
        const dir = yield* Effect.acquireRelease(
          Effect.sync(() => mkdtempSync(join(tmpdir(), "gent-storage-retired-parts-"))),
          (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
        )
        const dbPath = join(dir, "gent.db")
        const db = new Database(dbPath)
        db.run(`
          CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `)
        db.run(`
          CREATE TABLE branches (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
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
            turn_duration_ms INTEGER,
            metadata TEXT
          )
        `)
        db.run(`
          CREATE TABLE tasks (
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
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
            FOREIGN KEY (branch_id, session_id) REFERENCES branches(id, session_id) ON DELETE CASCADE
          )
        `)
        db.run(`
          CREATE TABLE task_deps (
            task_id TEXT NOT NULL,
            blocked_by_id TEXT NOT NULL,
            PRIMARY KEY (task_id, blocked_by_id),
            FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
            FOREIGN KEY (blocked_by_id) REFERENCES tasks(id) ON DELETE CASCADE
          )
        `)
        db.run(`CREATE VIRTUAL TABLE retired_fts USING fts5(content)`)
        db.run(`CREATE VIEW retired_message_view AS SELECT id FROM messages`)
        db.run(`
          CREATE TRIGGER retired_message_touch
          AFTER INSERT ON messages
          BEGIN
            INSERT INTO retired_fts(content) VALUES (new.id);
          END
        `)
        db.run(`INSERT INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)`, [
          "retired-session",
          0,
          0,
        ])
        db.run(`INSERT INTO branches (id, session_id, created_at) VALUES (?, ?, ?)`, [
          "retired-branch",
          "retired-session",
          0,
        ])
        db.run(
          `INSERT INTO messages (id, session_id, branch_id, role, parts, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          ["retired-message", "retired-session", "retired-branch", "user", "[]", 0],
        )
        db.run(
          `INSERT INTO tasks (id, session_id, branch_id, subject, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
          ["retired-task", "retired-session", "retired-branch", "old task", 0, 0],
        )
        db.run(`INSERT INTO task_deps (task_id, blocked_by_id) VALUES (?, ?)`, [
          "retired-task",
          "retired-task",
        ])
        db.run(`INSERT INTO retired_fts(content) VALUES (?)`, ["old index"])
        db.close()

        const layer = Storage.LiveWithSql(dbPath).pipe(
          Layer.provide(BunFileSystem.layer),
          Layer.provide(BunServices.layer),
        )
        yield* Effect.gen(function* () {
          const sessions = yield* SessionStorage
          const branches = yield* BranchStorage
          const messages = yield* MessageStorage
          const sql = yield* SqlClient.SqlClient
          const columns = yield* sql.unsafe<{ name: string }>(`PRAGMA table_info(messages)`)
          const tables = yield* sql<{ name: string }>`
            SELECT name FROM sqlite_schema WHERE type = ${"table"} AND name NOT LIKE ${"sqlite_%"}
          `
          const views = yield* sql<{ name: string }>`
            SELECT name FROM sqlite_schema WHERE type = ${"view"}
          `
          const triggers = yield* sql<{ name: string }>`
            SELECT name FROM sqlite_schema WHERE type = ${"trigger"}
          `
          const foreignKeys = yield* sql<{ foreign_keys: number }>`PRAGMA foreign_keys`
          const coreVersion = yield* sql<{
            value: string
          }>`SELECT value FROM storage_meta WHERE key = ${"core_schema_version"}`
          expect(tables.map((table) => table.name)).not.toContain("tasks")
          expect(tables.map((table) => table.name)).not.toContain("task_deps")
          expect(tables.map((table) => table.name)).not.toContain("retired_fts")
          expect(tables.some((table) => table.name.startsWith("retired_fts_"))).toBe(false)
          expect(views.map((view) => view.name)).not.toContain("retired_message_view")
          expect(triggers.map((trigger) => trigger.name)).not.toContain("retired_message_touch")
          expect(foreignKeys[0]?.foreign_keys).toBe(1)
          expect(coreVersion[0]?.value).toBe("1")
          expect(columns.map((column) => column.name)).not.toContain("parts")
          yield* sessions.createSession(
            new Session({
              id: SessionId.make("reset-session"),
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
          )
          yield* branches.createBranch(
            new Branch({
              id: BranchId.make("reset-branch"),
              sessionId: SessionId.make("reset-session"),
              createdAt: new Date(),
            }),
          )
          yield* messages.createMessage(
            Message.Regular.make({
              id: "reset-message",
              sessionId: SessionId.make("reset-session"),
              branchId: BranchId.make("reset-branch"),
              role: "user",
              parts: [new TextPart({ type: "text", text: "fresh write" })],
              createdAt: new Date(),
            }),
          )
          const messagesResult = yield* messages.listMessages(BranchId.make("reset-branch"))
          expect(messagesResult).toHaveLength(1)
          expect(messagesResult[0]?.parts).toEqual([
            new TextPart({ type: "text", text: "fresh write" }),
          ])
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
          const sessions = yield* SessionStorage
          const branches = yield* BranchStorage
          const messages = yield* MessageStorage
          yield* sessions.createSession(
            new Session({
              id: sessionId,
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
          )
          yield* branches.createBranch(
            new Branch({
              id: branchId,
              sessionId,
              createdAt: new Date(),
            }),
          )
          yield* messages.createMessage(
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
        const sessions = yield* SessionStorage
        const sql = yield* SqlClient.SqlClient
        const now = Date.now()
        const branchExit = yield* Effect.exit(
          sql`INSERT INTO branches (id, session_id, name, created_at) VALUES (${"orphan-branch"}, ${"missing-session"}, ${null}, ${now})`,
        )
        expect(branchExit._tag).toBe("Failure")
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("fk-session"),
            createdAt: new Date(now),
            updatedAt: new Date(now),
          }),
        )
        const messageExit = yield* Effect.exit(
          sql`INSERT INTO messages (id, session_id, branch_id, role, created_at, turn_duration_ms) VALUES (${"orphan-message"}, ${"fk-session"}, ${"missing-branch"}, ${"user"}, ${now}, ${null})`,
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
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const sql = yield* SqlClient.SqlClient
        const now = new Date()
        yield* sessions.createSession(
          new Session({ id: SessionId.make("parent-a"), createdAt: now, updatedAt: now }),
        )
        yield* branches.createBranch(
          new Branch({
            id: BranchId.make("parent-a-branch"),
            sessionId: SessionId.make("parent-a"),
            createdAt: now,
          }),
        )
        yield* sessions.createSession(
          new Session({ id: SessionId.make("parent-b"), createdAt: now, updatedAt: now }),
        )
        yield* branches.createBranch(
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
        const sessions = yield* SessionStorage
        const now = new Date()
        const exit = yield* Effect.exit(
          sessions.createSession(
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
          yield* sessions.getSession(SessionId.make("storage-dangling-parent-branch")),
        ).toBeUndefined()
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    it.live("rejects branch creation with a parent branch outside the same session", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const sql = yield* SqlClient.SqlClient
        const now = new Date()
        yield* sessions.createSession(
          new Session({ id: SessionId.make("branch-parent-a"), createdAt: now, updatedAt: now }),
        )
        yield* sessions.createSession(
          new Session({ id: SessionId.make("branch-parent-b"), createdAt: now, updatedAt: now }),
        )
        yield* branches.createBranch(
          new Branch({
            id: BranchId.make("branch-parent-a-root"),
            sessionId: SessionId.make("branch-parent-a"),
            createdAt: now,
          }),
        )
        const exit = yield* Effect.exit(
          branches.createBranch(
            new Branch({
              id: BranchId.make("branch-parent-b-child"),
              sessionId: SessionId.make("branch-parent-b"),
              parentBranchId: BranchId.make("branch-parent-a-root"),
              createdAt: now,
            }),
          ),
        )
        expect(exit._tag).toBe("Failure")
        expect(yield* branches.getBranch(BranchId.make("branch-parent-b-child"))).toBeUndefined()
        const directInsertExit = yield* Effect.exit(
          sql`INSERT INTO branches (id, session_id, parent_branch_id, created_at) VALUES (${"branch-parent-b-direct-child"}, ${"branch-parent-b"}, ${"branch-parent-a-root"}, ${now.getTime()})`,
        )
        expect(directInsertExit._tag).toBe("Failure")
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    it.live("rejects deleting branches that own child branches or child sessions", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const sql = yield* SqlClient.SqlClient
        const now = new Date()
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("delete-parent-session"),
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* branches.createBranch(
          new Branch({
            id: BranchId.make("delete-parent-root"),
            sessionId: SessionId.make("delete-parent-session"),
            createdAt: now,
          }),
        )
        yield* branches.createBranch(
          new Branch({
            id: BranchId.make("delete-parent-child"),
            sessionId: SessionId.make("delete-parent-session"),
            parentBranchId: BranchId.make("delete-parent-root"),
            createdAt: now,
          }),
        )
        const childBranchExit = yield* Effect.exit(
          branches.deleteBranch(BranchId.make("delete-parent-root")),
        )
        expect(childBranchExit._tag).toBe("Failure")
        expect(yield* branches.getBranch(BranchId.make("delete-parent-root"))).toBeDefined()
        const directChildBranchExit = yield* Effect.exit(
          sql`DELETE FROM branches WHERE id = ${"delete-parent-root"}`,
        )
        expect(directChildBranchExit._tag).toBe("Failure")
        expect(yield* branches.getBranch(BranchId.make("delete-parent-root"))).toBeDefined()
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("delete-child-session"),
            parentSessionId: SessionId.make("delete-parent-session"),
            parentBranchId: BranchId.make("delete-parent-child"),
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* branches.createBranch(
          new Branch({
            id: BranchId.make("delete-child-session-branch"),
            sessionId: SessionId.make("delete-child-session"),
            createdAt: now,
          }),
        )
        const childSessionExit = yield* Effect.exit(
          branches.deleteBranch(BranchId.make("delete-parent-child")),
        )
        expect(childSessionExit._tag).toBe("Failure")
        expect(yield* branches.getBranch(BranchId.make("delete-parent-child"))).toBeDefined()
        expect(yield* sessions.getSession(SessionId.make("delete-child-session"))).toBeDefined()
        const directChildSessionExit = yield* Effect.exit(
          sql`DELETE FROM branches WHERE id = ${"delete-parent-child"}`,
        )
        expect(directChildSessionExit._tag).toBe("Failure")
        expect(yield* branches.getBranch(BranchId.make("delete-parent-child"))).toBeDefined()
        expect(yield* sessions.getSession(SessionId.make("delete-child-session"))).toBeDefined()
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    it.live("deletes session children and storage projections", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const messages = yield* MessageStorage
        const events = yield* EventStorage
        const sql = yield* SqlClient.SqlClient
        const now = new Date()
        const sessionId = SessionId.make("cascade-session")
        const branchId = BranchId.make("cascade-branch")
        const childSessionId = SessionId.make("cascade-child-session")
        const childBranchId = BranchId.make("cascade-child-branch")
        yield* sessions.createSession(
          new Session({
            id: sessionId,
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* branches.createBranch(
          new Branch({
            id: branchId,
            sessionId,
            createdAt: now,
          }),
        )
        yield* sessions.createSession(
          new Session({
            id: childSessionId,
            parentSessionId: sessionId,
            parentBranchId: branchId,
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* branches.createBranch(
          new Branch({
            id: childBranchId,
            sessionId: childSessionId,
            createdAt: now,
          }),
        )
        yield* messages.createMessage(
          Message.Regular.make({
            id: MessageId.make("cascade-message"),
            sessionId,
            branchId,
            role: "user",
            parts: [new TextPart({ type: "text", text: "cascade projection" })],
            createdAt: now,
          }),
        )
        yield* messages.createMessage(
          Message.Regular.make({
            id: MessageId.make("cascade-child-message"),
            sessionId: childSessionId,
            branchId: childBranchId,
            role: "user",
            parts: [new TextPart({ type: "text", text: "cascade child projection" })],
            createdAt: now,
          }),
        )
        yield* events.appendEvent(
          AgentSwitched.make({
            sessionId,
            branchId,
            fromAgent: "cowork",
            toAgent: "deepwork",
          }),
        )
        const cascadedIds = yield* sessions.deleteSession(sessionId)
        const sessionsResult = yield* sql<{
          count: number
        }>`SELECT COUNT(*) as count FROM sessions`
        const branchesResult = yield* sql<{
          count: number
        }>`SELECT COUNT(*) as count FROM branches`
        const messagesResult = yield* sql<{
          count: number
        }>`SELECT COUNT(*) as count FROM messages`
        const eventsResult = yield* sql<{
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
        expect(sessionsResult[0]?.count).toBe(0)
        expect(branchesResult[0]?.count).toBe(0)
        expect(messagesResult[0]?.count).toBe(0)
        expect(eventsResult[0]?.count).toBe(0)
        expect(refs[0]?.count).toBe(0)
        expect(chunks[0]?.count).toBe(0)
        expect(fts[0]?.count).toBe(0)
        expect([...cascadedIds].sort()).toEqual([sessionId, childSessionId].sort())
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    it.live("returns the cascade set for a no-op delete of an already-removed session", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const cascadedIds = yield* sessions.deleteSession(SessionId.make("never-existed"))
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
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const sql = yield* SqlClient.SqlClient
        const now = new Date()
        const parentId = SessionId.make("race-parent")
        const parentBranchId = BranchId.make("race-parent-branch")
        yield* sessions.createSession(new Session({ id: parentId, createdAt: now, updatedAt: now }))
        yield* branches.createBranch(
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
          yield* sessions.createSession(
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
            sessions.createSession(
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
            sessions.deleteSession(parentId),
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
  })
  describe("Events", () => {
    it.live("getLatestEvent returns latest event by tag", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const events = yield* EventStorage
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
        yield* sessions.createSession(session)
        yield* branches.createBranch(branch)
        yield* events.appendEvent(
          AgentSwitched.make({
            sessionId: session.id,
            branchId: branch.id,
            fromAgent: "cowork",
            toAgent: "deepwork",
          }),
        )
        yield* events.appendEvent(
          AgentSwitched.make({
            sessionId: session.id,
            branchId: branch.id,
            fromAgent: "deepwork",
            toAgent: "cowork",
          }),
        )
        const latest = yield* events.getLatestEvent({
          sessionId: session.id,
          branchId: branch.id,
          tags: ["AgentSwitched"],
        })
        expect(latest?._tag).toBe("AgentSwitched")
        if (latest && latest._tag === "AgentSwitched") {
          expect(latest.toAgent).toBe(AgentName.make("cowork"))
        }
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
  })
  describe("Branches", () => {
    it.live("creates and retrieves a branch", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        yield* sessions.createSession(
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
        yield* branches.createBranch(branch)
        const retrieved = yield* branches.getBranch(BranchId.make("test-branch"))
        expect(retrieved).toBeDefined()
        expect(retrieved?.sessionId).toBe(SessionId.make("branch-session"))
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    it.live("lists branches for a session", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("multi-branch"),
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* branches.createBranch(
          new Branch({
            id: BranchId.make("b1"),
            sessionId: SessionId.make("multi-branch"),
            createdAt: new Date(),
          }),
        )
        yield* branches.createBranch(
          new Branch({
            id: BranchId.make("b2"),
            sessionId: SessionId.make("multi-branch"),
            parentBranchId: BranchId.make("b1"),
            createdAt: new Date(),
          }),
        )
        const branchesResult = yield* branches.listBranches(SessionId.make("multi-branch"))
        expect(branchesResult.length).toBe(2)
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    it.live("updates branch summary", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("summary-session"),
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* branches.createBranch(
          new Branch({
            id: BranchId.make("summary-branch"),
            sessionId: SessionId.make("summary-session"),
            createdAt: new Date(),
          }),
        )
        yield* branches.updateBranchSummary(BranchId.make("summary-branch"), "Short summary")
        const retrieved = yield* branches.getBranch(BranchId.make("summary-branch"))
        expect(retrieved?.summary).toBe("Short summary")
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
  })
  describe("Messages", () => {
    it.live("creates and retrieves messages", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const messages = yield* MessageStorage
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("msg-session"),
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* branches.createBranch(
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
        yield* messages.createMessage(message)
        const retrieved = yield* messages.getMessage(MessageId.make("msg-1"))
        expect(retrieved).toBeDefined()
        expect(retrieved?.role).toBe("user")
        expect(retrieved?.parts[0]?.type).toBe("text")
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    it.live("round-trips all persisted transcript part types", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const messages = yield* MessageStorage
        const toolCallId = ToolCallId.make("all-parts-tc")
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("all-parts-session"),
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* branches.createBranch(
          new Branch({
            id: BranchId.make("all-parts-branch"),
            sessionId: SessionId.make("all-parts-session"),
            createdAt: new Date(),
          }),
        )
        yield* messages.createMessage(
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
        const retrieved = yield* messages.getMessage(MessageId.make("all-parts-msg"))
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
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    it.live("stores message parts in shared content chunks", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const messages = yield* MessageStorage
        const sql = yield* SqlClient.SqlClient
        const sharedPart = new TextPart({ type: "text", text: "dedupe me" })
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("chunk-s"),
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* branches.createBranch(
          new Branch({
            id: BranchId.make("chunk-b"),
            sessionId: SessionId.make("chunk-s"),
            createdAt: new Date(),
          }),
        )
        yield* messages.createMessage(
          Message.Regular.make({
            id: "chunk-a",
            sessionId: SessionId.make("chunk-s"),
            branchId: BranchId.make("chunk-b"),
            role: "user",
            parts: [sharedPart],
            createdAt: new Date(1000),
          }),
        )
        yield* messages.createMessage(
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
        const messagesResult = yield* messages.listMessages(BranchId.make("chunk-b"))
        expect(chunkRows[0]?.count).toBe(1)
        expect(refRows[0]?.count).toBe(2)
        expect(messagesResult.map((message) => message.parts)).toEqual([[sharedPart], [sharedPart]])
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    it.live("counts messages in a branch", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const messages = yield* MessageStorage
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("count-session"),
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* branches.createBranch(
          new Branch({
            id: BranchId.make("count-branch"),
            sessionId: SessionId.make("count-session"),
            createdAt: new Date(),
          }),
        )
        yield* messages.createMessage(
          Message.Regular.make({
            id: "count-msg-1",
            sessionId: SessionId.make("count-session"),
            branchId: BranchId.make("count-branch"),
            role: "user",
            parts: [new TextPart({ type: "text", text: "one" })],
            createdAt: new Date(),
          }),
        )
        yield* messages.createMessage(
          Message.Regular.make({
            id: "count-msg-2",
            sessionId: SessionId.make("count-session"),
            branchId: BranchId.make("count-branch"),
            role: "assistant",
            parts: [new TextPart({ type: "text", text: "two" })],
            createdAt: new Date(),
          }),
        )
        const count = yield* branches.countMessages(BranchId.make("count-branch"))
        expect(count).toBe(2)
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    it.live("lists messages for a branch", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const messages = yield* MessageStorage
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("list-msg-session"),
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* branches.createBranch(
          new Branch({
            id: BranchId.make("list-msg-branch"),
            sessionId: SessionId.make("list-msg-session"),
            createdAt: new Date(),
          }),
        )
        yield* messages.createMessage(
          Message.Regular.make({
            id: "lm1",
            sessionId: SessionId.make("list-msg-session"),
            branchId: BranchId.make("list-msg-branch"),
            role: "user",
            parts: [new TextPart({ type: "text", text: "First" })],
            createdAt: new Date(),
          }),
        )
        yield* messages.createMessage(
          Message.Regular.make({
            id: "lm2",
            sessionId: SessionId.make("list-msg-session"),
            branchId: BranchId.make("list-msg-branch"),
            role: "assistant",
            parts: [new TextPart({ type: "text", text: "Response" })],
            createdAt: new Date(),
          }),
        )
        const messagesResult = yield* messages.listMessages(BranchId.make("list-msg-branch"))
        expect(messagesResult.length).toBe(2)
        expect(messagesResult[0]?.role).toBe("user")
        expect(messagesResult[1]?.role).toBe("assistant")
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    it.live("deletes message chunk refs and search projection rows", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const messages = yield* MessageStorage
        const sql = yield* SqlClient.SqlClient
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("delete-projection-session"),
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* branches.createBranch(
          new Branch({
            id: BranchId.make("delete-projection-branch"),
            sessionId: SessionId.make("delete-projection-session"),
            createdAt: new Date(),
          }),
        )
        yield* messages.createMessage(
          Message.Regular.make({
            id: "delete-projection-a",
            sessionId: SessionId.make("delete-projection-session"),
            branchId: BranchId.make("delete-projection-branch"),
            role: "user",
            parts: [new TextPart({ type: "text", text: "delete projection alpha" })],
            createdAt: new Date(1000),
          }),
        )
        yield* messages.createMessage(
          Message.Regular.make({
            id: "delete-projection-b",
            sessionId: SessionId.make("delete-projection-session"),
            branchId: BranchId.make("delete-projection-branch"),
            role: "assistant",
            parts: [new TextPart({ type: "text", text: "delete projection beta" })],
            createdAt: new Date(2000),
          }),
        )
        yield* messages.deleteMessages(BranchId.make("delete-projection-branch"))
        const messagesResult = yield* sql<{
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
        expect(messagesResult[0]?.count).toBe(0)
        expect(refs[0]?.count).toBe(0)
        expect(chunks[0]?.count).toBe(0)
        expect(fts[0]?.count).toBe(0)
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    it.live("updates session updatedAt when creating message", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const messages = yield* MessageStorage
        const start = new Date(0)
        const messageTime = new Date(1000)
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("session-updated-at"),
            createdAt: start,
            updatedAt: start,
          }),
        )
        yield* branches.createBranch(
          new Branch({
            id: BranchId.make("branch-updated-at"),
            sessionId: SessionId.make("session-updated-at"),
            createdAt: start,
          }),
        )
        yield* messages.createMessage(
          Message.Regular.make({
            id: "msg-updated-at",
            sessionId: SessionId.make("session-updated-at"),
            branchId: BranchId.make("branch-updated-at"),
            role: "user",
            parts: [new TextPart({ type: "text", text: "Ping" })],
            createdAt: messageTime,
          }),
        )
        const session = yield* sessions.getSession(SessionId.make("session-updated-at"))
        expect(session?.updatedAt.getTime()).toBe(messageTime.getTime())
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    it.live("rolls back message insert when session timestamp update fails", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const messages = yield* MessageStorage
        const sql = yield* SqlClient.SqlClient
        const start = new Date(0)
        const messageTime = new Date(1000)
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("tx-message-session"),
            createdAt: start,
            updatedAt: start,
          }),
        )
        yield* branches.createBranch(
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
          messages.createMessage(
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
        expect(yield* messages.getMessage(MessageId.make("tx-message"))).toBeUndefined()
        const session = yield* sessions.getSession(SessionId.make("tx-message-session"))
        expect(session?.updatedAt.getTime()).toBe(start.getTime())
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    it.live("createMessageIfAbsent leaves session timestamp unchanged when insert is ignored", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const messages = yield* MessageStorage
        const start = new Date(0)
        const firstTime = new Date(1000)
        const duplicateTime = new Date(2000)
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("if-absent-session"),
            createdAt: start,
            updatedAt: start,
          }),
        )
        yield* branches.createBranch(
          new Branch({
            id: BranchId.make("if-absent-branch"),
            sessionId: SessionId.make("if-absent-session"),
            createdAt: start,
          }),
        )
        yield* messages.createMessageIfAbsent(
          Message.Regular.make({
            id: "if-absent-message",
            sessionId: SessionId.make("if-absent-session"),
            branchId: BranchId.make("if-absent-branch"),
            role: "user",
            parts: [new TextPart({ type: "text", text: "first" })],
            createdAt: firstTime,
          }),
        )
        yield* messages.createMessageIfAbsent(
          Message.Regular.make({
            id: "if-absent-message",
            sessionId: SessionId.make("if-absent-session"),
            branchId: BranchId.make("if-absent-branch"),
            role: "user",
            parts: [new TextPart({ type: "text", text: "duplicate" })],
            createdAt: duplicateTime,
          }),
        )
        const session = yield* sessions.getSession(SessionId.make("if-absent-session"))
        expect(session?.updatedAt.getTime()).toBe(firstTime.getTime())
        const message = yield* messages.getMessage(MessageId.make("if-absent-message"))
        expect(message?.parts).toEqual([new TextPart({ type: "text", text: "first" })])
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    it.live("orders messages by createdAt then id", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const messages = yield* MessageStorage
        const timestamp = new Date()
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("order-session"),
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
        )
        yield* branches.createBranch(
          new Branch({
            id: BranchId.make("order-branch"),
            sessionId: SessionId.make("order-session"),
            createdAt: timestamp,
          }),
        )
        yield* messages.createMessage(
          Message.Regular.make({
            id: "b",
            sessionId: SessionId.make("order-session"),
            branchId: BranchId.make("order-branch"),
            role: "user",
            parts: [new TextPart({ type: "text", text: "Second" })],
            createdAt: timestamp,
          }),
        )
        yield* messages.createMessage(
          Message.Regular.make({
            id: "a",
            sessionId: SessionId.make("order-session"),
            branchId: BranchId.make("order-branch"),
            role: "user",
            parts: [new TextPart({ type: "text", text: "First" })],
            createdAt: timestamp,
          }),
        )
        const messagesResult = yield* messages.listMessages(BranchId.make("order-branch"))
        expect(messagesResult[0]?.id).toBe(MessageId.make("a"))
        expect(messagesResult[1]?.id).toBe(MessageId.make("b"))
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
  })
  describe("Message Metadata", () => {
    it.live("metadata round-trips through storage", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const messages = yield* MessageStorage
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("meta-s"),
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* branches.createBranch(
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
        yield* messages.createMessage(message)
        const messagesResult = yield* messages.listMessages(BranchId.make("meta-b"))
        expect(messagesResult.length).toBe(1)
        const m = messagesResult[0]!
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
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    it.live("createMessageIfAbsent preserves metadata", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const messages = yield* MessageStorage
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("upsert-s"),
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* branches.createBranch(
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
        yield* messages.createMessageIfAbsent(message)
        const messagesResult = yield* messages.listMessages(BranchId.make("upsert-b"))
        expect(messagesResult.length).toBe(1)
        expect(messagesResult[0]!.metadata).toBeDefined()
        expect(messagesResult[0]!.metadata!.hidden).toBe(true)
        expect(messagesResult[0]!.metadata!.extensionId).toBe("review-loop")
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    it.live("messages without metadata have undefined metadata", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const messages = yield* MessageStorage
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("no-meta-s"),
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* branches.createBranch(
          new Branch({
            id: BranchId.make("no-meta-b"),
            sessionId: SessionId.make("no-meta-s"),
            createdAt: new Date(),
          }),
        )
        yield* messages.createMessage(
          Message.Regular.make({
            id: "no-meta-msg",
            sessionId: SessionId.make("no-meta-s"),
            branchId: BranchId.make("no-meta-b"),
            role: "user",
            parts: [new TextPart({ type: "text", text: "plain" })],
            createdAt: new Date(),
          }),
        )
        const messagesResult = yield* messages.listMessages(BranchId.make("no-meta-b"))
        expect(messagesResult[0]!.metadata).toBeUndefined()
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    it.live("invalid stored metadata decodes to undefined across read surfaces", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const messages = yield* MessageStorage
        const relationships = yield* RelationshipStorage
        const sql = yield* SqlClient.SqlClient
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("bad-meta-s"),
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* branches.createBranch(
          new Branch({
            id: BranchId.make("bad-meta-b"),
            sessionId: SessionId.make("bad-meta-s"),
            createdAt: new Date(),
          }),
        )
        yield* sql`INSERT INTO messages (id, session_id, branch_id, kind, role, created_at, turn_duration_ms, metadata) VALUES (${"bad-meta-msg"}, ${"bad-meta-s"}, ${"bad-meta-b"}, ${null}, ${"assistant"}, ${Date.now()}, ${null}, ${'{"customType":1}'})`
        const messagesResult = yield* messages.listMessages(BranchId.make("bad-meta-b"))
        expect(messagesResult).toHaveLength(1)
        expect(messagesResult[0]!.metadata).toBeUndefined()
        const message = yield* messages.getMessage(MessageId.make("bad-meta-msg"))
        expect(message?.metadata).toBeUndefined()
        const detail = yield* relationships.getSessionDetail(SessionId.make("bad-meta-s"))
        expect(detail.branches).toHaveLength(1)
        expect(detail.branches[0]!.messages).toHaveLength(1)
        expect(detail.branches[0]!.messages[0]!.metadata).toBeUndefined()
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    test("domain message preserves metadata for transport", () => {
      const message = Message.Regular.make({
        id: "info-msg",
        sessionId: SessionId.make("info-s"),
        branchId: BranchId.make("info-b"),
        role: "assistant",
        parts: [new TextPart({ type: "text", text: "response" })],
        createdAt: new Date(),
        metadata: { customType: "review-status", hidden: true },
      })
      expect(message.metadata).toBeDefined()
      expect(message.metadata!.customType).toBe("review-status")
      expect(message.metadata!.hidden).toBe(true)
    })
    it.live("interjection messages round-trip as explicit variants", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const messages = yield* MessageStorage
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("interjection-s"),
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* branches.createBranch(
          new Branch({
            id: BranchId.make("interjection-b"),
            sessionId: SessionId.make("interjection-s"),
            createdAt: new Date(),
          }),
        )
        yield* messages.createMessage(
          Message.Interjection.make({
            id: "interjection-msg",
            sessionId: SessionId.make("interjection-s"),
            branchId: BranchId.make("interjection-b"),
            role: "user",
            parts: [new TextPart({ type: "text", text: "steer now" })],
            createdAt: new Date(),
          }),
        )
        const stored = yield* messages.getMessage(MessageId.make("interjection-msg"))
        if (stored === undefined) throw new Error("expected interjection message")
        expect(stored._tag).toBe("interjection")
        expect(stored.role).toBe("user")
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )
    test("domain message omits metadata when absent", () => {
      const message = Message.Regular.make({
        id: "plain-msg",
        sessionId: SessionId.make("plain-s"),
        branchId: BranchId.make("plain-b"),
        role: "user",
        parts: [new TextPart({ type: "text", text: "hi" })],
        createdAt: new Date(),
      })
      expect(message.metadata).toBeUndefined()
    })
  })
  describe("Event decoding", () => {
    const layer = Storage.TestWithSql()
    it.live("listEvents skips events with unknown _tag instead of crashing", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const events = yield* EventStorage
        const sql = yield* SqlClient.SqlClient
        const sessionId = SessionId.make("unknown-event-session")
        const branchId = BranchId.make("unknown-event-branch")
        yield* sessions.createSession(
          new Session({
            id: sessionId,
            name: "unknown-event",
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* branches.createBranch(new Branch({ id: branchId, sessionId, createdAt: new Date() }))
        yield* events.appendEvent(SessionStarted.make({ sessionId, branchId }))
        yield* sql`INSERT INTO events (session_id, branch_id, event_tag, event_json, created_at) VALUES (${sessionId}, ${branchId}, '__test_unknown__', ${JSON.stringify({ _tag: "__test_unknown__", sessionId, branchId, toolCallId: ToolCallId.make("tc-1"), toolName: "bash" })}, ${Date.now()})`
        yield* events.appendEvent(SessionStarted.make({ sessionId, branchId }))
        const eventsResult = yield* events.listEvents({ sessionId, branchId })
        expect(eventsResult.length).toBe(2)
        expect(eventsResult.every((e) => e.event._tag === "SessionStarted")).toBe(true)
      }).pipe(Effect.provide(layer)),
    )
    it.live("getLatestEvent returns undefined for undecodable events", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const events = yield* EventStorage
        const sql = yield* SqlClient.SqlClient
        const sessionId = SessionId.make("unknown-event-latest")
        const branchId = BranchId.make("unknown-event-latest-b")
        yield* sessions.createSession(
          new Session({
            id: sessionId,
            name: "unknown-event-latest",
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* branches.createBranch(new Branch({ id: branchId, sessionId, createdAt: new Date() }))
        yield* sql`INSERT INTO events (session_id, branch_id, event_tag, event_json, created_at) VALUES (${sessionId}, ${branchId}, 'SessionStarted', ${JSON.stringify({ _tag: "__test_unknown__", sessionId, branchId })}, ${Date.now()})`
        const latest = yield* events.getLatestEvent({
          sessionId,
          branchId,
          tags: ["SessionStarted"],
        })
        expect(latest).toBeUndefined()
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
        const sessions = yield* SessionStorage
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
              sessions.createSession(
                new Session({ id, createdAt: new Date(), updatedAt: new Date() }),
              ),
            ),
          { concurrency: "unbounded" },
        )
        const sessionsResult = yield* sessions.listSessions()
        const seen = new Set(sessionsResult.map((s) => s.id))
        for (const id of ids) {
          expect(seen.has(id)).toBe(true)
        }
        // Negative control: real interleaving, not accidental serialization.
        expect(yield* Ref.get(peak)).toBeGreaterThan(1)
      }).pipe(Effect.timeout("5 seconds"), Effect.provide(Storage.TestWithSql())),
    )
    it.live("appendEvent with N concurrent fibers produces N envelopes with unique ids", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const events = yield* EventStorage
        const sessionId = SessionId.make("ce-session")
        const branchId = BranchId.make("ce-branch")
        yield* sessions.createSession(
          new Session({ id: sessionId, createdAt: new Date(), updatedAt: new Date() }),
        )
        yield* branches.createBranch(new Branch({ id: branchId, sessionId, createdAt: new Date() }))
        const N = 32
        const active = yield* Ref.make(0)
        const peak = yield* Ref.make(0)
        const envelopes = yield* Effect.forEach(
          Array.from({ length: N }, () => 0),
          () =>
            trackedConcurrency(
              active,
              peak,
              events.appendEvent(SessionStarted.make({ sessionId, branchId })),
            ),
          { concurrency: "unbounded" },
        )
        expect(envelopes.length).toBe(N)
        const idSet = new Set(envelopes.map((e) => e.id))
        expect(idSet.size).toBe(N)
        const persisted = yield* events.listEvents({ sessionId, branchId })
        expect(persisted.length).toBe(N)
        expect(yield* Ref.get(peak)).toBeGreaterThan(1)
      }).pipe(Effect.timeout("5 seconds"), Effect.provide(Storage.TestWithSql())),
    )
    it.live("createMessage with N concurrent fibers produces N rows with no lost writes", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const messages = yield* MessageStorage
        const sessionId = SessionId.make("cm-session")
        const branchId = BranchId.make("cm-branch")
        yield* sessions.createSession(
          new Session({ id: sessionId, createdAt: new Date(), updatedAt: new Date() }),
        )
        yield* branches.createBranch(new Branch({ id: branchId, sessionId, createdAt: new Date() }))
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
              messages.createMessage(
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
        const persisted = yield* messages.listMessages(branchId)
        expect(persisted.length).toBe(N)
        const seen = new Set(persisted.map((m) => m.id))
        for (const id of ids) {
          expect(seen.has(id)).toBe(true)
        }
        expect(yield* Ref.get(peak)).toBeGreaterThan(1)
      }).pipe(Effect.timeout("5 seconds"), Effect.provide(Storage.TestWithSql())),
    )
  })
})
