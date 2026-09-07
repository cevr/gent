import { Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import * as Prompt from "effect/unstable/ai/Prompt"
import { StorageError } from "../domain/storage-error.js"
import { CellInput } from "../domain/cell-input.js"
import { makeOwnedToolCallReader, type OwnedToolCallAddress } from "./sqlite/owned-tool-call.js"

const ResultJson = Schema.fromJsonString(Prompt.ToolResultPart)
const ExecutionRow = Schema.Struct({ result_json: Schema.NullOr(Schema.String) })

/** Incomplete means no recorded result, not proof of a live worker. Never reclaim it. */
export const CellExecutionAdmission = Schema.TaggedUnion({
  Claimed: CellInput.fields,
  Incomplete: {},
  Completed: { result: Prompt.ToolResultPart },
})
export type CellExecutionAdmission = typeof CellExecutionAdmission.Type
type SavedCellExecution = Exclude<CellExecutionAdmission, { readonly _tag: "Claimed" }>

export interface CellExecutionStorageService {
  readonly get: (
    address: OwnedToolCallAddress,
  ) => Effect.Effect<Option.Option<SavedCellExecution>, StorageError>
  /** Commit this claim before evaluation. Do not wrap evaluation in a SQL transaction. */
  readonly claim: (
    address: OwnedToolCallAddress,
  ) => Effect.Effect<CellExecutionAdmission, StorageError>
  readonly complete: (
    address: OwnedToolCallAddress,
    result: Prompt.ToolResultPart,
  ) => Effect.Effect<void, StorageError>
}

const storageFailure = (cause: unknown) => {
  if (Schema.is(StorageError)(cause)) return cause
  return new StorageError({ message: "Failed to record cell execution", cause })
}

/** Outer cell receipts share the message database. They never store a VM continuation. */
export class CellExecutionStorage extends Context.Service<
  CellExecutionStorage,
  CellExecutionStorageService
>()("@gent/core/src/storage/cell-execution-storage/CellExecutionStorage") {
  static Live = Layer.effect(
    CellExecutionStorage,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const readOwnedCall = yield* makeOwnedToolCallReader
      const requireCell = Effect.fn("CellExecutionStorage.requireCell")(function* (
        address: OwnedToolCallAddress,
      ) {
        const call = yield* readOwnedCall(address)
        if (Option.isNone(call) || call.value.name !== "cell") {
          return yield* new StorageError({
            message: "Cell call is not owned by this workspace and branch",
          })
        }
        return call.value
      })
      const readRow = Effect.fn("CellExecutionStorage.readRow")(function* (
        address: OwnedToolCallAddress,
      ) {
        const rows = yield* sql<typeof ExecutionRow.Type>`
          SELECT result_json FROM cell_executions
          WHERE assistant_message_id = ${address.assistantMessageId}
            AND tool_call_id = ${address.toolCallId}
        `
        const row = Option.fromUndefinedOr(rows[0])
        if (Option.isNone(row)) return Option.none<typeof ExecutionRow.Type>()
        return Option.some(yield* Schema.decodeEffect(ExecutionRow)(row.value))
      })
      const get = Effect.fn("CellExecutionStorage.get")(function* (address: OwnedToolCallAddress) {
        return yield* Effect.gen(function* () {
          yield* requireCell(address)
          const row = yield* readRow(address)
          if (Option.isNone(row)) return Option.none<SavedCellExecution>()
          const json = Option.fromNullishOr(row.value.result_json)
          if (Option.isNone(json))
            return Option.some(CellExecutionAdmission.cases.Incomplete.make({}))
          const result = yield* Schema.decodeEffect(ResultJson)(json.value)
          if (result.id !== address.toolCallId || result.name !== "cell") {
            return yield* new StorageError({
              message: "Stored cell result does not match its call",
            })
          }
          return Option.some(CellExecutionAdmission.cases.Completed.make({ result }))
        }).pipe(sql.withTransaction, Effect.mapError(storageFailure))
      })
      const claim = Effect.fn("CellExecutionStorage.claim")(function* (
        address: OwnedToolCallAddress,
      ) {
        const outerTransaction = yield* Effect.serviceOption(sql.transactionService)
        if (Option.isSome(outerTransaction)) {
          return yield* new StorageError({
            message: "Cell admission requires a committed claim outside any caller transaction",
          })
        }
        return yield* Effect.gen(function* () {
          const call = yield* requireCell(address)
          const input = yield* Schema.decodeUnknownEffect(CellInput)(call.params)
          const now = (yield* DateTime.nowAsDate).getTime()
          const inserted = yield* sql<{ readonly tool_call_id: string }>`
            INSERT INTO cell_executions (assistant_message_id, tool_call_id, started_at)
            VALUES (${address.assistantMessageId}, ${address.toolCallId}, ${now})
            ON CONFLICT (assistant_message_id, tool_call_id) DO NOTHING
            RETURNING tool_call_id
          `
          if (inserted.length === 1) return CellExecutionAdmission.cases.Claimed.make(input)
          return yield* get(address).pipe(
            Effect.flatMap(
              Effect.fromOption(() => new StorageError({ message: "Cell admission disappeared" })),
            ),
          )
        }).pipe(sql.withTransaction, Effect.mapError(storageFailure))
      })
      const complete = Effect.fn("CellExecutionStorage.complete")(function* (
        address: OwnedToolCallAddress,
        result: Prompt.ToolResultPart,
      ) {
        return yield* Effect.gen(function* () {
          yield* requireCell(address)
          if (result.id !== address.toolCallId || result.name !== "cell") {
            return yield* new StorageError({ message: "Cell result does not match its call" })
          }
          const json = yield* Schema.encodeEffect(ResultJson)(result)
          const row = yield* readRow(address).pipe(
            Effect.flatMap(
              Effect.fromOption(() => new StorageError({ message: "Cell has not been admitted" })),
            ),
          )
          const existing = Option.fromNullishOr(row.result_json)
          if (Option.isSome(existing)) {
            if (existing.value === json) return
            return yield* new StorageError({ message: "Cell result is immutable" })
          }
          const now = (yield* DateTime.nowAsDate).getTime()
          yield* sql`
            UPDATE cell_executions SET result_json = ${json}, completed_at = ${now}
            WHERE assistant_message_id = ${address.assistantMessageId}
              AND tool_call_id = ${address.toolCallId}
              AND result_json IS NULL
          `
        }).pipe(sql.withTransaction, Effect.mapError(storageFailure))
      })
      return CellExecutionStorage.of({ get, claim, complete })
    }),
  )
}
