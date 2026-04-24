import { Cause, Effect, Schedule, Duration, Schema } from "effect"
import { ProviderError } from "../providers/provider.js"
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
  backoffFactor: Schema.Number.check(Schema.isGreaterThan(0)).annotate({
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

const hasRetryableStatus = (cause: unknown) => {
  if (cause === null || typeof cause !== "object" || !("status" in cause)) return false
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- runtime internal owns erased generic boundary
  const status = (cause as { status: number }).status
  return status === 429 || status === 529 || (status >= 500 && status < 600)
}

// Check if error is retryable

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

// Extract retry-after from error/headers

export const getRetryAfter = (error: unknown): number | undefined => {
  if (error === null || typeof error !== "object") return undefined

  // Check if cause is an AiError with retryAfter
  const errorCause = (error as { cause?: unknown }).cause
  if (AiError.isAiError(errorCause) && errorCause.retryAfter !== undefined) {
    return Duration.toMillis(errorCause.retryAfter)
  }

  // Fallback: check cause for headers
  const cause = errorCause
  if (cause !== null && typeof cause === "object" && "headers" in cause) {
    const headers = (cause as { headers: unknown }).headers
    if (headers instanceof Headers) {
      const retryAfter = headers.get("retry-after")
      if (retryAfter !== null && retryAfter !== "") {
        // Could be seconds or HTTP date
        const seconds = parseInt(retryAfter, 10)
        if (!isNaN(seconds)) return seconds * 1000
        // Try parsing as date
        const date = new Date(retryAfter)
        if (!isNaN(date.getTime())) {
          return Math.max(0, date.getTime() - Date.now())
        }
      }
    }
  }

  return undefined
}

// Calculate delay for attempt — private. `withRetry` is the only consumer;
// unit coverage flows through `withRetry({ onRetry })` reporting the
// computed delay (see retry-progress test).

const getRetryDelay = (
  attempt: number,
  error: unknown,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
): number => {
  // Check retry-after header first
  const retryAfter = getRetryAfter(error)
  if (retryAfter !== undefined) {
    return Math.min(retryAfter, config["maxDelay"])
  }

  // Exponential backoff
  const delay = config["initialDelay"] * Math.pow(config["backoffFactor"], attempt)
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

export const withRetry = <A, R, R2 = never>(
  effect: Effect.Effect<A, ProviderOrAuthError, R>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  options?: {
    readonly onRetry?: (info: RetryAttemptInfo) => Effect.Effect<void, never, R2>
  },
): Effect.Effect<A, ProviderOrAuthError, R | R2> => {
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
      const delayMs = getRetryDelay(meta.attempt - 1, meta.input, config)
      const notify =
        options?.onRetry !== undefined
          ? options.onRetry({
              attempt: meta.attempt,
              maxAttempts: config.maxAttempts,
              delayMs,
              error: meta.input,
            })
          : Effect.void
      return notify.pipe(
        Effect.as<[number, Duration.Duration]>([meta.attempt, Duration.millis(delayMs)]),
      )
    }),
  )

  return Effect.retry(effect, {
    schedule,
    while: (error) => isRetryable(error),
  }).pipe(Effect.withSpan("withRetry"))
}
