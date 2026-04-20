import { Effect, Layer } from "effect"
import { EventPublisher } from "../domain/event-publisher.js"
import {
  EventStore,
  ExtensionStateChanged,
  getEventBranchId,
  getEventSessionId,
  type AgentEvent,
  type EventStoreService,
} from "../domain/event.js"
import type { MachineEngineService } from "../runtime/extensions/resource-host/machine-engine.js"
import { MachineEngine } from "../runtime/extensions/resource-host/machine-engine.js"
import {
  SubscriptionEngine,
  type SubscriptionEngineService,
} from "../runtime/extensions/resource-host/subscription-engine.js"
import { ExtensionRegistry, type ExtensionRegistryService } from "../runtime/extensions/registry.js"
import { CurrentExtensionSession } from "../runtime/extensions/extension-actor-shared.js"
import { SessionCwdRegistry } from "../runtime/session-cwd-registry.js"
import type { SessionProfileCacheService } from "../runtime/session-profile.js"
import { RuntimePlatform } from "../runtime/runtime-platform.js"

const logDeliveryFailure = (message: string, fields: Record<string, unknown>) =>
  Effect.logWarning(message).pipe(Effect.annotateLogs(fields))

// ── Inner publisher logic ──

interface InnerPublisherDeps {
  readonly baseEventStore: EventStoreService
  readonly stateRuntime: MachineEngineService
  readonly bus: SubscriptionEngineService | undefined
}

/**
 * Build the pulseByTag index from an extension registry's resolved set.
 * Maps event `_tag` → set of extension IDs that declared `pulseTags`.
 */
const buildPulseIndex = (registryService: ExtensionRegistryService) => {
  const pulseByTag = new Map<string, Set<string>>()
  const resolved = registryService.getResolved()
  for (const ext of resolved.extensions) {
    const tags = ext.contributions.pulseTags ?? []
    for (const tag of tags) {
      const set = pulseByTag.get(tag) ?? new Set<string>()
      set.add(ext.manifest.id)
      pulseByTag.set(tag, set)
    }
  }
  return pulseByTag
}

/**
 * Inner publish logic. Dispatches an event through storage, machine engine,
 * pulse index, and subscription bus. Used by both `EventPublisherLive`
 * (single-profile, ephemeral children) and the router (per-cwd dispatch).
 */
const publishInner = (
  event: AgentEvent,
  deps: InnerPublisherDeps,
  pulseByTag: Map<string, Set<string>>,
) =>
  Effect.gen(function* () {
    yield* deps.baseEventStore.publish(event)
    const sessionId = getEventSessionId(event)
    if (sessionId === undefined) return

    const branchId = getEventBranchId(event)
    const extensionSession = { sessionId }
    const transitioned = yield* deps.stateRuntime.publish(event, { sessionId, branchId })

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

    if (deps.bus !== undefined) {
      yield* deps.bus
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
  })

// ── Single-profile EventPublisher (ephemeral children, tests) ──

/**
 * EventPublisher for single-profile contexts (ephemeral children, tests).
 *
 * Yields MachineEngine + ExtensionRegistry + optional SubscriptionEngine
 * once at construction and dispatches all events through them.
 */
export const EventPublisherLive: Layer.Layer<
  EventPublisher,
  never,
  EventStore | MachineEngine | ExtensionRegistry
> = Layer.effect(
  EventPublisher,
  Effect.gen(function* () {
    const baseEventStore = yield* EventStore
    const stateRuntime = yield* MachineEngine
    const registry = yield* ExtensionRegistry
    const busOpt = yield* Effect.serviceOption(SubscriptionEngine)
    const bus = busOpt._tag === "Some" ? busOpt.value : undefined

    const deps: InnerPublisherDeps = { baseEventStore, stateRuntime, bus }
    const pulseByTag = buildPulseIndex(registry)

    return EventPublisher.of({
      publish: (event) => publishInner(event, deps, pulseByTag),
      terminateSession: (_sessionId) => Effect.void,
    })
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
 * Dispatches events through the correct cwd's MachineEngine, pulseTags
 * index, and SubscriptionEngine. Falls back to the primary cwd when the
 * session's cwd is unknown or matches the primary.
 *
 * Storage (EventStore.publish) is shared — events go into one store
 * regardless of cwd. Only the extension runtime dispatch is per-cwd.
 */
export const makeEventPublisherRouter = (): {
  readonly handle: EventPublisherRouterHandle
  readonly layer: Layer.Layer<
    EventPublisher,
    never,
    EventStore | MachineEngine | ExtensionRegistry | SessionCwdRegistry | RuntimePlatform
  >
} => {
  const handle: EventPublisherRouterHandle = { profileCache: undefined }

  const layer = Layer.effect(
    EventPublisher,
    Effect.gen(function* () {
      const baseEventStore = yield* EventStore
      const primaryStateRuntime = yield* MachineEngine
      const primaryRegistry = yield* ExtensionRegistry
      const primaryBusOpt = yield* Effect.serviceOption(SubscriptionEngine)
      const primaryBus = primaryBusOpt._tag === "Some" ? primaryBusOpt.value : undefined
      const cwdRegistry = yield* SessionCwdRegistry
      const platform = yield* RuntimePlatform

      const primaryCwd = platform.cwd
      const primaryDeps: InnerPublisherDeps = {
        baseEventStore,
        stateRuntime: primaryStateRuntime,
        bus: primaryBus,
      }
      const primaryPulseByTag = buildPulseIndex(primaryRegistry)

      // Per-cwd pulse index cache — built lazily on first event for a cwd.
      const cwdPulseCache = new Map<string, Map<string, Set<string>>>()

      return EventPublisher.of({
        publish: (event) =>
          Effect.gen(function* () {
            const sessionId = getEventSessionId(event)
            if (sessionId === undefined) {
              yield* publishInner(event, primaryDeps, primaryPulseByTag)
              return
            }

            const sessionCwd = yield* cwdRegistry.lookup(sessionId)

            if (sessionCwd === undefined || sessionCwd === primaryCwd) {
              yield* publishInner(event, primaryDeps, primaryPulseByTag)
              return
            }

            // Different cwd — resolve per-cwd profile. If profile cache
            // is unavailable or resolution fails, persist the event but
            // skip runtime dispatch (fail closed). Falling back to the
            // primary cwd's MachineEngine would be silent wrong-runtime
            // delivery.
            if (handle.profileCache === undefined) {
              yield* baseEventStore.publish(event)
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
              // Profile resolution failed — event already persisted by
              // the catchCause path above, but publishInner wasn't called.
              // Persist here to ensure storage consistency.
              yield* baseEventStore.publish(event)
              return
            }

            const cwdDeps: InnerPublisherDeps = {
              baseEventStore,
              stateRuntime: profile.extensionStateRuntime,
              bus: profile.subscriptionEngine,
            }

            let pulseByTag = cwdPulseCache.get(sessionCwd)
            if (pulseByTag === undefined) {
              pulseByTag = buildPulseIndex(profile.registryService)
              cwdPulseCache.set(sessionCwd, pulseByTag)
            }

            yield* publishInner(event, cwdDeps, pulseByTag)
          }),

        terminateSession: (_sessionId) => Effect.void,
      })
    }),
  )

  return { handle, layer }
}
