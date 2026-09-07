import { expect, it } from "effect-bun-test"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { BunServices } from "@effect/platform-bun"
import { GentPlatform } from "@gent/core-internal/runtime/gent-platform"
import { ApprovalService } from "@gent/core-internal/runtime/approval-service"
import { CurrentCellToolOperation } from "@gent/core-internal/runtime/code-cell/current-cell-tool-operation"
import { createE2ELayer } from "@gent/core-internal/test-utils/e2e-layer"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { EventStorage } from "@gent/core-internal/storage/event-storage"
import { SqlClient } from "effect/unstable/sql"
import * as Prompt from "effect/unstable/ai/Prompt"
import {
  BranchId,
  ExtensionId,
  InteractionRequestId,
  MessageId,
  SessionId,
  ToolCallId,
  ToolId,
} from "@gent/core-internal/domain/ids"
import { Message, dateFromMillis } from "@gent/core-internal/domain/message"
import { StorageError } from "@gent/core-internal/domain/storage-error"
import {
  makeToolBindingIdentity,
  ToolBindingSource,
  ToolSchemaRevision,
  ToolSourceRevision,
} from "@gent/core-internal/domain/tool-binding"
import {
  encodeInteractionDecision,
  InteractionRequestRecord,
  InteractionPendingError,
} from "@gent/core-internal/domain/interaction-request"
import { CurrentWorkspaceId, WorkspaceId } from "@gent/core-internal/server/workspace-rpc"
import { CellExecutionStorage } from "@gent/core-internal/storage/cell-execution-storage"
import { CellToolOperationStorage } from "@gent/core-internal/storage/cell-tool-operation-storage"
import { InteractionStorage } from "@gent/core-internal/storage/interaction-storage"
import { MessageStorage } from "@gent/core-internal/storage/message-storage"
import { SqliteStorage } from "@gent/core-internal/storage/sqlite-storage"
import { ensureStorageParents } from "@gent/core-internal/test-utils"

const cell = {
  sessionId: SessionId.make("cell-operation-session"),
  branchId: BranchId.make("cell-operation-branch"),
  assistantMessageId: MessageId.make("cell-operation-message"),
  toolCallId: ToolCallId.make("cell-outer-call"),
}
const key = { cell, operationId: "1" }
const binding = makeToolBindingIdentity({
  toolId: ToolId.make("write"),
  extensionId: ExtensionId.make("files"),
  source: ToolBindingSource.cases.Static.make({
    sourceRevision: ToolSourceRevision.make("source-1"),
  }),
  schemaRevision: ToolSchemaRevision.make("schema-1"),
  resources: [],
})
const params = { ...key, binding, input: { path: "file.txt", content: "once" } }
const requestId = InteractionRequestId.make("cell-request")
const fixture = Effect.gen(function* () {
  yield* ensureStorageParents(cell)
  const messages = yield* MessageStorage
  yield* messages.createMessage(
    Message.cases.regular.make({
      id: cell.assistantMessageId,
      sessionId: cell.sessionId,
      branchId: cell.branchId,
      role: "assistant",
      createdAt: dateFromMillis(1_767_225_600_000),
      parts: [
        Prompt.toolCallPart({
          id: cell.toolCallId,
          name: "cell",
          params: { code: "await tools.call('write', {})" },
          providerExecuted: false,
        }),
      ],
    }),
  )
})
const request = InteractionRequestRecord.make({
  requestId,
  type: "approval",
  sessionId: cell.sessionId,
  branchId: cell.branchId,
  paramsJson: '{"text":"Allow write?"}',
  status: "pending",
  createdAt: 1_767_225_600_000,
})

it.live("admits an operation once and preserves its original input, binding, and result", () =>
  Effect.gen(function* () {
    yield* fixture
    const outer = yield* CellExecutionStorage
    const storage = yield* CellToolOperationStorage
    expect(Schema.is(StorageError)(yield* storage.admit(params).pipe(Effect.flip))).toBe(true)
    yield* outer.claim(cell)
    const claims = yield* Effect.all(
      Array.from({ length: 8 }, () => storage.admit(params)),
      { concurrency: 8 },
    )
    expect(claims.filter((claim) => claim.admitted)).toHaveLength(1)
    const operation = yield* storage.get(key)
    expect(operation.input).toEqual(params.input)
    expect(operation.binding).toEqual(binding)
    expect(operation.state._tag).toBe("Started")
    expect(
      (yield* storage.admit({ ...params, input: { content: "once", path: "file.txt" } })).admitted,
    ).toBe(false)
    expect(
      Schema.is(StorageError)(
        yield* storage.admit({ ...params, input: { content: "different" } }).pipe(Effect.flip),
      ),
    ).toBe(true)
    expect(
      Schema.is(StorageError)(
        yield* storage
          .admit({
            ...params,
            binding: makeToolBindingIdentity({
              ...binding,
              schemaRevision: ToolSchemaRevision.make("schema-2"),
            }),
          })
          .pipe(Effect.flip),
      ),
    ).toBe(true)
    const result = Prompt.toolResultPart({
      id: operation.toolCallId,
      name: "write",
      result: "written",
      isFailure: false,
      providerExecuted: false,
    })
    expect(
      Schema.is(StorageError)(
        yield* storage
          .complete(key, Prompt.toolResultPart({ ...result, name: "other" }))
          .pipe(Effect.flip),
      ),
    ).toBe(true)
    yield* storage.complete(key, result)
    yield* storage.complete(key, result)
    expect((yield* storage.get(key)).state).toEqual({ _tag: "Completed", result })
    expect((yield* storage.admit(params)).admitted).toBe(false)
    expect(
      Schema.is(StorageError)(
        yield* storage
          .complete(key, Prompt.toolResultPart({ ...result, result: "changed" }))
          .pipe(Effect.flip),
      ),
    ).toBe(true)
  }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
)

it.scopedLive(
  "publishes cell approval only after durable ownership and consumes its exact decision",
  () =>
    Effect.gen(function* () {
      yield* fixture
      yield* (yield* CellExecutionStorage).claim(cell)
      const storage = yield* CellToolOperationStorage
      const approval = yield* ApprovalService
      const events = yield* EventStorage
      const sql = yield* SqlClient.SqlClient
      yield* storage.admit(params)
      const peer = { ...key, operationId: "2" }
      yield* storage.admit({ ...params, ...peer })
      yield* sql`CREATE TEMP TRIGGER require_cell_approval_owner BEFORE INSERT ON events WHEN NEW.event_tag = 'InteractionPresented' BEGIN SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM cell_tool_operations o JOIN interaction_requests r ON r.request_id = o.request_id WHERE r.request_id = json_extract(NEW.event_json, '$.requestId')) THEN RAISE(ABORT, 'approval has no operation owner') END; END`
      const first = yield* approval
        .present({ text: "First?" }, cell)
        .pipe(Effect.provideService(CurrentCellToolOperation, key), Effect.flip)
      if (!Schema.is(InteractionPendingError)(first)) return yield* Effect.die(first)
      yield* approval.storeResolution(first.requestId, { approved: false, notes: "First denied" })
      const blocked = yield* approval
        .present({ text: "Second?" }, cell)
        .pipe(Effect.provideService(CurrentCellToolOperation, peer), Effect.flip)
      expect(blocked._tag).toBe("EventStoreError")
      expect((yield* storage.get(peer)).state._tag).toBe("Started")
      expect(
        (yield* events.listEvents(cell)).filter(
          (event) => event.event._tag === "InteractionPresented",
        ),
      ).toHaveLength(1)
      yield* storage.resume(key, first.requestId)
      expect(
        yield* approval
          .present({ text: "First?" }, cell)
          .pipe(Effect.provideService(CurrentCellToolOperation, key)),
      ).toEqual({ approved: false, notes: "First denied" })
      const second = yield* approval
        .present({ text: "Second?" }, cell)
        .pipe(Effect.provideService(CurrentCellToolOperation, peer), Effect.flip)
      if (!Schema.is(InteractionPendingError)(second)) return yield* Effect.die(second)
      expect(second.requestId).not.toBe(first.requestId)
      yield* approval.storeResolution(second.requestId, { approved: true })
      yield* storage.resume(peer, second.requestId)
      expect(
        yield* approval
          .present({ text: "Second?" }, cell)
          .pipe(Effect.provideService(CurrentCellToolOperation, peer)),
      ).toEqual({ approved: true })
      expect(
        (yield* approval
          .present({ text: "Again?" }, cell)
          .pipe(Effect.provideService(CurrentCellToolOperation, key), Effect.flip))._tag,
      ).toBe("EventStoreError")
    }).pipe(
      Effect.provide(
        createE2ELayer({
          agents: [],
          extensionInputs: [],
          providerLayer: LanguageModelLayers.debug(),
          durableApproval: true,
        }),
      ),
    ),
)

it.live("never leaves an approval behind when its operation link fails", () =>
  Effect.gen(function* () {
    yield* fixture
    yield* (yield* CellExecutionStorage).claim(cell)
    const storage = yield* CellToolOperationStorage
    const interactions = yield* InteractionStorage
    const sql = yield* SqlClient.SqlClient
    yield* storage.admit(params)
    yield* sql`CREATE TEMP TRIGGER reject_cell_link BEFORE UPDATE OF request_id ON cell_tool_operations BEGIN SELECT RAISE(ABORT, 'link failure'); END`
    expect(Schema.is(StorageError)(yield* storage.suspend(key, request).pipe(Effect.flip))).toBe(
      true,
    )
    expect(yield* interactions.listPending(cell)).toEqual([])
    expect((yield* storage.get(key)).state._tag).toBe("Started")
    yield* sql`DROP TRIGGER reject_cell_link`
    expect(
      Schema.is(StorageError)(
        yield* storage.suspend(key, request).pipe(sql.withTransaction, Effect.flip),
      ),
    ).toBe(true)
    expect(yield* interactions.listPending(cell)).toEqual([])
    yield* storage.suspend(key, request)
    expect(yield* interactions.listPending(cell)).toEqual([request])
    expect((yield* storage.get(key)).state).toEqual({ _tag: "Waiting", requestId })
  }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
)

it.live(
  "recovers cell operations only in their workspace and branch without granting execution",
  () =>
    Effect.gen(function* () {
      yield* fixture
      yield* (yield* CellExecutionStorage).claim(cell)
      const storage = yield* CellToolOperationStorage
      expect(yield* storage.listForCell(cell)).toEqual([])
      yield* storage.admit(params)
      yield* storage.suspend(key, request)
      const found = yield* storage.listForCell(cell)
      expect(found).toHaveLength(1)
      expect(found[0]?.key).toEqual(key)
      expect(found[0]?.operation.state).toEqual({ _tag: "Waiting", requestId })
      expect(
        Schema.is(StorageError)(
          yield* storage
            .listForCell({ ...cell, branchId: BranchId.make("other") })
            .pipe(Effect.flip),
        ),
      ).toBe(true)
      expect(
        Schema.is(StorageError)(
          yield* storage
            .listForCell(cell)
            .pipe(
              Effect.provideService(CurrentWorkspaceId, WorkspaceId.make("b".repeat(64))),
              Effect.flip,
            ),
        ),
      ).toBe(true)
      yield* (yield* InteractionStorage).decide(
        requestId,
        yield* encodeInteractionDecision({ approved: true }),
      )
      const resumed = yield* storage.resume(key, requestId)
      yield* storage.complete(
        key,
        Prompt.toolResultPart({
          id: resumed.toolCallId,
          name: binding.toolId,
          result: "done",
          isFailure: false,
          providerExecuted: false,
        }),
      )
      yield* storage.admit({ ...params, operationId: "2" })
      const completed = yield* storage.listForCell(cell)
      expect(completed.map(({ operation }) => operation.state._tag)).toEqual([
        "Completed",
        "Started",
      ])
      expect((yield* storage.admit(params)).admitted).toBe(false)
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
)

it.live("binds a decision to one waiting operation and grants one resume attempt", () =>
  Effect.gen(function* () {
    yield* fixture
    yield* (yield* CellExecutionStorage).claim(cell)
    const storage = yield* CellToolOperationStorage
    const interactions = yield* InteractionStorage
    const first = yield* storage.admit(params)
    const peer = { ...params, operationId: "2" }
    yield* storage.admit(peer)
    yield* storage.suspend(key, request)
    expect(Schema.is(StorageError)(yield* storage.suspend(key, request).pipe(Effect.flip))).toBe(
      true,
    )
    expect(Schema.is(StorageError)(yield* storage.suspend(peer, request).pipe(Effect.flip))).toBe(
      true,
    )
    expect((yield* storage.get(peer)).state._tag).toBe("Started")
    expect(Schema.is(StorageError)(yield* storage.resume(key, requestId).pipe(Effect.flip))).toBe(
      true,
    )
    yield* interactions.decide(requestId, "not-json")
    expect(Schema.is(StorageError)(yield* storage.resume(key, requestId).pipe(Effect.flip))).toBe(
      true,
    )
    expect((yield* storage.get(key)).state._tag).toBe("Waiting")
    const decision = { approved: false, notes: "Do not write" }
    yield* interactions.decide(requestId, yield* encodeInteractionDecision(decision))
    const resumed = yield* storage.resume(key, requestId)
    expect(resumed.state).toEqual({ _tag: "Resuming", requestId, decision })
    expect(resumed.toolCallId).toBe(first.operation.toolCallId)
    expect(Schema.is(StorageError)(yield* storage.resume(key, requestId).pipe(Effect.flip))).toBe(
      true,
    )
    expect((yield* storage.admit(params)).admitted).toBe(false)
    expect((yield* storage.get(key)).state._tag).toBe("Resuming")
  }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
)

it.live(
  "rejects cross-workspace and cross-branch access and clears records with the outer cell",
  () =>
    Effect.gen(function* () {
      yield* fixture
      yield* (yield* CellExecutionStorage).claim(cell)
      const storage = yield* CellToolOperationStorage
      const sql = yield* SqlClient.SqlClient
      yield* storage.admit(params)
      const hidden = yield* storage
        .get(key)
        .pipe(
          Effect.provideService(CurrentWorkspaceId, WorkspaceId.make("a".repeat(64))),
          Effect.flip,
        )
      expect(Schema.is(StorageError)(hidden)).toBe(true)
      const wrong = { ...key, cell: { ...cell, branchId: BranchId.make("other-branch") } }
      expect(Schema.is(StorageError)(yield* storage.get(wrong).pipe(Effect.flip))).toBe(true)
      expect(
        Schema.is(StorageError)(yield* storage.admit({ ...params, ...wrong }).pipe(Effect.flip)),
      ).toBe(true)
      yield* sql`DELETE FROM messages WHERE id = ${cell.assistantMessageId}`
      const rows = yield* sql<{
        readonly count: number
      }>`SELECT COUNT(*) AS count FROM cell_tool_operations`
      expect(rows[0]?.count).toBe(0)
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
)

it.live("does not admit external work inside a caller transaction or after cell completion", () =>
  Effect.gen(function* () {
    yield* fixture
    const outer = yield* CellExecutionStorage
    yield* outer.claim(cell)
    const storage = yield* CellToolOperationStorage
    const sql = yield* SqlClient.SqlClient
    expect(
      Schema.is(StorageError)(yield* storage.admit(params).pipe(sql.withTransaction, Effect.flip)),
    ).toBe(true)
    expect((yield* storage.admit(params)).admitted).toBe(true)
    yield* storage.suspend(key, request)
    const interactions = yield* InteractionStorage
    yield* interactions.decide(requestId, yield* encodeInteractionDecision({ approved: true }))
    expect(
      Schema.is(StorageError)(
        yield* storage.resume(key, requestId).pipe(sql.withTransaction, Effect.flip),
      ),
    ).toBe(true)
    expect((yield* storage.get(key)).state._tag).toBe("Waiting")
    yield* outer.complete(
      cell,
      Prompt.toolResultPart({
        id: cell.toolCallId,
        name: "cell",
        result: "cancelled",
        isFailure: true,
        providerExecuted: false,
      }),
    )
    expect(Schema.is(StorageError)(yield* storage.resume(key, requestId).pipe(Effect.flip))).toBe(
      true,
    )
    expect(
      Schema.is(StorageError)(
        yield* storage.admit({ ...params, operationId: "2" }).pipe(Effect.flip),
      ),
    ).toBe(true)
  }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
)

it.scopedLive("retains approval ownership and prevents a second resume after database reopen", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const directory = yield* fs.makeTempDirectoryScoped()
    const layer = SqliteStorage.LiveWithSql(path.join(directory, "gent.db")).pipe(
      Layer.provide(GentPlatform.Test()),
    )
    yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(layer)
        yield* Effect.gen(function* () {
          yield* fixture
          yield* (yield* CellExecutionStorage).claim(cell)
          const storage = yield* CellToolOperationStorage
          yield* storage.admit(params)
          yield* storage.suspend(key, request)
          yield* (yield* InteractionStorage).decide(
            requestId,
            yield* encodeInteractionDecision({ approved: true }),
          )
        }).pipe(Effect.provideContext(context))
      }),
    )
    const resumedId = yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(layer)
        return yield* Effect.gen(function* () {
          const storage = yield* CellToolOperationStorage
          expect((yield* storage.get(key)).state).toEqual({ _tag: "Waiting", requestId })
          expect(
            (yield* storage.listForCell(cell)).map(({ operation }) => operation.state),
          ).toEqual([{ _tag: "Waiting", requestId }])
          const resumed = yield* storage.resume(key, requestId)
          expect(resumed.state).toEqual({
            _tag: "Resuming",
            requestId,
            decision: { approved: true },
          })
          return resumed.toolCallId
        }).pipe(Effect.provideContext(context))
      }),
    )
    yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(layer)
        yield* Effect.gen(function* () {
          const storage = yield* CellToolOperationStorage
          const existing = yield* storage.admit(params)
          expect(existing.admitted).toBe(false)
          expect(existing.operation.toolCallId).toBe(resumedId)
          expect(existing.operation.state._tag).toBe("Resuming")
          expect(
            (yield* storage.listForCell(cell)).map(({ operation }) => operation.state._tag),
          ).toEqual(["Resuming"])
          expect(
            Schema.is(StorageError)(yield* storage.resume(key, requestId).pipe(Effect.flip)),
          ).toBe(true)
        }).pipe(Effect.provideContext(context))
      }),
    )
  }).pipe(Effect.provide(BunServices.layer)),
)
