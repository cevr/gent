/**
 * AnthropicBetaCache — cross-request beta-rejection learning.
 *
 * Outcome-based tests: assert what the next `getExcluded` returns
 * after a sequence of records / env changes / model switches. No
 * internal call counters. The cache is pure logic over `Ref<CacheCell>`
 * so a real Effect runtime + the service's own layer is the simplest
 * harness.
 */
import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { AnthropicBetaCache } from "@gent/extensions/anthropic/beta-cache"

const run = <A, E>(eff: Effect.Effect<A, E, AnthropicBetaCache>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(eff.pipe(Effect.provide(AnthropicBetaCache.layer))) as Effect.Effect<A, E, never>,
  )

describe("AnthropicBetaCache — basic record / get", () => {
  test("get on empty cache returns empty set", async () => {
    await run(
      Effect.gen(function* () {
        const cache = yield* AnthropicBetaCache
        const excluded = yield* cache.getExcluded("claude-opus-4-6", "flag-a")
        expect(excluded.size).toBe(0)
      }),
    )
  })

  test("recorded beta appears in next getExcluded for same model", async () => {
    await run(
      Effect.gen(function* () {
        const cache = yield* AnthropicBetaCache
        yield* cache.getExcluded("claude-opus-4-6", "flag-a")
        yield* cache.recordExcluded("claude-opus-4-6", "context-1m-2025-08-07", "flag-a")
        const excluded = yield* cache.getExcluded("claude-opus-4-6", "flag-a")
        expect(excluded.has("context-1m-2025-08-07")).toBe(true)
        expect(excluded.size).toBe(1)
      }),
    )
  })

  test("multiple records accumulate in the same model's set", async () => {
    await run(
      Effect.gen(function* () {
        const cache = yield* AnthropicBetaCache
        yield* cache.getExcluded("claude-opus-4-6", "flag-a")
        yield* cache.recordExcluded("claude-opus-4-6", "beta-x", "flag-a")
        yield* cache.recordExcluded("claude-opus-4-6", "beta-y", "flag-a")
        const excluded = yield* cache.getExcluded("claude-opus-4-6", "flag-a")
        expect(excluded.has("beta-x")).toBe(true)
        expect(excluded.has("beta-y")).toBe(true)
        expect(excluded.size).toBe(2)
      }),
    )
  })

  test("recordExcluded is standalone-safe — no prior getExcluded required", async () => {
    // Counsel-driven contract: recordExcluded carries currentBetaFlags
    // and applies the same env/model-change clear/seed as getExcluded.
    // Calling record before any get must NOT lose data on the next read.
    await run(
      Effect.gen(function* () {
        const cache = yield* AnthropicBetaCache
        yield* cache.recordExcluded("claude-opus-4-6", "beta-x", "flag-a")
        const excluded = yield* cache.getExcluded("claude-opus-4-6", "flag-a")
        expect(excluded.has("beta-x")).toBe(true)
        expect(excluded.size).toBe(1)
      }),
    )
  })
})

describe("AnthropicBetaCache — clear-on-env-change", () => {
  test("changing betaFlags env clears all learned exclusions", async () => {
    await run(
      Effect.gen(function* () {
        const cache = yield* AnthropicBetaCache
        yield* cache.getExcluded("claude-opus-4-6", "flag-a")
        yield* cache.recordExcluded("claude-opus-4-6", "beta-x", "flag-a")

        // Env changes: prior learning should be discarded.
        const after = yield* cache.getExcluded("claude-opus-4-6", "flag-b")
        expect(after.size).toBe(0)

        // And subsequent same-env requests start fresh.
        const stillEmpty = yield* cache.getExcluded("claude-opus-4-6", "flag-b")
        expect(stillEmpty.size).toBe(0)
      }),
    )
  })

  test("env change from undefined → defined also clears", async () => {
    // Learn under env=undefined, then switch to env="flag-a" — prior
    // learning must be discarded.
    await run(
      Effect.gen(function* () {
        const cache = yield* AnthropicBetaCache
        yield* cache.recordExcluded("claude-opus-4-6", "beta-x", undefined)
        const after = yield* cache.getExcluded("claude-opus-4-6", "flag-a")
        expect(after.size).toBe(0)
      }),
    )
  })
})

describe("AnthropicBetaCache — clear-on-model-change", () => {
  test("switching model clears prior model's learning", async () => {
    await run(
      Effect.gen(function* () {
        const cache = yield* AnthropicBetaCache
        yield* cache.getExcluded("claude-opus-4-6", "flag-a")
        yield* cache.recordExcluded("claude-opus-4-6", "beta-x", "flag-a")

        // Different model under same env → cache cleared.
        const haiku = yield* cache.getExcluded("claude-haiku-4-5", "flag-a")
        expect(haiku.size).toBe(0)

        // Switching back doesn't restore the prior learning either —
        // matches legacy "clear-on-modelId-change" semantics.
        const opus = yield* cache.getExcluded("claude-opus-4-6", "flag-a")
        expect(opus.size).toBe(0)
      }),
    )
  })
})

describe("AnthropicBetaCache — same-model same-env stability", () => {
  test("repeated getExcluded with unchanged inputs is stable across many calls", async () => {
    await run(
      Effect.gen(function* () {
        const cache = yield* AnthropicBetaCache
        yield* cache.recordExcluded("claude-opus-4-6", "beta-x", "flag-a")
        for (let i = 0; i < 5; i++) {
          const excluded = yield* cache.getExcluded("claude-opus-4-6", "flag-a")
          expect(excluded.has("beta-x")).toBe(true)
        }
      }),
    )
  })
})
