import { Effect, Layer } from "effect"
import { EventPublisher } from "../domain/event-publisher.js"
import { BaseEventStore, getEventBranchId, getEventSessionId } from "../domain/event.js"
import { WorkflowRuntime } from "../runtime/extensions/workflow-runtime.js"
import { ExtensionEventBus } from "../runtime/extensions/event-bus.js"
import { ExtensionRegistry } from "../runtime/extensions/registry.js"
import { CurrentExtensionSession } from "../runtime/extensions/extension-actor-shared.js"
import { RuntimePlatform } from "../runtime/runtime-platform.js"

const logDeliveryFailure = (message: string, fields: Record<string, unknown>) =>
  Effect.logWarning(message).pipe(Effect.annotateLogs(fields))

/**
 * EventPublisher routes agent events to storage + extension state runtime.
 *
 * NOTE: Currently uses the server-wide WorkflowRuntime. In multi-cwd
 * shared mode (future), this would need profile-aware routing via SessionProfileCache.
 * For V1 (one cwd per server), the server-wide runtime matches the active profile.
 */
export const EventPublisherLive: Layer.Layer<
  EventPublisher,
  never,
  BaseEventStore | WorkflowRuntime | ExtensionRegistry | RuntimePlatform
> = Layer.effect(
  EventPublisher,
  Effect.gen(function* () {
    const baseEventStore = yield* BaseEventStore
    const stateRuntime = yield* WorkflowRuntime
    const registry = yield* ExtensionRegistry
    const platform = yield* RuntimePlatform
    const projections = registry.getResolved().projections
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
          const changed = yield* stateRuntime.publish(event, { sessionId, branchId })

          if (branchId !== undefined) {
            if (changed) {
              const actorSnapshots = yield* stateRuntime.getUiSnapshots(sessionId, branchId).pipe(
                Effect.catchEager((error) =>
                  logDeliveryFailure("extension.snapshot.publish.failed", {
                    sessionId,
                    branchId,
                    error: String(error),
                  }).pipe(Effect.as([])),
                ),
              )
              for (const snapshot of actorSnapshots) {
                yield* baseEventStore.publish(snapshot).pipe(
                  Effect.catchEager((error) =>
                    logDeliveryFailure("extension.snapshot.append.failed", {
                      sessionId,
                      branchId,
                      extensionId: snapshot.extensionId,
                      error: String(error),
                    }),
                  ),
                )
              }
            }
            // Projection snapshots — re-evaluate on every event since projections
            // derive from on-disk truth. Compile-time UI ownership rule guarantees
            // an extension cannot own both an actor.snapshot and a projection.ui,
            // so dedupe vs `actorEmitted` is unnecessary.
            const projEval = yield* projections
              .evaluateUi({
                sessionId,
                branchId,
                cwd: platform.cwd,
                home: platform.home,
              })
              .pipe(
                Effect.catchEager((error) =>
                  logDeliveryFailure("extension.projection.evaluate.failed", {
                    sessionId,
                    branchId,
                    error: String(error),
                  }).pipe(Effect.as({ uiSnapshots: [] })),
                ),
              )
            for (const snapshot of projEval.uiSnapshots) {
              yield* baseEventStore.publish(snapshot).pipe(
                Effect.catchEager((error) =>
                  logDeliveryFailure("extension.projection.snapshot.append.failed", {
                    sessionId,
                    branchId,
                    extensionId: snapshot.extensionId,
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
