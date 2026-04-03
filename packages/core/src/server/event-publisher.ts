import { Cause, Deferred, Effect, Exit, Layer, Queue, Ref, Scope, Semaphore } from "effect"
import { EventPublisher } from "../domain/event-publisher.js"
import {
  BaseEventStore,
  type AgentEvent,
  getEventBranchId,
  getEventSessionId,
} from "../domain/event.js"
import type { BranchId, SessionId } from "../domain/ids.js"
import { ExtensionStateRuntime } from "../runtime/extensions/state-runtime.js"
import { ExtensionEventBus } from "../runtime/extensions/event-bus.js"
import { CurrentExtensionSession } from "../runtime/extensions/extension-actor-shared.js"

interface DeliveryItem {
  readonly event: AgentEvent
  readonly sessionId: SessionId
  readonly branchId?: BranchId
  readonly done: Deferred.Deferred<void>
}

interface DeliverySlot {
  readonly queue: Queue.Queue<DeliveryItem>
}

const formatCause = (cause: Cause.Cause<unknown>) => String(Cause.squash(cause))

const logDeliveryFailure = (message: string, fields: Record<string, unknown>) =>
  Effect.logWarning(message).pipe(Effect.annotateLogs(fields))

export const EventPublisherLive: Layer.Layer<
  EventPublisher,
  never,
  BaseEventStore | ExtensionStateRuntime
> = Layer.effect(
  EventPublisher,
  Effect.acquireRelease(
    Effect.gen(function* () {
      const baseEventStore = yield* BaseEventStore
      const stateRuntime = yield* ExtensionStateRuntime
      const busOpt = yield* Effect.serviceOption(ExtensionEventBus)
      const runtimeScope = yield* Scope.make()
      const bus = busOpt._tag === "Some" ? busOpt.value : undefined
      const deliverySlotsRef = yield* Ref.make<Map<SessionId, DeliverySlot>>(new Map())
      const deliveryLock = yield* Semaphore.make(1)

      const processItem = (item: DeliveryItem) =>
        Effect.gen(function* () {
          const extensionSession = { sessionId: item.sessionId }
          const changed = yield* stateRuntime.publish(item.event, {
            sessionId: item.sessionId,
            branchId: item.branchId,
          })

          if (changed && item.branchId !== undefined) {
            const snapshots = yield* stateRuntime
              .getUiSnapshots(item.sessionId, item.branchId)
              .pipe(
                Effect.catchEager((error) =>
                  logDeliveryFailure("extension.snapshot.publish.failed", {
                    sessionId: item.sessionId,
                    branchId: item.branchId,
                    error: String(error),
                  }).pipe(Effect.as([])),
                ),
              )
            for (const snapshot of snapshots) {
              yield* baseEventStore.publish(snapshot).pipe(
                Effect.catchEager((error) =>
                  logDeliveryFailure("extension.snapshot.append.failed", {
                    sessionId: item.sessionId,
                    branchId: item.branchId,
                    extensionId: snapshot.extensionId,
                    error: String(error),
                  }),
                ),
              )
            }
          }

          yield* stateRuntime.notifyObservers(item.event).pipe(
            Effect.provideService(CurrentExtensionSession, extensionSession),
            Effect.catchEager((error) =>
              logDeliveryFailure("extension.observer.notify.failed", {
                sessionId: item.sessionId,
                event: item.event._tag,
                error: String(error),
              }),
            ),
          )

          if (bus !== undefined) {
            yield* bus
              .emit({
                channel: `agent:${item.event._tag}`,
                payload: item.event,
                sessionId: item.sessionId,
                ...(item.branchId !== undefined ? { branchId: item.branchId } : {}),
              })
              .pipe(
                Effect.provideService(CurrentExtensionSession, extensionSession),
                Effect.catchEager((error) =>
                  logDeliveryFailure("extension.bus.emit.failed", {
                    sessionId: item.sessionId,
                    event: item.event._tag,
                    error: String(error),
                  }),
                ),
              )
          }
        }).pipe(
          Effect.catchCause((cause) =>
            logDeliveryFailure("extension.delivery.failed", {
              sessionId: item.sessionId,
              event: item.event._tag,
              error: formatCause(cause),
            }),
          ),
          Effect.ensuring(Deferred.succeed(item.done, void 0).pipe(Effect.asVoid)),
        )

      const worker = (sessionId: SessionId, queue: Queue.Queue<DeliveryItem>) =>
        Effect.forever(Queue.take(queue).pipe(Effect.flatMap(processItem))).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.void
            return logDeliveryFailure("extension.delivery.worker.failed", {
              sessionId,
              error: formatCause(cause),
            })
          }),
        )

      const ensureDeliverySlot = (sessionId: SessionId): Effect.Effect<DeliverySlot> =>
        deliveryLock.withPermits(1)(
          Effect.gen(function* () {
            const existing = (yield* Ref.get(deliverySlotsRef)).get(sessionId)
            if (existing !== undefined) return existing

            const queue = yield* Queue.unbounded<DeliveryItem>()
            yield* Effect.forkIn(worker(sessionId, queue), runtimeScope)

            const slot: DeliverySlot = { queue }
            yield* Ref.update(deliverySlotsRef, (current) => {
              const next = new Map(current)
              next.set(sessionId, slot)
              return next
            })
            return slot
          }),
        )

      return {
        runtimeScope,
        service: EventPublisher.of({
          publish: (event) =>
            Effect.gen(function* () {
              yield* baseEventStore.publish(event)
              const sessionId = getEventSessionId(event)
              if (sessionId === undefined) return

              const slot = yield* ensureDeliverySlot(sessionId)
              const done = yield* Deferred.make<void>()
              const branchId = getEventBranchId(event)
              yield* Queue.offer(slot.queue, { event, sessionId, branchId, done })

              const currentSession = yield* Effect.serviceOption(CurrentExtensionSession)
              if (currentSession._tag === "Some" && currentSession.value.sessionId === sessionId) {
                return
              }

              yield* Deferred.await(done)
            }),

          terminateSession: (sessionId) =>
            Effect.gen(function* () {
              const slot = (yield* Ref.get(deliverySlotsRef)).get(sessionId)
              if (slot !== undefined) {
                yield* Queue.shutdown(slot.queue)
                yield* Ref.update(deliverySlotsRef, (current) => {
                  const next = new Map(current)
                  next.delete(sessionId)
                  return next
                })
              }
            }),
        }),
      }
    }),
    ({ runtimeScope }) => Scope.close(runtimeScope, Exit.void),
  ).pipe(Effect.map(({ service }) => service)),
)
