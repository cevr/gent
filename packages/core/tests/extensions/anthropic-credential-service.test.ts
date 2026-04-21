/**
 * AnthropicCredentialService — Effect-native credential cache.
 *
 * The service caches credentials in a `Ref` with TTL 30s + a 60s
 * freshness margin (refresh before the wire-side auth gate rejects).
 * This test drives the IO seam (`AnthropicCredentialIO`) deterministically
 * via `TestClock` so we can assert cache semantics without spawning
 * `security` or hitting the keychain.
 */
import { describe, test, expect } from "bun:test"
import { Cause, Effect, Layer, Option, Ref } from "effect"
import { TestClock } from "effect/testing"
import {
  AnthropicCredentialService,
  type AnthropicCredentialIO,
} from "@gent/extensions/anthropic/credential-service"
import { ProviderAuthError, type ProviderAuthInfo } from "@gent/core/extensions/api"
import type { ClaudeCredentials } from "@gent/extensions/anthropic/oauth"

// ── Helpers ──

const makeCreds = (label: string, expiresAt: number): ClaudeCredentials => ({
  accessToken: `${label}-access`,
  refreshToken: `${label}-refresh`,
  expiresAt,
})

interface IOState {
  readResult: () => Effect.Effect<ClaudeCredentials, ProviderAuthError>
  refreshResult: () => Effect.Effect<ClaudeCredentials, ProviderAuthError>
}

const makeIO = (state: IOState): AnthropicCredentialIO => ({
  read: Effect.suspend(() => state.readResult()),
  refresh: Effect.suspend(() => state.refreshResult()),
})

interface PersistState {
  lastWritten: { access: string; refresh: string; expires: number } | undefined
  failNext: boolean
}

const makeAuthInfo = (state: PersistState): ProviderAuthInfo => ({
  type: "oauth",
  persist: (updated) =>
    Effect.suspend(() => {
      if (state.failNext) {
        state.failNext = false
        return Effect.die(new Error("simulated persist failure"))
      }
      state.lastWritten = updated
      return Effect.void
    }),
})

// TestClock starts at time 0, so all expiresAt values are absolute
// (relative to t=0), not `Date.now() + offset`.
const FAR_FUTURE = 10 * 60 * 1000 // expiresAt = 10 minutes from t=0

// `TestClock.adjust` requires a `Scope` (it manages internal sleeper
// fibers). Wrap with `Effect.scoped` so tests don't have to thread
// scope manually.
const runWithTestClock = <A, E>(eff: Effect.Effect<A, E, AnthropicCredentialService>) =>
  Effect.runPromise(
    Effect.scoped(eff).pipe(Effect.provide(TestClock.layer())) as Effect.Effect<A, E, never>,
  )

// ── Tests ──

describe("AnthropicCredentialService — cache hit/miss", () => {
  test("returns cached creds within TTL even when source changes", async () => {
    // Outcome assertion: if the source switches underneath, a cached
    // call must STILL return the original creds — that proves the
    // cache was consulted, no internal call counter needed.
    const creds1 = makeCreds("k1", FAR_FUTURE)
    const creds2 = makeCreds("k2", FAR_FUTURE)
    const callsRef: { current: ClaudeCredentials } = { current: creds1 }
    const state: IOState = {
      readResult: () => Effect.succeed(callsRef.current),
      refreshResult: () => Effect.fail(new ProviderAuthError({ message: "should not be called" })),
    }
    const layer = AnthropicCredentialService.layerFromIO(makeIO(state))

    await runWithTestClock(
      Effect.gen(function* () {
        const svc = yield* AnthropicCredentialService
        const first = yield* svc.getFresh
        callsRef.current = creds2 // source switches; cache should ignore
        const second = yield* svc.getFresh
        expect(first.accessToken).toBe("k1-access")
        expect(second.accessToken).toBe("k1-access")
      }).pipe(Effect.provide(layer)),
    )
  })

  test("re-reads source after TTL expires", async () => {
    const creds1 = makeCreds("k1", FAR_FUTURE)
    const creds2 = makeCreds("k2", FAR_FUTURE)
    const callsRef: { current: ClaudeCredentials } = { current: creds1 }
    const state: IOState = {
      readResult: () => Effect.succeed(callsRef.current),
      refreshResult: () => Effect.fail(new ProviderAuthError({ message: "should not be called" })),
    }
    const layer = AnthropicCredentialService.layerFromIO(makeIO(state))

    await runWithTestClock(
      Effect.gen(function* () {
        const svc = yield* AnthropicCredentialService
        const first = yield* svc.getFresh
        callsRef.current = creds2
        yield* TestClock.adjust("31 seconds")
        const second = yield* svc.getFresh
        expect(first.accessToken).toBe("k1-access")
        expect(second.accessToken).toBe("k2-access")
      }).pipe(Effect.provide(layer)),
    )
  })
})

describe("AnthropicCredentialService — refresh on stale", () => {
  test("expiring-soon creds trigger refresh; refreshed creds returned + persisted", async () => {
    // Outcome assertions: returned creds are the refreshed ones (not
    // the stale ones), and persist saw the new credential. Both are
    // observable via the public surface (return value + persist
    // recording its argument) — no internal call counter needed.
    const stale = makeCreds("stale", 30_000) // 30s — inside the 60s freshness margin
    const fresh = makeCreds("fresh", FAR_FUTURE)
    const state: IOState = {
      readResult: () => Effect.succeed(stale),
      refreshResult: () => Effect.succeed(fresh),
    }
    const persistState: PersistState = { lastWritten: undefined, failNext: false }
    const layer = AnthropicCredentialService.layerFromIO(makeIO(state), makeAuthInfo(persistState))

    await runWithTestClock(
      Effect.gen(function* () {
        const svc = yield* AnthropicCredentialService
        const result = yield* svc.getFresh
        expect(result.accessToken).toBe("fresh-access")
        expect(persistState.lastWritten?.access).toBe("fresh-access")
      }).pipe(Effect.provide(layer)),
    )
  })

  test("refresh failure surfaces ProviderAuthError to caller", async () => {
    const stale = makeCreds("stale", 30_000)
    const state: IOState = {
      readResult: () => Effect.succeed(stale),
      refreshResult: () =>
        Effect.fail(new ProviderAuthError({ message: "OAuth 401 from refresh" })),
    }
    const layer = AnthropicCredentialService.layerFromIO(makeIO(state))

    const result = await runWithTestClock(
      Effect.gen(function* () {
        const svc = yield* AnthropicCredentialService
        return yield* Effect.exit(svc.getFresh)
      }).pipe(Effect.provide(layer)),
    )

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      const errOpt = Cause.findErrorOption(result.cause)
      expect(Option.isSome(errOpt)).toBe(true)
      if (Option.isSome(errOpt)) {
        expect(errOpt.value.message).toContain("unavailable or expired")
      }
    }
  })
})

describe("AnthropicCredentialService — invalidate", () => {
  test("invalidate forces next getFresh to re-read", async () => {
    const creds1 = makeCreds("k1", FAR_FUTURE)
    const creds2 = makeCreds("k2", FAR_FUTURE)
    const callsRef: { current: ClaudeCredentials } = { current: creds1 }
    const state: IOState = {
      readResult: () => Effect.succeed(callsRef.current),
      refreshResult: () => Effect.fail(new ProviderAuthError({ message: "should not be called" })),
    }
    const layer = AnthropicCredentialService.layerFromIO(makeIO(state))

    await runWithTestClock(
      Effect.gen(function* () {
        const svc = yield* AnthropicCredentialService
        const before = yield* svc.getFresh
        callsRef.current = creds2
        yield* svc.invalidate
        const after = yield* svc.getFresh
        expect(before.accessToken).toBe("k1-access")
        expect(after.accessToken).toBe("k2-access")
      }).pipe(Effect.provide(layer)),
    )
  })
})

describe("AnthropicCredentialService — persist failure does not regress getFresh", () => {
  test("write-back failure logs warning but returns fresh creds", async () => {
    const stale = makeCreds("stale", 30_000)
    const fresh = makeCreds("fresh", FAR_FUTURE)
    const state: IOState = {
      readResult: () => Effect.succeed(stale),
      refreshResult: () => Effect.succeed(fresh),
    }
    const persistState: PersistState = { lastWritten: undefined, failNext: true }
    const layer = AnthropicCredentialService.layerFromIO(makeIO(state), makeAuthInfo(persistState))

    await runWithTestClock(
      Effect.gen(function* () {
        const svc = yield* AnthropicCredentialService
        const result = yield* svc.getFresh
        // Outcome: caller still receives the freshly-refreshed creds
        // even though persist died. lastWritten remains undefined,
        // confirming the write didn't land — but getFresh kept moving.
        expect(result.accessToken).toBe("fresh-access")
        expect(persistState.lastWritten).toBeUndefined()
      }).pipe(Effect.provide(layer)),
    )
  })
})

describe("AnthropicCredentialService — keychain miss falls through to refresh", () => {
  test("read fails → refresh succeeds → returns refreshed creds", async () => {
    const fresh = makeCreds("fresh", FAR_FUTURE)
    const state: IOState = {
      readResult: () => Effect.fail(new ProviderAuthError({ message: "no keychain entry" })),
      refreshResult: () => Effect.succeed(fresh),
    }
    const layer = AnthropicCredentialService.layerFromIO(makeIO(state))

    await runWithTestClock(
      Effect.gen(function* () {
        const svc = yield* AnthropicCredentialService
        const result = yield* svc.getFresh
        // Outcome: when read fails, the refresh path's creds reach the
        // caller. No internal call counters needed.
        expect(result.accessToken).toBe("fresh-access")
      }).pipe(Effect.provide(layer)),
    )
  })
})

// Suppress unused-warning for Layer/Ref imports (intentional helper imports)
void Layer
void Ref
