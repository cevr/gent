/**
 * Session-scoped extension event bus for cross-extension coordination.
 *
 * Convention: extensions namespace channels (e.g., "audit:phase:detect", "review:completed").
 * Payloads should be schema-validated at emit/subscribe boundaries by the extension author.
 */

import { ServiceMap, Effect, Layer, Ref } from "effect"

export interface ExtensionEventBusService {
  /** Emit a payload on a namespaced channel */
  readonly emit: (channel: string, payload: unknown) => Effect.Effect<void>
  /** Subscribe a handler to a channel. Returns an unsubscribe effect. */
  readonly on: (
    channel: string,
    handler: (payload: unknown) => Effect.Effect<void>,
  ) => Effect.Effect<void>
  /** Remove a specific handler from a channel */
  readonly off: (
    channel: string,
    handler: (payload: unknown) => Effect.Effect<void>,
  ) => Effect.Effect<void>
}

type HandlerFn = (payload: unknown) => Effect.Effect<void>
type HandlerMap = Map<string, Set<HandlerFn>>

export class ExtensionEventBus extends ServiceMap.Service<
  ExtensionEventBus,
  ExtensionEventBusService
>()("@gent/core/src/runtime/extensions/event-bus/ExtensionEventBus") {
  static Live: Layer.Layer<ExtensionEventBus> = Layer.effect(
    ExtensionEventBus,
    Effect.gen(function* () {
      const handlersRef = yield* Ref.make<HandlerMap>(new Map())

      return {
        emit: Effect.fn("ExtensionEventBus.emit")(function* (channel: string, payload: unknown) {
          const handlers = yield* Ref.get(handlersRef)
          const channelHandlers = handlers.get(channel)
          if (channelHandlers === undefined || channelHandlers.size === 0) return

          yield* Effect.forEach(
            [...channelHandlers],
            (handler) => handler(payload).pipe(Effect.ignoreCause),
            { concurrency: "unbounded" },
          )
        }),

        on: Effect.fn("ExtensionEventBus.on")(function* (channel: string, handler: HandlerFn) {
          yield* Ref.update(handlersRef, (handlers) => {
            const updated = new Map(handlers)
            const existing = updated.get(channel)
            if (existing !== undefined) {
              const newSet = new Set(existing)
              newSet.add(handler)
              updated.set(channel, newSet)
            } else {
              updated.set(channel, new Set([handler]))
            }
            return updated
          })
        }),

        off: Effect.fn("ExtensionEventBus.off")(function* (channel: string, handler: HandlerFn) {
          yield* Ref.update(handlersRef, (handlers) => {
            const updated = new Map(handlers)
            const existing = updated.get(channel)
            if (existing !== undefined) {
              const newSet = new Set(existing)
              newSet.delete(handler)
              if (newSet.size === 0) {
                updated.delete(channel)
              } else {
                updated.set(channel, newSet)
              }
            }
            return updated
          })
        }),
      }
    }),
  )

  static Test = (): Layer.Layer<ExtensionEventBus> => ExtensionEventBus.Live
}
