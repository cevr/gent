import { Context, Effect, Layer, Option, Predicate, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import * as Prompt from "effect/unstable/ai/Prompt"
import { canonicalJsonString } from "effect-encore"
import {
  type BranchId,
  InteractionRequestId,
  MessageId,
  SessionId,
  ToolCallId,
} from "../domain/ids.js"
import {
  ApprovalDecisionSchema,
  type InteractionRequestRecord,
} from "../domain/interaction-request.js"
import { StorageError } from "../domain/storage-error.js"
import { ToolBindingIdentity, canonicalizeToolBindingIdentity } from "../domain/tool-binding.js"
import { GentPlatform } from "../runtime/gent-platform.js"
import { makeOwnedToolCallReader, type OwnedToolCallAddress } from "./sqlite/owned-tool-call.js"
import { InteractionStorage } from "./interaction-storage.js"

export const CellToolOperationId = Schema.NonEmptyString.check(Schema.isMaxLength(128))
const OperationAddressRow = Schema.Struct({
  operation_id: CellToolOperationId,
})
export const CellToolOperationState = Schema.TaggedUnion({
  Started: {},
  Waiting: { requestId: InteractionRequestId },
  Resuming: { requestId: InteractionRequestId, decision: ApprovalDecisionSchema },
  Completed: { result: Prompt.ToolResultPart },
})
const Operation = Schema.Struct({
  toolCallId: ToolCallId,
  binding: ToolBindingIdentity,
  input: Schema.Json,
  state: CellToolOperationState,
})
export type CellToolOperation = typeof Operation.Type
const OperationJson = Schema.fromJsonString(Operation)
const Row = Schema.Struct({
  record_json: Schema.String,
  request_id: Schema.NullOr(InteractionRequestId),
})
const DecisionRow = Schema.Struct({ decision_json: Schema.NullOr(Schema.String) })
const LocatedRow = Schema.Struct({
  assistant_message_id: MessageId,
  cell_tool_call_id: ToolCallId,
  operation_id: CellToolOperationId,
  session_id: SessionId,
})
const hasInteraction = Predicate.or(Predicate.isTagged("Waiting"), Predicate.isTagged("Resuming"))

export interface CellToolOperationKey {
  readonly cell: OwnedToolCallAddress
  readonly operationId: string
}

export interface CellToolOperationStorageService {
  readonly admit: (
    params: CellToolOperationKey & {
      readonly binding: ToolBindingIdentity
      readonly input: Schema.Json
    },
  ) => Effect.Effect<
    { readonly admitted: boolean; readonly operation: CellToolOperation },
    StorageError
  >
  readonly get: (key: CellToolOperationKey) => Effect.Effect<CellToolOperation, StorageError>
  /** Locate an inner operation by the call id its receipt carries, within one branch. */
  readonly findByToolCallId: (params: {
    readonly branchId: BranchId
    readonly toolCallId: ToolCallId
  }) => Effect.Effect<Option.Option<CellToolOperation>, StorageError>
  /** Recover all inner outcomes without relying on a live worker or phase. */
  readonly listForCell: (
    cell: OwnedToolCallAddress,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly key: CellToolOperationKey; readonly operation: CellToolOperation }>,
    StorageError
  >
  readonly suspend: (
    key: CellToolOperationKey,
    request: InteractionRequestRecord,
  ) => Effect.Effect<void, StorageError>
  readonly resume: (
    key: CellToolOperationKey,
    requestId: InteractionRequestId,
  ) => Effect.Effect<CellToolOperation, StorageError>
  readonly complete: (
    key: CellToolOperationKey,
    result: Prompt.ToolResultPart,
  ) => Effect.Effect<void, StorageError>
}

const failure = (cause: unknown) => {
  if (Schema.is(StorageError)(cause)) return cause
  return new StorageError({ message: "Cell tool operation storage failed", cause })
}

/** Durable receipts, not a scheduler. Started and Resuming are never reclaimed. */
export class CellToolOperationStorage extends Context.Service<
  CellToolOperationStorage,
  CellToolOperationStorageService
>()("@gent/core/src/storage/cell-tool-operation-storage/CellToolOperationStorage") {
  static Live = Layer.effect(
    CellToolOperationStorage,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const platform = yield* GentPlatform
      const interactions = yield* InteractionStorage
      const readOwnedCall = yield* makeOwnedToolCallReader
      const callIdFor = (key: CellToolOperationKey) =>
        ToolCallId.make(
          `cell:${platform.hash("sha256", canonicalJsonString([key.cell.assistantMessageId, key.cell.toolCallId, key.operationId]))}`,
        )
      const ownCell = Effect.fn("CellToolOperationStorage.ownCell")(function* (
        cell: OwnedToolCallAddress,
      ) {
        const call = yield* readOwnedCall(cell)
        if (Option.isNone(call) || call.value.name !== "cell")
          return yield* new StorageError({
            message: "Cell operation is outside the current workspace and branch",
          })
        const rows =
          yield* sql`SELECT 1 FROM cell_executions WHERE assistant_message_id = ${cell.assistantMessageId} AND tool_call_id = ${cell.toolCallId}`
        if (rows.length !== 1)
          return yield* new StorageError({
            message: "Cell operation requires an admitted outer cell",
          })
      })
      const own = Effect.fn("CellToolOperationStorage.own")(function* (key: CellToolOperationKey) {
        yield* Schema.decodeEffect(CellToolOperationId)(key.operationId)
        yield* ownCell(key.cell)
      })
      const read = Effect.fn("CellToolOperationStorage.read")(function* (
        key: CellToolOperationKey,
      ) {
        const rows = yield* sql<
          typeof Row.Type
        >`SELECT record_json, request_id FROM cell_tool_operations WHERE assistant_message_id = ${key.cell.assistantMessageId} AND cell_tool_call_id = ${key.cell.toolCallId} AND operation_id = ${key.operationId}`
        const row = yield* Schema.decodeUnknownEffect(Row)(rows[0])
        const operation = yield* Schema.decodeEffect(OperationJson)(row.record_json)
        if (operation.toolCallId !== callIdFor(key))
          return yield* new StorageError({ message: "Cell operation call identity is corrupt" })
        if (
          operation.state._tag === "Completed" &&
          (operation.state.result.id !== operation.toolCallId ||
            operation.state.result.name !== operation.binding.toolId)
        )
          return yield* new StorageError({
            message: "Stored cell operation result does not match its binding",
          })
        if (hasInteraction(operation.state) && operation.state.requestId !== row.request_id)
          return yield* new StorageError({
            message: "Cell operation interaction identity is corrupt",
          })
        return operation
      })
      const write = Effect.fn("CellToolOperationStorage.write")(function* (
        key: CellToolOperationKey,
        operation: CellToolOperation,
      ) {
        const json = yield* Schema.encodeEffect(OperationJson)(operation)
        yield* sql`UPDATE cell_tool_operations SET record_json = ${json} WHERE assistant_message_id = ${key.cell.assistantMessageId} AND cell_tool_call_id = ${key.cell.toolCallId} AND operation_id = ${key.operationId}`
      })
      const outsideTransaction = Effect.gen(function* () {
        if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
          return yield* new StorageError({
            message: "Cell operation admission must commit outside a caller transaction",
          })
      })
      const requireOpenCell = Effect.fn("CellToolOperationStorage.requireOpenCell")(function* (
        key: CellToolOperationKey,
      ) {
        const rows =
          yield* sql`SELECT 1 FROM cell_executions WHERE assistant_message_id = ${key.cell.assistantMessageId} AND tool_call_id = ${key.cell.toolCallId} AND result_json IS NULL`
        if (rows.length !== 1)
          return yield* new StorageError({
            message: "Completed cell cannot admit more host effects",
          })
      })
      const admit = Effect.fn("CellToolOperationStorage.admit")(function* (
        params: Parameters<CellToolOperationStorageService["admit"]>[0],
      ) {
        yield* outsideTransaction
        return yield* Effect.gen(function* () {
          yield* own(params)
          yield* requireOpenCell(params)
          const toolCallId = callIdFor(params)
          const operation = yield* Schema.decodeEffect(Operation)({
            toolCallId,
            binding: canonicalizeToolBindingIdentity(params.binding),
            input: params.input,
            state: CellToolOperationState.cases.Started.make({}),
          })
          const json = yield* Schema.encodeEffect(OperationJson)(operation)
          const inserted =
            yield* sql`INSERT INTO cell_tool_operations (assistant_message_id, cell_tool_call_id, operation_id, record_json) VALUES (${params.cell.assistantMessageId}, ${params.cell.toolCallId}, ${params.operationId}, ${json}) ON CONFLICT DO NOTHING RETURNING operation_id`
          const existing = yield* read(params)
          const immutable = (value: CellToolOperation) =>
            canonicalJsonString({
              toolCallId: value.toolCallId,
              binding: value.binding,
              input: value.input,
            })
          if (immutable(existing) !== immutable(operation))
            return yield* new StorageError({
              message: "Cell operation input and binding are immutable",
            })
          return { admitted: inserted.length === 1, operation: existing }
        }).pipe(sql.withTransaction, Effect.mapError(failure))
      })
      const get = Effect.fn("CellToolOperationStorage.get")((key: CellToolOperationKey) =>
        own(key).pipe(Effect.andThen(read(key)), sql.withTransaction, Effect.mapError(failure)),
      )
      const findByToolCallId = Effect.fn("CellToolOperationStorage.findByToolCallId")(
        function* (params: { readonly branchId: BranchId; readonly toolCallId: ToolCallId }) {
          return yield* Effect.gen(function* () {
            const rows = yield* sql<typeof LocatedRow.Type>`
            SELECT o.assistant_message_id, o.cell_tool_call_id, o.operation_id, m.session_id
            FROM cell_tool_operations o
            JOIN messages m ON m.id = o.assistant_message_id
            WHERE m.branch_id = ${params.branchId}
              AND json_extract(o.record_json, '$.toolCallId') = ${params.toolCallId}
            LIMIT 1
          `
            const located = Option.fromUndefinedOr(rows[0])
            if (Option.isNone(located)) return Option.none<CellToolOperation>()
            const row = yield* Schema.decodeEffect(LocatedRow)(located.value)
            const cell = {
              sessionId: row.session_id,
              branchId: params.branchId,
              assistantMessageId: row.assistant_message_id,
              toolCallId: row.cell_tool_call_id,
            }
            // Ownership goes through the same workspace-scoped reader as every other access.
            if (Option.isNone(yield* readOwnedCall(cell))) return Option.none<CellToolOperation>()
            return Option.some(yield* read({ cell, operationId: row.operation_id }))
          }).pipe(sql.withTransaction, Effect.mapError(failure))
        },
      )
      const listForCell = Effect.fn("CellToolOperationStorage.listForCell")(function* (
        cell: OwnedToolCallAddress,
      ) {
        return yield* Effect.gen(function* () {
          yield* ownCell(cell)
          const rows = yield* sql<typeof OperationAddressRow.Type>`
            SELECT operation_id FROM cell_tool_operations
            WHERE assistant_message_id = ${cell.assistantMessageId}
              AND cell_tool_call_id = ${cell.toolCallId}
            ORDER BY operation_id
          `
          return yield* Effect.forEach(rows, (raw) =>
            Effect.gen(function* () {
              const row = yield* Schema.decodeEffect(OperationAddressRow)(raw)
              const key = { cell, operationId: row.operation_id }
              return { key, operation: yield* read(key) }
            }),
          )
        }).pipe(sql.withTransaction, Effect.mapError(failure))
      })
      const interaction = Effect.fn("CellToolOperationStorage.interaction")(function* (
        key: CellToolOperationKey,
        requestId: InteractionRequestId,
      ) {
        const rows = yield* sql<
          typeof DecisionRow.Type
        >`SELECT decision_json FROM interaction_requests WHERE request_id = ${requestId} AND session_id = ${key.cell.sessionId} AND branch_id = ${key.cell.branchId} AND status = 'pending'`
        if (rows.length !== 1)
          return yield* new StorageError({
            message: "Pending interaction does not belong to this operation branch",
          })
        const row = yield* Schema.decodeUnknownEffect(DecisionRow)(rows[0])
        return Option.fromNullishOr(row.decision_json)
      })
      const suspend = Effect.fn("CellToolOperationStorage.suspend")(function* (
        key: CellToolOperationKey,
        request: InteractionRequestRecord,
      ) {
        yield* outsideTransaction
        return yield* Effect.gen(function* () {
          yield* own(key)
          yield* requireOpenCell(key)
          const operation = yield* read(key)
          if (
            request.sessionId !== key.cell.sessionId ||
            request.branchId !== key.cell.branchId ||
            request.type !== "approval" ||
            request.status !== "pending" ||
            Option.isSome(Option.fromNullishOr(request.decisionJson))
          )
            return yield* new StorageError({
              message: "Cell operation requires a new approval in its own branch",
            })
          if (operation.state._tag !== "Started" && operation.state._tag !== "Resuming")
            return yield* new StorageError({
              message: "Cell operation cannot wait from its current state",
            })
          yield* interactions.persist(request)
          const requestId = request.requestId
          yield* sql`UPDATE cell_tool_operations SET request_id = ${requestId} WHERE assistant_message_id = ${key.cell.assistantMessageId} AND cell_tool_call_id = ${key.cell.toolCallId} AND operation_id = ${key.operationId}`
          yield* write(key, {
            ...operation,
            state: CellToolOperationState.cases.Waiting.make({ requestId }),
          })
        }).pipe(sql.withTransaction, Effect.mapError(failure))
      })
      const resume = Effect.fn("CellToolOperationStorage.resume")(function* (
        key: CellToolOperationKey,
        requestId: InteractionRequestId,
      ) {
        yield* outsideTransaction
        return yield* Effect.gen(function* () {
          yield* own(key)
          yield* requireOpenCell(key)
          const operation = yield* read(key)
          if (operation.state._tag !== "Waiting" || operation.state.requestId !== requestId)
            return yield* new StorageError({
              message: "Cell operation is not waiting for this request",
            })
          const decisionJson = yield* interaction(key, requestId)
          if (Option.isNone(decisionJson))
            return yield* new StorageError({
              message: "Cell operation has no saved interaction decision",
            })
          const decision = yield* Schema.decodeEffect(
            Schema.fromJsonString(ApprovalDecisionSchema),
          )(decisionJson.value)
          const resumed = {
            ...operation,
            state: CellToolOperationState.cases.Resuming.make({ requestId, decision }),
          }
          yield* write(key, resumed)
          return resumed
        }).pipe(sql.withTransaction, Effect.mapError(failure))
      })
      const complete = Effect.fn("CellToolOperationStorage.complete")(function* (
        key: CellToolOperationKey,
        result: Prompt.ToolResultPart,
      ) {
        return yield* Effect.gen(function* () {
          yield* own(key)
          const operation = yield* read(key)
          if (result.id !== operation.toolCallId || result.name !== operation.binding.toolId)
            return yield* new StorageError({
              message: "Cell operation result does not match its bound call",
            })
          if (operation.state._tag === "Waiting")
            return yield* new StorageError({
              message: "Cell operation must resume before completion",
            })
          const completed = {
            ...operation,
            state: CellToolOperationState.cases.Completed.make({ result }),
          }
          if (operation.state._tag === "Completed") {
            if (
              (yield* Schema.encodeEffect(OperationJson)(operation)) !==
              (yield* Schema.encodeEffect(OperationJson)(completed))
            )
              return yield* new StorageError({ message: "Cell operation result is immutable" })
            return
          }
          yield* write(key, completed)
        }).pipe(sql.withTransaction, Effect.mapError(failure))
      })
      return CellToolOperationStorage.of({
        admit,
        get,
        findByToolCallId,
        listForCell,
        suspend,
        resume,
        complete,
      })
    }),
  )
}
