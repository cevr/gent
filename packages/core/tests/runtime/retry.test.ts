import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import {
  isRetryable,
  getRetryAfter,
  getRetryDelay,
  DEFAULT_RETRY_CONFIG,
  withRetry,
} from "@gent/core/runtime/retry"
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

describe("getRetryDelay", () => {
  test("exponential backoff on attempt 0", () => {
    const delay = getRetryDelay(0, {})
    expect(delay).toBe(DEFAULT_RETRY_CONFIG.initialDelay) // 2000
  })

  test("exponential backoff on attempt 1", () => {
    const delay = getRetryDelay(1, {})
    expect(delay).toBe(
      DEFAULT_RETRY_CONFIG.initialDelay * DEFAULT_RETRY_CONFIG.backoffFactor, // 4000
    )
  })

  test("caps at maxDelay", () => {
    const delay = getRetryDelay(100, {})
    expect(delay).toBe(DEFAULT_RETRY_CONFIG.maxDelay) // 30000
  })

  test("uses retry-after header when available", () => {
    const headers = new Headers({ "retry-after": "3" })
    const error = { cause: { headers } }
    const delay = getRetryDelay(0, error)
    expect(delay).toBe(3000)
  })

  test("caps retry-after at maxDelay", () => {
    const headers = new Headers({ "retry-after": "999" })
    const error = { cause: { headers } }
    const delay = getRetryDelay(0, error)
    expect(delay).toBe(DEFAULT_RETRY_CONFIG.maxDelay)
  })

  test("respects custom config", () => {
    const config = { initialDelay: 100, maxDelay: 500, backoffFactor: 3, maxAttempts: 5 }
    expect(getRetryDelay(0, {}, config)).toBe(100)
    expect(getRetryDelay(1, {}, config)).toBe(300)
    expect(getRetryDelay(2, {}, config)).toBe(500) // capped
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
