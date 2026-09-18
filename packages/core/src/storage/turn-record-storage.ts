/**
 * The durable position of one turn.
 *
 * A turn is keyed by the user message that opened it. Before the record
 * existed, a resumed turn found its position by probing up to 200 derived
 * message ids and, for each, a second id for the tool results. The record
 * replaces that scan with one row: the step whose messages committed, how
 * many continuation instructions the turn has spent, and the tool calls the
 * current step issued and has not settled.
 *
 * The row is written after the step's messages commit, in its own
 * transaction. A reader can therefore see a step's messages without the
 * position that names them, so the row is a hint and the messages decide:
 * `resolveTurnPosition` cross-checks both branches against the assistant
 * message before it trusts the step this row reports.
 */
import { Context, DateTime, Effect, Layer, Predicate, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { BranchId, MessageId, SessionId } from "../domain/ids.js"
import { storageError, type StorageError } from "../domain/errors.js"
import { CurrentWorkspaceId } from "../server/workspace-rpc.js"

/** One tool call the current step issued. Named so replay can match it. */
export const PendingToolCall = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
})
export type PendingToolCall = typeof PendingToolCall.Type

export const TurnRecord = Schema.Struct({
  /** The last step whose assistant and tool messages committed. 0 before step 1. */
  step: Schema.Natural,
  /** Continuation instructions this turn has persisted. Capped by the loop. */
  continuations: Schema.Natural,
  /** Tool calls the current step issued and has not settled. */
  pendingToolCalls: Schema.Array(PendingToolCall),
})
export type TurnRecord = typeof TurnRecord.Type

export const emptyTurnRecord: TurnRecord = {
  step: 0,
  continuations: 0,
  pendingToolCalls: [],
}

interface TurnRecordKey {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly messageId: MessageId
}

const TurnRecordRow = Schema.Struct({
  step: Schema.Finite,
  continuations: Schema.Finite,
  pending_tool_calls_json: Schema.String,
})

const decodePending = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(PendingToolCall)))
const encodePending = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(PendingToolCall)))

interface TurnRecordStorageService {
  /** The turn's position, or the empty record when the turn has no row yet. */
  readonly get: (key: TurnRecordKey) => Effect.Effect<TurnRecord, StorageError>
  /** Write the turn's position. Idempotent for one step boundary. */
  readonly put: (key: TurnRecordKey, record: TurnRecord) => Effect.Effect<void, StorageError>
}

export class TurnRecordStorage extends Context.Service<
  TurnRecordStorage,
  TurnRecordStorageService
>()("@gent/core/src/storage/turn-record-storage/TurnRecordStorage") {
  static Live: Layer.Layer<TurnRecordStorage, never, SqlClient.SqlClient> = Layer.effect(
    TurnRecordStorage,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const get = Effect.fn("TurnRecordStorage.get")(function* (key: TurnRecordKey) {
        return yield* Effect.gen(function* () {
          const workspaceId = yield* CurrentWorkspaceId
          const rows = yield* sql<typeof TurnRecordRow.Type>`
            SELECT t.step, t.continuations, t.pending_tool_calls_json
            FROM turn_records t
            JOIN sessions s ON s.id = t.session_id
            WHERE t.session_id = ${key.sessionId}
              AND t.branch_id = ${key.branchId}
              AND t.message_id = ${key.messageId}
              AND s.workspace_id = ${workspaceId}
            LIMIT 1
          `
          const row = rows[0]
          if (Predicate.isUndefined(row)) return emptyTurnRecord
          const decoded = yield* Schema.decodeEffect(TurnRecordRow)(row)
          const pendingToolCalls = yield* decodePending(decoded.pending_tool_calls_json)
          return {
            step: Math.max(0, Math.trunc(decoded.step)),
            continuations: Math.max(0, Math.trunc(decoded.continuations)),
            pendingToolCalls,
          } satisfies TurnRecord
        }).pipe(Effect.mapError(storageError("Failed to read the turn record")))
      })

      const put = Effect.fn("TurnRecordStorage.put")(function* (
        key: TurnRecordKey,
        record: TurnRecord,
      ) {
        return yield* Effect.gen(function* () {
          const pendingJson = yield* encodePending(record.pendingToolCalls)
          const updatedAt = (yield* DateTime.nowAsDate).getTime()
          yield* sql`
            INSERT INTO turn_records (
              session_id,
              branch_id,
              message_id,
              step,
              continuations,
              pending_tool_calls_json,
              updated_at
            ) VALUES (
              ${key.sessionId},
              ${key.branchId},
              ${key.messageId},
              ${record.step},
              ${record.continuations},
              ${pendingJson},
              ${updatedAt}
            )
            ON CONFLICT (session_id, branch_id, message_id) DO UPDATE SET
              step = excluded.step,
              continuations = excluded.continuations,
              pending_tool_calls_json = excluded.pending_tool_calls_json,
              updated_at = excluded.updated_at
          `
        }).pipe(Effect.mapError(storageError("Failed to write the turn record")))
      })

      return TurnRecordStorage.of({ get, put })
    }),
  )
}

/** The record a step boundary writes once its messages have committed. */
export const turnRecordAtStep = (params: {
  readonly step: number
  readonly continuations: number
  readonly pendingToolCalls: ReadonlyArray<PendingToolCall>
}): TurnRecord => ({
  step: Math.max(0, Math.trunc(params.step)),
  continuations: Math.max(0, Math.trunc(params.continuations)),
  pendingToolCalls: params.pendingToolCalls,
})
