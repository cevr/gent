/**
 * EventStorage — focused service for agent event persistence + queries.
 *
 * Provided by `SqliteStorage` from the shared SQLite client.
 */

import { Clock, Context, Effect, Layer, Schema } from "effect"
import { Model } from "effect/unstable/schema"
import {
  EventEnvelope,
  EventId,
  getEventBranchId,
  getEventSessionId,
  type AgentEvent,
  type AgentEventTag,
} from "../domain/event.js"
import { BranchId, SessionId } from "../domain/ids.js"
import { StorageError } from "../domain/storage-error.js"
import { SqlClient, SqlModel } from "effect/unstable/sql"
import { decodeEvent, encodeEvent, type EventRow } from "./sqlite/rows.js"
import { CurrentWorkspaceId } from "../server/workspace-rpc.js"

class EventTable extends Model.Class<EventTable>("EventTable")({
  id: Model.Generated(Schema.Number),
  session_id: SessionId,
  branch_id: Schema.NullOr(BranchId),
  event_tag: Schema.String,
  event_json: Schema.String,
  created_at: Schema.Number,
  trace_id: Schema.NullOr(Schema.String),
}) {}

export interface EventStorageService {
  readonly appendEvent: (
    event: AgentEvent,
    options?: { traceId?: string },
  ) => Effect.Effect<EventEnvelope, StorageError>
  readonly listEvents: (params: {
    sessionId: SessionId
    branchId?: BranchId
    afterId?: number
  }) => Effect.Effect<ReadonlyArray<EventEnvelope>, StorageError>
  readonly getLatestEventId: (params: {
    sessionId: SessionId
    branchId?: BranchId
  }) => Effect.Effect<number | undefined, StorageError>
  readonly getLatestEvent: (params: {
    sessionId: SessionId
    branchId: BranchId
    tags: ReadonlyArray<AgentEventTag>
  }) => Effect.Effect<AgentEvent | undefined, StorageError>
}

export class EventStorage extends Context.Service<EventStorage, EventStorageService>()(
  "@gent/core/src/storage/event-storage/EventStorage",
) {
  static Live: Layer.Layer<EventStorage, never, SqlClient.SqlClient> = Layer.effect(
    EventStorage,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const eventRepository = yield* SqlModel.makeRepository(EventTable, {
        tableName: "events",
        spanPrefix: "EventStorage",
        idColumn: "id",
      })
      const mapError = (message: string) => (cause: unknown) => new StorageError({ message, cause })

      return {
        appendEvent: Effect.fn("EventStorage.appendEvent")(
          function* (event, options) {
            const workspaceId = yield* CurrentWorkspaceId
            const sessionId = getEventSessionId(event)
            if (sessionId === undefined) {
              return yield* new StorageError({ message: "Event missing sessionId" })
            }
            const sessionRows = yield* sql<{ id: SessionId }>`
              SELECT id FROM sessions
              WHERE id = ${sessionId} AND workspace_id = ${workspaceId}
            `
            if (sessionRows.length === 0) {
              return yield* new StorageError({
                message: `Session not found in current workspace: ${sessionId}`,
              })
            }
            const branchId = getEventBranchId(event)
            const createdAt = yield* Clock.currentTimeMillis
            const traceId = options?.traceId
            const eventJson = yield* encodeEvent(event)
            const row = yield* eventRepository.insert({
              session_id: sessionId,
              branch_id: branchId ?? null,
              event_tag: event._tag,
              event_json: eventJson,
              created_at: createdAt,
              trace_id: traceId ?? null,
            })
            return EventEnvelope.make({
              id: EventId.make(row.id),
              event,
              createdAt,
              ...(traceId !== undefined ? { traceId } : {}),
            })
          },
          Effect.mapError(mapError("Failed to append event")),
        ),
        listEvents: Effect.fn("EventStorage.listEvents")(
          function* ({ sessionId, branchId, afterId }) {
            const workspaceId = yield* CurrentWorkspaceId
            const sinceId = afterId ?? 0
            const rows =
              branchId !== undefined
                ? yield* sql<EventRow>`SELECT e.id, e.event_json, e.created_at, e.trace_id
                    FROM events e
                    JOIN sessions s ON s.id = e.session_id
                    WHERE e.session_id = ${sessionId}
                      AND s.workspace_id = ${workspaceId}
                      AND (e.branch_id = ${branchId} OR e.branch_id IS NULL)
                      AND e.id > ${sinceId}
                    ORDER BY e.id ASC`
                : yield* sql<EventRow>`SELECT e.id, e.event_json, e.created_at, e.trace_id
                    FROM events e
                    JOIN sessions s ON s.id = e.session_id
                    WHERE e.session_id = ${sessionId}
                      AND s.workspace_id = ${workspaceId}
                      AND e.id > ${sinceId}
                    ORDER BY e.id ASC`
            const envelopes: EventEnvelope[] = []
            for (const row of rows) {
              const decoded = yield* decodeEvent(row.event_json).pipe(Effect.option)
              if (decoded._tag === "Some") {
                envelopes.push(
                  EventEnvelope.make({
                    id: EventId.make(row.id),
                    event: decoded.value,
                    createdAt: row.created_at,
                    ...(row.trace_id !== null ? { traceId: row.trace_id } : {}),
                  }),
                )
              }
            }
            return envelopes
          },
          Effect.mapError(mapError("Failed to list events")),
        ),

        getLatestEventId: Effect.fn("EventStorage.getLatestEventId")(
          function* ({ sessionId, branchId }) {
            const workspaceId = yield* CurrentWorkspaceId
            const rows =
              branchId !== undefined
                ? yield* sql<{
                    id: number
                  }>`SELECT e.id
                    FROM events e
                    JOIN sessions s ON s.id = e.session_id
                    WHERE e.session_id = ${sessionId}
                      AND s.workspace_id = ${workspaceId}
                      AND (e.branch_id = ${branchId} OR e.branch_id IS NULL)
                    ORDER BY e.id DESC LIMIT 1`
                : yield* sql<{
                    id: number
                  }>`SELECT e.id
                    FROM events e
                    JOIN sessions s ON s.id = e.session_id
                    WHERE e.session_id = ${sessionId}
                      AND s.workspace_id = ${workspaceId}
                    ORDER BY e.id DESC LIMIT 1`
            return rows[0]?.id
          },
          Effect.mapError(mapError("Failed to get latest event id")),
        ),

        getLatestEvent: Effect.fn("EventStorage.getLatestEvent")(
          function* ({ sessionId, branchId, tags }) {
            if (tags.length === 0) return undefined
            const workspaceId = yield* CurrentWorkspaceId
            const rows = yield* sql<{
              event_json: string
            }>`SELECT e.event_json
              FROM events e
              JOIN sessions s ON s.id = e.session_id
              WHERE e.session_id = ${sessionId}
                AND s.workspace_id = ${workspaceId}
                AND (e.branch_id = ${branchId} OR e.branch_id IS NULL)
                AND e.event_tag IN ${sql.in(tags)}
              ORDER BY e.id DESC LIMIT 1`
            const row = rows[0]
            if (row === undefined) return undefined
            const decoded = yield* decodeEvent(row.event_json).pipe(Effect.option)
            return decoded._tag === "Some" ? decoded.value : undefined
          },
          Effect.mapError(mapError("Failed to get latest event")),
        ),
      } satisfies EventStorageService
    }),
  )
}
