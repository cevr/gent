import { Effect, Layer } from "effect"
import { EventPublisher } from "../domain/event-publisher.js"
import {
  BaseEventStore,
  ExtensionStateChanged,
  getEventBranchId,
  getEventSessionId,
} from "../domain/event.js"
import { WorkflowRuntime } from "../runtime/extensions/workflow-runtime.js"
import { ExtensionEventBus } from "../runtime/extensions/event-bus.js"
import { CurrentExtensionSession } from "../runtime/extensions/extension-actor-shared.js"

const logDeliveryFailure = (message: string, fields: Record<string, unknown>) =>
  Effect.logWarning(message).pipe(Effect.annotateLogs(fields))

/**
 * EventPublisher routes agent events to storage + extension state runtime.
 *
 * Pulse policy: `ExtensionStateChanged` is emitted ONLY for extensions whose
 * workflow machine actually transitioned in response to the published event.
 * No projection fan-out — projections are derivations the agent loop
 * recomputes on its natural cadence; clients that need fresh state subscribe
 * to the typed events they actually care about, or query on demand.
 *
 * NOTE: Currently uses the server-wide WorkflowRuntime. In multi-cwd
 * shared mode (future), this would need profile-aware routing via SessionProfileCache.
 * For V1 (one cwd per server), the server-wide runtime matches the active profile.
 */
export const EventPublisherLive: Layer.Layer<
  EventPublisher,
  never,
  BaseEventStore | WorkflowRuntime
> = Layer.effect(
  EventPublisher,
  Effect.gen(function* () {
    const baseEventStore = yield* BaseEventStore
    const stateRuntime = yield* WorkflowRuntime
    const busOpt = yield* Effect.serviceOption(ExtensionEventBus)
    const bus = busOpt._tag === "Some" ? busOpt.value : undefined

    return EventPublisher.of({
      publish: (event) =>
        Effect.gen(function* () {
          yield* baseEventStore.publish(event)
          const sessionId = getEventSessionId(event)
          if (sessionId === undefined) return

          const branchId = getEventBranchId(event)
          const extensionSession = { sessionId }
          // Drive workflow state machines. The returned list contains only
          // extensions whose machine genuinely transitioned — used below to
          // emit `ExtensionStateChanged` pulses with surgical precision.
          const transitioned = yield* stateRuntime.publish(event, { sessionId, branchId })

          // Defense in depth: never fan out pulses for the pulse itself.
          if (branchId !== undefined && event._tag !== "ExtensionStateChanged") {
            for (const extensionId of transitioned) {
              const pulse = new ExtensionStateChanged({
                sessionId,
                branchId,
                extensionId,
              })
              yield* baseEventStore.publish(pulse).pipe(
                Effect.catchEager((error) =>
                  logDeliveryFailure("extension.state-changed.publish.failed", {
                    sessionId,
                    branchId,
                    extensionId,
                    error: String(error),
                  }),
                ),
              )
            }
          }

          if (bus !== undefined) {
            yield* bus
              .emit({
                channel: `agent:${event._tag}`,
                payload: event,
                sessionId,
                ...(branchId !== undefined ? { branchId } : {}),
              })
              .pipe(
                Effect.provideService(CurrentExtensionSession, extensionSession),
                Effect.catchEager((error) =>
                  logDeliveryFailure("extension.bus.emit.failed", {
                    sessionId,
                    event: event._tag,
                    error: String(error),
                  }),
                ),
              )
          }
        }),

      terminateSession: (_sessionId) => Effect.void,
    })
  }),
)
