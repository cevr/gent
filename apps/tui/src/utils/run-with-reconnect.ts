import { Effect, Schedule } from "effect"
import { clientLog } from "./client-logger"

export interface ReconnectOptions<E> {
  readonly label?: string
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
): Effect.Effect<never, never, R> => {
  let attempt = 0
  const label = options.label ?? "unknown"
  return Effect.gen(function* () {
    attempt++
    clientLog.info("reconnect.attempt", { label, attempt })
    yield* effectFactory().pipe(
      Effect.catchEager((error) =>
        Effect.sync(() => {
          clientLog.warn("reconnect.error", { label, attempt, error: String(error) })
          options.onError?.(error)
        }),
      ),
    )
    clientLog.info("reconnect.stream-ended", { label, attempt })
    clientLog.info("reconnect.wait-for-ready", { label, attempt })
    yield* options.waitForRetry()
    clientLog.info("reconnect.ready", { label, attempt })
  }).pipe(Effect.repeat(backoff)) as Effect.Effect<never, never, R>
}
