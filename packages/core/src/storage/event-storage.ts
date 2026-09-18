/**
 * EventStorage — focused service for agent event persistence + queries.
 *
 * Provided by `SqliteStorage` from the shared SQLite client.
 */

import { Array as Arr, Clock, Context, Effect, Layer, Option, Predicate, Schema } from "effect"
import {
  AgentEvent,
  EventEnvelope,
  EventId,
  getEventBranchId,
  getEventSessionId,
  type AgentEventTag,
} from "../domain/event.js"
import type { BranchId, MessageId, SessionId } from "../domain/ids.js"
import { StorageError, storageError, storageErrorExcept } from "../domain/errors.js"
import { SqlClient } from "effect/unstable/sql"
import { decodeEvent, decodeEventRow, encodeEvent, toSqlNull } from "./schema.js"
import { CurrentWorkspaceId } from "../server/workspace-rpc.js"

const LatestEventIdRow = Schema.Struct({ id: Schema.Finite })
const decodeLatestEventIdRow = Schema.decodeUnknownEffect(LatestEventIdRow)

const EventJsonRow = Schema.Struct({ id: EventId, event_json: Schema.String })
const decodeEventJsonRow = Schema.decodeUnknownEffect(EventJsonRow)

type EventDecodeOperation = "listEvents" | "getLatestEvent" | "listToolResultWindow"

export class EventDecodeError extends Schema.TaggedError<EventDecodeError>()("EventDecodeError", {
  eventId: EventId,
  operation: Schema.Literals(["listEvents", "getLatestEvent", "listToolResultWindow"]),
  error: Schema.String,
}) {}

export type EventStorageError = StorageError | EventDecodeError
const isEventDecodeError = Schema.is(EventDecodeError)

/**
 * A retired event type stays in the table after its feature is removed. Replay
 * skips those rows with a warning instead of making the whole session
 * unloadable; a known tag with a bad payload is corruption and still fails.
 */
const isKnownEventTag = (tag: string): boolean => Object.hasOwn(AgentEvent.cases, tag)

const decodePersistedEvent = Effect.fn("EventStorage.decodePersistedEvent")(function* (params: {
  eventId: EventId
  eventJson: string
  operation: EventDecodeOperation
}) {
  return yield* decodeEvent(params.eventJson).pipe(
    Effect.tapCause((cause) =>
      Effect.logWarning("event decode failed").pipe(
        Effect.annotateLogs({
          event_id: params.eventId,
          operation: params.operation,
          error: String(cause),
        }),
      ),
    ),
    Effect.mapError(
      (error) =>
        new EventDecodeError({
          eventId: params.eventId,
          operation: params.operation,
          error: String(error),
        }),
    ),
  )
})

/**
 * Turn raw event rows into envelopes, dropping rows whose tag no longer
 * exists. Both replay reads share this: the only difference between them is
 * which operation a decode failure reports.
 */
const rowsToEnvelopes = Effect.fn("EventStorage.rowsToEnvelopes")(function* (
  rawRows: ReadonlyArray<unknown>,
  operation: EventDecodeOperation,
) {
  const rows = yield* Effect.forEach(rawRows, (row) => decodeEventRow(row))
  const envelopes = yield* Effect.forEach(rows, (row) =>
    Effect.gen(function* () {
      if (!isKnownEventTag(row.event_tag)) {
        yield* Effect.logWarning("event.retired-tag-skipped").pipe(
          Effect.annotateLogs({ event_id: row.id, event_tag: row.event_tag }),
        )
        return Option.none<EventEnvelope>()
      }
      const decoded = yield* decodePersistedEvent({
        eventId: row.id,
        eventJson: row.event_json,
        operation,
      })
      const fields = {
        id: row.id,
        event: decoded,
        createdAt: row.created_at,
      }
      if (!Predicate.isNull(row.trace_id)) {
        Object.assign(fields, { traceId: row.trace_id })
      }
      return Option.some(EventEnvelope.make(fields))
    }),
  )
  return Arr.getSomes(envelopes)
})

interface EventStorageService {
  readonly appendEvent: (
    event: AgentEvent,
    options?: { traceId?: string },
  ) => Effect.Effect<EventEnvelope, StorageError>
  readonly listEvents: (params: {
    sessionId: SessionId
    branchId?: BranchId
    afterId?: number
  }) => Effect.Effect<ReadonlyArray<EventEnvelope>, EventStorageError>
  readonly getLatestEventId: (params: {
    sessionId: SessionId
    branchId?: BranchId
    // oxlint-disable-next-line effect/noNullish -- Event history lookup uses undefined when no row exists.
  }) => Effect.Effect<number | undefined, StorageError>
  readonly getLatestEvent: (params: {
    sessionId: SessionId
    branchId: BranchId
    tags: ReadonlyArray<AgentEventTag>
    messageId?: MessageId
    // oxlint-disable-next-line effect/noNullish -- Event history lookup uses undefined when no matching event exists.
  }) => Effect.Effect<AgentEvent | undefined, EventStorageError>
  /**
   * Events between one assistant message and the next assistant boundary.
   *
   * The point question a replaying tool step asks: what settled under *this*
   * step. Both bounds are found by id, so the read is the window rather than
   * the transcript. Envelopes, not events -- the publisher's dedup set keys
   * on `envelope.id`.
   */
  readonly listToolResultWindow: (params: {
    sessionId: SessionId
    branchId: BranchId
    assistantMessageId: MessageId
  }) => Effect.Effect<ReadonlyArray<EventEnvelope>, EventStorageError>
}

export class EventStorage extends Context.Service<EventStorage, EventStorageService>()(
  "@gent/core/src/storage/event-storage/EventStorage",
) {
  static Live: Layer.Layer<EventStorage, never, SqlClient.SqlClient> = Layer.effect(
    EventStorage,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const mapEventStorageError = storageErrorExcept(isEventDecodeError)

      return {
        appendEvent: Effect.fn("EventStorage.appendEvent")(
          function* (event, options) {
            const workspaceId = yield* CurrentWorkspaceId
            const sessionId = getEventSessionId(event)
            if (Predicate.isUndefined(sessionId)) {
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
            const inserted = yield* sql<{ id: number }>`INSERT INTO events ${sql.insert({
              session_id: sessionId,
              branch_id: toSqlNull(branchId),
              event_tag: event._tag,
              event_json: eventJson,
              created_at: createdAt,
              trace_id: toSqlNull(traceId),
            })} RETURNING id`
            const row = inserted[0]
            if (Predicate.isUndefined(row)) {
              return yield* new StorageError({ message: "Event insert returned no id" })
            }
            return EventEnvelope.make({
              id: EventId.make(row.id),
              event,
              createdAt,
              traceId,
            })
          },
          Effect.mapError(storageError("Failed to append event")),
        ),
        listEvents: Effect.fn("EventStorage.listEvents")(
          function* ({ sessionId, branchId, afterId }) {
            const workspaceId = yield* CurrentWorkspaceId
            const sinceId = afterId ?? 0
            const rawRows = yield* Option.match(Option.fromUndefinedOr(branchId), {
              onSome: (
                branchId,
              ) => sql`SELECT e.id, e.event_tag, e.event_json, e.created_at, e.trace_id
                    FROM events e
                    JOIN sessions s ON s.id = e.session_id
                    WHERE e.session_id = ${sessionId}
                      AND s.workspace_id = ${workspaceId}
                      AND (e.branch_id = ${branchId} OR e.branch_id IS NULL)
                      AND e.id > ${sinceId}
                    ORDER BY e.id ASC`,
              onNone: () => sql`SELECT e.id, e.event_tag, e.event_json, e.created_at, e.trace_id
                    FROM events e
                    JOIN sessions s ON s.id = e.session_id
                    WHERE e.session_id = ${sessionId}
                      AND s.workspace_id = ${workspaceId}
                      AND e.id > ${sinceId}
                    ORDER BY e.id ASC`,
            })
            return yield* rowsToEnvelopes(rawRows, "listEvents")
          },
          Effect.mapError(mapEventStorageError("Failed to list events")),
        ),

        getLatestEventId: Effect.fn("EventStorage.getLatestEventId")(
          function* ({ sessionId, branchId }) {
            const workspaceId = yield* CurrentWorkspaceId
            const rawRows = yield* Option.match(Option.fromUndefinedOr(branchId), {
              onSome: (branchId) => sql`SELECT e.id
                    FROM events e
                    JOIN sessions s ON s.id = e.session_id
                    WHERE e.session_id = ${sessionId}
                      AND s.workspace_id = ${workspaceId}
                      AND (e.branch_id = ${branchId} OR e.branch_id IS NULL)
                    ORDER BY e.id DESC LIMIT 1`,
              onNone: () => sql`SELECT e.id
                    FROM events e
                    JOIN sessions s ON s.id = e.session_id
                    WHERE e.session_id = ${sessionId}
                      AND s.workspace_id = ${workspaceId}
                    ORDER BY e.id DESC LIMIT 1`,
            })
            // oxlint-disable-next-line effect/noNullish -- Event history lookup uses undefined when no row exists.
            if (Predicate.isUndefined(rawRows[0])) return undefined
            const row = yield* decodeLatestEventIdRow(rawRows[0])
            return row.id
          },
          Effect.mapError(storageError("Failed to get latest event id")),
        ),

        getLatestEvent: Effect.fn("EventStorage.getLatestEvent")(
          function* ({ sessionId, branchId, tags, messageId }) {
            // oxlint-disable-next-line effect/noNullish -- Event history lookup uses undefined when no matching tag exists.
            if (tags.length === 0) return undefined
            const workspaceId = yield* CurrentWorkspaceId
            const rawRows = yield* sql`SELECT e.id, e.event_json
              FROM events e
              JOIN sessions s ON s.id = e.session_id
              WHERE e.session_id = ${sessionId}
                AND s.workspace_id = ${workspaceId}
                AND (e.branch_id = ${branchId} OR e.branch_id IS NULL)
                AND e.event_tag IN ${sql.in(tags)}
                AND (${toSqlNull(messageId)} IS NULL
                  OR json_extract(e.event_json, '$.messageId') = ${toSqlNull(messageId)})
              ORDER BY e.id DESC LIMIT 1`
            // oxlint-disable-next-line effect/noNullish -- Event history lookup uses undefined when no row exists.
            if (Predicate.isUndefined(rawRows[0])) return undefined
            const row = yield* decodeEventJsonRow(rawRows[0])
            return yield* decodePersistedEvent({
              eventId: row.id,
              eventJson: row.event_json,
              operation: "getLatestEvent",
            })
          },
          Effect.mapError(mapEventStorageError("Failed to get latest event")),
        ),

        listToolResultWindow: Effect.fn("EventStorage.listToolResultWindow")(
          function* ({ sessionId, branchId, assistantMessageId }) {
            const workspaceId = yield* CurrentWorkspaceId
            // `MessageReceived` nests the message, so both bounds read
            // `$.message.*`. Each probe rides idx_events_session_tag.
            const anchorRows = yield* sql<{ id: EventId }>`SELECT e.id
              FROM events e
              JOIN sessions s ON s.id = e.session_id
              WHERE e.session_id = ${sessionId}
                AND s.workspace_id = ${workspaceId}
                AND (e.branch_id = ${branchId} OR e.branch_id IS NULL)
                AND e.event_tag = 'MessageReceived'
                AND json_extract(e.event_json, '$.message.id') = ${assistantMessageId}
              ORDER BY e.id DESC LIMIT 1`
            const anchor = anchorRows[0]
            if (Predicate.isUndefined(anchor)) return []
            const boundaryRows = yield* sql<{ id: EventId }>`SELECT e.id
              FROM events e
              JOIN sessions s ON s.id = e.session_id
              WHERE e.session_id = ${sessionId}
                AND s.workspace_id = ${workspaceId}
                AND (e.branch_id = ${branchId} OR e.branch_id IS NULL)
                AND e.id > ${anchor.id}
                AND e.event_tag = 'MessageReceived'
                AND json_extract(e.event_json, '$.message.role') = 'assistant'
              ORDER BY e.id ASC LIMIT 1`
            const rawRows = yield* Option.match(Option.fromUndefinedOr(boundaryRows[0]), {
              onSome: (
                boundary,
              ) => sql`SELECT e.id, e.event_tag, e.event_json, e.created_at, e.trace_id
                      FROM events e
                      JOIN sessions s ON s.id = e.session_id
                      WHERE e.session_id = ${sessionId}
                        AND s.workspace_id = ${workspaceId}
                        AND (e.branch_id = ${branchId} OR e.branch_id IS NULL)
                        AND e.id > ${anchor.id}
                        AND e.id < ${boundary.id}
                      ORDER BY e.id ASC`,
              onNone: () => sql`SELECT e.id, e.event_tag, e.event_json, e.created_at, e.trace_id
                      FROM events e
                      JOIN sessions s ON s.id = e.session_id
                      WHERE e.session_id = ${sessionId}
                        AND s.workspace_id = ${workspaceId}
                        AND (e.branch_id = ${branchId} OR e.branch_id IS NULL)
                        AND e.id > ${anchor.id}
                      ORDER BY e.id ASC`,
            })
            return yield* rowsToEnvelopes(rawRows, "listToolResultWindow")
          },
          Effect.mapError(mapEventStorageError("Failed to list tool result window")),
        ),
      } satisfies EventStorageService
    }),
  )
}
