import { Effect, Layer } from "effect"
import { EventPublisher } from "../domain/event-publisher.js"
import {
  BaseEventStore,
  ExtensionStateChanged,
  getEventBranchId,
  getEventSessionId,
} from "../domain/event.js"
import { MachineEngine } from "../runtime/extensions/resource-host/machine-engine.js"
import { SubscriptionEngine } from "../runtime/extensions/resource-host/subscription-engine.js"
import { ExtensionRegistry } from "../runtime/extensions/registry.js"
import { CurrentExtensionSession } from "../runtime/extensions/extension-actor-shared.js"

const logDeliveryFailure = (message: string, fields: Record<string, unknown>) =>
  Effect.logWarning(message).pipe(Effect.annotateLogs(fields))

/**
 * EventPublisher routes agent events to storage + extension state runtime.
 *
 * Pulse policy: `ExtensionStateChanged` is emitted for two distinct sources,
 * combined and deduped per (sessionId, branchId, extensionId):
 *   1. Workflow transitions — extensions whose machine actually transitioned
 *      in response to the published event (per `MachineEngine.publish`).
 *   2. `pulseTags` declarations — query-backed / projection-only extensions
 *      that declared which event tags invalidate their snapshot via the
 *      `pulseTags: [...]` bucket on `defineExtension`. These never have an
 *      actor, so without explicit declaration they would silently stale.
 *
 * No blanket per-event-per-observable fan-out. Pulses are surgical.
 *
 * NOTE: Currently uses the server-wide MachineEngine. In multi-cwd
 * shared mode (future), this would need profile-aware routing via SessionProfileCache.
 * For V1 (one cwd per server), the server-wide engine matches the active profile.
 */
export const EventPublisherLive: Layer.Layer<
  EventPublisher,
  never,
  BaseEventStore | MachineEngine | ExtensionRegistry
> = Layer.effect(
  EventPublisher,
  Effect.gen(function* () {
    const baseEventStore = yield* BaseEventStore
    const stateRuntime = yield* MachineEngine
    const registry = yield* ExtensionRegistry
    const busOpt = yield* Effect.serviceOption(SubscriptionEngine)
    const bus = busOpt._tag === "Some" ? busOpt.value : undefined

    // Pre-compute event-tag → extensionIds index from `pulseTags` bucket
    // declarations. Built once at startup; the loaded extension set is fixed
    // for the runtime lifetime.
    const pulseByTag = new Map<string, Set<string>>()
    {
      const resolved = registry.getResolved()
      for (const ext of resolved.extensions) {
        const tags = ext.contributions.pulseTags ?? []
        for (const tag of tags) {
          const set = pulseByTag.get(tag) ?? new Set<string>()
          set.add(ext.manifest.id)
          pulseByTag.set(tag, set)
        }
      }
    }

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
            const subscribers = pulseByTag.get(event._tag)
            const pulseTargets = new Set<string>(transitioned)
            if (subscribers !== undefined) {
              for (const id of subscribers) pulseTargets.add(id)
            }
            for (const extensionId of pulseTargets) {
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
                  logDeliveryFailure("extension.subscription.emit.failed", {
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
