import { Effect, Layer, PubSub, Queue, Stream } from "effect"
import { EventStore, EventStoreError } from "@gent/core"
import type { EventEnvelope } from "@gent/core"
import type { StorageError } from "@gent/storage"
import { Storage } from "@gent/storage"
import { appendFileSync } from "node:fs"

const esLog = (msg: string) => {
  try {
    const d = new Date()
    const ts = `[${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, "0")}]`
    appendFileSync("/tmp/gent-unified.log", `${ts} [eventstore] ${msg}\n`)
  } catch {}
}

const toEventStoreError =
  (message: string) =>
  (error: StorageError): EventStoreError =>
    new EventStoreError({ message, cause: error })

const getEventSessionId = (event: EventEnvelope["event"]): string | undefined => {
  if ("sessionId" in event) return event.sessionId as string
  if ("parentSessionId" in event) return event.parentSessionId as string
  return undefined
}

const matchesEventFilter = (env: EventEnvelope, sessionId: string, branchId?: string): boolean => {
  const eventSessionId = getEventSessionId(env.event)
  if (eventSessionId === undefined || eventSessionId !== sessionId) return false
  if (branchId === undefined) return true
  const eventBranchId =
    "branchId" in env.event ? (env.event.branchId as string | undefined) : undefined
  return eventBranchId === branchId || eventBranchId === undefined
}

export const EventStoreLive: Layer.Layer<EventStore, never, Storage> = Layer.scoped(
  EventStore,
  Effect.gen(function* () {
    const storage = yield* Storage
    const pubsub = yield* PubSub.unbounded<EventEnvelope>()

    return {
      publish: Effect.fn("EventStore.publish")(function* (event) {
        const envelope = yield* storage
          .appendEvent(event)
          .pipe(Effect.mapError(toEventStoreError("Failed to append event")))
        esLog(`publish: ${event._tag} id=${envelope.id}`)
        yield* PubSub.publish(pubsub, envelope)
      }),

      subscribe: ({ sessionId, branchId, after }) =>
        Stream.unwrapScoped(
          Effect.gen(function* () {
            const queue = yield* PubSub.subscribe(pubsub)
            const afterId = after ?? 0
            const latestId = yield* storage
              .getLatestEventId({ sessionId, branchId })
              .pipe(Effect.mapError(toEventStoreError("Failed to load latest event id")))
            const maxId = Math.max(afterId, latestId ?? afterId)
            esLog(`subscribe: afterId=${afterId} latestId=${latestId} maxId=${maxId}`)
            const buffered = yield* storage
              .listEvents({ sessionId, branchId, afterId })
              .pipe(Effect.mapError(toEventStoreError("Failed to load buffered events")))
            const initial = buffered.filter((env) => env.id <= maxId)
            esLog(`subscribe: initial=${initial.length} buffered=${buffered.length}`)
            const live = Stream.fromQueue(queue).pipe(
              Stream.tap((env) =>
                Effect.gen(function* () {
                  const size = yield* Queue.size(queue)
                  const shutdown = yield* Queue.isShutdown(queue)
                  const matches = env.id > maxId && matchesEventFilter(env, sessionId, branchId)
                  esLog(
                    `live queue: ${env.event._tag} id=${env.id} matches=${matches} qSize=${size} shutdown=${shutdown}`,
                  )
                }),
              ),
              Stream.filter(
                (env) => env.id > maxId && matchesEventFilter(env, sessionId, branchId),
              ),
            )
            return Stream.concat(Stream.fromIterable(initial), live)
          }),
        ),
    }
  }),
)
