/**
 * RelationshipStorage — focused service for session tree / relationship queries.
 *
 * Split from the `Storage` god-interface.
 */

import { Context, Effect, Layer } from "effect"
import type { Session, Branch, Message } from "../domain/message.js"
import type { BranchId, SessionId } from "../domain/ids.js"
import { StorageError } from "../domain/storage-error.js"
import { SqlClient } from "effect/unstable/sql"
import {
  branchFromRow,
  decodeStoredMessage,
  groupMessageChunkRows,
  sessionFromRow,
  type BranchRow,
  type MessageChunkRow,
  type SessionRow,
} from "./sqlite/rows.js"

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
            const rows =
              yield* sql<SessionRow>`SELECT id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at FROM sessions WHERE parent_session_id = ${parentSessionId} ORDER BY created_at ASC`
            return rows.map(sessionFromRow)
          },
          Effect.mapError(mapError("Failed to get child sessions")),
        ),

        getSessionAncestors: Effect.fn("RelationshipStorage.getSessionAncestors")(
          function* (sessionId) {
            const rows =
              yield* sql<SessionRow>`WITH RECURSIVE ancestors(id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at, depth) AS (
            SELECT id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at, 0
            FROM sessions WHERE id = ${sessionId}
            UNION ALL
            SELECT s.id, s.name, s.cwd, s.reasoning_level, s.active_branch_id, s.parent_session_id, s.parent_branch_id, s.created_at, s.updated_at, a.depth + 1
            FROM sessions s
            JOIN ancestors a ON s.id = a.parent_session_id
            WHERE a.depth < 20
          )
          SELECT id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at
          FROM ancestors
          ORDER BY depth ASC`
            return rows.map(sessionFromRow)
          },
          Effect.mapError(mapError("Failed to get session ancestors")),
        ),

        getSessionDetail: Effect.fn("RelationshipStorage.getSessionDetail")(
          function* (sessionId) {
            const sessionRows =
              yield* sql<SessionRow>`SELECT id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at FROM sessions WHERE id = ${sessionId}`
            const sessionRow = sessionRows[0]
            if (sessionRow === undefined) {
              return yield* new StorageError({ message: `Session not found: ${sessionId}` })
            }
            const session = sessionFromRow(sessionRow)

            const branchRows =
              yield* sql<BranchRow>`SELECT id, session_id, parent_branch_id, parent_message_id, name, summary, created_at FROM branches WHERE session_id = ${sessionId} ORDER BY created_at ASC`
            const branches = branchRows.map(branchFromRow)

            if (branches.length === 0) {
              return { session, branches: [] }
            }

            const branchIds = branches.map((b) => b.id)
            const allMsgRows = yield* sql<MessageChunkRow>`SELECT
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
            WHERE m.branch_id IN ${sql.in(branchIds)}
            ORDER BY m.created_at ASC, m.id ASC, mc.ordinal ASC`

            const rowsByBranch = new Map<BranchId, Array<MessageChunkRow>>()
            for (const branch of branches) rowsByBranch.set(branch.id, [])
            for (const row of allMsgRows) {
              const bucket = rowsByBranch.get(row.branch_id as BranchId)
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
