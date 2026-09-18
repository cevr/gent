/**
 * SessionStorage — focused service for session CRUD.
 *
 * Consumers yield only the narrow Tag they need; `SqliteStorage` provides
 * all focused storage Tags from one SQLite client.
 */

import { Context, Effect, Layer, Option, Predicate } from "effect"
import { Session } from "../domain/message.js"
import type { BranchId, SessionId } from "../domain/ids.js"
import { StorageError, storageError } from "../domain/errors.js"
import { SqlClient } from "effect/unstable/sql"
import { sessionFromRow, toSqlNull, SESSION_COLUMNS, type SessionRow } from "./schema.js"
import { CurrentWorkspaceId } from "../server/workspace-rpc.js"

export interface SessionStorageService {
  readonly createSession: (session: Session) => Effect.Effect<Session, StorageError>
  // oxlint-disable-next-line effect/noNullish -- Storage lookup uses undefined for an absent row.
  readonly getSession: (id: SessionId) => Effect.Effect<Session | undefined, StorageError>
  readonly listSessions: Effect.Effect<ReadonlyArray<Session>, StorageError>
  readonly updateSession: (session: Session) => Effect.Effect<Session, StorageError>
  /**
   * Deletes the session and every descendant, returning the full set of
   * session ids the cascade actually removed. Callers use the returned set
   * (not a pre-read tree snapshot) to clean in-memory runtime state, so a
   * child created between pre-collect and the durable tx is still cleaned.
   */
  readonly deleteSession: (id: SessionId) => Effect.Effect<ReadonlyArray<SessionId>, StorageError>
}

export class SessionStorage extends Context.Service<SessionStorage, SessionStorageService>()(
  "@gent/core/src/storage/session-storage/SessionStorage",
) {
  static Live: Layer.Layer<SessionStorage, never, SqlClient.SqlClient> = Layer.effect(
    SessionStorage,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      return {
        createSession: Effect.fn("SessionStorage.createSession")(
          function* (session) {
            const workspaceId = yield* CurrentWorkspaceId
            if (
              !Predicate.isUndefined(session.parentBranchId) &&
              Predicate.isUndefined(session.parentSessionId)
            ) {
              return yield* new StorageError({
                message: "Cannot create session with parentBranchId without parentSessionId",
              })
            }
            if (
              !Predicate.isUndefined(session.parentBranchId) &&
              !Predicate.isUndefined(session.parentSessionId)
            ) {
              const parentRows = yield* sql<{
                id: BranchId
              }>`SELECT b.id
                FROM branches b
                JOIN sessions s ON s.id = b.session_id
                WHERE b.id = ${session.parentBranchId}
                  AND b.session_id = ${session.parentSessionId}
                  AND s.workspace_id = ${workspaceId}`
              if (parentRows.length === 0) {
                return yield* new StorageError({
                  message: `Parent branch not found in parent session: ${session.parentBranchId}`,
                })
              }
            }
            // A session with no thread of its own starts one. Only a caller
            // continuing existing work — a compaction handoff — passes the
            // parent's thread; a spawn stays out of it by saying nothing.
            const stored = Option.match(Option.fromUndefinedOr(session.threadId), {
              onNone: () => new Session({ ...session, threadId: session.id }),
              onSome: () => session,
            })
            yield* sql`INSERT INTO sessions ${sql.insert({
              id: session.id,
              workspace_id: workspaceId,
              name: toSqlNull(session.name),
              cwd: toSqlNull(session.cwd),
              model_id: toSqlNull(session.modelId),
              reasoning_level: toSqlNull(session.reasoningLevel),
              active_branch_id: toSqlNull(session.activeBranchId),
              parent_session_id: toSqlNull(session.parentSessionId),
              parent_branch_id: toSqlNull(session.parentBranchId),
              thread_id: stored.threadId,
              created_at: session.createdAt.getTime(),
              updated_at: session.updatedAt.getTime(),
            })}`
            return stored
          },
          Effect.mapError(storageError("Failed to create session")),
        ),

        getSession: Effect.fn("SessionStorage.getSession")(
          function* (id) {
            const workspaceId = yield* CurrentWorkspaceId
            const rows =
              yield* sql<SessionRow>`SELECT ${sql.literal(SESSION_COLUMNS)} FROM sessions WHERE id = ${id} AND workspace_id = ${workspaceId}`
            const row = rows[0]
            // oxlint-disable-next-line effect/noNullish -- Storage lookup uses undefined for an absent row.
            if (Predicate.isUndefined(row)) return undefined
            return yield* sessionFromRow(row)
          },
          Effect.mapError(storageError("Failed to get session")),
        ),

        listSessions: Effect.suspend(
          Effect.fn("SessionStorage.listSessions")(function* () {
            const workspaceId = yield* CurrentWorkspaceId
            const rows =
              yield* sql<SessionRow>`SELECT ${sql.literal(SESSION_COLUMNS)} FROM sessions WHERE workspace_id = ${workspaceId} ORDER BY updated_at DESC`
            return yield* Effect.forEach(rows, sessionFromRow)
          }),
        ).pipe(Effect.mapError(storageError("Failed to list sessions"))),

        updateSession: Effect.fn("SessionStorage.updateSession")(
          function* (session) {
            const workspaceId = yield* CurrentWorkspaceId
            yield* sql`UPDATE sessions SET name = ${toSqlNull(session.name)}, model_id = ${toSqlNull(session.modelId)}, reasoning_level = ${toSqlNull(session.reasoningLevel)}, active_branch_id = ${toSqlNull(session.activeBranchId)}, updated_at = ${session.updatedAt.getTime()} WHERE id = ${session.id} AND workspace_id = ${workspaceId}`
            return session
          },
          Effect.mapError(storageError("Failed to update session")),
        ),

        deleteSession: Effect.fn("SessionStorage.deleteSession")(
          function* (id) {
            const workspaceId = yield* CurrentWorkspaceId
            return yield* Effect.gen(function* () {
              const descendantRows = yield* sql<{ id: SessionId }>`
                  WITH RECURSIVE descendants(id) AS (
                    SELECT id FROM sessions WHERE id = ${id} AND workspace_id = ${workspaceId}
                    UNION
                    SELECT sessions.id
                    FROM sessions
                    JOIN descendants ON sessions.parent_session_id = descendants.id
                    WHERE sessions.workspace_id = ${workspaceId}
                  )
                  SELECT id FROM descendants
                `
              const cascadedIds = descendantRows.map((row) => row.id)
              if (cascadedIds.length === 0) return cascadedIds
              yield* sql`DELETE FROM agent_loop_queues WHERE session_id IN ${sql.in(cascadedIds)}`
              yield* sql`DELETE FROM sessions WHERE id IN ${sql.in(cascadedIds)}`
              yield* sql`DELETE FROM content_chunks WHERE id NOT IN (SELECT chunk_id FROM message_chunks)`
              return cascadedIds
            }).pipe(sql.withTransaction)
          },
          Effect.mapError(storageError("Failed to delete session")),
        ),
      } satisfies SessionStorageService
    }),
  )
}
