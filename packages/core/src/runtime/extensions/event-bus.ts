/**
 * ExtensionEventBus — channel-based pub/sub for extension communication.
 *
 * Unifies three previously separate mechanisms into one primitive:
 * - Agent event observation (replaces `ext.observe()`)
 * - Client intent delivery (replaces ad-hoc `sendIntent` RPC wiring)
 * - Extension-to-extension communication
 *
 * Dispatch rules:
 * - Agent events auto-published as `"agent:<EventTag>"` with sessionId/branchId
 * - `ext.bus.on("agent:*", handler)` is the new `ext.observe()`
 * - `ext.bus.on("extensionId:channel", handler)` for targeted side-effects
 * - Handlers run with full service access (unlike pure actor reducers)
 * - Errors caught per-handler — one failing handler doesn't affect others
 */

import { Effect, ServiceMap, Layer, Ref } from "effect"
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

// ── Service ──

export interface ExtensionEventBusService {
  /** Emit an envelope to all matching subscribers. Fire-and-forget — errors caught per handler. */
  readonly emit: (envelope: BusEnvelope) => Effect.Effect<void>
  /** Subscribe to a channel pattern. Returns unsubscribe function.
   *  Pattern: exact match or `"agent:*"` wildcard (matches all `"agent:<tag>"` channels). */
  readonly on: (pattern: string, handler: BusHandler) => Effect.Effect<() => void>
}

export class ExtensionEventBus extends ServiceMap.Service<
  ExtensionEventBus,
  ExtensionEventBusService
>()("@gent/core/src/runtime/extensions/event-bus/ExtensionEventBus") {
  static Live: Layer.Layer<ExtensionEventBus> = Layer.effect(
    ExtensionEventBus,
    Effect.gen(function* () {
      // Two maps: exact channel → handlers, wildcard prefix → handlers
      const exactRef = yield* Ref.make(new Map<string, Set<BusHandler>>())
      const wildcardRef = yield* Ref.make(new Map<string, Set<BusHandler>>())

      const parseWildcard = (pattern: string): { prefix: string } | undefined => {
        if (pattern.endsWith(":*")) {
          return { prefix: pattern.slice(0, -1) } // "agent:*" → prefix "agent:"
        }
        return undefined
      }

      return {
        emit: (envelope) =>
          Effect.gen(function* () {
            const exact = yield* Ref.get(exactRef)
            const wildcards = yield* Ref.get(wildcardRef)

            const handlers: BusHandler[] = []

            // Exact match
            const exactHandlers = exact.get(envelope.channel)
            if (exactHandlers !== undefined) {
              for (const h of exactHandlers) handlers.push(h)
            }

            // Wildcard matches
            for (const [prefix, set] of wildcards) {
              if (envelope.channel.startsWith(prefix)) {
                for (const h of set) handlers.push(h)
              }
            }

            // Fire-and-forget all handlers concurrently — errors caught per handler
            if (handlers.length > 0) {
              yield* Effect.forEach(
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
            }
          }),

        on: (pattern, handler) =>
          Effect.gen(function* () {
            const wildcard = parseWildcard(pattern)
            if (wildcard !== undefined) {
              yield* Ref.update(wildcardRef, (m) => {
                const next = new Map(m)
                const set = next.get(wildcard.prefix) ?? new Set()
                set.add(handler)
                next.set(wildcard.prefix, set)
                return next
              })
              return () => {
                Effect.runSync(
                  Ref.update(wildcardRef, (m) => {
                    const next = new Map(m)
                    const set = next.get(wildcard.prefix)
                    if (set !== undefined) {
                      set.delete(handler)
                      if (set.size === 0) next.delete(wildcard.prefix)
                    }
                    return next
                  }),
                )
              }
            }
            // Exact match
            yield* Ref.update(exactRef, (m) => {
              const next = new Map(m)
              const set = next.get(pattern) ?? new Set()
              set.add(handler)
              next.set(pattern, set)
              return next
            })
            return () => {
              Effect.runSync(
                Ref.update(exactRef, (m) => {
                  const next = new Map(m)
                  const set = next.get(pattern)
                  if (set !== undefined) {
                    set.delete(handler)
                    if (set.size === 0) next.delete(pattern)
                  }
                  return next
                }),
              )
            }
          }),
      }
    }),
  )

  /** Create a bus with pre-registered subscriptions from extensions. */
  /** Create a bus with pre-registered subscriptions from extensions. */
  static withSubscriptions = (
    subscriptions: ReadonlyArray<{
      readonly pattern: string
      readonly handler: (envelope: BusEnvelope) => void | Promise<void>
    }>,
  ): Layer.Layer<ExtensionEventBus> => {
    if (subscriptions.length === 0) return ExtensionEventBus.Live
    // Build a layer that registers all subscriptions after the bus is created
    const registrationLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        const bus = yield* ExtensionEventBus
        for (const sub of subscriptions) {
          yield* bus.on(sub.pattern, (envelope) =>
            Effect.tryPromise({
              try: () => Promise.resolve(sub.handler(envelope)),
              catch: () => Effect.void as never,
            }).pipe(Effect.catchEager(() => Effect.void)),
          )
        }
      }),
    )
    return Layer.provideMerge(registrationLayer, ExtensionEventBus.Live)
  }

  static Test = (): Layer.Layer<ExtensionEventBus> => ExtensionEventBus.Live
}
