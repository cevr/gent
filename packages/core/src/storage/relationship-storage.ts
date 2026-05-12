/**
 * RelationshipStorage — focused service for session tree / relationship queries.
 *
 * Provided by `SqliteStorage` from the shared SQLite client.
 */

import { Context, Effect, Layer } from "effect"
import type { Session, Branch, Message } from "../domain/message.js"
import type { BranchId, SessionId } from "../domain/ids.js"
import { StorageError } from "../domain/storage-error.js"
import { SqlClient } from "effect/unstable/sql"
import {
  branchFromRow,
  decodeStoredMessage,
  decodeMessageChunkRow,
  groupMessageChunkRows,
  sessionFromRow,
  type BranchRow,
  type MessageChunkRow,
  type SessionRow,
} from "./sqlite/rows.js"
import { CurrentWorkspaceId } from "../server/workspace-rpc.js"

export interface RelationshipStorageService {
  readonly getChildSessions: (
    parentSessionId: SessionId,
  ) => Effect.Effect<ReadonlyArray<Session>, StorageError>

  readonly getSessionAncestors: (
    sessionId: SessionId,
  ) => Effect.Effect<ReadonlyArray<Session>, StorageError>

  /** Returns branches + messages within a single session (not cross-session tree) */
  readonly getSessionDetail: (sessionId: SessionId) => Effect.Effect<
    {
      session: Session
      branches: ReadonlyArray<{
        branch: Branch
        messages: ReadonlyArray<Message>
      }>
    },
    StorageError
  >
}

export class RelationshipStorage extends Context.Service<
  RelationshipStorage,
  RelationshipStorageService
>()("@gent/core/src/storage/relationship-storage/RelationshipStorage") {
  static Live: Layer.Layer<RelationshipStorage, never, SqlClient.SqlClient> = Layer.effect(
    RelationshipStorage,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const mapError = (message: string) => (cause: unknown) => new StorageError({ message, cause })

      return {
        getChildSessions: Effect.fn("RelationshipStorage.getChildSessions")(
          function* (parentSessionId) {
            const workspaceId = yield* CurrentWorkspaceId
            const rows =
              yield* sql<SessionRow>`SELECT id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at FROM sessions WHERE parent_session_id = ${parentSessionId} AND workspace_id = ${workspaceId} ORDER BY created_at ASC`
            return yield* Effect.forEach(rows, sessionFromRow)
          },
          Effect.mapError(mapError("Failed to get child sessions")),
        ),

        getSessionAncestors: Effect.fn("RelationshipStorage.getSessionAncestors")(
          function* (sessionId) {
            const workspaceId = yield* CurrentWorkspaceId
            const rows =
              yield* sql<SessionRow>`WITH RECURSIVE ancestors(id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at, depth) AS (
            SELECT id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at, 0
            FROM sessions WHERE id = ${sessionId} AND workspace_id = ${workspaceId}
            UNION ALL
            SELECT s.id, s.name, s.cwd, s.reasoning_level, s.active_branch_id, s.parent_session_id, s.parent_branch_id, s.created_at, s.updated_at, a.depth + 1
            FROM sessions s
            JOIN ancestors a ON s.id = a.parent_session_id
            WHERE a.depth < 20 AND s.workspace_id = ${workspaceId}
          )
          SELECT id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at
          FROM ancestors
          ORDER BY depth ASC`
            return yield* Effect.forEach(rows, sessionFromRow)
          },
          Effect.mapError(mapError("Failed to get session ancestors")),
        ),

        getSessionDetail: Effect.fn("RelationshipStorage.getSessionDetail")(
          function* (sessionId) {
            const workspaceId = yield* CurrentWorkspaceId
            const sessionRows =
              yield* sql<SessionRow>`SELECT id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at FROM sessions WHERE id = ${sessionId} AND workspace_id = ${workspaceId}`
            const sessionRow = sessionRows[0]
            if (sessionRow === undefined) {
              return yield* new StorageError({ message: `Session not found: ${sessionId}` })
            }
            const session = yield* sessionFromRow(sessionRow)

            const branchRows =
              yield* sql<BranchRow>`SELECT b.id, b.session_id, b.parent_branch_id, b.parent_message_id, b.name, b.summary, b.created_at
                FROM branches b
                JOIN sessions s ON s.id = b.session_id
                WHERE b.session_id = ${sessionId} AND s.workspace_id = ${workspaceId}
                ORDER BY b.created_at ASC`
            const branches = yield* Effect.forEach(branchRows, branchFromRow)

            if (branches.length === 0) {
              return { session, branches: [] }
            }

            const branchIds = branches.map((b) => b.id)
            const allMsgRawRows = yield* sql`SELECT
              m.id,
              m.session_id,
              m.branch_id,
              m.kind,
              m.role,
              m.created_at,
              m.turn_duration_ms,
              m.metadata,
              mc.ordinal as chunk_ordinal,
              c.part_json as chunk_part_json
            FROM messages m
            LEFT JOIN message_chunks mc ON mc.message_id = m.id
            LEFT JOIN content_chunks c ON c.id = mc.chunk_id
            JOIN sessions s ON s.id = m.session_id
            WHERE m.branch_id IN ${sql.in(branchIds)}
              AND s.workspace_id = ${workspaceId}
            ORDER BY m.created_at ASC, m.id ASC, mc.ordinal ASC`
            const allMsgRows = yield* Effect.forEach(allMsgRawRows, (row) =>
              decodeMessageChunkRow(row),
            )

            const rowsByBranch = new Map<BranchId, Array<MessageChunkRow>>()
            for (const branch of branches) rowsByBranch.set(branch.id, [])
            for (const row of allMsgRows) {
              const bucket = rowsByBranch.get(row.branch_id)
              if (bucket !== undefined) bucket.push(row)
            }

            const result = yield* Effect.forEach(branches, (branch) =>
              Effect.gen(function* () {
                const msgRows = rowsByBranch.get(branch.id) ?? []
                const messages = yield* Effect.forEach(
                  groupMessageChunkRows(msgRows),
                  ({ row, partJsons }) => decodeStoredMessage(row, partJsons),
                )
                return { branch, messages }
              }),
            )

            return { session, branches: result }
          },
          Effect.mapError(mapError("Failed to get session detail")),
        ),
      } satisfies RelationshipStorageService
    }),
  )
}
