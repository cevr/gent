import { Effect, Schedule, Duration, Schema } from "effect"
import { ProviderError } from "@gent/providers"

// Retry Config Schema

export const RetryConfig = Schema.Struct({
  initialDelay: Schema.Number.pipe(Schema.int(), Schema.positive()).annotations({
    description: "Initial delay in milliseconds",
  }),
  maxDelay: Schema.Number.pipe(Schema.int(), Schema.positive()).annotations({
    description: "Maximum delay in milliseconds",
  }),
  backoffFactor: Schema.Number.pipe(Schema.positive()).annotations({
    description: "Multiplier for exponential backoff",
  }),
  maxAttempts: Schema.Number.pipe(Schema.int(), Schema.positive()).annotations({
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

// Check if error is retryable

export const isRetryable = (error: unknown): boolean => {
  if (!(error instanceof ProviderError)) return false

  const message = error.message.toLowerCase()
  const cause = error.cause

  // Rate limits
  if (message.includes("rate limit") || message.includes("429")) return true
  if (message.includes("too many requests")) return true

  // Overloaded
  if (message.includes("overloaded") || message.includes("529")) return true

  // Server errors (5xx)
  if (message.includes("500") || message.includes("502") || message.includes("503") || message.includes("504")) return true
  if (message.includes("internal server error")) return true
  if (message.includes("bad gateway")) return true
  if (message.includes("service unavailable")) return true
  if (message.includes("gateway timeout")) return true

  // Check cause for status codes
  if (cause && typeof cause === "object" && "status" in cause) {
    const status = (cause as { status: number }).status
    if (status === 429 || status === 529 || (status >= 500 && status < 600)) {
      return true
    }
  }

  return false
}

// Extract retry-after from error/headers

export const getRetryAfter = (error: unknown): number | undefined => {
  if (!error || typeof error !== "object") return undefined

  // Check cause for headers
  const cause = (error as { cause?: unknown }).cause
  if (cause && typeof cause === "object" && "headers" in cause) {
    const headers = (cause as { headers: unknown }).headers
    if (headers instanceof Headers) {
      const retryAfter = headers.get("retry-after")
      if (retryAfter) {
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

// Calculate delay for attempt

export const getRetryDelay = (
  attempt: number,
  error: unknown,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): number => {
  // Check retry-after header first
  const retryAfter = getRetryAfter(error)
  if (retryAfter !== undefined) {
    return Math.min(retryAfter, config.maxDelay)
  }

  // Exponential backoff
  const delay = config.initialDelay * Math.pow(config.backoffFactor, attempt)
  return Math.min(delay, config.maxDelay)
}

// Create retry schedule for Effect

export const makeRetrySchedule = (
  config: RetryConfig = DEFAULT_RETRY_CONFIG
) =>
  Schedule.exponential(Duration.millis(config.initialDelay), config.backoffFactor).pipe(
    Schedule.whileInput<ProviderError>(isRetryable),
    Schedule.intersect(Schedule.recurs(config.maxAttempts - 1))
  )

// Retry wrapper for provider calls

export const withRetry = <A, R>(
  effect: Effect.Effect<A, ProviderError, R>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): Effect.Effect<A, ProviderError, R> =>
  effect.pipe(
    Effect.retry(makeRetrySchedule(config)),
    Effect.withSpan("withRetry")
  )
