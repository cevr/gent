import { Cause, Duration, Effect, Option, Predicate, Random, Schedule, Schema } from "effect"
import * as AiError from "effect/unstable/ai/AiError"
import { DEFAULT_RETRY_POLICY, type ProviderAuthError, type RetryPolicy } from "../domain/driver.js"
import { ProviderError } from "../domain/errors.js"
import type { DriverRegistryService } from "./extensions/driver-registry.js"

/**
 * The policy of the driver a turn will call, by its effective driver id
 * (`effectiveModelDriver` in `domain/agent.ts`). A driver without a policy,
 * or no driver at all, retries under `DEFAULT_RETRY_POLICY`.
 */
export const driverRetryPolicy = Effect.fn("Retry.driverRetryPolicy")(function* (
  driverRegistry: DriverRegistryService,
  driverId: Option.Option<string>,
) {
  if (Option.isNone(driverId)) return DEFAULT_RETRY_POLICY
  const driver = yield* driverRegistry.getModel(driverId.value)
  if (Predicate.isUndefined(driver) || Predicate.isUndefined(driver.retry)) {
    return DEFAULT_RETRY_POLICY
  }
  return driver.retry
})

type ProviderOrAuthError = ProviderError | ProviderAuthError

/**
 * Only a transient `ProviderError` is retried; a credential failure escapes.
 * A request the provider accepted can still end with an error event inside
 * the stream; the driver's policy names the wire shapes that count.
 */
const isRetryable =
  (policy: RetryPolicy) =>
  (error: ProviderOrAuthError): error is ProviderError => {
    if (!Schema.is(ProviderError)(error)) return false
    if (AiError.isAiError(error.cause)) return error.cause.isRetryable
    return Schema.is(policy.transientStreamEvent)(error.cause)
  }

const retryAfterMs = (error: ProviderError): Option.Option<number> => {
  if (!AiError.isAiError(error.cause)) return Option.none()
  return Option.map(Option.fromUndefinedOr(error.cause.retryAfter), Duration.toMillis)
}

/** Upper bound of the random spread added to a backoff delay, as a fraction of it. */
const JITTER_FRACTION = 0.25

/** `attempt` counts completed failures; `jitter` is a uniform sample in [0, 1). */
const retryDelay = (
  attempt: number,
  error: ProviderError,
  config: RetryPolicy,
  jitter: number,
): number =>
  Option.match(retryAfterMs(error), {
    onSome: (ms) => Math.min(ms, config.maxDelay),
    onNone: () => {
      const base = config.initialDelay * config.backoffFactor ** attempt
      return Math.min(Math.round(base * (1 + JITTER_FRACTION * jitter)), config.maxDelay)
    },
  })

interface RetryAttemptInfo {
  readonly attempt: number
  readonly maxAttempts: number
  readonly delayMs: number
  readonly error: ProviderError
}

/**
 * Retry a provider call on transient failure under the driver's policy. The
 * provider's own retry-after wins over the backoff; both are capped at
 * `maxDelay`. `onRetry` runs before each wait with the delay the schedule
 * will take.
 */
export const retryProviderCall =
  <R2 = never>(
    config: RetryPolicy,
    options?: {
      readonly onRetry?: (info: RetryAttemptInfo) => Effect.Effect<void, never, R2>
    },
  ): (<A, R>(
    effect: Effect.Effect<A, ProviderOrAuthError, R>,
  ) => Effect.Effect<A, ProviderOrAuthError, R | R2>) =>
  <A, R>(effect: Effect.Effect<A, ProviderOrAuthError, R>) => {
    const retryable = isRetryable(config)
    // meta.attempt is 1-indexed: 1 after the first failure, 2 after the second.
    const schedule = Schedule.fromStepWithMetadata<
      ProviderOrAuthError,
      number,
      R2,
      never,
      never,
      never
    >(
      Effect.succeed((meta: Schedule.InputMetadata<ProviderOrAuthError>) => {
        if (meta.attempt >= config.maxAttempts || !retryable(meta.input)) {
          return Cause.done(meta.attempt)
        }
        const error = meta.input
        return Effect.gen(function* () {
          const jitter = yield* Random.next
          const delayMs = retryDelay(meta.attempt - 1, error, config, jitter)
          if (!Predicate.isUndefined(options?.onRetry)) {
            yield* options.onRetry({
              attempt: meta.attempt,
              maxAttempts: config.maxAttempts,
              delayMs,
              error,
            })
          }
          return [meta.attempt, Duration.millis(delayMs)] satisfies [number, Duration.Duration]
        })
      }),
    )

    return Effect.retry(effect, { schedule, while: retryable }).pipe(
      Effect.withSpan("provider.retry"),
    )
  }
