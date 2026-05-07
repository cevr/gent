/**
 * AgentLoopQueueStorage — durable branch-local queued turns.
 *
 * Actor mailbox persistence only deduplicates delivered operations. The
 * product queue is a runtime datum users can observe and expect to survive
 * worker restart, so it gets its own storage row per branch.
 */

import { Clock, Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  LoopQueueState,
  type LoopQueueState as LoopQueueStateType,
} from "../domain/agent-loop-queue-state.js"
import type { BranchId, SessionId } from "../domain/ids.js"
import { StorageError } from "../domain/storage-error.js"
import { CurrentWorkspaceId } from "../server/workspace-rpc.js"

const LoopQueueStateJson = Schema.fromJsonString(LoopQueueState)
const decodeLoopQueueState = Schema.decodeUnknownEffect(LoopQueueStateJson)
const encodeLoopQueueState = Schema.encodeEffect(LoopQueueStateJson)

interface QueueRow {
  session_id: SessionId
  branch_id: BranchId
  queue_json: string
  updated_at: number
}

const emptyLoopQueueState = (): LoopQueueStateType => ({
  steering: [],
  followUp: [],
})

const mapError = (message: string) => (cause: unknown) => new StorageError({ message, cause })

export interface AgentLoopQueueStorageService {
  readonly getQueueState: (
    sessionId: SessionId,
    branchId: BranchId,
  ) => Effect.Effect<LoopQueueStateType, StorageError>
  readonly putQueueState: (
    sessionId: SessionId,
    branchId: BranchId,
    queue: LoopQueueStateType,
  ) => Effect.Effect<void, StorageError>
  readonly clearQueueState: (
    sessionId: SessionId,
    branchId: BranchId,
  ) => Effect.Effect<void, StorageError>
}

export class AgentLoopQueueStorage extends Context.Service<
  AgentLoopQueueStorage,
  AgentLoopQueueStorageService
>()("@gent/core/src/storage/agent-loop-queue-storage/AgentLoopQueueStorage") {
  static Live: Layer.Layer<AgentLoopQueueStorage, never, SqlClient.SqlClient> = Layer.effect(
    AgentLoopQueueStorage,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      return {
        getQueueState: Effect.fn("AgentLoopQueueStorage.getQueueState")(
          function* (sessionId, branchId) {
            const workspaceId = yield* CurrentWorkspaceId
            const rows = yield* sql<QueueRow>`SELECT
              q.session_id,
              q.branch_id,
              q.queue_json,
              q.updated_at
            FROM agent_loop_queues q
            WHERE q.session_id = ${sessionId}
              AND q.branch_id = ${branchId}
              AND q.workspace_id = ${workspaceId}
            LIMIT 1`
            const row = rows[0]
            if (row === undefined) return emptyLoopQueueState()
            return yield* decodeLoopQueueState(row.queue_json)
          },
          Effect.mapError(mapError("Failed to get agent loop queue")),
        ),

        putQueueState: Effect.fn("AgentLoopQueueStorage.putQueueState")(
          function* (sessionId, branchId, queue) {
            const workspaceId = yield* CurrentWorkspaceId
            const queueJson = yield* encodeLoopQueueState(queue)
            const updatedAt = yield* Clock.currentTimeMillis
            yield* sql`INSERT INTO agent_loop_queues (workspace_id, session_id, branch_id, queue_json, updated_at)
              VALUES (${workspaceId}, ${sessionId}, ${branchId}, ${queueJson}, ${updatedAt})
              ON CONFLICT(workspace_id, session_id, branch_id) DO UPDATE SET
                queue_json = excluded.queue_json,
                updated_at = excluded.updated_at`
          },
          Effect.mapError(mapError("Failed to put agent loop queue")),
        ),

        clearQueueState: Effect.fn("AgentLoopQueueStorage.clearQueueState")(
          function* (sessionId, branchId) {
            const workspaceId = yield* CurrentWorkspaceId
            yield* sql`DELETE FROM agent_loop_queues
              WHERE workspace_id = ${workspaceId}
                AND session_id = ${sessionId}
                AND branch_id = ${branchId}
              `
          },
          Effect.mapError(mapError("Failed to clear agent loop queue")),
        ),
      } satisfies AgentLoopQueueStorageService
    }),
  )
}
