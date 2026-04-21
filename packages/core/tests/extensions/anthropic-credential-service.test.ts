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
  readCalls: number
  refreshCalls: number
  readResult: () => Effect.Effect<ClaudeCredentials, ProviderAuthError>
  refreshResult: () => Effect.Effect<ClaudeCredentials, ProviderAuthError>
}

const makeIO = (state: IOState): AnthropicCredentialIO => ({
  read: Effect.suspend(() => {
    state.readCalls += 1
    return state.readResult()
  }),
  refresh: Effect.suspend(() => {
    state.refreshCalls += 1
    return state.refreshResult()
  }),
})

interface PersistState {
  calls: number
  lastWritten: { access: string; refresh: string; expires: number } | undefined
  failNext: boolean
}

const makeAuthInfo = (state: PersistState): ProviderAuthInfo => ({
  type: "oauth",
  persist: (updated) =>
    Effect.suspend(() => {
      state.calls += 1
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
  test("first call reads from IO; second call within TTL returns cached creds", async () => {
    const state: IOState = {
      readCalls: 0,
      refreshCalls: 0,
      readResult: () => Effect.succeed(makeCreds("k1", FAR_FUTURE)),
      refreshResult: () => Effect.fail(new ProviderAuthError({ message: "should not be called" })),
    }
    const layer = AnthropicCredentialService.layerFromIO(makeIO(state))

    await runWithTestClock(
      Effect.gen(function* () {
        const svc = yield* AnthropicCredentialService
        const first = yield* svc.getFresh
        const second = yield* svc.getFresh
        expect(first.accessToken).toBe("k1-access")
        expect(second.accessToken).toBe("k1-access")
        expect(state.readCalls).toBe(1) // second call hit cache
        expect(state.refreshCalls).toBe(0)
      }).pipe(Effect.provide(layer)),
    )
  })

  test("call after TTL expires re-reads from IO", async () => {
    const creds1 = makeCreds("k1", FAR_FUTURE)
    const creds2 = makeCreds("k2", FAR_FUTURE)
    const callsRef: { current: ClaudeCredentials } = { current: creds1 }
    const state: IOState = {
      readCalls: 0,
      refreshCalls: 0,
      readResult: () => Effect.succeed(callsRef.current),
      refreshResult: () => Effect.fail(new ProviderAuthError({ message: "should not be called" })),
    }
    const layer = AnthropicCredentialService.layerFromIO(makeIO(state))

    await runWithTestClock(
      Effect.gen(function* () {
        const svc = yield* AnthropicCredentialService
        const first = yield* svc.getFresh
        expect(first.accessToken).toBe("k1-access")
        // Advance past the 30s cache TTL
        callsRef.current = creds2
        yield* TestClock.adjust("31 seconds")
        const second = yield* svc.getFresh
        expect(second.accessToken).toBe("k2-access")
        expect(state.readCalls).toBe(2)
      }).pipe(Effect.provide(layer)),
    )
  })
})

describe("AnthropicCredentialService — refresh on stale", () => {
  test("expiring-soon creds trigger refresh; refreshed creds returned + persisted", async () => {
    const stale = makeCreds("stale", 30_000) // 30s — inside the 60s freshness margin
    const fresh = makeCreds("fresh", FAR_FUTURE)
    const state: IOState = {
      readCalls: 0,
      refreshCalls: 0,
      readResult: () => Effect.succeed(stale),
      refreshResult: () => Effect.succeed(fresh),
    }
    const persistState: PersistState = { calls: 0, lastWritten: undefined, failNext: false }
    const layer = AnthropicCredentialService.layerFromIO(makeIO(state), makeAuthInfo(persistState))

    await runWithTestClock(
      Effect.gen(function* () {
        const svc = yield* AnthropicCredentialService
        const result = yield* svc.getFresh
        expect(result.accessToken).toBe("fresh-access")
        expect(state.readCalls).toBe(1)
        expect(state.refreshCalls).toBe(1)
        expect(persistState.calls).toBe(1)
        expect(persistState.lastWritten?.access).toBe("fresh-access")
      }).pipe(Effect.provide(layer)),
    )
  })

  test("refresh failure surfaces ProviderAuthError to caller", async () => {
    const stale = makeCreds("stale", 30_000)
    const state: IOState = {
      readCalls: 0,
      refreshCalls: 0,
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
      readCalls: 0,
      refreshCalls: 0,
      readResult: () => Effect.succeed(callsRef.current),
      refreshResult: () => Effect.fail(new ProviderAuthError({ message: "should not be called" })),
    }
    const layer = AnthropicCredentialService.layerFromIO(makeIO(state))

    await runWithTestClock(
      Effect.gen(function* () {
        const svc = yield* AnthropicCredentialService
        yield* svc.getFresh
        expect(state.readCalls).toBe(1)
        callsRef.current = creds2
        yield* svc.invalidate
        const next = yield* svc.getFresh
        expect(next.accessToken).toBe("k2-access")
        expect(state.readCalls).toBe(2)
      }).pipe(Effect.provide(layer)),
    )
  })
})

describe("AnthropicCredentialService — persist failure does not regress getFresh", () => {
  test("write-back failure logs warning but returns fresh creds (counsel HIGH #1)", async () => {
    const stale = makeCreds("stale", 30_000)
    const fresh = makeCreds("fresh", FAR_FUTURE)
    const state: IOState = {
      readCalls: 0,
      refreshCalls: 0,
      readResult: () => Effect.succeed(stale),
      refreshResult: () => Effect.succeed(fresh),
    }
    const persistState: PersistState = { calls: 0, lastWritten: undefined, failNext: true }
    const layer = AnthropicCredentialService.layerFromIO(makeIO(state), makeAuthInfo(persistState))

    await runWithTestClock(
      Effect.gen(function* () {
        const svc = yield* AnthropicCredentialService
        const result = yield* svc.getFresh
        expect(result.accessToken).toBe("fresh-access") // fresh creds returned
        expect(persistState.calls).toBe(1) // persist was attempted
        expect(persistState.lastWritten).toBeUndefined() // failed write-back, but caller still got creds
      }).pipe(Effect.provide(layer)),
    )
  })
})

describe("AnthropicCredentialService — keychain miss falls through to refresh", () => {
  test("read fails → refresh succeeds → returns refreshed creds", async () => {
    const fresh = makeCreds("fresh", FAR_FUTURE)
    const state: IOState = {
      readCalls: 0,
      refreshCalls: 0,
      readResult: () => Effect.fail(new ProviderAuthError({ message: "no keychain entry" })),
      refreshResult: () => Effect.succeed(fresh),
    }
    const layer = AnthropicCredentialService.layerFromIO(makeIO(state))

    await runWithTestClock(
      Effect.gen(function* () {
        const svc = yield* AnthropicCredentialService
        const result = yield* svc.getFresh
        expect(result.accessToken).toBe("fresh-access")
        expect(state.readCalls).toBe(1)
        expect(state.refreshCalls).toBe(1)
      }).pipe(Effect.provide(layer)),
    )
  })
})

// Suppress unused-warning for Layer/Ref imports (intentional helper imports)
void Layer
void Ref
