import { Effect, Schedule } from "effect"

export interface ReconnectOptions<E> {
  readonly onError?: (error: E) => void
  readonly waitForRetry: () => Effect.Effect<void>
}

/** Exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s (cap) */
const backoff = Schedule.exponential("1 second", 2).pipe(
  Schedule.either(Schedule.spaced("30 seconds")),
)

export const runWithReconnect = <E, R>(
  effectFactory: () => Effect.Effect<void, E, R>,
  options: ReconnectOptions<E>,
): Effect.Effect<never, never, R> =>
  Effect.gen(function* () {
    yield* effectFactory().pipe(
      Effect.catchEager((error) => Effect.sync(() => options.onError?.(error))),
    )
    yield* options.waitForRetry()
  }).pipe(Effect.repeat(backoff)) as Effect.Effect<never, never, R>
