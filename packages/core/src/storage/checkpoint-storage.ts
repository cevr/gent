import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { AgentLoopCheckpointRecord } from "../runtime/agent/agent-loop.checkpoint.js"
import type { SessionId, BranchId } from "../domain/ids.js"
import { StorageError } from "./sqlite-storage.js"

interface AgentLoopCheckpointRow {
  session_id: SessionId
  branch_id: BranchId
  version: number
  state_tag: string
  state_json: string
  updated_at: number
}

const fromRow = (row: AgentLoopCheckpointRow): AgentLoopCheckpointRecord => ({
  sessionId: row.session_id,
  branchId: row.branch_id,
  version: row.version,
  stateTag: row.state_tag,
  stateJson: row.state_json,
  updatedAt: row.updated_at,
})

const mapError = (message: string) => (e: unknown) => new StorageError({ message, cause: e })

export interface CheckpointStorageService {
  readonly upsert: (
    record: AgentLoopCheckpointRecord,
  ) => Effect.Effect<AgentLoopCheckpointRecord, StorageError>
  readonly get: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<AgentLoopCheckpointRecord | undefined, StorageError>
  readonly list: () => Effect.Effect<ReadonlyArray<AgentLoopCheckpointRecord>, StorageError>
  readonly remove: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<void, StorageError>
}

export class CheckpointStorage extends Context.Service<
  CheckpointStorage,
  CheckpointStorageService
>()("@gent/core/src/storage/checkpoint-storage/CheckpointStorage") {
  static Live: Layer.Layer<CheckpointStorage, never, SqlClient.SqlClient> = Layer.effect(
    CheckpointStorage,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      return {
        upsert: Effect.fn("CheckpointStorage.upsert")(
          function* (record) {
            yield* sql`INSERT INTO agent_loop_checkpoints (session_id, branch_id, version, state_tag, state_json, updated_at) VALUES (${record.sessionId}, ${record.branchId}, ${record.version}, ${record.stateTag}, ${record.stateJson}, ${record.updatedAt}) ON CONFLICT(session_id, branch_id) DO UPDATE SET version = excluded.version, state_tag = excluded.state_tag, state_json = excluded.state_json, updated_at = excluded.updated_at`
            return record
          },
          Effect.mapError(mapError("Failed to upsert agent loop checkpoint")),
        ),

        get: Effect.fn("CheckpointStorage.get")(
          function* (input) {
            const rows =
              yield* sql<AgentLoopCheckpointRow>`SELECT session_id, branch_id, version, state_tag, state_json, updated_at FROM agent_loop_checkpoints WHERE session_id = ${input.sessionId} AND branch_id = ${input.branchId}`
            const row = rows[0]
            return row === undefined ? undefined : fromRow(row)
          },
          Effect.mapError(mapError("Failed to get agent loop checkpoint")),
        ),

        list: Effect.fn("CheckpointStorage.list")(
          function* () {
            const rows =
              yield* sql<AgentLoopCheckpointRow>`SELECT session_id, branch_id, version, state_tag, state_json, updated_at FROM agent_loop_checkpoints ORDER BY updated_at ASC`
            return rows.map(fromRow)
          },
          Effect.mapError(mapError("Failed to list agent loop checkpoints")),
        ),

        remove: Effect.fn("CheckpointStorage.remove")(
          function* (input) {
            yield* sql`DELETE FROM agent_loop_checkpoints WHERE session_id = ${input.sessionId} AND branch_id = ${input.branchId}`
          },
          Effect.mapError(mapError("Failed to delete agent loop checkpoint")),
        ),
      }
    }),
  )
}
