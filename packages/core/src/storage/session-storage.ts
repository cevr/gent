/**
 * SessionStorage — focused service for session CRUD.
 *
 * Consumers yield only the narrow Tag they need; `SqliteStorage` provides
 * all focused storage Tags from one SQLite client.
 */

import { Context, Effect, Layer, Schema } from "effect"
import { Model } from "effect/unstable/schema"
import type { Session } from "../domain/message.js"
import { BranchId, SessionId } from "../domain/ids.js"
import { ReasoningEffort } from "../domain/agent.js"
import { StorageError } from "../domain/storage-error.js"
import { SqlClient, SqlModel } from "effect/unstable/sql"
import { sessionFromRow, type SessionRow } from "./sqlite/rows.js"
import { CurrentWorkspaceId } from "../server/workspace-rpc.js"

class SessionTable extends Model.Class<SessionTable>("SessionTable")({
  id: Model.GeneratedByApp(SessionId),
  workspace_id: Schema.String,
  name: Schema.NullOr(Schema.String),
  cwd: Schema.NullOr(Schema.String),
  reasoning_level: Schema.NullOr(ReasoningEffort),
  active_branch_id: Schema.NullOr(BranchId),
  parent_session_id: Schema.NullOr(SessionId),
  parent_branch_id: Schema.NullOr(BranchId),
  created_at: Schema.Number,
  updated_at: Schema.Number,
}) {}

export interface SessionStorageService {
  readonly createSession: (session: Session) => Effect.Effect<Session, StorageError>
  readonly getSession: (id: SessionId) => Effect.Effect<Session | undefined, StorageError>
  readonly getLastSessionByCwd: (cwd: string) => Effect.Effect<Session | undefined, StorageError>
  readonly listSessions: () => Effect.Effect<ReadonlyArray<Session>, StorageError>
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
      const sessionRepository = yield* SqlModel.makeRepository(SessionTable, {
        tableName: "sessions",
        spanPrefix: "SessionStorage",
        idColumn: "id",
      })
      const mapError = (message: string) => (cause: unknown) => new StorageError({ message, cause })

      return {
        createSession: Effect.fn("SessionStorage.createSession")(
          function* (session) {
            const workspaceId = yield* CurrentWorkspaceId
            if (session.parentBranchId !== undefined && session.parentSessionId === undefined) {
              return yield* new StorageError({
                message: "Cannot create session with parentBranchId without parentSessionId",
              })
            }
            if (session.parentBranchId !== undefined && session.parentSessionId !== undefined) {
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
            yield* sessionRepository.insertVoid({
              id: session.id,
              workspace_id: workspaceId,
              name: session.name ?? null,
              cwd: session.cwd ?? null,
              reasoning_level: session.reasoningLevel ?? null,
              active_branch_id: session.activeBranchId ?? null,
              parent_session_id: session.parentSessionId ?? null,
              parent_branch_id: session.parentBranchId ?? null,
              created_at: session.createdAt.getTime(),
              updated_at: session.updatedAt.getTime(),
            })
            return session
          },
          Effect.mapError(mapError("Failed to create session")),
        ),

        getSession: Effect.fn("SessionStorage.getSession")(
          function* (id) {
            const workspaceId = yield* CurrentWorkspaceId
            const rows =
              yield* sql<SessionRow>`SELECT id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at FROM sessions WHERE id = ${id} AND workspace_id = ${workspaceId}`
            const row = rows[0]
            if (row === undefined) return undefined
            return sessionFromRow(row)
          },
          Effect.mapError(mapError("Failed to get session")),
        ),

        getLastSessionByCwd: Effect.fn("SessionStorage.getLastSessionByCwd")(
          function* (cwd) {
            const workspaceId = yield* CurrentWorkspaceId
            const rows =
              yield* sql<SessionRow>`SELECT id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at FROM sessions WHERE cwd = ${cwd} AND workspace_id = ${workspaceId} ORDER BY updated_at DESC LIMIT 1`
            const row = rows[0]
            if (row === undefined) return undefined
            return sessionFromRow(row)
          },
          Effect.mapError(mapError("Failed to get last session by cwd")),
        ),

        listSessions: Effect.fn("SessionStorage.listSessions")(
          function* () {
            const workspaceId = yield* CurrentWorkspaceId
            const rows =
              yield* sql<SessionRow>`SELECT id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at FROM sessions WHERE workspace_id = ${workspaceId} ORDER BY updated_at DESC`
            return rows.map(sessionFromRow)
          },
          Effect.mapError(mapError("Failed to list sessions")),
        ),

        updateSession: Effect.fn("SessionStorage.updateSession")(
          function* (session) {
            const workspaceId = yield* CurrentWorkspaceId
            yield* sql`UPDATE sessions SET name = ${session.name ?? null}, reasoning_level = ${session.reasoningLevel ?? null}, active_branch_id = ${session.activeBranchId ?? null}, updated_at = ${session.updatedAt.getTime()} WHERE id = ${session.id} AND workspace_id = ${workspaceId}`
            return session
          },
          Effect.mapError(mapError("Failed to update session")),
        ),

        deleteSession: Effect.fn("SessionStorage.deleteSession")(
          function* (id) {
            const workspaceId = yield* CurrentWorkspaceId
            return yield* sql.withTransaction(
              Effect.gen(function* () {
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
                yield* sql`DELETE FROM messages_fts WHERE session_id IN ${sql.in(cascadedIds)}`
                yield* sql`DELETE FROM agent_loop_queues WHERE session_id IN ${sql.in(cascadedIds)}`
                yield* sql`DELETE FROM sessions WHERE id IN ${sql.in(cascadedIds)}`
                yield* sql`DELETE FROM content_chunks WHERE id NOT IN (SELECT chunk_id FROM message_chunks)`
                return cascadedIds
              }),
            )
          },
          Effect.mapError(mapError("Failed to delete session")),
        ),
      } satisfies SessionStorageService
    }),
  )
}
