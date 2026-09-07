import { Cause, Clock, Duration, Effect, Option, Predicate, Random, Schedule, Schema } from "effect"
import { ProviderError } from "../domain/provider-error.js"
import type { ProviderAuthError } from "../domain/driver.js"
import * as AiError from "effect/unstable/ai/AiError"

// Retry Config Schema

export const RetryConfig = Schema.Struct({
  initialDelay: Schema.Int.check(Schema.isGreaterThan(0)).annotate({
    description: "Initial delay in milliseconds",
  }),
  maxDelay: Schema.Int.check(Schema.isGreaterThan(0)).annotate({
    description: "Maximum delay in milliseconds",
  }),
  backoffFactor: Schema.Finite.check(Schema.isGreaterThan(0)).annotate({
    description: "Multiplier for exponential backoff",
  }),
  maxAttempts: Schema.Int.check(Schema.isGreaterThan(0)).annotate({
    description: "Maximum retry attempts",
  }),
})
export type RetryConfig = typeof RetryConfig.Type

// Default config

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  initialDelay: 2000,
  maxDelay: 30000,
  backoffFactor: 2,
  maxAttempts: 3,
}

const retryableMessageSnippets = [
  "rate limit",
  "429",
  "too many requests",
  "overloaded",
  "529",
  "500",
  "502",
  "503",
  "504",
  "internal server error",
  "bad gateway",
  "service unavailable",
  "gateway timeout",
]

const StatusCause = Schema.Struct({ status: Schema.Finite })

const hasRetryableStatus = (cause: unknown) => {
  if (!Schema.is(StatusCause)(cause)) return false
  const status = cause.status
  return status === 429 || status === 529 || (status >= 500 && status < 600)
}

// Check if error is retryable

// oxlint-disable-next-line effect/noUnknownParameters -- Provider failures arrive as unknown values at this retry boundary.
export const isRetryable = (error: unknown): boolean => {
  if (!Schema.is(ProviderError)(error)) return false

  // Check if cause is an AiError — use typed retryability
  if (AiError.isAiError(error.cause)) {
    return error.cause.isRetryable
  }

  // Fallback to string matching for non-AiError causes
  const message = error.message.toLowerCase()
  if (retryableMessageSnippets.some((snippet) => message.includes(snippet))) return true
  return hasRetryableStatus(error.cause)
}

// Extract retry-after from error/headers.

const ErrorCause = Schema.Struct({ cause: Schema.optional(Schema.Unknown) })
const HeadersCause = Schema.Struct({ headers: Schema.instanceOf(Headers) })

// oxlint-disable-next-line effect/noUnknownParameters -- Provider failures arrive as unknown values at this retry boundary.
const getRetryAfterOption = (error: unknown, nowMs: number): Option.Option<number> => {
  const decodedError = Schema.decodeUnknownOption(ErrorCause)(error)
  if (Option.isNone(decodedError)) return Option.none()

  return Option.match(Option.fromUndefinedOr(decodedError.value.cause), {
    onNone: () => Option.none(),
    onSome: (errorCause) => {
      if (AiError.isAiError(errorCause)) {
        if (!Predicate.isUndefined(errorCause.retryAfter)) {
          return Option.some(Duration.toMillis(errorCause.retryAfter))
        }
        return Option.none()
      }

      if (!Schema.is(HeadersCause)(errorCause)) return Option.none()
      const retryAfter = errorCause.headers.get("retry-after")
      if (Predicate.isNull(retryAfter) || retryAfter === "") return Option.none()
      // Could be seconds or HTTP date.
      const seconds = parseInt(retryAfter, 10)
      if (!Number.isNaN(seconds)) return Option.some(seconds * 1000)
      // Try parsing as date.
      const dateMs = Date.parse(retryAfter)
      if (!Number.isNaN(dateMs)) return Option.some(Math.max(0, dateMs - nowMs))
      return Option.none()
    },
  })
}

// oxlint-disable-next-line effect/noNullish, effect/noUnknownParameters -- This public helper preserves the established absent retry-after API and accepts provider failures at the retry boundary.
export const getRetryAfter = (error: unknown, nowMs = 0): number | undefined =>
  Option.getOrUndefined(getRetryAfterOption(error, nowMs))

// Calculate delay for attempt — private. `retryProviderCall` is the only consumer;
// unit coverage flows through `retryProviderCall({ onRetry })` reporting the
// computed delay (see retry-progress test).

/** Upper bound of the random spread added to a backoff delay, as a fraction of it. */
export const RETRY_JITTER_FRACTION = 0.25

export const getRetryDelay = (
  attempt: number,
  error: ProviderError,
  nowMs: number,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  /** Uniform sample in [0, 1). Spreads concurrent retries; never exceeds `maxDelay`. */
  jitter = 0,
): number => {
  // Check retry-after header first
  const retryAfter = getRetryAfterOption(error, nowMs)
  if (Option.isSome(retryAfter)) {
    return Math.min(retryAfter.value, config["maxDelay"])
  }

  // Exponential backoff with bounded jitter
  const base = config["initialDelay"] * Math.pow(config["backoffFactor"], attempt)
  const delay = Math.round(base * (1 + RETRY_JITTER_FRACTION * jitter))
  return Math.min(delay, config["maxDelay"])
}

export interface RetryAttemptInfo {
  readonly attempt: number
  readonly maxAttempts: number
  readonly delayMs: number
  readonly error: ProviderError
}

// Retry wrapper for provider calls.
//
// Accepts `ProviderError | ProviderAuthError` because driver credential
// failures surface as `ProviderAuthError` — those are not transient and
// must escape without retry. The schedule re-inspects the tag and only
// retries transient `ProviderError` values.

type ProviderOrAuthError = ProviderError | ProviderAuthError

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
    // meta.attempt is 1-indexed: 1 after first failure, 2 after second, etc.
    // Allow retries while attempt < maxAttempts (i.e. maxAttempts-1 retries total)
    const schedule = Schedule.fromStepWithMetadata<
      ProviderOrAuthError,
      number,
      R2,
      never,
      never,
      never
    >(
      Effect.succeed((meta: Schedule.InputMetadata<ProviderOrAuthError>) => {
        if (meta.attempt >= config.maxAttempts) {
          return Cause.done(meta.attempt)
        }
        if (!Schema.is(ProviderError)(meta.input)) {
          return Cause.done(meta.attempt)
        }
        const error = meta.input
        return Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis
          const jitter = yield* Random.next
          const delayMs = getRetryDelay(meta.attempt - 1, error, nowMs, config, jitter)
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

    return Effect.retry(effect, {
      schedule,
      while: (error) => isRetryable(error),
    }).pipe(Effect.withSpan("provider.retry"))
  }
