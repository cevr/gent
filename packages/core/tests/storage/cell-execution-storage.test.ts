import { expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import * as Prompt from "effect/unstable/ai/Prompt"
import { BranchId, MessageId, SessionId, ToolCallId } from "@gent/core-internal/domain/ids"
import { Branch, dateFromMillis, Message, Session } from "@gent/core-internal/domain/message"
import { StorageError } from "@gent/core-internal/domain/storage-error"
import { GentPlatform } from "@gent/core-internal/runtime/gent-platform"
import { CurrentWorkspaceId, WorkspaceId } from "@gent/core-internal/server/workspace-rpc"
import { BranchStorage } from "@gent/core-internal/storage/branch-storage"
import { CellExecutionStorage } from "@gent/core-internal/storage/cell-execution-storage"
import { MessageStorage } from "@gent/core-internal/storage/message-storage"
import { SessionStorage } from "@gent/core-internal/storage/session-storage"
import { SqliteStorage } from "@gent/core-internal/storage/sqlite-storage"

const now = dateFromMillis(1_767_225_600_000)
const code = "await tools.write({ path: 'result.txt', content: 'once' })"
const makeFixture = Effect.fn("test.makeCellCall")(function* (suffix: string) {
  const sessions = yield* SessionStorage
  const branches = yield* BranchStorage
  const messages = yield* MessageStorage
  const address = {
    sessionId: SessionId.make(`cell-session-${suffix}`),
    branchId: BranchId.make(`cell-branch-${suffix}`),
    assistantMessageId: MessageId.make(`cell-message-${suffix}`),
    toolCallId: ToolCallId.make(`cell-call-${suffix}`),
  }
  yield* sessions.createSession(
    new Session({ id: address.sessionId, createdAt: now, updatedAt: now }),
  )
  yield* branches.createBranch(
    new Branch({ id: address.branchId, sessionId: address.sessionId, createdAt: now }),
  )
  yield* messages.createMessage(
    Message.cases.regular.make({
      id: address.assistantMessageId,
      sessionId: address.sessionId,
      branchId: address.branchId,
      role: "assistant",
      parts: [
        Prompt.toolCallPart({
          id: address.toolCallId,
          name: "cell",
          params: { code },
          providerExecuted: false,
        }),
      ],
      createdAt: now,
    }),
  )
  return address
})

it.live("admits a cell once under concurrent claims and retains its first result", () =>
  Effect.gen(function* () {
    const address = yield* makeFixture("concurrent")
    const storage = yield* CellExecutionStorage
    expect(yield* storage.get(address)).toEqual(Option.none())
    const claims = yield* Effect.all(
      Array.from({ length: 8 }, () => storage.claim(address)),
      { concurrency: 8 },
    )
    expect(claims.filter((claim) => claim._tag === "Claimed")).toEqual([{ _tag: "Claimed", code }])
    expect(claims.filter((claim) => claim._tag === "Incomplete")).toHaveLength(7)
    expect(yield* storage.get(address)).toEqual(Option.some({ _tag: "Incomplete" }))
    const result = Prompt.toolResultPart({
      id: address.toolCallId,
      name: "cell",
      result: { display: "done" },
      isFailure: false,
      providerExecuted: false,
    })
    yield* storage.complete(address, result)
    expect(yield* storage.get(address)).toEqual(Option.some({ _tag: "Completed", result }))
    yield* storage.complete(address, result)
    expect(yield* storage.claim(address)).toEqual({ _tag: "Completed", result })
    const conflict = yield* storage
      .complete(address, Prompt.toolResultPart({ ...result, result: "different" }))
      .pipe(Effect.flip)
    expect(conflict.message).toBe("Cell result is immutable")
    expect(yield* storage.claim(address)).toEqual({ _tag: "Completed", result })
  }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
)

it.live("denies cross-workspace and cross-branch claims and completions", () =>
  Effect.gen(function* () {
    const address = yield* makeFixture("ownership")
    const storage = yield* CellExecutionStorage
    const result = Prompt.toolResultPart({
      id: address.toolCallId,
      name: "cell",
      result: "done",
      isFailure: false,
      providerExecuted: false,
    })
    const otherWorkspace = WorkspaceId.make("a".repeat(64))
    expect(
      Schema.is(StorageError)(
        yield* storage
          .get(address)
          .pipe(Effect.provideService(CurrentWorkspaceId, otherWorkspace), Effect.flip),
      ),
    ).toBe(true)
    const hiddenClaim = yield* storage
      .claim(address)
      .pipe(Effect.provideService(CurrentWorkspaceId, otherWorkspace), Effect.flip)
    expect(Schema.is(StorageError)(hiddenClaim)).toBe(true)
    expect((yield* storage.claim(address))._tag).toBe("Claimed")
    const hiddenComplete = yield* storage
      .complete(address, result)
      .pipe(Effect.provideService(CurrentWorkspaceId, otherWorkspace), Effect.flip)
    expect(Schema.is(StorageError)(hiddenComplete)).toBe(true)
    for (const wrongAddress of [
      { ...address, branchId: BranchId.make("other-branch") },
      { ...address, sessionId: SessionId.make("other-session") },
      { ...address, toolCallId: ToolCallId.make("missing-call") },
    ]) {
      expect(Schema.is(StorageError)(yield* storage.get(wrongAddress).pipe(Effect.flip))).toBe(true)
      expect(Schema.is(StorageError)(yield* storage.claim(wrongAddress).pipe(Effect.flip))).toBe(
        true,
      )
      expect(
        Schema.is(StorageError)(yield* storage.complete(wrongAddress, result).pipe(Effect.flip)),
      ).toBe(true)
    }
    expect((yield* storage.claim(address))._tag).toBe("Incomplete")
  }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
)

it.live("rejects unclaimed and mismatched results and removes receipts with the message", () =>
  Effect.gen(function* () {
    const address = yield* makeFixture("integrity")
    const storage = yield* CellExecutionStorage
    const sql = yield* SqlClient.SqlClient
    const result = Prompt.toolResultPart({
      id: address.toolCallId,
      name: "cell",
      result: "failure",
      isFailure: true,
      providerExecuted: false,
    })
    expect(
      Schema.is(StorageError)(yield* storage.complete(address, result).pipe(Effect.flip)),
    ).toBe(true)
    yield* storage.claim(address)
    expect(
      Schema.is(StorageError)(
        yield* storage
          .complete(address, Prompt.toolResultPart({ ...result, name: "other" }))
          .pipe(Effect.flip),
      ),
    ).toBe(true)
    yield* storage.complete(address, result)
    expect(yield* storage.claim(address)).toEqual({ _tag: "Completed", result })
    yield* sql`UPDATE cell_executions SET result_json = ${"not-json"} WHERE assistant_message_id = ${address.assistantMessageId}`
    expect(Schema.is(StorageError)(yield* storage.claim(address).pipe(Effect.flip))).toBe(true)
    yield* sql`DELETE FROM messages WHERE id = ${address.assistantMessageId}`
    const rows = yield* sql<{
      readonly count: number
    }>`SELECT COUNT(*) AS count FROM cell_executions`
    expect(rows[0]?.count).toBe(0)
  }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
)

it.live("rejects admission inside a caller transaction before granting execution", () =>
  Effect.gen(function* () {
    const address = yield* makeFixture("transaction")
    const storage = yield* CellExecutionStorage
    const sql = yield* SqlClient.SqlClient
    const rejected = yield* storage.claim(address).pipe(sql.withTransaction, Effect.flip)
    expect(Schema.is(StorageError)(rejected)).toBe(true)
    expect(yield* storage.claim(address)).toEqual({ _tag: "Claimed", code })
  }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
)

it.scopedLive(
  "keeps incomplete claims and saved failures after closing and reopening the database",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const storageLayer = SqliteStorage.LiveWithSql(path.join(dir, "gent.db")).pipe(
        Layer.provide(GentPlatform.Test()),
      )
      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(storageLayer)
          return yield* Effect.gen(function* () {
            const storage = yield* CellExecutionStorage
            const interrupted = yield* makeFixture("interrupted")
            const completed = yield* makeFixture("completed")
            yield* storage.claim(interrupted)
            yield* storage.claim(completed)
            const result = Prompt.toolResultPart({
              id: completed.toolCallId,
              name: "cell",
              result: "execution failed",
              isFailure: true,
              providerExecuted: false,
            })
            yield* storage.complete(completed, result)
            return { interrupted, completed, result }
          }).pipe(Effect.provideContext(context))
        }),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(storageLayer)
          return yield* Effect.gen(function* () {
            const storage = yield* CellExecutionStorage
            expect(yield* storage.claim(first.interrupted)).toEqual({ _tag: "Incomplete" })
            expect(yield* storage.claim(first.completed)).toEqual({
              _tag: "Completed",
              result: first.result,
            })
          }).pipe(Effect.provideContext(context))
        }),
      )
    }).pipe(Effect.provide(BunServices.layer)),
)
