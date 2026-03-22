import { describe, test, expect } from "bun:test"
import { getRetryAfter, getRetryDelay, DEFAULT_RETRY_CONFIG } from "@gent/core/runtime/retry"

describe("getRetryAfter", () => {
  test("returns undefined for null", () => {
    expect(getRetryAfter(null)).toBeUndefined()
  })

  test("returns undefined for non-object", () => {
    expect(getRetryAfter("string")).toBeUndefined()
  })

  test("returns undefined for object without cause.headers", () => {
    expect(getRetryAfter({ cause: { status: 429 } })).toBeUndefined()
  })

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
