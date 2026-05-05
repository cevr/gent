import { Context, Effect, Layer, Schema, SchemaGetter as Getter } from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  InteractionRequestRecord,
  InteractionRequestStatus,
} from "../domain/interaction-request.js"
import { SessionId, BranchId } from "../domain/ids.js"
import type { InteractionRequestId } from "../domain/ids.js"
import { StorageError } from "../domain/storage-error.js"

const InteractionRequestRow = Schema.Struct({
  request_id: Schema.String,
  type: Schema.String,
  session_id: SessionId,
  branch_id: BranchId,
  params_json: Schema.String,
  // Read raw status string off the wire; the transform coerces
  // unknown values back to "pending".
  status: Schema.String,
  created_at: Schema.Number,
})
type InteractionRequestRow = typeof InteractionRequestRow.Type
type InteractionRequestRecordEncoded = typeof InteractionRequestRecord.Encoded

const isStatus = Schema.is(InteractionRequestStatus)

const rowToRecord = (row: InteractionRequestRow): InteractionRequestRecordEncoded => ({
  requestId: row.request_id,
  type: row.type,
  sessionId: row.session_id,
  branchId: row.branch_id,
  paramsJson: row.params_json,
  status: isStatus(row.status) ? row.status : ("pending" as const),
  createdAt: row.created_at,
})

const recordToRow = (record: InteractionRequestRecordEncoded): InteractionRequestRow => ({
  request_id: record.requestId,
  type: record.type,
  session_id: SessionId.make(record.sessionId),
  branch_id: BranchId.make(record.branchId),
  params_json: record.paramsJson,
  status: record.status,
  created_at: record.createdAt,
})

const RowToRecord = InteractionRequestRow.pipe(
  Schema.decodeTo(InteractionRequestRecord, {
    decode: Getter.transform(rowToRecord),
    encode: Getter.transform(recordToRow),
  }),
)

const decodeRow = Schema.decodeSync(RowToRecord)

const mapError = (message: string) => (e: unknown) => new StorageError({ message, cause: e })

export interface InteractionStorageService {
  readonly persist: (
    record: InteractionRequestRecord,
  ) => Effect.Effect<InteractionRequestRecord, StorageError>
  readonly resolve: (requestId: InteractionRequestId) => Effect.Effect<void, StorageError>
  /** List pending interactions. Pass `scope` to narrow to a specific session+branch
   *  (used by the projection for per-session UI). Omit `scope` for a global scan
   *  (used by server startup for rehydration). */
  readonly listPending: (scope?: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
  }) => Effect.Effect<ReadonlyArray<InteractionRequestRecord>, StorageError>
  readonly deletePending: (
    sessionId: SessionId,
    branchId: BranchId,
  ) => Effect.Effect<void, StorageError>
  /**
   * Delete pending interaction_requests rows whose (session_id, branch_id)
   * has no matching agent_loop_checkpoints row. Returns the number of rows
   * deleted. Used by startup recovery to drop unresumable orphans (typical
   * cause: schema reset, or crash between persist-row and write-checkpoint).
   */
  readonly reconcileOrphansAgainstCheckpoints: () => Effect.Effect<number, StorageError>
}

export class InteractionStorage extends Context.Service<
  InteractionStorage,
  InteractionStorageService
>()("@gent/core/src/storage/interaction-storage/InteractionStorage") {
  static Live: Layer.Layer<InteractionStorage, never, SqlClient.SqlClient> = Layer.effect(
    InteractionStorage,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      return {
        persist: Effect.fn("InteractionStorage.persist")(
          function* (record) {
            yield* sql`INSERT INTO interaction_requests (request_id, type, session_id, branch_id, params_json, status, created_at) VALUES (${record.requestId}, ${record.type}, ${record.sessionId}, ${record.branchId}, ${record.paramsJson}, ${record.status}, ${record.createdAt})`
            return record
          },
          Effect.mapError(mapError("Failed to persist interaction request")),
        ),

        resolve: Effect.fn("InteractionStorage.resolve")(
          function* (requestId) {
            yield* sql`UPDATE interaction_requests SET status = 'resolved' WHERE request_id = ${requestId}`
          },
          Effect.mapError(mapError("Failed to resolve interaction request")),
        ),

        listPending: Effect.fn("InteractionStorage.listPending")(
          function* (scope?: { sessionId: SessionId; branchId: BranchId }) {
            const rows =
              scope === undefined
                ? yield* sql<InteractionRequestRow>`SELECT request_id, type, session_id, branch_id, params_json, status, created_at FROM interaction_requests WHERE status = 'pending' ORDER BY created_at ASC`
                : yield* sql<InteractionRequestRow>`SELECT request_id, type, session_id, branch_id, params_json, status, created_at FROM interaction_requests WHERE status = 'pending' AND session_id = ${scope.sessionId} AND branch_id = ${scope.branchId} ORDER BY created_at ASC`
            return rows.map((row) => decodeRow(row))
          },
          Effect.mapError(mapError("Failed to list pending interaction requests")),
        ),

        deletePending: Effect.fn("InteractionStorage.deletePending")(
          function* (sessionId, branchId) {
            yield* sql`DELETE FROM interaction_requests WHERE session_id = ${sessionId} AND branch_id = ${branchId} AND status = 'pending'`
          },
          Effect.mapError(mapError("Failed to delete pending interaction requests")),
        ),

        reconcileOrphansAgainstCheckpoints: Effect.fn(
          "InteractionStorage.reconcileOrphansAgainstCheckpoints",
        )(
          function* () {
            const result = yield* sql<{
              request_id: string
            }>`DELETE FROM interaction_requests WHERE status = 'pending' AND NOT EXISTS (SELECT 1 FROM agent_loop_checkpoints c WHERE c.session_id = interaction_requests.session_id AND c.branch_id = interaction_requests.branch_id) RETURNING request_id`
            return result.length
          },
          Effect.mapError(mapError("Failed to reconcile orphan interaction requests")),
        ),
      }
    }),
  )
}
