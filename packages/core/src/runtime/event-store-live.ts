import { Effect, Layer, PubSub, Stream } from "effect"
import { EventStore, EventStoreError, getEventSessionId } from "../domain/event.js"
import type { EventEnvelope, EventStoreService } from "../domain/event.js"
import type { SessionId, BranchId } from "../domain/ids.js"
import { Storage, type StorageError } from "../storage/sqlite-storage.js"

const toEventStoreError =
  (message: string) =>
  (error: StorageError): EventStoreError =>
    new EventStoreError({ message, cause: error })

const getOrCreateSessionPubSub = (
  sessions: Map<SessionId, PubSub.PubSub<EventEnvelope>>,
  sessionId: SessionId,
): PubSub.PubSub<EventEnvelope> => {
  const existing = sessions.get(sessionId)
  if (existing !== undefined) return existing
  const ps = Effect.runSync(PubSub.unbounded<EventEnvelope>())
  sessions.set(sessionId, ps)
  return ps
}

const matchesBranchFilter = (env: EventEnvelope, branchId?: BranchId): boolean => {
  if (branchId === undefined) return true
  const eventBranchId =
    "branchId" in env.event ? (env.event.branchId as BranchId | undefined) : undefined
  return eventBranchId === branchId || eventBranchId === undefined
}

export const EventStoreLive: Layer.Layer<EventStore, never, Storage> = Layer.unwrap(
  Effect.gen(function* () {
    const storage = yield* Storage
    const sessions = new Map<SessionId, PubSub.PubSub<EventEnvelope>>()

    const service: EventStoreService = {
      publish: Effect.fn("EventStore.publish")(function* (event) {
        const currentSpan = yield* Effect.currentParentSpan.pipe(
          Effect.orElseSucceed(() => undefined),
        )
        const traceId = currentSpan !== undefined ? currentSpan.traceId : undefined
        const envelope = yield* storage
          .appendEvent(event, traceId !== undefined ? { traceId } : undefined)
          .pipe(Effect.mapError(toEventStoreError("Failed to append event")))
        const eventSessionId = getEventSessionId(event)
        if (eventSessionId !== undefined) {
          yield* PubSub.publish(getOrCreateSessionPubSub(sessions, eventSessionId), envelope)
        }
      }),

      subscribe: ({ sessionId, branchId, after }) =>
        Stream.scoped(
          Stream.unwrap(
            Effect.gen(function* () {
              const afterId = after ?? 0
              const ps = getOrCreateSessionPubSub(sessions, sessionId)
              const subscription = yield* PubSub.subscribe(ps)
              const initial = yield* storage
                .listEvents({ sessionId, branchId, afterId })
                .pipe(Effect.mapError(toEventStoreError("Failed to load buffered events")))
              const maxId = initial[initial.length - 1]?.id ?? afterId
              const live = Stream.fromSubscription(subscription).pipe(
                Stream.filter((env) => env.id > maxId && matchesBranchFilter(env, branchId)),
              )

              yield* Effect.logInfo("EventStore.subscribe.open").pipe(
                Effect.annotateLogs({
                  sessionId,
                  branchId: branchId ?? "all",
                  afterId,
                  initialCount: initial.length,
                }),
              )
              yield* Effect.addFinalizer(() =>
                Effect.logInfo("EventStore.subscribe.close").pipe(
                  Effect.annotateLogs({ sessionId, branchId: branchId ?? "all" }),
                ),
              )

              return Stream.concat(Stream.fromIterable(initial), live)
            }),
          ),
        ),

      removeSession: (sessionId) =>
        Effect.gen(function* () {
          const ps = sessions.get(sessionId)
          if (ps !== undefined) {
            sessions.delete(sessionId)
            yield* PubSub.shutdown(ps)
          }
        }),
    }

    return Layer.succeed(EventStore, service)
  }),
)
