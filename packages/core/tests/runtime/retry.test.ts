import { describe, test, expect, it } from "effect-bun-test"
import { dateFromMillis } from "@gent/core-internal/domain/message"
import { Clock, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import {
  isRetryable,
  getRetryAfter,
  DEFAULT_RETRY_CONFIG,
  retryProviderCall,
} from "../../src/runtime/retry"
import { ProviderError } from "@gent/core-internal/domain/provider-error"

describe("getRetryAfter", () => {
  test("parses retry-after seconds from Headers", () => {
    const headers = new Headers({ "retry-after": "5" })
    const error = { cause: { headers } }
    expect(getRetryAfter(error)).toBe(5000)
  })
  it.live("parses retry-after date from Headers", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const future = dateFromMillis(now + 10_000)
      const headers = new Headers({ "retry-after": future.toUTCString() })
      const error = { cause: { headers } }
      const result = getRetryAfter(error, now)
      expect(result).toBeDefined()
      // Should be roughly 10 seconds from now (within tolerance)
      expect(Math.abs(result! - 10000)).toBeLessThan(2000)
    }),
  )
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
  it.effect("retryProviderCall computes HTTP-date retry-after delay from TestClock", () =>
    Effect.gen(function* () {
      // Plant a retry-after HTTP-date 30s past TestClock's current time.
      // The schedule's new Clock.currentTimeMillis read must observe the
      // test clock, otherwise the delay would equal (httpDate - wallNow)
      // and the assertion below would fail by minutes-or-hours.
      const nowMs = yield* Clock.currentTimeMillis
      const future = dateFromMillis(nowMs + 30_000)
      const headers = new Headers({ "retry-after": future.toUTCString() })
      const attempts: Array<number> = []
      let callCount = 0
      const fiber = yield* Effect.forkChild(
        Effect.gen(function* () {
          callCount += 1
          if (callCount < 2) {
            return yield* new ProviderError({
              message: "Rate limit",
              model: "test",
              cause: { headers },
            })
          }
          return "ok"
        }).pipe(
          retryProviderCall(
            { ...DEFAULT_RETRY_CONFIG, initialDelay: 1, maxDelay: 60_000, maxAttempts: 3 },
            {
              onRetry: ({ delayMs }) =>
                Effect.sync(() => {
                  attempts.push(delayMs)
                }),
            },
          ),
        ),
      )
      // Drive the schedule's sleep deterministically.
      yield* TestClock.adjust("31 seconds")
      const exit = yield* Fiber.await(fiber)
      expect(exit._tag).toBe("Success")
      // Tolerance accounts for HTTP-date second-precision truncation.
      expect(attempts.length).toBe(1)
      expect(Math.abs(attempts[0]! - 30_000)).toBeLessThan(2_000)
    }),
  )

  it.live("retryProviderCall reports retry progress", () =>
    Effect.gen(function* () {
      const attempts: Array<{
        attempt: number
        maxAttempts: number
        delayMs: number
        error: string
      }> = []
      let callCount = 0
      const result = yield* Effect.gen(function* () {
        callCount += 1
        if (callCount < 3) {
          return yield* new ProviderError({
            message: "Rate limit exceeded (429)",
            model: "test",
          })
        }
        return "ok"
      }).pipe(
        retryProviderCall(
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
    }),
  )
})
