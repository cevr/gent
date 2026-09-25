import { describe, expect, it, test } from "effect-bun-test"
import * as Prompt from "effect/unstable/ai/Prompt"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { SqliteClient as BunSqliteClient } from "@effect/sql-sqlite-bun"
import {
  Cause,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Ref,
  Schema,
} from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  AgentLoopQueueStorage,
  BranchStorage,
  DurableOperations,
  emptyTurnRecord,
  EventDecodeError,
  EventStorage,
  MessageStorage,
  RelationshipStorage,
  SessionOperationStorage,
  SessionStorage,
  SqliteStorage,
  ToolCallBindingStorage,
  turnRecordAtStep,
  TurnRecordStorage,
} from "../../src/storage/storage"
import { GentPlatform } from "../../src/runtime/gent-platform"
import { CurrentWorkspaceId, DefaultWorkspaceId, WorkspaceId } from "../../src/server/workspace-rpc"
import { Branch, dateFromMillis, Message, Session } from "../../src/domain/message"
import {
  ErrorOccurred,
  MessageReceived,
  SessionStarted,
  ToolCallStarted,
  ToolCallSucceeded,
} from "../../src/domain/event"
import {
  BranchId,
  ExtensionId,
  MessageId,
  RequestId,
  SessionId,
  ToolCallId,
  ToolId,
} from "../../src/domain/ids"
import {
  ToolBindingIdentity,
  ToolBindingSource,
  ToolCallBindingConflictError,
  ToolSchemaRevision,
  ToolSourceRevision,
} from "../../src/domain/capability"
import { StorageError } from "../../src/domain/errors"
import { testSqliteStorage } from "../../src/test-utils/harness"

// ── session storage ─────────────────────────────────────────────────────────

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
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
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
      const sessionsResult = yield* sessions.listSessions
      expect(sessionsResult.length).toBe(2)
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
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
      const sessionsResult = yield* sessions.listSessions
      expect(sessionsResult.map((session) => session.id)).toEqual([
        SessionId.make("s2"),
        SessionId.make("s1"),
      ])
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
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
      yield* sessions.renameSession(session.id, "Updated", FIXED_NOW)
      const retrieved = yield* sessions.getSession(SessionId.make("update-test"))
      expect(retrieved?.name).toBe("Updated")
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )
  it.live("decodes invalid stored reasoning levels as absent", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO sessions (id, reasoning_level, created_at, updated_at) VALUES (${"invalid-reasoning"}, ${"too-spicy"}, ${FIXED_NOW_MILLIS}, ${FIXED_NOW_MILLIS})`
      const retrieved = yield* sessions.getSession(SessionId.make("invalid-reasoning"))
      expect(retrieved?.reasoningLevel).toBeUndefined()
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )
  it.live("fails through StorageError for invalid durable session row shape", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO sessions (id, created_at, updated_at) VALUES (${"invalid-session-row"}, ${"not-a-number"}, ${FIXED_NOW_MILLIS})`
      const exit = yield* Effect.exit(sessions.getSession(SessionId.make("invalid-session-row")))
      expect(exit._tag).toBe("Failure")
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
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
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )
  it.live("enables sqlite foreign key enforcement", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{
        foreign_keys: number
      }>`PRAGMA foreign_keys`
      expect(rows[0]?.foreign_keys).toBe(1)
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )
  it.scoped("configures file-backed sqlite durability pragmas", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const layer = SqliteStorage.LiveWithSql(
        path.join(dir, "gent.db"),
        () => Layer.empty,
        {},
      ).pipe(
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
      const layer = SqliteStorage.LiveWithSql(dbPath, () => Layer.empty, {}).pipe(
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
          "tool_call_bindings",
          "resource_graph_state",
          "message_insertion_order",
          "drop_resource_graph_state",
          "drop_write_only_storage",
          "session_model",
          "turn_records",
          "session_thread",
          "drop_message_search_index",
          "interaction_owner",
          "turn_record_admission",
          "session_admission",
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
          "tool_call_bindings",
          "resource_graph_state",
          "message_insertion_order",
          "drop_resource_graph_state",
          "drop_write_only_storage",
          "session_model",
          "turn_records",
          "session_thread",
          "drop_message_search_index",
          "interaction_owner",
          "turn_record_admission",
          "session_admission",
        ])
      }).pipe(Effect.provide(layer))
    }).pipe(Effect.provide(BunServices.layer)),
  )
  it.scoped("upgrades equal-time message order without changing stored content", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const layer = SqliteStorage.LiveWithSql(
        path.join(dir, "gent.db"),
        () => Layer.empty,
        {},
      ).pipe(
        Layer.provide(BunFileSystem.layer),
        Layer.provide(BunServices.layer),
        Layer.provide(GentPlatform.Test()),
      )
      const sessionId = SessionId.make("order-upgrade-session")
      const branchId = BranchId.make("order-upgrade-branch")
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const messages = yield* MessageStorage
        yield* sessions.createSession(
          new Session({ id: sessionId, createdAt: FIXED_NOW, updatedAt: FIXED_NOW }),
        )
        yield* branches.createBranch(new Branch({ id: branchId, sessionId, createdAt: FIXED_NOW }))
        for (const id of ["step9", "step10"]) {
          yield* messages.createMessage(
            Message.cases.regular.make({
              id: MessageId.make(id),
              sessionId,
              branchId,
              role: "assistant",
              parts: [Prompt.textPart({ text: id })],
              createdAt: FIXED_NOW,
            }),
          )
        }
        // Restore the version-10 schema in this temporary test database.
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe("DROP TRIGGER messages_assign_insertion_order")
        yield* sql.unsafe("DROP INDEX idx_messages_branch_created")
        yield* sql.unsafe("DROP INDEX idx_messages_insertion_order")
        yield* sql.unsafe("ALTER TABLE messages DROP COLUMN insertion_order")
        yield* sql.unsafe(
          "CREATE INDEX idx_messages_branch_created ON messages(branch_id, created_at, id)",
        )
        yield* sql.unsafe("DELETE FROM gent_storage_migrations WHERE migration_id >= 11")
      }).pipe(Effect.provide(layer))
      yield* Effect.gen(function* () {
        const messages = yield* MessageStorage
        const before = yield* messages.listMessages(branchId)
        expect(before.map((message) => message.id)).toEqual([
          MessageId.make("step9"),
          MessageId.make("step10"),
        ])
        expect(before.map((message) => message.parts)).toEqual([
          [Prompt.textPart({ text: "step9" })],
          [Prompt.textPart({ text: "step10" })],
        ])
        yield* messages.createMessageIfAbsent(
          Message.cases.regular.make({
            id: MessageId.make("step11"),
            sessionId,
            branchId,
            role: "user",
            parts: [Prompt.textPart({ text: "next turn" })],
            createdAt: FIXED_NOW,
          }),
        )
        expect((yield* messages.listMessages(branchId)).map((message) => message.id)).toEqual([
          MessageId.make("step9"),
          MessageId.make("step10"),
          MessageId.make("step11"),
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

      const layer = SqliteStorage.LiveWithSql(dbPath, () => Layer.empty, {}).pipe(
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
        // oxlint-disable-next-line effect/noNullish -- Keep the null value required by this external data contract.
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
        // oxlint-disable-next-line effect/noNullish -- Keep the null value required by this external data contract.
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
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
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
      yield* operations.saveReceipt(
        DurableOperations.createSession,
        RequestId.make("projection-cascade-request"),
        { sessionId, branchId, name: "Projection cascade" },
        { sessionId, branchId },
      )

      yield* sessions.deleteSession(sessionId)

      const queueRows = yield* sql<{ count: number }>`
        SELECT COUNT(*) as count FROM agent_loop_queues
      `
      const operationRows = yield* sql<{ count: number }>`
        SELECT COUNT(*) as count FROM durable_operations
      `
      expect(queueRows[0]?.count).toBe(0)
      expect(operationRows[0]?.count).toBe(0)
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )
  /**
   * `session.create` receipts once carried an `agentOverride` the input no
   * longer has. Those rows are still on disk, so the receipt must decode with
   * the stale key present: a retry that fails to read its own receipt would
   * create a second session.
   */
  it.live("a stored session.create receipt decodes with a retired key present", () =>
    Effect.gen(function* () {
      const operations = yield* SessionOperationStorage
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const sql = yield* SqlClient.SqlClient
      const sessionId = SessionId.make("stale-receipt-session")
      const branchId = BranchId.make("stale-receipt-branch")
      const requestId = RequestId.make("stale-receipt-request")

      yield* sessions.createSession(
        new Session({ id: sessionId, createdAt: FIXED_NOW, updatedAt: FIXED_NOW }),
      )
      yield* branches.createBranch(
        new Branch({ id: branchId, sessionId, name: "main", createdAt: FIXED_NOW }),
      )

      // The shape an earlier build wrote, including the retired key.
      const StaleReceipt = Schema.fromJsonString(
        Schema.Struct({
          sessionId: Schema.String,
          branchId: Schema.String,
          name: Schema.String,
          initialPrompt: Schema.String,
          agentOverride: Schema.String,
        }),
      )
      const staleJson = yield* Schema.encodeEffect(StaleReceipt)({
        sessionId,
        branchId,
        name: "Stale receipt",
        initialPrompt: "seed",
        agentOverride: "memory:reflect",
      })
      yield* sql`INSERT INTO durable_operations (workspace_id, operation, request_id, result_json, subject_session_id, subject_branch_id, created_at) VALUES (${"0".repeat(64)}, ${"session.create"}, ${requestId}, ${staleJson}, ${sessionId}, ${branchId}, ${FIXED_NOW_MILLIS})`

      const receipt = yield* operations.getReceipt(DurableOperations.createSession, requestId)
      expect(receipt?.sessionId).toBe(sessionId)
      expect(receipt?.name).toBe("Stale receipt")
      expect(receipt?.initialPrompt).toBe("seed")
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
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
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
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
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
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
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )
  it.live("protects branches that own child branches or child sessions", () =>
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
      const directChildSessionExit = yield* Effect.exit(
        sql`DELETE FROM branches WHERE id = ${"delete-parent-child"}`,
      )
      expect(directChildSessionExit._tag).toBe("Failure")
      expect(yield* branches.getBranch(BranchId.make("delete-parent-child"))).toBeDefined()
      expect(yield* sessions.getSession(SessionId.make("delete-child-session"))).toBeDefined()
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
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
        ErrorOccurred.make({
          sessionId,
          branchId,
          error: "cascade projection",
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
      expect(sessionsResult[0]?.count).toBe(0)
      expect(branchesResult[0]?.count).toBe(0)
      expect(messagesResult[0]?.count).toBe(0)
      expect(eventsResult[0]?.count).toBe(0)
      expect(refs[0]?.count).toBe(0)
      expect(chunks[0]?.count).toBe(0)
      expect([...cascadedIds].sort()).toEqual([sessionId, childSessionId].sort())
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )
  it.live("returns the cascade set for a no-op delete of an already-removed session", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const cascadedIds = yield* sessions.deleteSession(SessionId.make("never-existed"))
      expect(cascadedIds).toEqual([])
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
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
          Effect.forEach(childIds, createChild, { concurrency: 16 }),
        ],
        { concurrency: 2 },
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
    }).pipe(Effect.timeout("5 seconds"), Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )
})

describe("persisted loop queue format", () => {
  /**
   * The queue row is the loop's only durable memory of accepted-but-unanswered
   * input. A field renamed, reordered into a required position, or dropped
   * means a branch silently loses queued work on the next open, so the whole
   * shape is pinned here as raw JSON rather than as a value built from the
   * schema — a schema change cannot quietly move this literal with it.
   */
  const storedQueueJson = `{
    "steering": [
      {
        "message": {
          "_tag": "interjection",
          "id": "steer-1",
          "sessionId": "legacy-session",
          "branchId": "legacy-branch",
          "role": "user",
          "parts": [{ "options": {}, "type": "text", "text": "steer me" }],
          "createdAt": 1767225600000
        },
        "agentOverride": "main",
        "wake": true
      }
    ],
    "followUp": [
      {
        "message": {
          "_tag": "regular",
          "id": "follow-1",
          "sessionId": "legacy-session",
          "branchId": "legacy-branch",
          "role": "user",
          "parts": [{ "options": {}, "type": "text", "text": "next" }],
          "createdAt": 1767225600000
        },
        "interactive": false,
        "keyed": true
      }
    ],
    "inFlight": {
      "message": {
        "_tag": "regular",
        "id": "in-flight-1",
        "sessionId": "legacy-session",
        "branchId": "legacy-branch",
        "role": "user",
        "parts": [{ "options": {}, "type": "text", "text": "running" }],
        "createdAt": 1767225600000
      }
    }
  }`

  it.live("a row holding every optional field still decodes after the inbox move", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const queues = yield* AgentLoopQueueStorage
      const sql = yield* SqlClient.SqlClient
      const now = FIXED_NOW
      const sessionId = SessionId.make("legacy-session")
      const branchId = BranchId.make("legacy-branch")
      yield* sessions.createSession(new Session({ id: sessionId, createdAt: now, updatedAt: now }))
      yield* branches.createBranch(new Branch({ id: branchId, sessionId, createdAt: now }))
      yield* sql`INSERT INTO agent_loop_queues (workspace_id, session_id, branch_id, queue_json, updated_at) VALUES (${DefaultWorkspaceId}, ${sessionId}, ${branchId}, ${storedQueueJson}, ${now.getTime()})`

      const loaded = yield* queues.getQueueState(sessionId, branchId)
      expect(loaded.steering).toHaveLength(1)
      expect(loaded.steering[0]?.wake).toBe(true)
      expect(loaded.steering[0]?.message._tag).toBe("interjection")
      expect(loaded.followUp).toHaveLength(1)
      // Retired keys on an old row are ignored, not rejected. The admission
      // keys moved to the session in migration 023 (schema.test.ts).
      expect(Object.keys(loaded.steering[0] ?? {})).not.toContain("agentOverride")
      expect(Object.keys(loaded.followUp[0] ?? {})).not.toContain("interactive")
      expect(Object.keys(loaded.followUp[0] ?? {})).not.toContain("keyed")
      expect(String(loaded.inFlight?.message.id)).toBe("in-flight-1")
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )
})

// ── message storage ─────────────────────────────────────────────────────────

const MessageDetails = Schema.Struct({ iteration: Schema.Finite })

describe("Messages", () => {
  it.live("creates and retrieves messages", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("msg-session"),
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      )
      yield* branches.createBranch(
        new Branch({
          id: BranchId.make("msg-branch"),
          sessionId: SessionId.make("msg-session"),
          createdAt: FIXED_NOW,
        }),
      )
      const message = Message.cases.regular.make({
        id: MessageId.make("msg-1"),
        sessionId: SessionId.make("msg-session"),
        branchId: BranchId.make("msg-branch"),
        role: "user",
        parts: [Prompt.textPart({ text: "Hello" })],
        createdAt: FIXED_NOW,
      })
      yield* messages.createMessage(message)
      const retrieved = yield* messages.getMessage(MessageId.make("msg-1"))
      expect(retrieved).toBeDefined()
      expect(retrieved?.role).toBe("user")
      expect(retrieved?.parts[0]?.type).toBe("text")
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
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
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      )
      yield* branches.createBranch(
        new Branch({
          id: BranchId.make("all-parts-branch"),
          sessionId: SessionId.make("all-parts-session"),
          createdAt: FIXED_NOW,
        }),
      )
      yield* messages.createMessage(
        Message.cases.regular.make({
          id: MessageId.make("all-parts-msg"),
          sessionId: SessionId.make("all-parts-session"),
          branchId: BranchId.make("all-parts-branch"),
          role: "assistant",
          parts: [
            Prompt.textPart({ text: "hello" }),
            Prompt.reasoningPart({ text: "thinking" }),
            Prompt.filePart({
              data: "data:image/webp;base64,abc",
              mediaType: "image/webp",
            }),
            Prompt.toolCallPart({
              id: toolCallId,
              name: "inspect",
              params: { target: "image" },
              providerExecuted: false,
            }),
            Prompt.toolResultPart({
              id: toolCallId,
              name: "inspect",
              isFailure: false,
              providerExecuted: false,
              result: { ok: true },
            }),
          ],
          createdAt: FIXED_NOW,
        }),
      )
      const retrieved = yield* messages.getMessage(MessageId.make("all-parts-msg"))
      expect(retrieved?.parts.map((part) => part.type)).toEqual([
        "text",
        "reasoning",
        "file",
        "tool-call",
        "tool-result",
      ])
      expect(retrieved?.parts[2]).toEqual(
        expect.objectContaining({
          type: "file",
          data: "data:image/webp;base64,abc",
          mediaType: "image/webp",
        }),
      )
      expect(retrieved?.parts[3]).toEqual(
        expect.objectContaining({
          type: "tool-call",
          id: toolCallId,
          name: "inspect",
          params: { target: "image" },
          providerExecuted: false,
        }),
      )
      expect(retrieved?.parts[4]).toEqual(
        expect.objectContaining({
          type: "tool-result",
          id: toolCallId,
          name: "inspect",
          isFailure: false,
          result: { ok: true },
        }),
      )
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )
  it.live("stores message parts in shared content chunks", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      const sql = yield* SqlClient.SqlClient
      const sharedPart = Prompt.textPart({ text: "dedupe me" })
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("chunk-s"),
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      )
      yield* branches.createBranch(
        new Branch({
          id: BranchId.make("chunk-b"),
          sessionId: SessionId.make("chunk-s"),
          createdAt: FIXED_NOW,
        }),
      )
      yield* messages.createMessage(
        Message.cases.regular.make({
          id: MessageId.make("chunk-a"),
          sessionId: SessionId.make("chunk-s"),
          branchId: BranchId.make("chunk-b"),
          role: "user",
          parts: [sharedPart],
          createdAt: dateFromMillis(1000),
        }),
      )
      yield* messages.createMessage(
        Message.cases.regular.make({
          id: MessageId.make("chunk-b-msg"),
          sessionId: SessionId.make("chunk-s"),
          branchId: BranchId.make("chunk-b"),
          role: "assistant",
          parts: [sharedPart],
          createdAt: dateFromMillis(2000),
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
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )
  it.live("lists messages for a branch", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("list-msg-session"),
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      )
      yield* branches.createBranch(
        new Branch({
          id: BranchId.make("list-msg-branch"),
          sessionId: SessionId.make("list-msg-session"),
          createdAt: FIXED_NOW,
        }),
      )
      yield* messages.createMessage(
        Message.cases.regular.make({
          id: MessageId.make("lm1"),
          sessionId: SessionId.make("list-msg-session"),
          branchId: BranchId.make("list-msg-branch"),
          role: "user",
          parts: [Prompt.textPart({ text: "First" })],
          createdAt: FIXED_NOW,
        }),
      )
      yield* messages.createMessage(
        Message.cases.regular.make({
          id: MessageId.make("lm2"),
          sessionId: SessionId.make("list-msg-session"),
          branchId: BranchId.make("list-msg-branch"),
          role: "assistant",
          parts: [Prompt.textPart({ text: "Response" })],
          createdAt: FIXED_NOW,
        }),
      )
      const messagesResult = yield* messages.listMessages(BranchId.make("list-msg-branch"))
      expect(messagesResult.length).toBe(2)
      expect(messagesResult[0]?.role).toBe("user")
      expect(messagesResult[1]?.role).toBe("assistant")
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )
  it.live("updates session updatedAt when creating message", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      const start = dateFromMillis(0)
      const messageTime = dateFromMillis(1000)
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
        Message.cases.regular.make({
          id: MessageId.make("msg-updated-at"),
          sessionId: SessionId.make("session-updated-at"),
          branchId: BranchId.make("branch-updated-at"),
          role: "user",
          parts: [Prompt.textPart({ text: "Ping" })],
          createdAt: messageTime,
        }),
      )
      const session = yield* sessions.getSession(SessionId.make("session-updated-at"))
      expect(session?.updatedAt.getTime()).toBe(messageTime.getTime())
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )
  it.live("rolls back message insert when session timestamp update fails", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      const sql = yield* SqlClient.SqlClient
      const start = dateFromMillis(0)
      const messageTime = dateFromMillis(1000)
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
          Message.cases.regular.make({
            id: MessageId.make("tx-message"),
            sessionId: SessionId.make("tx-message-session"),
            branchId: BranchId.make("tx-message-branch"),
            role: "user",
            parts: [Prompt.textPart({ text: "rollback" })],
            createdAt: messageTime,
          }),
        ),
      )
      expect(error._tag).toBe("StorageError")
      expect(yield* messages.getMessage(MessageId.make("tx-message"))).toBeUndefined()
      const session = yield* sessions.getSession(SessionId.make("tx-message-session"))
      expect(session?.updatedAt.getTime()).toBe(start.getTime())
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )
  it.live("createMessageIfAbsent leaves session timestamp unchanged when insert is ignored", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      const start = dateFromMillis(0)
      const firstTime = dateFromMillis(1000)
      const duplicateTime = dateFromMillis(2000)
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
        Message.cases.regular.make({
          id: MessageId.make("if-absent-message"),
          sessionId: SessionId.make("if-absent-session"),
          branchId: BranchId.make("if-absent-branch"),
          role: "user",
          parts: [Prompt.textPart({ text: "first" })],
          createdAt: firstTime,
        }),
      )
      yield* messages.createMessageIfAbsent(
        Message.cases.regular.make({
          id: MessageId.make("if-absent-message"),
          sessionId: SessionId.make("if-absent-session"),
          branchId: BranchId.make("if-absent-branch"),
          role: "user",
          parts: [Prompt.textPart({ text: "duplicate" })],
          createdAt: duplicateTime,
        }),
      )
      const session = yield* sessions.getSession(SessionId.make("if-absent-session"))
      expect(session?.updatedAt.getTime()).toBe(firstTime.getTime())
      const message = yield* messages.getMessage(MessageId.make("if-absent-message"))
      expect(message?.parts).toEqual([Prompt.textPart({ text: "first" })])
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )
  it.live("preserves insertion order for equal timestamps in history", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      const timestamp = FIXED_NOW
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
        Message.cases.regular.make({
          id: MessageId.make("b"),
          sessionId: SessionId.make("order-session"),
          branchId: BranchId.make("order-branch"),
          role: "user",
          parts: [Prompt.textPart({ text: "Second" })],
          createdAt: timestamp,
        }),
      )
      yield* messages.createMessage(
        Message.cases.regular.make({
          id: MessageId.make("a"),
          sessionId: SessionId.make("order-session"),
          branchId: BranchId.make("order-branch"),
          role: "user",
          parts: [Prompt.textPart({ text: "First" })],
          createdAt: timestamp,
        }),
      )
      const messagesResult = yield* messages.listMessages(BranchId.make("order-branch"))
      expect(messagesResult.map((message) => message.id)).toEqual([
        MessageId.make("b"),
        MessageId.make("a"),
      ])
      const relationships = yield* RelationshipStorage
      const detail = yield* relationships.getSessionDetail(SessionId.make("order-session"))
      expect(detail.branches[0]?.messages.map((message) => message.id)).toEqual([
        MessageId.make("b"),
        MessageId.make("a"),
      ])
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe("VACUUM")
      expect(
        (yield* messages.listMessages(BranchId.make("order-branch"))).map((message) => message.id),
      ).toEqual([MessageId.make("b"), MessageId.make("a")])
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
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
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      )
      yield* branches.createBranch(
        new Branch({
          id: BranchId.make("meta-b"),
          sessionId: SessionId.make("meta-s"),
          createdAt: FIXED_NOW,
        }),
      )
      const message = Message.cases.regular.make({
        id: MessageId.make("meta-msg-1"),
        sessionId: SessionId.make("meta-s"),
        branchId: BranchId.make("meta-b"),
        role: "user",
        parts: [Prompt.textPart({ text: "hello" })],
        createdAt: FIXED_NOW,
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
      const details = m.metadata!.details
      expect(Schema.is(MessageDetails)(details)).toBe(true)
      if (!Schema.is(MessageDetails)(details)) return
      expect(details.iteration).toBe(3)
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )
  it.live("createMessageIfAbsent preserves metadata", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("upsert-s"),
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      )
      yield* branches.createBranch(
        new Branch({
          id: BranchId.make("upsert-b"),
          sessionId: SessionId.make("upsert-s"),
          createdAt: FIXED_NOW,
        }),
      )
      const message = Message.cases.regular.make({
        id: MessageId.make("upsert-msg"),
        sessionId: SessionId.make("upsert-s"),
        branchId: BranchId.make("upsert-b"),
        role: "user",
        parts: [Prompt.textPart({ text: "follow-up" })],
        createdAt: FIXED_NOW,
        metadata: { hidden: true, extensionId: ExtensionId.make("review-loop") },
      })
      yield* messages.createMessageIfAbsent(message)
      const messagesResult = yield* messages.listMessages(BranchId.make("upsert-b"))
      expect(messagesResult.length).toBe(1)
      expect(messagesResult[0]!.metadata).toBeDefined()
      expect(messagesResult[0]!.metadata!.hidden).toBe(true)
      expect(messagesResult[0]!.metadata!.extensionId).toBe("review-loop")
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )
  it.live("messages without metadata have undefined metadata", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("no-meta-s"),
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      )
      yield* branches.createBranch(
        new Branch({
          id: BranchId.make("no-meta-b"),
          sessionId: SessionId.make("no-meta-s"),
          createdAt: FIXED_NOW,
        }),
      )
      yield* messages.createMessage(
        Message.cases.regular.make({
          id: MessageId.make("no-meta-msg"),
          sessionId: SessionId.make("no-meta-s"),
          branchId: BranchId.make("no-meta-b"),
          role: "user",
          parts: [Prompt.textPart({ text: "plain" })],
          createdAt: FIXED_NOW,
        }),
      )
      const messagesResult = yield* messages.listMessages(BranchId.make("no-meta-b"))
      expect(messagesResult[0]!.metadata).toBeUndefined()
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )
  it.live("invalid stored metadata fails across read surfaces", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      const relationships = yield* RelationshipStorage
      const sql = yield* SqlClient.SqlClient
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("bad-meta-s"),
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      )
      yield* branches.createBranch(
        new Branch({
          id: BranchId.make("bad-meta-b"),
          sessionId: SessionId.make("bad-meta-s"),
          createdAt: FIXED_NOW,
        }),
      )
      // oxlint-disable-next-line effect/noNullish -- Keep the null value required by this external data contract.
      yield* sql`INSERT INTO messages (id, session_id, branch_id, kind, role, created_at, turn_duration_ms, metadata) VALUES (${"bad-meta-msg"}, ${"bad-meta-s"}, ${"bad-meta-b"}, ${null}, ${"assistant"}, ${FIXED_NOW_MILLIS}, ${null}, ${'{"customType":1}'})`
      const listExit = yield* Effect.exit(messages.listMessages(BranchId.make("bad-meta-b")))
      expect(listExit._tag).toBe("Failure")
      const getExit = yield* Effect.exit(messages.getMessage(MessageId.make("bad-meta-msg")))
      expect(getExit._tag).toBe("Failure")
      const detailExit = yield* Effect.exit(
        relationships.getSessionDetail(SessionId.make("bad-meta-s")),
      )
      expect(detailExit._tag).toBe("Failure")
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )
  test("domain message preserves metadata for transport", () => {
    const message = Message.cases.regular.make({
      id: MessageId.make("info-msg"),
      sessionId: SessionId.make("info-s"),
      branchId: BranchId.make("info-b"),
      role: "assistant",
      parts: [Prompt.textPart({ text: "response" })],
      createdAt: FIXED_NOW,
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
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      )
      yield* branches.createBranch(
        new Branch({
          id: BranchId.make("interjection-b"),
          sessionId: SessionId.make("interjection-s"),
          createdAt: FIXED_NOW,
        }),
      )
      yield* messages.createMessage(
        Message.cases.interjection.make({
          id: MessageId.make("interjection-msg"),
          sessionId: SessionId.make("interjection-s"),
          branchId: BranchId.make("interjection-b"),
          role: "user",
          parts: [Prompt.textPart({ text: "steer now" })],
          createdAt: FIXED_NOW,
        }),
      )
      const stored = yield* messages.getMessage(MessageId.make("interjection-msg"))
      if (Predicate.isUndefined(stored))
        return yield* Effect.die(new Error("expected interjection message"))
      expect(stored._tag).toBe("interjection")
      expect(stored.role).toBe("user")
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )
  test("domain message omits metadata when absent", () => {
    const message = Message.cases.regular.make({
      id: MessageId.make("plain-msg"),
      sessionId: SessionId.make("plain-s"),
      branchId: BranchId.make("plain-b"),
      role: "user",
      parts: [Prompt.textPart({ text: "hi" })],
      createdAt: FIXED_NOW,
    })
    expect(message.metadata).toBeUndefined()
  })
})

// ── event storage ───────────────────────────────────────────────────────────

describe("Event decoding", () => {
  const layer = testSqliteStorage(() => Layer.empty, {})
  it.live("listEvents skips an event whose tag was retired and keeps the rest", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const events = yield* EventStorage
      const sql = yield* SqlClient.SqlClient
      const sessionId = SessionId.make("unknown-event-session")
      const branchId = BranchId.make("unknown-event-branch")
      const unknownEventJson =
        '{"_tag":"__test_unknown__","sessionId":"unknown-event-session","branchId":"unknown-event-branch","toolCallId":"tc-1","toolName":"bash"}'
      yield* sessions.createSession(
        new Session({
          id: sessionId,
          name: "unknown-event",
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      )
      yield* branches.createBranch(new Branch({ id: branchId, sessionId, createdAt: FIXED_NOW }))
      yield* events.appendEvent(SessionStarted.make({ sessionId, branchId }))
      yield* sql`INSERT INTO events (session_id, branch_id, event_tag, event_json, created_at) VALUES (${sessionId}, ${branchId}, '__test_unknown__', ${unknownEventJson}, ${FIXED_NOW_MILLIS})`
      const listed = yield* events.listEvents({ sessionId, branchId })
      expect(listed.map((envelope) => envelope.event._tag)).toEqual(["SessionStarted"])
    }).pipe(Effect.provide(layer)),
  )
  it.live(
    "listEvents still fails with a tagged decode error for a known tag with a bad payload",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const events = yield* EventStorage
        const sql = yield* SqlClient.SqlClient
        const sessionId = SessionId.make("corrupt-event-session")
        const branchId = BranchId.make("corrupt-event-branch")
        const corruptEventJson =
          '{"_tag":"SessionStarted","sessionId":"corrupt-event-session","branchId":42}'
        yield* sessions.createSession(
          new Session({
            id: sessionId,
            name: "corrupt-event",
            createdAt: FIXED_NOW,
            updatedAt: FIXED_NOW,
          }),
        )
        yield* branches.createBranch(new Branch({ id: branchId, sessionId, createdAt: FIXED_NOW }))
        yield* sql`INSERT INTO events (session_id, branch_id, event_tag, event_json, created_at) VALUES (${sessionId}, ${branchId}, 'SessionStarted', ${corruptEventJson}, ${FIXED_NOW_MILLIS})`
        const error = yield* events.listEvents({ sessionId, branchId }).pipe(Effect.flip)
        expect(error._tag).toBe("EventDecodeError")
        if (error._tag !== "EventDecodeError") return
        expect(error).toBeInstanceOf(EventDecodeError)
        expect(error.operation).toBe("listEvents")
      }).pipe(Effect.provide(layer)),
  )
})

describe("tool result window", () => {
  const layer = testSqliteStorage(() => Layer.empty, {})
  const sessionId = SessionId.make("window-session")
  const branchId = BranchId.make("window-branch")

  const assistantMessage = (id: string) =>
    Message.cases.regular.make({
      id: MessageId.make(id),
      sessionId,
      branchId,
      role: "assistant",
      parts: [],
      createdAt: FIXED_NOW,
    })

  const userMessage = (id: string) =>
    Message.cases.regular.make({
      id: MessageId.make(id),
      sessionId,
      branchId,
      role: "user",
      parts: [],
      createdAt: FIXED_NOW,
    })

  /**
   * Two full tool steps back to back. The window for the first step must stop
   * at the second assistant message, so the second step's result never leaks
   * into the first step's replay.
   */
  const seedTwoSteps = Effect.gen(function* () {
    const sessions = yield* SessionStorage
    const branches = yield* BranchStorage
    const events = yield* EventStorage
    yield* sessions.createSession(
      new Session({ id: sessionId, createdAt: FIXED_NOW, updatedAt: FIXED_NOW }),
    )
    yield* branches.createBranch(new Branch({ id: branchId, sessionId, createdAt: FIXED_NOW }))

    yield* events.appendEvent(MessageReceived.make({ message: userMessage("m-user") }))
    yield* events.appendEvent(MessageReceived.make({ message: assistantMessage("m-first") }))
    yield* events.appendEvent(
      ToolCallStarted.make({
        sessionId,
        branchId,
        toolCallId: ToolCallId.make("tc-first"),
        toolName: "bash",
      }),
    )
    yield* events.appendEvent(
      ToolCallSucceeded.make({
        sessionId,
        branchId,
        toolCallId: ToolCallId.make("tc-first"),
        toolName: "bash",
        output: "first",
      }),
    )
    yield* events.appendEvent(MessageReceived.make({ message: assistantMessage("m-second") }))
    yield* events.appendEvent(
      ToolCallSucceeded.make({
        sessionId,
        branchId,
        toolCallId: ToolCallId.make("tc-second"),
        toolName: "bash",
        output: "second",
      }),
    )
  })

  it.live("stops at the next assistant message", () =>
    Effect.gen(function* () {
      yield* seedTwoSteps
      const events = yield* EventStorage
      const window = yield* events.listToolResultWindow({
        sessionId,
        branchId,
        assistantMessageId: MessageId.make("m-first"),
      })
      expect(window.map((envelope) => envelope.event._tag)).toEqual([
        "ToolCallStarted",
        "ToolCallSucceeded",
      ])
      const succeeded = window[1]?.event
      expect(succeeded?._tag === "ToolCallSucceeded" && succeeded.output).toBe("first")
    }).pipe(Effect.provide(layer)),
  )

  it.live("runs to the end of the branch for the newest assistant message", () =>
    Effect.gen(function* () {
      yield* seedTwoSteps
      const events = yield* EventStorage
      const window = yield* events.listToolResultWindow({
        sessionId,
        branchId,
        assistantMessageId: MessageId.make("m-second"),
      })
      expect(window.map((envelope) => envelope.event._tag)).toEqual(["ToolCallSucceeded"])
    }).pipe(Effect.provide(layer)),
  )

  it.live("carries the envelope id the publisher dedups on", () =>
    Effect.gen(function* () {
      yield* seedTwoSteps
      const events = yield* EventStorage
      const window = yield* events.listToolResultWindow({
        sessionId,
        branchId,
        assistantMessageId: MessageId.make("m-first"),
      })
      const listed = yield* events.listEvents({ sessionId, branchId })
      const byTag = new Map(listed.map((envelope) => [envelope.event._tag, envelope.id]))
      expect(window[0]?.id).toBe(byTag.get("ToolCallStarted"))
    }).pipe(Effect.provide(layer)),
  )

  it.live("returns nothing for a message the branch never received", () =>
    Effect.gen(function* () {
      yield* seedTwoSteps
      const events = yield* EventStorage
      const window = yield* events.listToolResultWindow({
        sessionId,
        branchId,
        assistantMessageId: MessageId.make("m-absent"),
      })
      expect(window).toEqual([])
    }).pipe(Effect.provide(layer)),
  )
})

// ── branch storage ──────────────────────────────────────────────────────────

describe("Branches", () => {
  it.live("creates and retrieves a branch", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("branch-session"),
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      )
      const branch = new Branch({
        id: BranchId.make("test-branch"),
        sessionId: SessionId.make("branch-session"),
        createdAt: FIXED_NOW,
      })
      yield* branches.createBranch(branch)
      const retrieved = yield* branches.getBranch(BranchId.make("test-branch"))
      expect(retrieved).toBeDefined()
      expect(retrieved?.sessionId).toBe(SessionId.make("branch-session"))
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )
  it.live("lists branches for a session", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("multi-branch"),
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      )
      yield* branches.createBranch(
        new Branch({
          id: BranchId.make("b1"),
          sessionId: SessionId.make("multi-branch"),
          createdAt: FIXED_NOW,
        }),
      )
      yield* branches.createBranch(
        new Branch({
          id: BranchId.make("b2"),
          sessionId: SessionId.make("multi-branch"),
          parentBranchId: BranchId.make("b1"),
          createdAt: FIXED_NOW,
        }),
      )
      const branchesResult = yield* branches.listBranches(SessionId.make("multi-branch"))
      expect(branchesResult.length).toBe(2)
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )
  it.live("fails through StorageError for invalid durable branch row shape", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const sql = yield* SqlClient.SqlClient
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("invalid-branch-session"),
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      )
      yield* sql`INSERT INTO branches (id, session_id, created_at) VALUES (${"invalid-branch-row"}, ${"invalid-branch-session"}, ${"not-a-number"})`
      const exit = yield* Effect.exit(branches.getBranch(BranchId.make("invalid-branch-row")))
      expect(exit._tag).toBe("Failure")
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )
})

// ── concurrent writes ───────────────────────────────────────────────────────

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
        yield* Ref.update(peak, (p) => {
          if (n > p) {
            return n
          }
          return p
        })
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
            sessions.createSession(new Session({ id, createdAt: FIXED_NOW, updatedAt: FIXED_NOW })),
          ),
        { concurrency: N },
      )
      const sessionsResult = yield* sessions.listSessions
      const seen = new Set(sessionsResult.map((s) => s.id))
      for (const id of ids) {
        expect(seen.has(id)).toBe(true)
      }
      // Negative control: real interleaving, not accidental serialization.
      expect(yield* Ref.get(peak)).toBeGreaterThan(1)
    }).pipe(Effect.timeout("5 seconds"), Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )
  it.live("appendEvent with N concurrent fibers produces N envelopes with unique ids", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const events = yield* EventStorage
      const sessionId = SessionId.make("ce-session")
      const branchId = BranchId.make("ce-branch")
      yield* sessions.createSession(
        new Session({ id: sessionId, createdAt: FIXED_NOW, updatedAt: FIXED_NOW }),
      )
      yield* branches.createBranch(new Branch({ id: branchId, sessionId, createdAt: FIXED_NOW }))
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
        { concurrency: N },
      )
      expect(envelopes.length).toBe(N)
      const idSet = new Set(envelopes.map((e) => e.id))
      expect(idSet.size).toBe(N)
      const persisted = yield* events.listEvents({ sessionId, branchId })
      expect(persisted.length).toBe(N)
      expect(yield* Ref.get(peak)).toBeGreaterThan(1)
    }).pipe(Effect.timeout("5 seconds"), Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )
  it.live("createMessage with N concurrent fibers produces N rows with no lost writes", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      const sessionId = SessionId.make("cm-session")
      const branchId = BranchId.make("cm-branch")
      yield* sessions.createSession(
        new Session({ id: sessionId, createdAt: FIXED_NOW, updatedAt: FIXED_NOW }),
      )
      yield* branches.createBranch(new Branch({ id: branchId, sessionId, createdAt: FIXED_NOW }))
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
              Message.cases.regular.make({
                id,
                sessionId,
                branchId,
                role: "user",
                parts: [Prompt.textPart({ text: id })],
                createdAt: FIXED_NOW,
              }),
            ),
          ),
        { concurrency: N },
      )
      const persisted = yield* messages.listMessages(branchId)
      expect(persisted.length).toBe(N)
      const seen = new Set(persisted.map((m) => m.id))
      for (const id of ids) {
        expect(seen.has(id)).toBe(true)
      }
      expect(yield* Ref.get(peak)).toBeGreaterThan(1)
    }).pipe(Effect.timeout("5 seconds"), Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )
})

// ── relationship storage ────────────────────────────────────────────────────

/**
 * The thread a session belongs to.
 *
 * A thread is the work, not one session's parent line. Storage keeps a thread
 * passed on create and roots a new one at a session created without one.
 * `SessionMutations.createSession` passes none, so a delegate run or a `/btw`
 * fork starts its own thread; rows that an earlier handoff writer stored can
 * still share their parent's thread.
 */

/**
 * Create a session with an optional parent and thread. A stored handoff row
 * carries its parent's thread; a spawn carries none, so storage roots a new
 * thread at the session.
 */
const makeSession = (
  id: string,
  options: { readonly parent?: string; readonly thread?: string; readonly at: number },
) =>
  Effect.gen(function* () {
    const sessions = yield* SessionStorage
    const parentFields = Option.match(Option.fromUndefinedOr(options.parent), {
      onNone: () => ({}),
      onSome: (parent) => ({ parentSessionId: SessionId.make(parent) }),
    })
    const threadFields = Option.match(Option.fromUndefinedOr(options.thread), {
      onNone: () => ({}),
      onSome: (thread) => ({ threadId: SessionId.make(thread) }),
    })
    return yield* sessions.createSession(
      new Session({
        id: SessionId.make(id),
        name: id,
        ...parentFields,
        ...threadFields,
        createdAt: dateFromMillis(options.at),
        updatedAt: dateFromMillis(options.at),
      }),
    )
  })

const ids = (sessions: ReadonlyArray<Session>) => sessions.map((session) => String(session.id))

describe("thread sessions", () => {
  it.live("reaches a sibling handoff the parent line never saw", () =>
    Effect.gen(function* () {
      const root = yield* makeSession("root", { at: 1_000 })
      // Two handoffs off one root: the context window ran out twice.
      yield* makeSession("first", { parent: "root", thread: String(root.threadId), at: 2_000 })
      yield* makeSession("second", { parent: "root", thread: String(root.threadId), at: 3_000 })
      const relationships = yield* RelationshipStorage

      const thread = yield* relationships.getThreadSessions(SessionId.make("first"))
      expect(ids(thread)).toEqual(["root", "first", "second"])
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )

  it.live("leaves a spawned session out of the thread it was launched from", () =>
    Effect.gen(function* () {
      const root = yield* makeSession("root", { at: 1_000 })
      yield* makeSession("handoff", { parent: "root", thread: String(root.threadId), at: 2_000 })
      // A delegate run passes no thread, so it starts its own.
      yield* makeSession("delegate", { parent: "root", at: 3_000 })
      const relationships = yield* RelationshipStorage

      const thread = yield* relationships.getThreadSessions(SessionId.make("root"))
      expect(ids(thread)).toEqual(["root", "handoff"])
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )

  it.live("gives a spawned session its own thread, including its handoffs", () =>
    Effect.gen(function* () {
      yield* makeSession("root", { at: 1_000 })
      const delegate = yield* makeSession("delegate", { parent: "root", at: 2_000 })
      // The delegate outgrew its own window and handed off.
      yield* makeSession("delegate-handoff", {
        parent: "delegate",
        thread: String(delegate.threadId),
        at: 3_000,
      })
      const relationships = yield* RelationshipStorage

      // Asked from inside the spawn, the answer is the spawn's own work —
      // not the parent's thread with the spawn filtered out of it.
      const thread = yield* relationships.getThreadSessions(SessionId.make("delegate"))
      expect(ids(thread)).toEqual(["delegate", "delegate-handoff"])
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )

  it.live("deleting a session keeps the handoffs that continue it and drops its spawns", () =>
    Effect.gen(function* () {
      const root = yield* makeSession("root", { at: 1_000 })
      yield* makeSession("handoff", { parent: "root", thread: String(root.threadId), at: 2_000 })
      // The handoff's own spawn belongs to the kept conversation.
      yield* makeSession("handoff-spawn", { parent: "handoff", at: 3_000 })
      const delegate = yield* makeSession("delegate", { parent: "root", at: 4_000 })
      // A spawn's handoff is the spawn's work, so it goes with the spawn.
      yield* makeSession("delegate-handoff", {
        parent: "delegate",
        thread: String(delegate.threadId),
        at: 5_000,
      })
      const sessions = yield* SessionStorage
      const relationships = yield* RelationshipStorage

      const deleted = yield* sessions.deleteSession(SessionId.make("root"))

      expect(deleted.map(String).toSorted()).toEqual(["delegate", "delegate-handoff", "root"])
      const handoff = yield* sessions.getSession(SessionId.make("handoff"))
      expect(handoff?.parentSessionId).toBeUndefined()
      const thread = yield* relationships.getThreadSessions(SessionId.make("handoff"))
      expect(ids(thread)).toEqual(["handoff"])
      const children = yield* relationships.getChildSessions(SessionId.make("handoff"))
      expect(ids(children)).toEqual(["handoff-spawn"])
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )

  it.live("a session tree holds the session and everything below it, and nothing beside it", () =>
    Effect.gen(function* () {
      const root = yield* makeSession("root", { at: 1_000 })
      yield* makeSession("handoff", { parent: "root", thread: String(root.threadId), at: 2_000 })
      yield* makeSession("delegate", { parent: "root", at: 3_000 })
      yield* makeSession("grandchild", { parent: "delegate", at: 4_000 })
      // Another conversation in the same workspace, with its own child.
      yield* makeSession("other", { at: 5_000 })
      yield* makeSession("other-child", { parent: "other", at: 6_000 })
      const relationships = yield* RelationshipStorage

      const tree = yield* relationships.getSessionTree(SessionId.make("root"))
      expect(ids(tree)).toEqual(["grandchild", "delegate", "handoff", "root"])
      const branch = yield* relationships.getSessionTree(SessionId.make("delegate"))
      expect(ids(branch)).toEqual(["grandchild", "delegate"])
      expect(yield* relationships.getSessionTree(SessionId.make("missing"))).toEqual([])
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )

  it.live("roots a thread at a session created without one", () =>
    Effect.gen(function* () {
      const root = yield* makeSession("root", { at: 1_000 })
      expect(String(root.threadId)).toBe("root")
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )
})

// ── tool call binding storage ───────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId.make("a".repeat(64))
const WORKSPACE_B = WorkspaceId.make("b".repeat(64))

const makeBinding = (schemaRevision = "schema/1") =>
  ToolBindingIdentity.make({
    toolId: ToolId.make("@test/tool"),
    extensionId: ExtensionId.make("@test/extension"),
    source: ToolBindingSource.cases.Static.make({
      sourceRevision: ToolSourceRevision.make("source/1"),
    }),
    schemaRevision: ToolSchemaRevision.make(schemaRevision),
  })

const makeFixture = (suffix: string, workspaceId: WorkspaceId = DefaultWorkspaceId) =>
  Effect.gen(function* () {
    const sessions = yield* SessionStorage
    const branches = yield* BranchStorage
    const messages = yield* MessageStorage
    const sessionId = SessionId.make(`binding-session-${suffix}`)
    const branchId = BranchId.make(`binding-branch-${suffix}`)
    const messageId = MessageId.make(`binding-message-${suffix}`)

    yield* sessions.createSession(
      new Session({
        id: sessionId,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      }),
    )
    yield* branches.createBranch(
      new Branch({
        id: branchId,
        sessionId,
        createdAt: FIXED_NOW,
      }),
    )
    const message = Message.cases.regular.make({
      id: messageId,
      sessionId,
      branchId,
      role: "assistant",
      parts: [
        Prompt.toolCallPart({
          id: ToolCallId.make(`binding-call-${suffix}`),
          name: "@test/tool",
          params: {},
          providerExecuted: false,
        }),
      ],
      createdAt: FIXED_NOW,
    })
    yield* messages.createMessage(message)
    return { sessionId, branchId, messageId, toolCallId: ToolCallId.make(`binding-call-${suffix}`) }
  }).pipe(Effect.provideService(CurrentWorkspaceId, workspaceId))

const saveParams = (
  fixture: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
    readonly messageId: MessageId
    readonly toolCallId: ToolCallId
  },
  binding = makeBinding(),
) => ({
  assistantMessageId: fixture.messageId,
  toolCallId: fixture.toolCallId,
  sessionId: fixture.sessionId,
  branchId: fixture.branchId,
  binding,
  createdAt: FIXED_NOW.getTime(),
})

const getParams = (fixture: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly messageId: MessageId
  readonly toolCallId: ToolCallId
}) => ({
  assistantMessageId: fixture.messageId,
  toolCallId: fixture.toolCallId,
  sessionId: fixture.sessionId,
  branchId: fixture.branchId,
})

describe("ToolCallBindingStorage", () => {
  it.live("round-trips a canonical JSON-safe binding identity", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture("round-trip")
      const storage = yield* ToolCallBindingStorage
      const binding = makeBinding()

      const saved = yield* storage.save(saveParams(fixture, binding))
      const loaded = yield* storage.get(getParams(fixture))

      expect(saved).toEqual(binding)
      expect(loaded).toEqual(binding)
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )

  it.live("accepts an equal duplicate without changing the immutable row", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture("equal-duplicate")
      const storage = yield* ToolCallBindingStorage
      const first = makeBinding()
      const second = makeBinding()

      yield* storage.save(saveParams(fixture, first))
      const duplicate = yield* storage.save(saveParams(fixture, second))

      expect(duplicate).toEqual(first)
      expect(yield* storage.get(getParams(fixture))).toEqual(first)
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )

  it.live("rejects a conflicting duplicate without overwriting the row", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture("conflict")
      const storage = yield* ToolCallBindingStorage
      const first = makeBinding()
      yield* storage.save(saveParams(fixture, first))

      const conflict = yield* storage
        .save(saveParams(fixture, makeBinding("schema/2")))
        .pipe(Effect.exit)
      expect(Exit.isFailure(conflict)).toBe(true)
      if (Exit.isFailure(conflict)) {
        expect(Schema.is(ToolCallBindingConflictError)(Cause.squash(conflict.cause))).toBe(true)
      }
      expect(yield* storage.get(getParams(fixture))).toEqual(first)
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )

  it.live("requires the assistant message to contain the bound tool call", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture("call-ownership")
      const storage = yield* ToolCallBindingStorage
      const missingCall = yield* storage
        .save(
          saveParams({
            ...fixture,
            toolCallId: ToolCallId.make("binding-call-missing"),
          }),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(missingCall)).toBe(true)
      if (Exit.isFailure(missingCall)) {
        expect(Schema.is(StorageError)(Cause.squash(missingCall.cause))).toBe(true)
      }

      const binding = makeBinding()
      const mismatchedName = yield* storage
        .save(
          saveParams(
            fixture,
            ToolBindingIdentity.make({
              ...binding,
              toolId: ToolId.make("@test/other-tool"),
            }),
          ),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(mismatchedName)).toBe(true)
      if (Exit.isFailure(mismatchedName)) {
        expect(Schema.is(StorageError)(Cause.squash(mismatchedName.cause))).toBe(true)
      }
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )

  it.live("rejects reads and writes outside the message workspace and branch", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture("ownership", WORKSPACE_A)
      const storage = yield* ToolCallBindingStorage
      yield* storage
        .save(saveParams(fixture))
        .pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE_A))

      const hiddenFromOtherWorkspace = yield* storage
        .get(getParams(fixture))
        .pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE_B))
      expect(hiddenFromOtherWorkspace).toBeUndefined()

      const hiddenWrite = yield* storage
        .save(saveParams(fixture, makeBinding("schema/hidden-workspace")))
        .pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE_B), Effect.exit)
      expect(Exit.isFailure(hiddenWrite)).toBe(true)
      if (Exit.isFailure(hiddenWrite)) {
        expect(Schema.is(StorageError)(Cause.squash(hiddenWrite.cause))).toBe(true)
      }

      const wrongSession = yield* storage
        .save(
          saveParams({
            ...fixture,
            sessionId: SessionId.make("binding-other-session"),
          }),
        )
        .pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE_A))
        .pipe(Effect.exit)
      expect(Exit.isFailure(wrongSession)).toBe(true)
      if (Exit.isFailure(wrongSession)) {
        expect(Schema.is(StorageError)(Cause.squash(wrongSession.cause))).toBe(true)
      }

      const wrongBranch = yield* storage
        .save(
          saveParams({
            ...fixture,
            branchId: BranchId.make("binding-other-branch"),
          }),
        )
        .pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE_A))
        .pipe(Effect.exit)
      expect(Exit.isFailure(wrongBranch)).toBe(true)
      if (Exit.isFailure(wrongBranch)) {
        expect(Schema.is(StorageError)(Cause.squash(wrongBranch.cause))).toBe(true)
      }

      const stillStored = yield* storage
        .get(getParams(fixture))
        .pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE_A))
      expect(stillStored).toEqual(makeBinding())
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )

  it.live("rolls back a message and its binding in one outer transaction", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      const storage = yield* ToolCallBindingStorage
      const sql = yield* SqlClient.SqlClient
      const messageId = MessageId.make("binding-rollback-message")
      const toolCallId = ToolCallId.make("binding-rollback-call")
      const sessionId = SessionId.make("binding-session-rollback")
      const branchId = BranchId.make("binding-branch-rollback")

      yield* sessions.createSession(
        new Session({ id: sessionId, createdAt: FIXED_NOW, updatedAt: FIXED_NOW }),
      )
      yield* branches.createBranch(new Branch({ id: branchId, sessionId, createdAt: FIXED_NOW }))
      const message = Message.cases.regular.make({
        id: messageId,
        sessionId,
        branchId,
        role: "assistant",
        parts: [
          Prompt.toolCallPart({
            id: toolCallId,
            name: "@test/tool",
            params: {},
            providerExecuted: false,
          }),
        ],
        createdAt: FIXED_NOW,
      })

      const rolledBack = yield* Effect.gen(function* () {
        yield* messages.createMessage(message)
        yield* storage.save({
          assistantMessageId: messageId,
          toolCallId,
          sessionId,
          branchId,
          binding: makeBinding(),
          createdAt: FIXED_NOW.getTime(),
        })
        return yield* Effect.fail("rollback")
      }).pipe(sql.withTransaction, Effect.exit)
      expect(Exit.isFailure(rolledBack)).toBe(true)
      expect(yield* messages.getMessage(messageId)).toBeUndefined()
      expect(
        yield* storage.get({
          assistantMessageId: messageId,
          toolCallId,
          sessionId,
          branchId,
        }),
      ).toBeUndefined()
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )

  it.live("deletes bindings with their assistant message", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture("cascade")
      const storage = yield* ToolCallBindingStorage
      const sql = yield* SqlClient.SqlClient
      yield* storage.save(saveParams(fixture))

      yield* sql`DELETE FROM messages WHERE id = ${fixture.messageId}`
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM tool_call_bindings
        WHERE assistant_message_id = ${fixture.messageId}
      `
      expect(rows[0]?.count).toBe(0)
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )

  it.live("rejects malformed binding JSON at the read boundary", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture("malformed")
      const sql = yield* SqlClient.SqlClient
      const storage = yield* ToolCallBindingStorage
      yield* sql`
        INSERT INTO tool_call_bindings (
          assistant_message_id,
          tool_call_id,
          binding_json,
          created_at
        ) VALUES (
          ${fixture.messageId},
          ${fixture.toolCallId},
          ${"not-json"},
          ${FIXED_NOW.getTime()}
        )
      `

      const malformed = yield* storage.get(getParams(fixture)).pipe(Effect.exit)
      expect(Exit.isFailure(malformed)).toBe(true)
      if (Exit.isFailure(malformed)) {
        expect(Schema.is(StorageError)(Cause.squash(malformed.cause))).toBe(true)
      }
    }).pipe(Effect.provide(testSqliteStorage(() => Layer.empty, {}))),
  )
})

// ── turn record storage ─────────────────────────────────────────────────────

const storageLayer = testSqliteStorage(() => Layer.empty, {})

const makeFixtureTurnRecord = (suffix: string, workspaceId: WorkspaceId = DefaultWorkspaceId) =>
  Effect.gen(function* () {
    const sessions = yield* SessionStorage
    const branches = yield* BranchStorage
    const messages = yield* MessageStorage
    const sessionId = SessionId.make(`turn-session-${suffix}`)
    const branchId = BranchId.make(`turn-branch-${suffix}`)
    const messageId = MessageId.make(`turn-message-${suffix}`)

    yield* sessions.createSession(
      new Session({ id: sessionId, createdAt: FIXED_NOW, updatedAt: FIXED_NOW }),
    )
    yield* branches.createBranch(new Branch({ id: branchId, sessionId, createdAt: FIXED_NOW }))
    yield* messages.createMessage(
      Message.cases.regular.make({
        id: messageId,
        sessionId,
        branchId,
        role: "user",
        parts: [],
        createdAt: FIXED_NOW,
      }),
    )
    return { sessionId, branchId, messageId }
  }).pipe(Effect.provideService(CurrentWorkspaceId, workspaceId))

describe("TurnRecordStorage", () => {
  it.live("reports the empty position for a turn that has written no step", () =>
    Effect.gen(function* () {
      const key = yield* makeFixtureTurnRecord("empty")
      const storage = yield* TurnRecordStorage
      expect(yield* storage.get(key)).toEqual(emptyTurnRecord)
    }).pipe(
      Effect.provideService(CurrentWorkspaceId, DefaultWorkspaceId),
      Effect.provide(storageLayer),
    ),
  )

  it.live("round-trips the step, the continuation count, and the pending calls", () =>
    Effect.gen(function* () {
      const key = yield* makeFixtureTurnRecord("round-trip")
      const storage = yield* TurnRecordStorage
      const record = turnRecordAtStep({
        step: 3,
        continuations: 1,
        pendingToolCalls: [{ id: "call-1", name: "@test/tool" }],
      })
      yield* storage.put(key, record)
      expect(yield* storage.get(key)).toEqual(record)
    }).pipe(
      Effect.provideService(CurrentWorkspaceId, DefaultWorkspaceId),
      Effect.provide(storageLayer),
    ),
  )

  it.live("a row that still holds a turn admission reads as its position", () =>
    Effect.gen(function* () {
      const key = yield* makeFixtureTurnRecord("admission")
      const storage = yield* TurnRecordStorage
      const sql = yield* SqlClient.SqlClient
      // Written by the per-turn admission before migration 023 moved it to the session.
      const admission = `{"agentOverride":"helper","runSpec":{"overrides":{"maxSteps":4}},"interactive":false}`
      yield* sql`
        INSERT INTO turn_records (session_id, branch_id, message_id, step, continuations, pending_tool_calls_json, admission_json, updated_at)
        VALUES (${key.sessionId}, ${key.branchId}, ${key.messageId}, ${2}, ${0}, ${"[]"}, ${admission}, ${FIXED_NOW.getTime()})
      `
      expect(yield* storage.get(key)).toEqual(
        turnRecordAtStep({ step: 2, continuations: 0, pendingToolCalls: [] }),
      )
    }).pipe(
      Effect.provideService(CurrentWorkspaceId, DefaultWorkspaceId),
      Effect.provide(storageLayer),
    ),
  )

  it.live("a row written before admissions existed reads as a plain turn", () =>
    Effect.gen(function* () {
      const key = yield* makeFixtureTurnRecord("pre-admission")
      const storage = yield* TurnRecordStorage
      const sql = yield* SqlClient.SqlClient
      yield* sql`
        INSERT INTO turn_records (session_id, branch_id, message_id, step, continuations, pending_tool_calls_json, updated_at)
        VALUES (${key.sessionId}, ${key.branchId}, ${key.messageId}, ${3}, ${0}, ${"[]"}, ${FIXED_NOW.getTime()})
      `
      expect(yield* storage.get(key)).toEqual(
        turnRecordAtStep({ step: 3, continuations: 0, pendingToolCalls: [] }),
      )
    }).pipe(
      Effect.provideService(CurrentWorkspaceId, DefaultWorkspaceId),
      Effect.provide(storageLayer),
    ),
  )

  it.live("advances one turn's position without leaving the earlier step readable", () =>
    Effect.gen(function* () {
      const key = yield* makeFixtureTurnRecord("advance")
      const storage = yield* TurnRecordStorage
      yield* storage.put(
        key,
        turnRecordAtStep({
          step: 1,
          continuations: 0,
          pendingToolCalls: [{ id: "call-1", name: "@test/tool" }],
        }),
      )
      yield* storage.put(key, turnRecordAtStep({ step: 2, continuations: 0, pendingToolCalls: [] }))
      const loaded = yield* storage.get(key)
      expect(loaded.step).toBe(2)
      expect(loaded.pendingToolCalls).toEqual([])
    }).pipe(
      Effect.provideService(CurrentWorkspaceId, DefaultWorkspaceId),
      Effect.provide(storageLayer),
    ),
  )

  it.live("hides a record that belongs to another workspace", () =>
    Effect.gen(function* () {
      const key = yield* makeFixtureTurnRecord("workspace", WORKSPACE_B)
      const storage = yield* TurnRecordStorage
      yield* storage
        .put(key, turnRecordAtStep({ step: 5, continuations: 2, pendingToolCalls: [] }))
        .pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE_B))
      const own = yield* storage
        .get(key)
        .pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE_B))
      expect(own.step).toBe(5)
      const foreign = yield* storage
        .get(key)
        .pipe(Effect.provideService(CurrentWorkspaceId, DefaultWorkspaceId))
      expect(foreign).toEqual(emptyTurnRecord)
    }).pipe(Effect.provide(storageLayer)),
  )

  it.live("drops the record when its turn message is deleted", () =>
    Effect.gen(function* () {
      const key = yield* makeFixtureTurnRecord("cascade")
      const storage = yield* TurnRecordStorage
      const sql = yield* SqlClient.SqlClient
      yield* storage.put(key, turnRecordAtStep({ step: 2, continuations: 0, pendingToolCalls: [] }))
      yield* sql`DELETE FROM messages WHERE id = ${key.messageId}`
      expect(yield* storage.get(key)).toEqual(emptyTurnRecord)
    }).pipe(
      Effect.provideService(CurrentWorkspaceId, DefaultWorkspaceId),
      Effect.provide(storageLayer),
    ),
  )
})

describe("turn_records migration", () => {
  it.live("creates the turn_records table with its turn key", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const columns = yield* sql<{ readonly name: string; readonly pk: number }>`
        SELECT name, pk FROM pragma_table_info('turn_records')
      `
      expect(columns.map((column) => column.name).sort()).toEqual([
        "admission_json",
        "branch_id",
        "continuations",
        "message_id",
        "pending_tool_calls_json",
        "session_id",
        "step",
        "updated_at",
      ])
      const key = columns
        .filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk)
        .map((column) => column.name)
      expect(key).toEqual(["session_id", "branch_id", "message_id"])
    }).pipe(Effect.provide(storageLayer)),
  )

  it.live("records the turn_records migration in the applied chain", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ readonly name: string }>`
        SELECT name FROM gent_storage_migrations WHERE name = 'turn_records'
      `
      expect(rows.length).toBe(1)
    }).pipe(Effect.provide(storageLayer)),
  )
})
