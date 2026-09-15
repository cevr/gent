import { describe, expect, it } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Branch, dateFromMillis, Message, Session } from "../../src/domain/message"
import { BranchId, MessageId, SessionId } from "../../src/domain/ids"
import { CurrentWorkspaceId, DefaultWorkspaceId, WorkspaceId } from "../../src/server/workspace-rpc"
import { MessageStorage } from "../../src/storage/message-storage"
import { SqliteStorage } from "../../src/storage/sqlite-storage"
import { BranchStorage } from "../../src/storage/branch-storage"
import { SessionStorage } from "../../src/storage/session-storage"
import {
  emptyTurnRecord,
  TurnRecordStorage,
  turnRecordAtStep,
} from "../../src/storage/turn-record-storage"

const FIXED_NOW = dateFromMillis(1_767_225_600_000)
const WORKSPACE_B = WorkspaceId.make("b".repeat(64))

const storageLayer = SqliteStorage.TestWithSql(() => Layer.empty, {})

const makeFixture = (suffix: string, workspaceId: WorkspaceId = DefaultWorkspaceId) =>
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
      const key = yield* makeFixture("empty")
      const storage = yield* TurnRecordStorage
      expect(yield* storage.get(key)).toEqual(emptyTurnRecord)
    }).pipe(
      Effect.provideService(CurrentWorkspaceId, DefaultWorkspaceId),
      Effect.provide(storageLayer),
    ),
  )

  it.live("round-trips the step, the continuation count, and the pending calls", () =>
    Effect.gen(function* () {
      const key = yield* makeFixture("round-trip")
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

  it.live("advances one turn's position without leaving the earlier step readable", () =>
    Effect.gen(function* () {
      const key = yield* makeFixture("advance")
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
      const key = yield* makeFixture("workspace", WORKSPACE_B)
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
      const key = yield* makeFixture("cascade")
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
