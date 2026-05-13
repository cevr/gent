import { describe, expect, it } from "effect-bun-test"
import * as Prompt from "effect/unstable/ai/Prompt"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { SqliteClient as BunSqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Exit, FileSystem, Layer, Path } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteStorage } from "@gent/core-internal/storage/sqlite-storage"
import { GentPlatform } from "@gent/core-internal/runtime/gent-platform"
import { EventStorage } from "@gent/core-internal/storage/event-storage"
import { MessageStorage } from "@gent/core-internal/storage/message-storage"
import { BranchStorage } from "@gent/core-internal/storage/branch-storage"
import { AgentLoopQueueStorage } from "@gent/core-internal/storage/agent-loop-queue-storage"
import { SessionStorage } from "@gent/core-internal/storage/session-storage"
import { SessionOperationStorage } from "@gent/core-internal/storage/session-operation-storage"
import { Branch, dateFromMillis, Message, Session } from "@gent/core-internal/domain/message"
import { AgentSwitched } from "@gent/core-internal/domain/event"
import { AgentName } from "@gent/core-internal/domain/agent"
import { BranchId, MessageId, RequestId, SessionId } from "@gent/core-internal/domain/ids"

const FIXED_NOW_MILLIS = 1_767_225_600_000
const FIXED_NOW = dateFromMillis(FIXED_NOW_MILLIS)

describe("Sessions", () => {
  it.live("creates and retrieves a session", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const session = new Session({
        id: SessionId.make("test-session"),
        name: "Test Session",
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      })
      yield* sessions.createSession(session)
      const retrieved = yield* sessions.getSession(SessionId.make("test-session"))
      expect(retrieved).toBeDefined()
      expect(retrieved?.id).toBe(SessionId.make("test-session"))
      expect(retrieved?.name).toBe("Test Session")
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
  it.live("lists sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("s1"),
          name: "Session 1",
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      )
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("s2"),
          name: "Session 2",
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      )
      const sessionsResult = yield* sessions.listSessions()
      expect(sessionsResult.length).toBe(2)
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
  it.live("lists first branch per session", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const now = FIXED_NOW_MILLIS
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("s1"),
          createdAt: dateFromMillis(now),
          updatedAt: dateFromMillis(now),
        }),
      )
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("s2"),
          createdAt: dateFromMillis(now + 1),
          updatedAt: dateFromMillis(now + 1),
        }),
      )
      const sessionsResult = yield* sessions.listSessions()
      expect(sessionsResult.map((session) => session.id)).toEqual([
        SessionId.make("s2"),
        SessionId.make("s1"),
      ])
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
  it.live("updates a session", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const session = new Session({
        id: SessionId.make("update-test"),
        name: "Original",
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      })
      yield* sessions.createSession(session)
      yield* sessions.updateSession(new Session({ ...session, name: "Updated" }))
      const retrieved = yield* sessions.getSession(SessionId.make("update-test"))
      expect(retrieved?.name).toBe("Updated")
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
  it.live("decodes invalid stored reasoning levels as absent", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO sessions (id, reasoning_level, created_at, updated_at) VALUES (${"invalid-reasoning"}, ${"too-spicy"}, ${FIXED_NOW_MILLIS}, ${FIXED_NOW_MILLIS})`
      const retrieved = yield* sessions.getSession(SessionId.make("invalid-reasoning"))
      expect(retrieved?.reasoningLevel).toBeUndefined()
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
  it.live("fails through StorageError for invalid durable session row shape", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO sessions (id, created_at, updated_at) VALUES (${"invalid-session-row"}, ${"not-a-number"}, ${FIXED_NOW_MILLIS})`
      const exit = yield* Effect.exit(sessions.getSession(SessionId.make("invalid-session-row")))
      expect(exit._tag).toBe("Failure")
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
  it.live("deletes a session", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("delete-test"),
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      )
      yield* sessions.deleteSession(SessionId.make("delete-test"))
      const retrieved = yield* sessions.getSession(SessionId.make("delete-test"))
      expect(retrieved).toBeUndefined()
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
  it.live("enables sqlite foreign key enforcement", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{
        foreign_keys: number
      }>`PRAGMA foreign_keys`
      expect(rows[0]?.foreign_keys).toBe(1)
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
  it.scoped("configures file-backed sqlite durability pragmas", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const layer = SqliteStorage.LiveWithSql(path.join(dir, "gent.db")).pipe(
        Layer.provide(BunFileSystem.layer),
        Layer.provide(BunServices.layer),
        Layer.provide(GentPlatform.Test()),
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
    }).pipe(Effect.provide(BunServices.layer)),
  )
  it.scoped("migrator runs forward-only and is idempotent on reboot", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const dbPath = path.join(dir, "gent.db")
      const layer = SqliteStorage.LiveWithSql(dbPath).pipe(
        Layer.provide(BunFileSystem.layer),
        Layer.provide(BunServices.layer),
        Layer.provide(GentPlatform.Test()),
      )
      const sessionId = SessionId.make("migrator-session")

      yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        yield* sessions.createSession(
          new Session({ id: sessionId, createdAt: FIXED_NOW, updatedAt: FIXED_NOW }),
        )
        const sql = yield* SqlClient.SqlClient
        const migrations = yield* sql<{
          name: string
        }>`SELECT name FROM gent_storage_migrations ORDER BY migration_id`
        expect(migrations.map((row) => row.name)).toEqual([
          "init",
          "agent_loop_queue",
          "session_workspace",
          "agent_loop_queue_workspace",
          "interaction_decision",
          "durable_operations",
          "durable_operation_integrity",
          "agent_loop_queue_integrity",
        ])
      }).pipe(Effect.provide(layer))

      // Reboot — migrator must not re-run the init migration.
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const found = yield* sessions.getSession(sessionId)
        expect(found?.id).toBe(sessionId)
        const sql = yield* SqlClient.SqlClient
        const migrations = yield* sql<{
          name: string
        }>`SELECT name FROM gent_storage_migrations ORDER BY migration_id`
        expect(migrations.map((row) => row.name)).toEqual([
          "init",
          "agent_loop_queue",
          "session_workspace",
          "agent_loop_queue_workspace",
          "interaction_decision",
          "durable_operations",
          "durable_operation_integrity",
          "agent_loop_queue_integrity",
        ])
      }).pipe(Effect.provide(layer))
    }).pipe(Effect.provide(BunServices.layer)),
  )
  it.scoped("reports existing storage tables without migration records", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const dbPath = path.join(dir, "gent.db")

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(`
          CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `)
      }).pipe(Effect.provide(BunSqliteClient.layer({ filename: dbPath })))

      const layer = SqliteStorage.LiveWithSql(dbPath).pipe(
        Layer.provide(BunFileSystem.layer),
        Layer.provide(BunServices.layer),
        Layer.provide(GentPlatform.Test()),
      )
      const exit = yield* Effect.exit(Layer.buildWithScope(layer, yield* Effect.scope))

      expect(exit._tag).toBe("Failure")
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("existing storage tables")
        expect(String(exit.cause)).toContain("gent_storage_migrations")
      }
    }).pipe(Effect.provide(BunServices.layer)),
  )
  it.live("rejects orphan branch, message, event, queue, and durable operation rows", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const sql = yield* SqlClient.SqlClient
      const now = FIXED_NOW_MILLIS
      const branchExit = yield* Effect.exit(
        sql`INSERT INTO branches (id, session_id, name, created_at) VALUES (${"orphan-branch"}, ${"missing-session"}, ${null}, ${now})`,
      )
      expect(branchExit._tag).toBe("Failure")
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("fk-session"),
          createdAt: dateFromMillis(now),
          updatedAt: dateFromMillis(now),
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
      const queueExit = yield* Effect.exit(
        sql`INSERT INTO agent_loop_queues (workspace_id, session_id, branch_id, queue_json, updated_at) VALUES (${"default"}, ${"fk-session"}, ${"missing-branch"}, ${`{"steering":[],"followUp":[]}`}, ${now})`,
      )
      expect(queueExit._tag).toBe("Failure")
      const durableExit = yield* Effect.exit(
        sql`INSERT INTO durable_operations (workspace_id, operation, request_id, result_json, subject_session_id, subject_branch_id, created_at) VALUES (${"default"}, ${"session.create"}, ${"orphan-durable"}, ${"{}"}, ${"fk-session"}, ${"missing-branch"}, ${now})`,
      )
      expect(durableExit._tag).toBe("Failure")
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
  it.live("cascades queue and durable operation projections when deleting a session", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const queues = yield* AgentLoopQueueStorage
      const operations = yield* SessionOperationStorage
      const sql = yield* SqlClient.SqlClient
      const now = FIXED_NOW
      const sessionId = SessionId.make("projection-cascade-session")
      const branchId = BranchId.make("projection-cascade-branch")
      yield* sessions.createSession(new Session({ id: sessionId, createdAt: now, updatedAt: now }))
      yield* branches.createBranch(new Branch({ id: branchId, sessionId, createdAt: now }))
      yield* queues.putQueueState(sessionId, branchId, {
        steering: [],
        followUp: [
          {
            message: Message.cases.regular.make({
              id: MessageId.make("projection-cascade-message"),
              sessionId,
              branchId,
              role: "user",
              parts: [Prompt.textPart({ text: "follow up" })],
              createdAt: now,
            }),
          },
        ],
      })
      yield* operations.saveCreateSession(RequestId.make("projection-cascade-request"), {
        sessionId,
        branchId,
        name: "Projection cascade",
      })

      yield* sessions.deleteSession(sessionId)

      const queueRows = yield* sql<{ count: number }>`
        SELECT COUNT(*) as count FROM agent_loop_queues
      `
      const operationRows = yield* sql<{ count: number }>`
        SELECT COUNT(*) as count FROM durable_operations
      `
      expect(queueRows[0]?.count).toBe(0)
      expect(operationRows[0]?.count).toBe(0)
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
  it.live("rejects invalid session parent and active branch relationships", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const sql = yield* SqlClient.SqlClient
      const now = FIXED_NOW
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
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
  it.live("rejects parent branch without parent session through storage service", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const now = FIXED_NOW
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
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
  it.live("rejects branch creation with a parent branch outside the same session", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const sql = yield* SqlClient.SqlClient
      const now = FIXED_NOW
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
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
  it.live("rejects deleting branches that own child branches or child sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const sql = yield* SqlClient.SqlClient
      const now = FIXED_NOW
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
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
  it.live("deletes session children and storage projections", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      const events = yield* EventStorage
      const sql = yield* SqlClient.SqlClient
      const now = FIXED_NOW
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
        Message.cases.regular.make({
          id: MessageId.make("cascade-message"),
          sessionId,
          branchId,
          role: "user",
          parts: [Prompt.textPart({ text: "cascade projection" })],
          createdAt: now,
        }),
      )
      yield* messages.createMessage(
        Message.cases.regular.make({
          id: MessageId.make("cascade-child-message"),
          sessionId: childSessionId,
          branchId: childBranchId,
          role: "user",
          parts: [Prompt.textPart({ text: "cascade child projection" })],
          createdAt: now,
        }),
      )
      yield* events.appendEvent(
        AgentSwitched.make({
          sessionId,
          branchId,
          fromAgent: AgentName.make("cowork"),
          toAgent: AgentName.make("deepwork"),
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
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
  it.live("returns the cascade set for a no-op delete of an already-removed session", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const cascadedIds = yield* sessions.deleteSession(SessionId.make("never-existed"))
      expect(cascadedIds).toEqual([])
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
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
      const now = FIXED_NOW
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
      const preChildIds = Array.from({ length: K }, (_, i) => SessionId.make(`race-pre-child-${i}`))
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
    }).pipe(Effect.timeout("5 seconds"), Effect.provide(SqliteStorage.TestWithSql())),
  )
})
