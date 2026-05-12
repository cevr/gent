/**
 * BranchStorage — focused service for branch CRUD + message counting.
 *
 * Provided by `SqliteStorage` from the shared SQLite client.
 */

import { Context, Effect, Layer, Schema } from "effect"
import { Model } from "effect/unstable/schema"
import type { Branch } from "../domain/message.js"
import { BranchId, MessageId, SessionId } from "../domain/ids.js"
import { StorageError } from "../domain/storage-error.js"
import { SqlClient, SqlModel } from "effect/unstable/sql"
import { branchFromRow, type BranchRow } from "./sqlite/rows.js"
import { CurrentWorkspaceId } from "../server/workspace-rpc.js"

class BranchTable extends Model.Class<BranchTable>("BranchTable")({
  id: Model.GeneratedByApp(BranchId),
  session_id: SessionId,
  parent_branch_id: Schema.NullOr(BranchId),
  parent_message_id: Schema.NullOr(MessageId),
  name: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
  created_at: Schema.Number,
}) {}

export interface BranchStorageService {
  readonly createBranch: (branch: Branch) => Effect.Effect<Branch, StorageError>
  readonly getBranch: (id: BranchId) => Effect.Effect<Branch | undefined, StorageError>
  readonly listBranches: (
    sessionId: SessionId,
  ) => Effect.Effect<ReadonlyArray<Branch>, StorageError>
  readonly deleteBranch: (id: BranchId) => Effect.Effect<void, StorageError>
  readonly updateBranchSummary: (
    branchId: BranchId,
    summary: string,
  ) => Effect.Effect<void, StorageError>
  readonly countMessages: (branchId: BranchId) => Effect.Effect<number, StorageError>
  readonly countMessagesByBranches: (
    branchIds: readonly BranchId[],
  ) => Effect.Effect<ReadonlyMap<BranchId, number>, StorageError>
}

export class BranchStorage extends Context.Service<BranchStorage, BranchStorageService>()(
  "@gent/core/src/storage/branch-storage/BranchStorage",
) {
  static Live: Layer.Layer<BranchStorage, never, SqlClient.SqlClient> = Layer.effect(
    BranchStorage,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const branchRepository = yield* SqlModel.makeRepository(BranchTable, {
        tableName: "branches",
        spanPrefix: "BranchStorage",
        idColumn: "id",
      })
      const mapError = (message: string) => (cause: unknown) => new StorageError({ message, cause })

      return {
        createBranch: Effect.fn("BranchStorage.createBranch")(
          function* (branch) {
            const workspaceId = yield* CurrentWorkspaceId
            const sessionRows = yield* sql<{ id: SessionId }>`
              SELECT id FROM sessions
              WHERE id = ${branch.sessionId} AND workspace_id = ${workspaceId}
            `
            if (sessionRows.length === 0) {
              return yield* new StorageError({
                message: `Session not found in current workspace: ${branch.sessionId}`,
              })
            }
            if (branch.parentBranchId !== undefined) {
              const parentRows = yield* sql<{
                id: BranchId
              }>`SELECT b.id
                FROM branches b
                JOIN sessions s ON s.id = b.session_id
                WHERE b.id = ${branch.parentBranchId}
                  AND b.session_id = ${branch.sessionId}
                  AND s.workspace_id = ${workspaceId}`
              if (parentRows.length === 0) {
                return yield* new StorageError({
                  message: `Parent branch not found in session: ${branch.parentBranchId}`,
                })
              }
            }
            yield* branchRepository.insertVoid({
              id: branch.id,
              session_id: branch.sessionId,
              parent_branch_id: branch.parentBranchId ?? null,
              parent_message_id: branch.parentMessageId ?? null,
              name: branch.name ?? null,
              summary: branch.summary ?? null,
              created_at: branch.createdAt.getTime(),
            })
            return branch
          },
          Effect.mapError(mapError("Failed to create branch")),
        ),

        getBranch: Effect.fn("BranchStorage.getBranch")(
          function* (id) {
            const workspaceId = yield* CurrentWorkspaceId
            const rows =
              yield* sql<BranchRow>`SELECT b.id, b.session_id, b.parent_branch_id, b.parent_message_id, b.name, b.summary, b.created_at
              FROM branches b
              JOIN sessions s ON s.id = b.session_id
              WHERE b.id = ${id} AND s.workspace_id = ${workspaceId}`
            const row = rows[0]
            if (row === undefined) return undefined
            return yield* branchFromRow(row)
          },
          Effect.mapError(mapError("Failed to get branch")),
        ),

        listBranches: Effect.fn("BranchStorage.listBranches")(
          function* (sessionId) {
            const workspaceId = yield* CurrentWorkspaceId
            const rows =
              yield* sql<BranchRow>`SELECT b.id, b.session_id, b.parent_branch_id, b.parent_message_id, b.name, b.summary, b.created_at
              FROM branches b
              JOIN sessions s ON s.id = b.session_id
              WHERE b.session_id = ${sessionId} AND s.workspace_id = ${workspaceId}
              ORDER BY b.created_at ASC`
            return yield* Effect.forEach(rows, branchFromRow)
          },
          Effect.mapError(mapError("Failed to list branches")),
        ),

        updateBranchSummary: Effect.fn("BranchStorage.updateBranchSummary")(
          function* (branchId, summary) {
            const workspaceId = yield* CurrentWorkspaceId
            yield* sql`UPDATE branches
              SET summary = ${summary}
              WHERE id = ${branchId}
                AND session_id IN (SELECT id FROM sessions WHERE workspace_id = ${workspaceId})`
          },
          Effect.asVoid,
          Effect.mapError(mapError("Failed to update branch summary")),
        ),

        deleteBranch: Effect.fn("BranchStorage.deleteBranch")(
          function* (id) {
            const workspaceId = yield* CurrentWorkspaceId
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const childBranches = yield* sql<{
                  count: number
                }>`SELECT COUNT(*) as count
                  FROM branches b
                  JOIN sessions s ON s.id = b.session_id
                  WHERE b.parent_branch_id = ${id} AND s.workspace_id = ${workspaceId}`
                if ((childBranches[0]?.count ?? 0) > 0) {
                  return yield* new StorageError({
                    message: `Cannot delete branch with child branches: ${id}`,
                  })
                }

                const childSessions = yield* sql<{
                  count: number
                }>`SELECT COUNT(*) as count
                  FROM sessions
                  WHERE parent_branch_id = ${id} AND workspace_id = ${workspaceId}`
                if ((childSessions[0]?.count ?? 0) > 0) {
                  return yield* new StorageError({
                    message: `Cannot delete branch with child sessions: ${id}`,
                  })
                }

                const messageRows = yield* sql<{
                  id: MessageId
                }>`SELECT m.id
                  FROM messages m
                  JOIN sessions s ON s.id = m.session_id
                  WHERE m.branch_id = ${id} AND s.workspace_id = ${workspaceId}`
                const messageIds = messageRows.map((row) => row.id)
                if (messageIds.length > 0) {
                  yield* sql`DELETE FROM messages_fts WHERE message_id IN ${sql.in(messageIds)}`
                }
                yield* sql`DELETE FROM agent_loop_queues
                  WHERE branch_id = ${id}
                    AND session_id IN (SELECT id FROM sessions WHERE workspace_id = ${workspaceId})`
                yield* sql`DELETE FROM branches
                  WHERE id = ${id}
                    AND session_id IN (SELECT id FROM sessions WHERE workspace_id = ${workspaceId})`
                yield* sql`DELETE FROM content_chunks WHERE id NOT IN (SELECT chunk_id FROM message_chunks)`
              }),
            )
          },
          Effect.mapError(mapError("Failed to delete branch")),
        ),

        countMessages: Effect.fn("BranchStorage.countMessages")(
          function* (branchId) {
            const workspaceId = yield* CurrentWorkspaceId
            const rows = yield* sql<{
              count: number
            }>`SELECT COUNT(*) as count
              FROM messages m
              JOIN sessions s ON s.id = m.session_id
              WHERE m.branch_id = ${branchId} AND s.workspace_id = ${workspaceId}`
            return rows[0]?.count ?? 0
          },
          Effect.mapError(mapError("Failed to count messages")),
        ),

        countMessagesByBranches: Effect.fn("BranchStorage.countMessagesByBranches")(
          function* (branchIds) {
            if (branchIds.length === 0) return new Map<BranchId, number>()
            const workspaceId = yield* CurrentWorkspaceId
            const rows = yield* sql<{
              branch_id: BranchId
              count: number
            }>`SELECT m.branch_id, COUNT(*) as count
              FROM messages m
              JOIN sessions s ON s.id = m.session_id
              WHERE m.branch_id IN ${sql.in(branchIds)}
                AND s.workspace_id = ${workspaceId}
              GROUP BY m.branch_id`
            const result = new Map<BranchId, number>()
            for (const row of rows) {
              result.set(row.branch_id, row.count)
            }
            return result
          },
          Effect.mapError(mapError("Failed to count messages by branches")),
        ),
      } satisfies BranchStorageService
    }),
  )
}
