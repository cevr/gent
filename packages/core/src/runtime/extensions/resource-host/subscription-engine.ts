/**
 * Subscription engine — channel-based pub/sub for Resource subscriptions.
 *
 * Dispatch semantics: exact-match channels and `"<prefix>:*"` wildcards;
 * per-handler error isolation via `catchEager` + `catchDefect`. The engine
 * holds the registry and the `emit` entry point; install collects the
 * subscriptions array from each Resource and registers them at install
 * time (process or ephemeral scope).
 *
 * @module
 */

import { Effect, Context, Layer } from "effect"
import type { LoadedExtension } from "../../../domain/extension.js"
import type {
  ResourceBusEnvelope,
  ResourceScope,
  ResourceSubscription,
} from "../../../domain/resource.js"

// ── Public service ──

/**
 * A handler stored in the engine. `R` is erased at the boundary — handlers
 * with non-`never` requirements must be pre-provided by the caller before
 * being registered (the same constraint the legacy `BusHandler` carried).
 */
export type SubscriptionHandler = (envelope: ResourceBusEnvelope) => Effect.Effect<void>

export interface SubscriptionEngineService {
  /**
   * Emit an envelope to all matching subscribers.
   *
   * Delivery is sequential in registration order. Shared session state lives
   * behind `ActorRouter`, so handlers must not be forked by default.
   * Errors remain isolated per handler.
   */
  readonly emit: (envelope: ResourceBusEnvelope) => Effect.Effect<void>
  /** Subscribe to a channel pattern. Returns unsubscribe function.
   *  Pattern: exact match or `"<prefix>:*"` wildcard. */
  readonly on: (pattern: string, handler: SubscriptionHandler) => Effect.Effect<() => void>
}

export class SubscriptionEngine extends Context.Service<
  SubscriptionEngine,
  SubscriptionEngineService
>()("@gent/core/src/runtime/extensions/resource-host/subscription-engine/SubscriptionEngine") {
  static Live: Layer.Layer<SubscriptionEngine> = Layer.sync(SubscriptionEngine, () => makeEngine())

  /**
   * Build an engine pre-populated with the given subscriptions.
   *
   * Subscriptions' `R` channels are erased at registration; the caller is
   * responsible for ensuring their requirements are satisfied by the
   * surrounding Layer composition. Handlers with unmet requirements fail
   * at emit time.
   */
  static withSubscriptions = (
    subscriptions: ReadonlyArray<ResourceSubscription>,
  ): Layer.Layer<SubscriptionEngine> => {
    if (subscriptions.length === 0) return SubscriptionEngine.Live
    const registrationLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        const engine = yield* SubscriptionEngine
        for (const sub of subscriptions) {
          yield* engine.on(sub.pattern, sub.handler)
        }
      }),
    )
    return Layer.provideMerge(registrationLayer, SubscriptionEngine.Live)
  }

  static Test = (): Layer.Layer<SubscriptionEngine> => SubscriptionEngine.Live
}

export const collectSubscriptions = (
  extensions: ReadonlyArray<LoadedExtension>,
  scopes: ReadonlyArray<ResourceScope> = ["process"],
): ReadonlyArray<ResourceSubscription> => {
  const allowed = new Set(scopes)
  return extensions.flatMap((ext) =>
    (ext.contributions.resources ?? [])
      .filter((resource) => allowed.has(resource.scope))
      .flatMap((resource) => resource.subscriptions ?? []),
  )
}

// ── Internals ──

const parseWildcard = (pattern: string): { prefix: string } | undefined => {
  if (pattern.endsWith(":*")) return { prefix: pattern.slice(0, -1) }
  return undefined
}

const makeEngine = (): SubscriptionEngineService => {
  const exactHandlers = new Map<string, Set<SubscriptionHandler>>()
  const wildcardHandlers = new Map<string, Set<SubscriptionHandler>>()

  return {
    emit: (envelope) =>
      Effect.suspend(() => {
        const handlers: SubscriptionHandler[] = []

        const exact = exactHandlers.get(envelope.channel)
        if (exact !== undefined) {
          for (const h of exact) handlers.push(h)
        }

        for (const [prefix, set] of wildcardHandlers) {
          if (envelope.channel.startsWith(prefix)) {
            for (const h of set) handlers.push(h)
          }
        }

        if (handlers.length === 0) return Effect.void

        return Effect.forEach(
          handlers,
          (handler) =>
            handler(envelope).pipe(
              Effect.catchDefect((defect: unknown) =>
                Effect.logWarning("subscription.handler.defect").pipe(
                  Effect.annotateLogs({
                    channel: envelope.channel,
                    defect: String(defect),
                  }),
                ),
              ),
              Effect.catchEager((error) =>
                Effect.logWarning("subscription.handler.error").pipe(
                  Effect.annotateLogs({
                    channel: envelope.channel,
                    error: String(error),
                  }),
                ),
              ),
            ),
          { discard: true },
        )
      }),

    on: (pattern, handler) =>
      Effect.sync(() => {
        const wildcard = parseWildcard(pattern)
        const map = wildcard !== undefined ? wildcardHandlers : exactHandlers
        const key = wildcard !== undefined ? wildcard.prefix : pattern
        let set = map.get(key)
        if (set === undefined) {
          set = new Set()
          map.set(key, set)
        }
        set.add(handler)
        return () => {
          const s = map.get(key)
          if (s !== undefined) {
            s.delete(handler)
            if (s.size === 0) map.delete(key)
          }
        }
      }),
  }
}
