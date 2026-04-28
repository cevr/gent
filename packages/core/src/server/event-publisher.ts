import { Context, Effect, Layer } from "effect"
import {
  BuiltinEventSink,
  EventPublisher,
  type EventPublisherService,
} from "../domain/event-publisher.js"
import {
  EventStore,
  ExtensionStateChanged,
  getEventBranchId,
  getEventSessionId,
  type EventEnvelope,
  type EventStoreError,
  type EventStoreService,
} from "../domain/event.js"
import { ExtensionRegistry } from "../runtime/extensions/registry.js"
import { SessionCwdRegistry } from "../runtime/session-cwd-registry.js"
import { buildPulseIndex, type SessionProfileCacheService } from "../runtime/session-profile.js"
import { RuntimePlatform } from "../runtime/runtime-platform.js"

const logDeliveryFailure = (message: string, fields: Record<string, unknown>) =>
  Effect.logWarning(message).pipe(Effect.annotateLogs(fields))

// ── Inner publisher logic ──

interface InnerPublisherDeps {
  readonly baseEventStore: EventStoreService
}

/**
 * Inner delivery logic. Broadcasts an already-durable event through live
 * pulse index. Used by both `EventPublisherLive`
 * (single-profile, ephemeral children) and the router (per-cwd dispatch).
 */
const deliverInner = (
  envelope: EventEnvelope,
  deps: InnerPublisherDeps,
  pulseByTag: ReadonlyMap<string, ReadonlySet<string>>,
) =>
  Effect.gen(function* () {
    yield* deps.baseEventStore.broadcast(envelope)
    const event = envelope.event
    const sessionId = getEventSessionId(event)
    if (sessionId === undefined) return

    const branchId = getEventBranchId(event)

    // Yield the calling fiber before fanning out pulses.
    //
    // The legacy publisher routed every event through a per-session
    // mailbox (`mailbox.submit`), which forced a fiber yield as it
    // serialized via semaphore. Sites that publish on the same fiber
    // that drives the agent loop (e.g. EventPublisher dispatched from a
    // turn-control command) implicitly relied on that yield to let the
    // loop's driver fiber pick up the transition before deliverInner
    // returns. Without this `yieldNow`, the regression caught by
    // `packages/e2e/tests/queue-contract.test.ts` ("direct runs steer
    // before queued follow-up") slips back in: the runtime-state
    // subscriber observes initial Idle and never sees the
    // Idle → Running edge before the test polls.
    //
    // The honest fix is to restructure the agent-loop driver so it does
    // not depend on publisher fiber-yields (tracked separately as a
    // future architecture wave). Until then, yielding here preserves
    // the contract.
    yield* Effect.yieldNow

    // Pulse-on-event: extensions that declared `pulseTags` for this
    // event tag receive an `ExtensionStateChanged` envelope so their UI
    // surfaces refresh. After W10-PhaseB collapsed Resource.machine into
    // Behaviors, the FSM-transition signal is gone — declared `pulseTags`
    // is the only pulse path. Extensions that need pulse-on-state-change
    // must declare the relevant agent event tags.
    if (branchId !== undefined && event._tag !== "ExtensionStateChanged") {
      const subscribers = pulseByTag.get(event._tag)
      if (subscribers !== undefined) {
        for (const extensionId of subscribers) {
          const pulse = ExtensionStateChanged.make({
            sessionId,
            branchId,
            extensionId,
          })
          yield* deps.baseEventStore.publish(pulse).pipe(
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
    }
  })

const makeIdempotentDeliver = (
  deliver: (envelope: EventEnvelope) => Effect.Effect<void, EventStoreError>,
) => {
  const delivered = new Set<EventEnvelope["id"]>()
  return (envelope: EventEnvelope) =>
    Effect.gen(function* () {
      if (delivered.has(envelope.id)) return
      yield* deliver(envelope)
      delivered.add(envelope.id)
    })
}

const makePublisherContext = (publisher: EventPublisherService) =>
  Context.empty().pipe(
    Context.add(EventPublisher, publisher),
    Context.add(BuiltinEventSink, {
      publish: publisher.publish,
    }),
  )

// ── Single-profile EventPublisher (ephemeral children, tests) ──

/**
 * EventPublisher for single-profile contexts (ephemeral children, tests).
 *
 * Yields ExtensionRegistry once at construction and dispatches all events
 * through the committed-event fanout.
 */
export const EventPublisherLive: Layer.Layer<
  EventPublisher | BuiltinEventSink,
  never,
  EventStore | ExtensionRegistry
> = Layer.effectContext(
  Effect.gen(function* () {
    const baseEventStore = yield* EventStore
    const registry = yield* ExtensionRegistry
    const deps: InnerPublisherDeps = { baseEventStore }
    const pulseByTag = buildPulseIndex(registry)
    const deliver = makeIdempotentDeliver((envelope) => deliverInner(envelope, deps, pulseByTag))

    return makePublisherContext(
      EventPublisher.of({
        append: (event) => baseEventStore.append(event),
        deliver,
        publish: (event) =>
          Effect.gen(function* () {
            const envelope = yield* baseEventStore.append(event)
            yield* deliver(envelope)
          }),
        terminateSession: (_sessionId) => Effect.void,
      }),
    )
  }),
)

// ── Per-cwd EventPublisher router (server composition root) ──

/**
 * Mutable handle for late-binding SessionProfileCache into the router.
 *
 * Breaks the circular dependency: EventPublisher is in `baseServicesLive`
 * but SessionProfileCache depends on `allDeps` (which includes baseServicesLive).
 * The handle is set by `createDependencies` after profile cache construction.
 */
export interface EventPublisherRouterHandle {
  profileCache: SessionProfileCacheService | undefined
}

/**
 * Create a per-cwd EventPublisher router + a handle for late-binding
 * the SessionProfileCache.
 *
 * Dispatches events through the correct cwd's pulseTags index.
 * Falls back to the primary cwd when the
 * session's cwd is unknown or matches the primary.
 *
 * Storage (EventStore.publish) is shared — events go into one store
 * regardless of cwd. Only the extension runtime dispatch is per-cwd.
 */
export const makeEventPublisherRouter = (): {
  readonly handle: EventPublisherRouterHandle
  readonly layer: Layer.Layer<
    EventPublisher | BuiltinEventSink,
    never,
    EventStore | ExtensionRegistry | SessionCwdRegistry | RuntimePlatform
  >
} => {
  const handle: EventPublisherRouterHandle = { profileCache: undefined }

  const layer = Layer.effectContext(
    Effect.gen(function* () {
      const baseEventStore = yield* EventStore
      const primaryRegistry = yield* ExtensionRegistry
      const cwdRegistry = yield* SessionCwdRegistry
      const platform = yield* RuntimePlatform

      const primaryCwd = platform.cwd
      const primaryDeps: InnerPublisherDeps = {
        baseEventStore,
      }
      const primaryPulseByTag = buildPulseIndex(primaryRegistry)

      // Per-cwd pulse indices live on the SessionProfile itself
      // (`profile.pulseByTag`), so they share the profile's lifecycle —
      // no parallel cache to keep in sync.

      const deliverToProfile = (envelope: EventEnvelope) =>
        Effect.gen(function* () {
          const event = envelope.event
          const sessionId = getEventSessionId(event)
          if (sessionId === undefined) {
            yield* deliverInner(envelope, primaryDeps, primaryPulseByTag)
            return
          }

          const sessionCwd = yield* cwdRegistry.lookup(sessionId).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                // Storage lookup failed — broadcast event but don't guess
                // which runtime to dispatch to (fail-closed).
                yield* baseEventStore.broadcast(envelope)
                yield* logDeliveryFailure("event-publisher.cwd-lookup.failed", {
                  sessionId,
                  error: String(cause),
                })
                return "__cwd_lookup_failed__" as const
              }),
            ),
          )

          if (sessionCwd === "__cwd_lookup_failed__") return

          if (sessionCwd === undefined || sessionCwd === primaryCwd) {
            yield* deliverInner(envelope, primaryDeps, primaryPulseByTag)
            return
          }

          // Different cwd — resolve per-cwd profile. If profile cache
          // is unavailable or resolution fails, persist the event but
          // skip runtime dispatch (fail closed). Falling back to the
          // primary cwd's ActorRouter would be silent wrong-runtime
          // delivery.
          if (handle.profileCache === undefined) {
            yield* baseEventStore.broadcast(envelope)
            yield* logDeliveryFailure("event-publisher.profile-cache.unavailable", {
              sessionId,
              sessionCwd,
            })
            return
          }

          const profile = yield* handle.profileCache.resolve(sessionCwd).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                yield* logDeliveryFailure("event-publisher.profile-resolve.failed", {
                  sessionId,
                  sessionCwd,
                  error: String(cause),
                })
                return undefined
              }),
            ),
          )

          if (profile === undefined) {
            // Profile resolution failed — event is already durable, but
            // runtime dispatch is unsafe. Still broadcast to live event
            // subscribers.
            yield* baseEventStore.broadcast(envelope)
            return
          }

          const cwdDeps: InnerPublisherDeps = {
            baseEventStore,
          }

          yield* deliverInner(envelope, cwdDeps, profile.pulseByTag)
        })
      const deliver = makeIdempotentDeliver(deliverToProfile)

      return makePublisherContext(
        EventPublisher.of({
          append: (event) => baseEventStore.append(event),
          deliver,
          publish: (event) =>
            Effect.gen(function* () {
              const envelope = yield* baseEventStore.append(event)
              yield* deliver(envelope)
            }),

          terminateSession: (_sessionId) => Effect.void,
        }),
      )
    }),
  )

  return { handle, layer }
}
