import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import {
  isRetryable,
  getRetryAfter,
  DEFAULT_RETRY_CONFIG,
  withRetry,
} from "../../src/runtime/retry"
import { ProviderError } from "@gent/core/providers/provider"

describe("getRetryAfter", () => {
  test("parses retry-after seconds from Headers", () => {
    const headers = new Headers({ "retry-after": "5" })
    const error = { cause: { headers } }
    expect(getRetryAfter(error)).toBe(5000)
  })

  test("parses retry-after date from Headers", () => {
    const future = new Date(Date.now() + 10000)
    const headers = new Headers({ "retry-after": future.toUTCString() })
    const error = { cause: { headers } }
    const result = getRetryAfter(error)
    expect(result).toBeDefined()
    // Should be roughly 10 seconds from now (within tolerance)
    expect(Math.abs(result! - 10000)).toBeLessThan(2000)
  })

  test("returns undefined for empty retry-after header", () => {
    const headers = new Headers()
    const error = { cause: { headers } }
    expect(getRetryAfter(error)).toBeUndefined()
  })
})

describe("Retry Logic", () => {
  test("isRetryable detects rate limits", () => {
    const rateLimitError = new ProviderError({
      message: "Rate limit exceeded (429)",
      model: "test",
    })
    expect(isRetryable(rateLimitError)).toBe(true)
  })

  test("isRetryable detects overload", () => {
    const overloadError = new ProviderError({
      message: "Service overloaded",
      model: "test",
    })
    expect(isRetryable(overloadError)).toBe(true)
  })

  test("isRetryable detects 500 errors", () => {
    const serverError = new ProviderError({
      message: "Internal server error 500",
      model: "test",
    })
    expect(isRetryable(serverError)).toBe(true)
  })

  test("isRetryable returns false for non-retryable errors", () => {
    const authError = new ProviderError({
      message: "Invalid API key",
      model: "test",
    })
    expect(isRetryable(authError)).toBe(false)
  })

  test("withRetry reports retry progress", async () => {
    const attempts: Array<{
      attempt: number
      maxAttempts: number
      delayMs: number
      error: string
    }> = []
    let callCount = 0

    const result = await Effect.runPromise(
      withRetry(
        Effect.gen(function* () {
          callCount += 1
          if (callCount < 3) {
            return yield* new ProviderError({
              message: "Rate limit exceeded (429)",
              model: "test",
            })
          }
          return "ok"
        }),
        { ...DEFAULT_RETRY_CONFIG, initialDelay: 1, maxDelay: 1, maxAttempts: 3 },
        {
          onRetry: ({ attempt, maxAttempts, delayMs, error }) =>
            Effect.sync(() => {
              attempts.push({ attempt, maxAttempts, delayMs, error: error.message })
            }),
        },
      ),
    )

    expect(result).toBe("ok")
    expect(attempts).toEqual([
      {
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1,
        error: "Rate limit exceeded (429)",
      },
      {
        attempt: 2,
        maxAttempts: 3,
        delayMs: 1,
        error: "Rate limit exceeded (429)",
      },
    ])
  })
})
