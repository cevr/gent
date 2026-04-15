import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { InteractionRequestRecord } from "../domain/interaction-request.js"
import type { SessionId, BranchId } from "../domain/ids.js"
import { StorageError } from "./sqlite-storage.js"

interface InteractionRequestRow {
  request_id: string
  type: string
  session_id: SessionId
  branch_id: BranchId
  params_json: string
  status: string
  created_at: number
}

const isStatus = (s: string): s is InteractionRequestRecord["status"] =>
  s === "pending" || s === "resolved"

const fromRow = (row: InteractionRequestRow): InteractionRequestRecord => ({
  requestId: row.request_id,
  type: row.type,
  sessionId: row.session_id,
  branchId: row.branch_id,
  paramsJson: row.params_json,
  status: isStatus(row.status) ? row.status : "pending",
  createdAt: row.created_at,
})

const mapError = (message: string) => (e: unknown) => new StorageError({ message, cause: e })

export interface InteractionStorageService {
  readonly persist: (
    record: InteractionRequestRecord,
  ) => Effect.Effect<InteractionRequestRecord, StorageError>
  readonly resolve: (requestId: string) => Effect.Effect<void, StorageError>
  readonly listPending: () => Effect.Effect<ReadonlyArray<InteractionRequestRecord>, StorageError>
  readonly deletePending: (
    sessionId: SessionId,
    branchId: BranchId,
  ) => Effect.Effect<void, StorageError>
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
          function* () {
            const rows =
              yield* sql<InteractionRequestRow>`SELECT request_id, type, session_id, branch_id, params_json, status, created_at FROM interaction_requests WHERE status = 'pending' ORDER BY created_at ASC`
            return rows.map(fromRow)
          },
          Effect.mapError(mapError("Failed to list pending interaction requests")),
        ),

        deletePending: Effect.fn("InteractionStorage.deletePending")(
          function* (sessionId, branchId) {
            yield* sql`DELETE FROM interaction_requests WHERE session_id = ${sessionId} AND branch_id = ${branchId} AND status = 'pending'`
          },
          Effect.mapError(mapError("Failed to delete pending interaction requests")),
        ),
      }
    }),
  )
}
