import { Cause, Duration, Effect, Option, Predicate, Random, Schedule, Schema } from "effect"
import * as AiError from "effect/unstable/ai/AiError"
import type { ProviderAuthError } from "../domain/driver.js"
import { ProviderError } from "../domain/provider-error.js"

interface RetryConfig {
  /** Delay before the first retry, in milliseconds. */
  readonly initialDelay: number
  /** Upper bound of any delay, in milliseconds. */
  readonly maxDelay: number
  /** Multiplier applied to the delay after each attempt. */
  readonly backoffFactor: number
  /** Attempts in total, the first call included. */
  readonly maxAttempts: number
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  initialDelay: 2000,
  maxDelay: 30000,
  backoffFactor: 2,
  maxAttempts: 3,
}

/**
 * A request the provider accepted can still end with an error event inside
 * the stream. The provider libraries pass that event through as a raw part,
 * so its wire identifier is the only signal: Anthropic names the error type,
 * OpenAI names a code.
 */
const TransientStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["overloaded_error", "api_error", "rate_limit_error"]),
  }),
  Schema.Struct({ code: Schema.Literals(["server_error", "rate_limit_exceeded"]) }),
])

type ProviderOrAuthError = ProviderError | ProviderAuthError

/** Only a transient `ProviderError` is retried; a credential failure escapes. */
const isRetryable = (error: ProviderOrAuthError): error is ProviderError => {
  if (!Schema.is(ProviderError)(error)) return false
  if (AiError.isAiError(error.cause)) return error.cause.isRetryable
  return Schema.is(TransientStreamEvent)(error.cause)
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
  config: RetryConfig,
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
 * Retry a provider call on transient failure. The provider's own retry-after
 * wins over the backoff; both are capped at `maxDelay`. `onRetry` runs before
 * each wait with the delay the schedule will take.
 */
export const retryProviderCall =
  <R2 = never>(
    config: RetryConfig = DEFAULT_RETRY_CONFIG,
    options?: {
      readonly onRetry?: (info: RetryAttemptInfo) => Effect.Effect<void, never, R2>
    },
  ): (<A, R>(
    effect: Effect.Effect<A, ProviderOrAuthError, R>,
  ) => Effect.Effect<A, ProviderOrAuthError, R | R2>) =>
  <A, R>(effect: Effect.Effect<A, ProviderOrAuthError, R>) => {
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
        if (meta.attempt >= config.maxAttempts || !isRetryable(meta.input)) {
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

    return Effect.retry(effect, { schedule, while: isRetryable }).pipe(
      Effect.withSpan("provider.retry"),
    )
  }
