/**
 * EventStorage — focused service for agent event persistence + queries.
 *
 * Split from the `Storage` god-interface.
 */

import { Clock, Context, Effect, Layer } from "effect"
import {
  EventEnvelope,
  EventId,
  getEventBranchId,
  getEventSessionId,
  type AgentEvent,
  type AgentEventTag,
} from "../domain/event.js"
import type { SessionId, BranchId } from "../domain/ids.js"
import { StorageError } from "../domain/storage-error.js"
import { SqlClient } from "effect/unstable/sql"
import { decodeEvent, encodeEvent, type EventRow } from "./sqlite/rows.js"

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
      const mapError = (message: string) => (cause: unknown) => new StorageError({ message, cause })

      return {
        appendEvent: Effect.fn("EventStorage.appendEvent")(
          function* (event, options) {
            const sessionId = getEventSessionId(event)
            if (sessionId === undefined) {
              return yield* new StorageError({ message: "Event missing sessionId" })
            }
            const branchId = getEventBranchId(event)
            const createdAt = yield* Clock.currentTimeMillis
            const traceId = options?.traceId
            const eventJson = yield* encodeEvent(event)
            const id = yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO events (session_id, branch_id, event_tag, event_json, created_at, trace_id) VALUES (${sessionId}, ${branchId ?? null}, ${event._tag}, ${eventJson}, ${createdAt}, ${traceId ?? null})`
                const rows = yield* sql<{ id: number }>`SELECT last_insert_rowid() as id`
                return rows[0]?.id ?? 0
              }),
            )
            return EventEnvelope.make({
              id: EventId.make(id),
              event,
              createdAt,
              ...(traceId !== undefined ? { traceId } : {}),
            })
          },
          Effect.mapError(mapError("Failed to append event")),
        ),
        listEvents: Effect.fn("EventStorage.listEvents")(
          function* ({ sessionId, branchId, afterId }) {
            const sinceId = afterId ?? 0
            const rows =
              branchId !== undefined
                ? yield* sql<EventRow>`SELECT id, event_json, created_at, trace_id FROM events WHERE session_id = ${sessionId} AND (branch_id = ${branchId} OR branch_id IS NULL) AND id > ${sinceId} ORDER BY id ASC`
                : yield* sql<EventRow>`SELECT id, event_json, created_at, trace_id FROM events WHERE session_id = ${sessionId} AND id > ${sinceId} ORDER BY id ASC`
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
            const rows =
              branchId !== undefined
                ? yield* sql<{
                    id: number
                  }>`SELECT id FROM events WHERE session_id = ${sessionId} AND (branch_id = ${branchId} OR branch_id IS NULL) ORDER BY id DESC LIMIT 1`
                : yield* sql<{
                    id: number
                  }>`SELECT id FROM events WHERE session_id = ${sessionId} ORDER BY id DESC LIMIT 1`
            return rows[0]?.id
          },
          Effect.mapError(mapError("Failed to get latest event id")),
        ),

        getLatestEvent: Effect.fn("EventStorage.getLatestEvent")(
          function* ({ sessionId, branchId, tags }) {
            if (tags.length === 0) return undefined
            const rows = yield* sql<{
              event_json: string
            }>`SELECT event_json FROM events WHERE session_id = ${sessionId} AND (branch_id = ${branchId} OR branch_id IS NULL) AND event_tag IN ${sql.in(tags)} ORDER BY id DESC LIMIT 1`
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
