/**
 * ExtensionEventBus — channel-based pub/sub for extension communication.
 *
 * Dispatch rules:
 * - Agent events auto-published as `"agent:<EventTag>"` with sessionId/branchId
 * - `ext.bus("agent:*", handler)` matches all agent events
 * - `ext.bus("extensionId:channel", handler)` for targeted side-effects
 * - Handlers run as bus-local side effects, not as actor reducers
 * - Errors caught per-handler — one failing handler doesn't affect others
 */

import { Effect, ServiceMap, Layer } from "effect"
import type { SessionId, BranchId } from "../../domain/ids.js"

// ── Envelope ──

export interface BusEnvelope {
  readonly channel: string
  readonly payload: unknown
  readonly sessionId?: SessionId
  readonly branchId?: BranchId
}

// ── Handler ──

export type BusHandler = (envelope: BusEnvelope) => Effect.Effect<void>

type SubscriptionHandlerResult = void | Promise<void> | Effect.Effect<void>

// ── Service ──

export interface ExtensionEventBusService {
  /** Emit an envelope to all matching subscribers. Fire-and-forget — errors caught per handler. */
  readonly emit: (envelope: BusEnvelope) => Effect.Effect<void>
  /** Subscribe to a channel pattern. Returns unsubscribe function.
   *  Pattern: exact match or `"agent:*"` wildcard (matches all `"agent:<tag>"` channels). */
  readonly on: (pattern: string, handler: BusHandler) => Effect.Effect<() => void>
}

const parseWildcard = (pattern: string): { prefix: string } | undefined => {
  if (pattern.endsWith(":*")) return { prefix: pattern.slice(0, -1) }
  return undefined
}

export class ExtensionEventBus extends ServiceMap.Service<
  ExtensionEventBus,
  ExtensionEventBusService
>()("@gent/core/src/runtime/extensions/event-bus/ExtensionEventBus") {
  static Live: Layer.Layer<ExtensionEventBus> = Layer.sync(ExtensionEventBus, () => {
    // Mutable maps — bus is created once, handlers registered/unregistered synchronously
    const exactHandlers = new Map<string, Set<BusHandler>>()
    const wildcardHandlers = new Map<string, Set<BusHandler>>()

    return {
      emit: (envelope) =>
        Effect.suspend(() => {
          const handlers: BusHandler[] = []

          // Exact match
          const exact = exactHandlers.get(envelope.channel)
          if (exact !== undefined) {
            for (const h of exact) handlers.push(h)
          }

          // Wildcard matches
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
                  Effect.logWarning("bus.handler.defect").pipe(
                    Effect.annotateLogs({
                      channel: envelope.channel,
                      defect: String(defect),
                    }),
                  ),
                ),
                Effect.catchEager((error) =>
                  Effect.logWarning("bus.handler.error").pipe(
                    Effect.annotateLogs({
                      channel: envelope.channel,
                      error: String(error),
                    }),
                  ),
                ),
              ),
            { concurrency: "unbounded", discard: true },
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
  })

  /** Create a bus with pre-registered subscriptions from extensions. */
  static withSubscriptions = (
    subscriptions: ReadonlyArray<{
      readonly pattern: string
      readonly handler: (envelope: BusEnvelope) => SubscriptionHandlerResult
    }>,
  ): Layer.Layer<ExtensionEventBus> => {
    if (subscriptions.length === 0) return ExtensionEventBus.Live
    const registrationLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        const bus = yield* ExtensionEventBus
        for (const sub of subscriptions) {
          yield* bus.on(sub.pattern, (envelope) => {
            const result = sub.handler(envelope)
            if (result === undefined) return Effect.void
            if (Effect.isEffect(result)) return result
            return Effect.promise(() => result)
          })
        }
      }),
    )
    return Layer.provideMerge(registrationLayer, ExtensionEventBus.Live)
  }

  static Test = (): Layer.Layer<ExtensionEventBus> => ExtensionEventBus.Live
}
