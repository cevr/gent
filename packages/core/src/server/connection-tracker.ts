/**
 * ConnectionTracker — tracks active WebSocket connections for idle shutdown.
 */

import { Context, Effect, Layer, Ref } from "effect"

export interface ConnectionTrackerService {
  readonly increment: () => Effect.Effect<void>
  readonly decrement: () => Effect.Effect<void>
  readonly count: () => Effect.Effect<number>
}

export class ConnectionTracker extends Context.Service<
  ConnectionTracker,
  ConnectionTrackerService
>()("@gent/core/src/server/connection-tracker/ConnectionTracker") {
  static Live: Layer.Layer<ConnectionTracker> = Layer.effect(
    ConnectionTracker,
    Effect.gen(function* () {
      const ref = yield* Ref.make(0)
      return {
        increment: () => Ref.update(ref, (n) => n + 1),
        decrement: () => Ref.update(ref, (n) => Math.max(0, n - 1)),
        count: () => Ref.get(ref),
      }
    }),
  )

  static Test = (): Layer.Layer<ConnectionTracker> => ConnectionTracker.Live
}
