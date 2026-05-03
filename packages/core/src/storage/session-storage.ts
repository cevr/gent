/**
 * SessionStorage — focused service for session CRUD.
 *
 * Split from the `Storage` god-interface. Each consumer yields
 * only the narrow Tag it needs; the full SQLite implementation provides
 * all sub-Tags through `Storage.LiveWithSql` / `Storage.MemoryWithSql`.
 */

import { Context, Effect, Layer } from "effect"
import type { Session } from "../domain/message.js"
import type { BranchId, SessionId } from "../domain/ids.js"
import { StorageError } from "../domain/storage-error.js"
import { SqlClient } from "effect/unstable/sql"
import { sessionFromRow, type SessionRow } from "./sqlite/rows.js"

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
      const mapError = (message: string) => (cause: unknown) => new StorageError({ message, cause })

      return {
        createSession: Effect.fn("SessionStorage.createSession")(
          function* (session) {
            if (session.parentBranchId !== undefined && session.parentSessionId === undefined) {
              return yield* new StorageError({
                message: "Cannot create session with parentBranchId without parentSessionId",
              })
            }
            if (session.parentBranchId !== undefined && session.parentSessionId !== undefined) {
              const parentRows = yield* sql<{
                id: BranchId
              }>`SELECT id FROM branches WHERE id = ${session.parentBranchId} AND session_id = ${session.parentSessionId}`
              if (parentRows.length === 0) {
                return yield* new StorageError({
                  message: `Parent branch not found in parent session: ${session.parentBranchId}`,
                })
              }
            }
            yield* sql`INSERT INTO sessions (id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at) VALUES (${session.id}, ${session.name ?? null}, ${session.cwd ?? null}, ${session.reasoningLevel ?? null}, ${session.activeBranchId ?? null}, ${session.parentSessionId ?? null}, ${session.parentBranchId ?? null}, ${session.createdAt.getTime()}, ${session.updatedAt.getTime()})`
            return session
          },
          Effect.mapError(mapError("Failed to create session")),
        ),

        getSession: Effect.fn("SessionStorage.getSession")(
          function* (id) {
            const rows =
              yield* sql<SessionRow>`SELECT id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at FROM sessions WHERE id = ${id}`
            const row = rows[0]
            if (row === undefined) return undefined
            return sessionFromRow(row)
          },
          Effect.mapError(mapError("Failed to get session")),
        ),

        getLastSessionByCwd: Effect.fn("SessionStorage.getLastSessionByCwd")(
          function* (cwd) {
            const rows =
              yield* sql<SessionRow>`SELECT id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at FROM sessions WHERE cwd = ${cwd} ORDER BY updated_at DESC LIMIT 1`
            const row = rows[0]
            if (row === undefined) return undefined
            return sessionFromRow(row)
          },
          Effect.mapError(mapError("Failed to get last session by cwd")),
        ),

        listSessions: Effect.fn("SessionStorage.listSessions")(
          function* () {
            const rows =
              yield* sql<SessionRow>`SELECT id, name, cwd, reasoning_level, active_branch_id, parent_session_id, parent_branch_id, created_at, updated_at FROM sessions ORDER BY updated_at DESC`
            return rows.map(sessionFromRow)
          },
          Effect.mapError(mapError("Failed to list sessions")),
        ),

        updateSession: Effect.fn("SessionStorage.updateSession")(
          function* (session) {
            yield* sql`UPDATE sessions SET name = ${session.name ?? null}, reasoning_level = ${session.reasoningLevel ?? null}, active_branch_id = ${session.activeBranchId ?? null}, updated_at = ${session.updatedAt.getTime()} WHERE id = ${session.id}`
            return session
          },
          Effect.mapError(mapError("Failed to update session")),
        ),

        deleteSession: (id) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                const descendantRows = yield* sql<{ id: SessionId }>`
                  WITH RECURSIVE descendants(id) AS (
                    SELECT id FROM sessions WHERE id = ${id}
                    UNION
                    SELECT sessions.id
                    FROM sessions
                    JOIN descendants ON sessions.parent_session_id = descendants.id
                  )
                  SELECT id FROM descendants
                `
                const cascadedIds = descendantRows.map((row) => row.id)
                if (cascadedIds.length === 0) return cascadedIds
                yield* sql`DELETE FROM messages_fts WHERE session_id IN ${sql.in(cascadedIds)}`
                yield* sql`DELETE FROM sessions WHERE id IN ${sql.in(cascadedIds)}`
                yield* sql`DELETE FROM content_chunks WHERE id NOT IN (SELECT chunk_id FROM message_chunks)`
                return cascadedIds
              }),
            )
            .pipe(
              Effect.mapError(mapError("Failed to delete session")),
              Effect.withSpan("SessionStorage.deleteSession"),
            ),
      } satisfies SessionStorageService
    }),
  )
}
