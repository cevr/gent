/**
 * RelationshipStorage — focused service for session tree / relationship queries.
 *
 * Provided by `SqliteStorage` from the shared SQLite client.
 */

import { Predicate, Context, Effect, Layer } from "effect"
import type { Session, Branch, Message } from "../domain/message.js"
import type { BranchId, SessionId } from "../domain/ids.js"
import { StorageError, storageError } from "../domain/errors.js"
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
  MESSAGE_CHUNK_SELECT,
  SESSION_COLUMNS,
} from "./schema.js"
import { CurrentWorkspaceId } from "../server/workspace-rpc.js"

interface RelationshipStorageService {
  readonly getChildSessions: (
    parentSessionId: SessionId,
  ) => Effect.Effect<ReadonlyArray<Session>, StorageError>

  readonly getSessionAncestors: (
    sessionId: SessionId,
  ) => Effect.Effect<ReadonlyArray<Session>, StorageError>

  /**
   * Every session in one thread, oldest first.
   *
   * A thread is the work itself, not one session's parent line: a session that
   * handed off twice has two children and both continue it. Sessions carry the
   * thread they belong to, so this is one indexed read — a delegate run or a
   * `/btw` side question started its own thread when it was created and is
   * simply not in this one.
   */
  readonly getThreadSessions: (
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

      return {
        getChildSessions: Effect.fn("RelationshipStorage.getChildSessions")(
          function* (parentSessionId) {
            const workspaceId = yield* CurrentWorkspaceId
            const rows =
              yield* sql<SessionRow>`SELECT ${sql.literal(SESSION_COLUMNS)} FROM sessions WHERE parent_session_id = ${parentSessionId} AND workspace_id = ${workspaceId} ORDER BY created_at ASC`
            return yield* Effect.forEach(rows, sessionFromRow)
          },
          Effect.mapError(storageError("Failed to get child sessions")),
        ),

        getSessionAncestors: Effect.fn("RelationshipStorage.getSessionAncestors")(
          function* (sessionId) {
            const workspaceId = yield* CurrentWorkspaceId
            const rows =
              yield* sql<SessionRow>`WITH RECURSIVE ancestors(${sql.literal(SESSION_COLUMNS)}, depth) AS (
            SELECT ${sql.literal(SESSION_COLUMNS)}, 0
            FROM sessions WHERE id = ${sessionId} AND workspace_id = ${workspaceId}
            UNION ALL
            SELECT s.id, s.name, s.cwd, s.model_id, s.reasoning_level, s.active_branch_id, s.parent_session_id, s.parent_branch_id, s.thread_id, s.created_at, s.updated_at, a.depth + 1
            FROM sessions s
            JOIN ancestors a ON s.id = a.parent_session_id
            WHERE a.depth < 20 AND s.workspace_id = ${workspaceId}
          )
          SELECT ${sql.literal(SESSION_COLUMNS)}
          FROM ancestors
          ORDER BY depth ASC`
            return yield* Effect.forEach(rows, sessionFromRow)
          },
          Effect.mapError(storageError("Failed to get session ancestors")),
        ),

        getThreadSessions: Effect.fn("RelationshipStorage.getThreadSessions")(
          function* (sessionId) {
            const workspaceId = yield* CurrentWorkspaceId
            const rows = yield* sql<SessionRow>`SELECT ${sql.literal(SESSION_COLUMNS)}
          FROM sessions
          WHERE workspace_id = ${workspaceId}
            AND thread_id = (
              SELECT thread_id FROM sessions
              WHERE id = ${sessionId} AND workspace_id = ${workspaceId}
            )
          ORDER BY created_at ASC`
            return yield* Effect.forEach(rows, sessionFromRow)
          },
          Effect.mapError(storageError("Failed to get thread sessions")),
        ),

        getSessionDetail: Effect.fn("RelationshipStorage.getSessionDetail")(
          function* (sessionId) {
            const workspaceId = yield* CurrentWorkspaceId
            const sessionRows =
              yield* sql<SessionRow>`SELECT ${sql.literal(SESSION_COLUMNS)} FROM sessions WHERE id = ${sessionId} AND workspace_id = ${workspaceId}`
            const sessionRow = sessionRows[0]
            if (Predicate.isUndefined(sessionRow)) {
              return yield* new StorageError({ message: `Session not found: ${sessionId}` })
            }
            const session = yield* sessionFromRow(sessionRow)

            const branchRows =
              yield* sql<BranchRow>`SELECT b.id, b.session_id, b.parent_branch_id, b.parent_message_id, b.name, b.created_at
                FROM branches b
                JOIN sessions s ON s.id = b.session_id
                WHERE b.session_id = ${sessionId} AND s.workspace_id = ${workspaceId}
                ORDER BY b.created_at ASC`
            const branches = yield* Effect.forEach(branchRows, branchFromRow)

            if (branches.length === 0) {
              return { session, branches: [] }
            }

            const branchIds = branches.map((b) => b.id)
            const allMsgRawRows = yield* sql`${sql.literal(MESSAGE_CHUNK_SELECT)}
            WHERE m.branch_id IN ${sql.in(branchIds)}
              AND s.workspace_id = ${workspaceId}
            ORDER BY m.created_at ASC, m.insertion_order ASC, mc.ordinal ASC`
            const allMsgRows = yield* Effect.forEach(allMsgRawRows, (row) =>
              decodeMessageChunkRow(row),
            )

            const rowsByBranch = new Map<BranchId, Array<MessageChunkRow>>()
            for (const branch of branches) rowsByBranch.set(branch.id, [])
            for (const row of allMsgRows) {
              const bucket = rowsByBranch.get(row.branch_id)
              if (!Predicate.isUndefined(bucket)) bucket.push(row)
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
          Effect.mapError(storageError("Failed to get session detail")),
        ),
      } satisfies RelationshipStorageService
    }),
  )
}
