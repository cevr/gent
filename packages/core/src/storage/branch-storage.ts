/**
 * BranchStorage — focused service for branch CRUD + message counting.
 *
 * Split from the `Storage` god-interface ().
 */

import { Context, Effect, Layer } from "effect"
import type { Branch } from "../domain/message.js"
import type { SessionId, BranchId, MessageId } from "../domain/ids.js"
import { StorageError } from "../domain/storage-error.js"
import { SqlClient } from "effect/unstable/sql"
import { branchFromRow, type BranchRow } from "./sqlite/rows.js"

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
      const mapError = (message: string) => (cause: unknown) => new StorageError({ message, cause })

      return {
        createBranch: Effect.fn("BranchStorage.createBranch")(
          function* (branch) {
            if (branch.parentBranchId !== undefined) {
              const parentRows = yield* sql<{
                id: BranchId
              }>`SELECT id FROM branches WHERE id = ${branch.parentBranchId} AND session_id = ${branch.sessionId}`
              if (parentRows.length === 0) {
                return yield* new StorageError({
                  message: `Parent branch not found in session: ${branch.parentBranchId}`,
                })
              }
            }
            yield* sql`INSERT INTO branches (id, session_id, parent_branch_id, parent_message_id, name, summary, created_at) VALUES (${branch.id}, ${branch.sessionId}, ${branch.parentBranchId ?? null}, ${branch.parentMessageId ?? null}, ${branch.name ?? null}, ${branch.summary ?? null}, ${branch.createdAt.getTime()})`
            return branch
          },
          Effect.mapError(mapError("Failed to create branch")),
        ),

        getBranch: Effect.fn("BranchStorage.getBranch")(
          function* (id) {
            const rows =
              yield* sql<BranchRow>`SELECT id, session_id, parent_branch_id, parent_message_id, name, summary, created_at FROM branches WHERE id = ${id}`
            const row = rows[0]
            if (row === undefined) return undefined
            return branchFromRow(row)
          },
          Effect.mapError(mapError("Failed to get branch")),
        ),

        listBranches: Effect.fn("BranchStorage.listBranches")(
          function* (sessionId) {
            const rows =
              yield* sql<BranchRow>`SELECT id, session_id, parent_branch_id, parent_message_id, name, summary, created_at FROM branches WHERE session_id = ${sessionId} ORDER BY created_at ASC`
            return rows.map(branchFromRow)
          },
          Effect.mapError(mapError("Failed to list branches")),
        ),

        updateBranchSummary: (branchId, summary) =>
          sql`UPDATE branches SET summary = ${summary} WHERE id = ${branchId}`.pipe(
            Effect.asVoid,
            Effect.mapError(mapError("Failed to update branch summary")),
            Effect.withSpan("BranchStorage.updateBranchSummary"),
          ),

        deleteBranch: Effect.fn("BranchStorage.deleteBranch")(
          function* (id) {
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const childBranches = yield* sql<{
                  count: number
                }>`SELECT COUNT(*) as count FROM branches WHERE parent_branch_id = ${id}`
                if ((childBranches[0]?.count ?? 0) > 0) {
                  return yield* new StorageError({
                    message: `Cannot delete branch with child branches: ${id}`,
                  })
                }

                const childSessions = yield* sql<{
                  count: number
                }>`SELECT COUNT(*) as count FROM sessions WHERE parent_branch_id = ${id}`
                if ((childSessions[0]?.count ?? 0) > 0) {
                  return yield* new StorageError({
                    message: `Cannot delete branch with child sessions: ${id}`,
                  })
                }

                const messageRows = yield* sql<{
                  id: MessageId
                }>`SELECT id FROM messages WHERE branch_id = ${id}`
                const messageIds = messageRows.map((row) => row.id)
                if (messageIds.length > 0) {
                  yield* sql`DELETE FROM messages_fts WHERE message_id IN ${sql.in(messageIds)}`
                }
                yield* sql`DELETE FROM branches WHERE id = ${id}`
                yield* sql`DELETE FROM content_chunks WHERE id NOT IN (SELECT chunk_id FROM message_chunks)`
              }),
            )
          },
          Effect.mapError(mapError("Failed to delete branch")),
        ),

        countMessages: Effect.fn("BranchStorage.countMessages")(
          function* (branchId) {
            const rows = yield* sql<{
              count: number
            }>`SELECT COUNT(*) as count FROM messages WHERE branch_id = ${branchId}`
            return rows[0]?.count ?? 0
          },
          Effect.mapError(mapError("Failed to count messages")),
        ),

        countMessagesByBranches: Effect.fn("BranchStorage.countMessagesByBranches")(
          function* (branchIds) {
            if (branchIds.length === 0) return new Map<BranchId, number>()
            const rows = yield* sql<{
              branch_id: BranchId
              count: number
            }>`SELECT branch_id, COUNT(*) as count FROM messages WHERE branch_id IN ${sql.in(branchIds)} GROUP BY branch_id`
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

  static fromStorage = (s: BranchStorageService): Layer.Layer<BranchStorage> =>
    Layer.succeed(BranchStorage, s)
}
