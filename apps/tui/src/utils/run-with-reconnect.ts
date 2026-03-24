import { Effect } from "effect"

export interface ReconnectOptions<E> {
  readonly onError?: (error: E) => void
  readonly waitForRetry: () => Effect.Effect<void>
}

export const runWithReconnect = <E, R>(
  effectFactory: () => Effect.Effect<void, E, R>,
  options: ReconnectOptions<E>,
): Effect.Effect<never, never, R> =>
  Effect.forever(
    Effect.gen(function* () {
      yield* effectFactory().pipe(
        Effect.catchEager((error) => Effect.sync(() => options.onError?.(error))),
      )
      yield* options.waitForRetry()
    }),
  )
