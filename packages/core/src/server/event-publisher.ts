import { Effect, Layer } from "effect"
import { EventPublisher } from "../domain/event-publisher.js"
import { BaseEventStore, getEventBranchId, getEventSessionId } from "../domain/event.js"
import { ExtensionStateRuntime } from "../runtime/extensions/state-runtime.js"
import { ExtensionEventBus } from "../runtime/extensions/event-bus.js"
import { CurrentExtensionSession } from "../runtime/extensions/extension-actor-shared.js"
import { SessionProfileCache } from "../runtime/session-profile.js"
import { Storage } from "../storage/sqlite-storage.js"

const logDeliveryFailure = (message: string, fields: Record<string, unknown>) =>
  Effect.logWarning(message).pipe(Effect.annotateLogs(fields))

export const EventPublisherLive: Layer.Layer<
  EventPublisher,
  never,
  BaseEventStore | ExtensionStateRuntime
> = Layer.effect(
  EventPublisher,
  Effect.gen(function* () {
    const baseEventStore = yield* BaseEventStore
    const serverStateRuntime = yield* ExtensionStateRuntime
    const busOpt = yield* Effect.serviceOption(ExtensionEventBus)
    const bus = busOpt._tag === "Some" ? busOpt.value : undefined
    const profileCacheOpt = yield* Effect.serviceOption(SessionProfileCache)
    const profileCache = profileCacheOpt._tag === "Some" ? profileCacheOpt.value : undefined
    const storageOpt = yield* Effect.serviceOption(Storage)
    const storageSvc = storageOpt._tag === "Some" ? storageOpt.value : undefined

    return EventPublisher.of({
      publish: (event) =>
        Effect.gen(function* () {
          yield* baseEventStore.publish(event)
          const sessionId = getEventSessionId(event)
          if (sessionId === undefined) return

          const branchId = getEventBranchId(event)
          const extensionSession = { sessionId }

          // Resolve per-session state runtime when profile cache is available
          let stateRuntime = serverStateRuntime
          if (profileCache !== undefined && storageSvc !== undefined) {
            const session = yield* storageSvc
              .getSession(sessionId)
              .pipe(Effect.catchEager(() => Effect.succeed(undefined)))
            if (session?.cwd !== undefined) {
              const profile = yield* profileCache
                .peek(session.cwd)
                .pipe(Effect.catchEager(() => Effect.succeed(undefined)))
              if (profile !== undefined) {
                stateRuntime = profile.extensionStateRuntime
              }
            }
          }

          const changed = yield* stateRuntime.publish(event, { sessionId, branchId })

          if (changed && branchId !== undefined) {
            const snapshots = yield* stateRuntime.getUiSnapshots(sessionId, branchId).pipe(
              Effect.catchEager((error) =>
                logDeliveryFailure("extension.snapshot.publish.failed", {
                  sessionId,
                  branchId,
                  error: String(error),
                }).pipe(Effect.as([])),
              ),
            )
            for (const snapshot of snapshots) {
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
