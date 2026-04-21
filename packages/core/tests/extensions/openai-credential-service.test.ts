/**
 * OpenAICredentialService — Effect-native credential cache.
 *
 * Mirrors the Anthropic credential service tests but adapted for the
 * OpenAI shape: there is no keychain `read` IO — initial credentials
 * come from `authInfo`, and `refresh(refreshToken)` is the only IO
 * call. Cache TTL 30s + 60s freshness margin behaviour is identical.
 *
 * Drives the IO seam (`OpenAICredentialIO`) deterministically via
 * `TestClock` so cache semantics are observable without hitting
 * `auth.openai.com`.
 */
import { describe, test, expect } from "bun:test"
import { Cause, Effect, Layer, Option, Ref } from "effect"
import { TestClock } from "effect/testing"
import {
  EMPTY_CREDENTIAL_CELL,
  OpenAICredentialService,
  type CredentialCacheCell,
  type OpenAICredentialIO,
  type OpenAICredentials,
} from "@gent/extensions/openai/credential-service"
import { ProviderAuthError, type ProviderAuthInfo } from "@gent/core/extensions/api"

// ── Helpers ──

const makeCreds = (label: string, expires: number): OpenAICredentials => ({
  access: `${label}-access`,
  refresh: `${label}-refresh`,
  expires,
  accountId: `${label}-account`,
})

interface IOState {
  refreshResult: (refreshToken: string) => Effect.Effect<OpenAICredentials, ProviderAuthError>
}

const makeIO = (state: IOState): OpenAICredentialIO => ({
  refresh: (rt) => Effect.suspend(() => state.refreshResult(rt)),
})

interface PersistState {
  lastWritten: { access: string; refresh: string; expires: number; accountId?: string } | undefined
  failNext: boolean
}

const makeAuthInfo = (
  state: PersistState,
  initial?: Partial<OpenAICredentials>,
): ProviderAuthInfo => ({
  type: "oauth",
  access: initial?.access ?? "seed-access",
  refresh: initial?.refresh ?? "seed-refresh",
  expires: initial?.expires ?? 0,
  ...(initial?.accountId !== undefined ? { accountId: initial.accountId } : {}),
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

// TestClock starts at time 0 — `expires` values are absolute (relative
// to t=0), not `Date.now() + offset`.
const FAR_FUTURE = 10 * 60 * 1000

const runWithTestClock = <A, E>(eff: Effect.Effect<A, E, OpenAICredentialService>) =>
  Effect.runPromise(
    Effect.scoped(eff).pipe(Effect.provide(TestClock.layer())) as Effect.Effect<A, E, never>,
  )

// ── Tests ──

describe("OpenAICredentialService — initial seed from authInfo", () => {
  test("seed creds from authInfo are returned without invoking refresh", async () => {
    const state: IOState = {
      refreshResult: () => Effect.fail(new ProviderAuthError({ message: "should not be called" })),
    }
    const layer = OpenAICredentialService.layerFromIO(
      makeIO(state),
      makeAuthInfo(
        { lastWritten: undefined, failNext: false },
        { access: "seed-access", refresh: "seed-refresh", expires: FAR_FUTURE, accountId: "acct1" },
      ),
    )

    await runWithTestClock(
      Effect.gen(function* () {
        const svc = yield* OpenAICredentialService
        const result = yield* svc.getFresh
        expect(result.access).toBe("seed-access")
        expect(result.accountId).toBe("acct1")
      }).pipe(Effect.provide(layer)),
    )
  })

  test("missing access AND refresh in authInfo + no cell creds → ProviderAuthError", async () => {
    const state: IOState = {
      refreshResult: () => Effect.fail(new ProviderAuthError({ message: "should not be called" })),
    }
    // authInfo with empty access AND empty refresh seeds EMPTY cell.
    const authInfo: ProviderAuthInfo = {
      type: "oauth",
      access: "",
      refresh: "",
      expires: 0,
    }
    const layer = OpenAICredentialService.layerFromIO(makeIO(state), authInfo)

    const result = await runWithTestClock(
      Effect.gen(function* () {
        const svc = yield* OpenAICredentialService
        return yield* Effect.exit(svc.getFresh)
      }).pipe(Effect.provide(layer)),
    )

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      const errOpt = Cause.findErrorOption(result.cause)
      expect(Option.isSome(errOpt)).toBe(true)
      if (Option.isSome(errOpt)) {
        expect(errOpt.value.message).toContain("unavailable")
      }
    }
  })
})

describe("OpenAICredentialService — refresh on stale", () => {
  test("expiring-soon seed triggers refresh; refreshed creds returned + persisted", async () => {
    // Seed expires inside the 60s freshness margin (30s) — getFresh
    // must refresh and persist the new creds.
    const fresh = makeCreds("fresh", FAR_FUTURE)
    const state: IOState = {
      refreshResult: (rt) => {
        expect(rt).toBe("seed-refresh")
        return Effect.succeed(fresh)
      },
    }
    const persistState: PersistState = { lastWritten: undefined, failNext: false }
    const layer = OpenAICredentialService.layerFromIO(
      makeIO(state),
      makeAuthInfo(persistState, {
        access: "seed-access",
        refresh: "seed-refresh",
        expires: 30_000,
      }),
    )

    await runWithTestClock(
      Effect.gen(function* () {
        const svc = yield* OpenAICredentialService
        const result = yield* svc.getFresh
        expect(result.access).toBe("fresh-access")
        expect(persistState.lastWritten?.access).toBe("fresh-access")
      }).pipe(Effect.provide(layer)),
    )
  })

  test("refresh failure surfaces ProviderAuthError + clears cell", async () => {
    const state: IOState = {
      refreshResult: () =>
        Effect.fail(new ProviderAuthError({ message: "OAuth 401 from refresh" })),
    }
    const persistState: PersistState = { lastWritten: undefined, failNext: false }
    const layer = OpenAICredentialService.layerFromIO(
      makeIO(state),
      makeAuthInfo(persistState, {
        access: "seed-access",
        refresh: "seed-refresh",
        expires: 30_000,
      }),
    )

    const result = await runWithTestClock(
      Effect.gen(function* () {
        const svc = yield* OpenAICredentialService
        return yield* Effect.exit(svc.getFresh)
      }).pipe(Effect.provide(layer)),
    )

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      const errOpt = Cause.findErrorOption(result.cause)
      expect(Option.isSome(errOpt)).toBe(true)
      if (Option.isSome(errOpt)) {
        expect(errOpt.value.message).toContain("401")
      }
    }
  })

  test("refresh response without accountId carries forward prior accountId", async () => {
    const refreshed: OpenAICredentials = {
      access: "fresh-access",
      refresh: "fresh-refresh",
      expires: FAR_FUTURE,
      // intentionally omits accountId — must not blank the prior one
    }
    const state: IOState = {
      refreshResult: () => Effect.succeed(refreshed),
    }
    const persistState: PersistState = { lastWritten: undefined, failNext: false }
    const layer = OpenAICredentialService.layerFromIO(
      makeIO(state),
      makeAuthInfo(persistState, {
        access: "seed-access",
        refresh: "seed-refresh",
        expires: 30_000,
        accountId: "prior-acct",
      }),
    )

    await runWithTestClock(
      Effect.gen(function* () {
        const svc = yield* OpenAICredentialService
        const result = yield* svc.getFresh
        expect(result.accountId).toBe("prior-acct")
        expect(persistState.lastWritten?.accountId).toBe("prior-acct")
      }).pipe(Effect.provide(layer)),
    )
  })
})

describe("OpenAICredentialService — cache hit/miss", () => {
  test("returns cached creds within TTL even when source changes", async () => {
    // After the first refresh fills the cell with fresh creds, the
    // second getFresh inside the 30s TTL must NOT call refresh again.
    const fresh1 = makeCreds("k1", FAR_FUTURE)
    const fresh2 = makeCreds("k2", FAR_FUTURE)
    const callsRef: { current: OpenAICredentials } = { current: fresh1 }
    const state: IOState = {
      refreshResult: () => Effect.succeed(callsRef.current),
    }
    const persistState: PersistState = { lastWritten: undefined, failNext: false }
    const layer = OpenAICredentialService.layerFromIO(
      makeIO(state),
      makeAuthInfo(persistState, {
        access: "seed-access",
        refresh: "seed-refresh",
        expires: 30_000,
      }),
    )

    await runWithTestClock(
      Effect.gen(function* () {
        const svc = yield* OpenAICredentialService
        const first = yield* svc.getFresh
        callsRef.current = fresh2 // would change refresh result if invoked
        const second = yield* svc.getFresh
        expect(first.access).toBe("k1-access")
        expect(second.access).toBe("k1-access")
      }).pipe(Effect.provide(layer)),
    )
  })

  test("seed creds still fresh enough → updates timestamp instead of refreshing", async () => {
    // Seed expires far in the future — no refresh needed even when
    // cache TTL would otherwise force a re-check.
    const state: IOState = {
      refreshResult: () => Effect.fail(new ProviderAuthError({ message: "should not be called" })),
    }
    const persistState: PersistState = { lastWritten: undefined, failNext: false }
    const layer = OpenAICredentialService.layerFromIO(
      makeIO(state),
      makeAuthInfo(persistState, {
        access: "seed-access",
        refresh: "seed-refresh",
        expires: FAR_FUTURE,
      }),
    )

    await runWithTestClock(
      Effect.gen(function* () {
        const svc = yield* OpenAICredentialService
        const first = yield* svc.getFresh
        yield* TestClock.adjust("31 seconds")
        const second = yield* svc.getFresh
        expect(first.access).toBe("seed-access")
        expect(second.access).toBe("seed-access")
      }).pipe(Effect.provide(layer)),
    )
  })
})

describe("OpenAICredentialService — invalidate", () => {
  test("invalidate forces next getFresh to refresh", async () => {
    const fresh = makeCreds("fresh", FAR_FUTURE)
    let refreshCount = 0
    const state: IOState = {
      refreshResult: () => {
        refreshCount += 1
        return Effect.succeed(fresh)
      },
    }
    const persistState: PersistState = { lastWritten: undefined, failNext: false }
    const layer = OpenAICredentialService.layerFromIO(
      makeIO(state),
      makeAuthInfo(persistState, {
        access: "seed-access",
        refresh: "seed-refresh",
        expires: FAR_FUTURE,
      }),
    )

    await runWithTestClock(
      Effect.gen(function* () {
        const svc = yield* OpenAICredentialService
        // Seed creds are already fresh — no refresh on first call.
        yield* svc.getFresh
        expect(refreshCount).toBe(0)
        // After invalidate the cell is empty, so even with no
        // accessible authInfo seed (cell holds null), the service
        // falls back to authInfo.refresh and forces a refresh call.
        yield* svc.invalidate
        const after = yield* svc.getFresh
        expect(after.access).toBe("fresh-access")
        expect(refreshCount).toBe(1)
      }).pipe(Effect.provide(layer)),
    )
  })
})

describe("OpenAICredentialService — persist failure does not regress getFresh", () => {
  test("write-back failure returns fresh creds anyway", async () => {
    const fresh = makeCreds("fresh", FAR_FUTURE)
    const state: IOState = {
      refreshResult: () => Effect.succeed(fresh),
    }
    const persistState: PersistState = { lastWritten: undefined, failNext: true }
    const layer = OpenAICredentialService.layerFromIO(
      makeIO(state),
      makeAuthInfo(persistState, {
        access: "seed-access",
        refresh: "seed-refresh",
        expires: 30_000,
      }),
    )

    await runWithTestClock(
      Effect.gen(function* () {
        const svc = yield* OpenAICredentialService
        const result = yield* svc.getFresh
        expect(result.access).toBe("fresh-access")
        expect(persistState.lastWritten).toBeUndefined()
      }).pipe(Effect.provide(layer)),
    )
  })
})

describe("OpenAICredentialService — layerFromRef preserves cell across builds", () => {
  test("two layer builds sharing the same cellRef share the cache", async () => {
    // Counsel C3 fix: extension-closure-owned Ref must survive across
    // resolveModel-equivalent layer builds. Two builds against the same
    // Ref must observe each other's writes.
    const fresh = makeCreds("fresh", FAR_FUTURE)
    let refreshCount = 0
    const state: IOState = {
      refreshResult: () => {
        refreshCount += 1
        return Effect.succeed(fresh)
      },
    }
    const persistState: PersistState = { lastWritten: undefined, failNext: false }
    const authInfo = makeAuthInfo(persistState, {
      access: "seed-access",
      refresh: "seed-refresh",
      expires: 30_000, // forces refresh on first getFresh
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const cellRef = yield* Ref.make<CredentialCacheCell>(EMPTY_CREDENTIAL_CELL)

          // First "resolveModel" build — refreshes once.
          yield* Effect.gen(function* () {
            const svc = yield* OpenAICredentialService
            yield* svc.getFresh
          }).pipe(
            Effect.provide(
              OpenAICredentialService.layerFromRefAndIO(cellRef, makeIO(state), authInfo),
            ),
          )

          // Second "resolveModel" build with same Ref — must hit cache.
          yield* Effect.gen(function* () {
            const svc = yield* OpenAICredentialService
            const result = yield* svc.getFresh
            expect(result.access).toBe("fresh-access")
          }).pipe(
            Effect.provide(
              OpenAICredentialService.layerFromRefAndIO(cellRef, makeIO(state), authInfo),
            ),
          )

          expect(refreshCount).toBe(1)
        }),
      ).pipe(Effect.provide(TestClock.layer())) as Effect.Effect<void, unknown, never>,
    )
  })
})

// Suppress unused-warning for Layer (intentional helper import)
void Layer
