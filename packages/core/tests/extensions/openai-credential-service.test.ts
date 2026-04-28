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
import { describe, expect, it } from "effect-bun-test"
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
  lastWritten:
    | {
        access: string
        refresh: string
        expires: number
        accountId?: string
      }
    | undefined
  failNext: boolean | "typed"
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
        const failure = state.failNext
        state.failNext = false
        if (failure === "typed") {
          return Effect.fail(new ProviderAuthError({ message: "typed persist failure" }))
        }
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
  it.live("seed creds from authInfo are returned without invoking refresh", () =>
    Effect.gen(function* () {
      const state: IOState = {
        refreshResult: () =>
          Effect.fail(new ProviderAuthError({ message: "should not be called" })),
      }
      const layer = OpenAICredentialService.layerFromIO(
        makeIO(state),
        makeAuthInfo(
          { lastWritten: undefined, failNext: false },
          {
            access: "seed-access",
            refresh: "seed-refresh",
            expires: FAR_FUTURE,
            accountId: "acct1",
          },
        ),
      )
      yield* Effect.promise(() =>
        runWithTestClock(
          Effect.gen(function* () {
            const svc = yield* OpenAICredentialService
            const result = yield* svc.getFresh
            expect(result.access).toBe("seed-access")
            expect(result.accountId).toBe("acct1")
          }).pipe(Effect.provide(layer)),
        ),
      )
    }),
  )
  it.live("missing access AND refresh in authInfo + no cell creds → ProviderAuthError", () =>
    Effect.gen(function* () {
      const state: IOState = {
        refreshResult: () =>
          Effect.fail(new ProviderAuthError({ message: "should not be called" })),
      }
      // authInfo with empty access AND empty refresh seeds EMPTY cell.
      const authInfo: ProviderAuthInfo = {
        type: "oauth",
        access: "",
        refresh: "",
        expires: 0,
      }
      const layer = OpenAICredentialService.layerFromIO(makeIO(state), authInfo)
      const result = yield* Effect.promise(() =>
        runWithTestClock(
          Effect.gen(function* () {
            const svc = yield* OpenAICredentialService
            return yield* Effect.exit(svc.getFresh)
          }).pipe(Effect.provide(layer)),
        ),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const errOpt = Cause.findErrorOption(result.cause)
        expect(Option.isSome(errOpt)).toBe(true)
        if (Option.isSome(errOpt)) {
          expect(errOpt.value.message).toContain("unavailable")
        }
      }
    }),
  )
})
describe("OpenAICredentialService — refresh on stale", () => {
  it.live("expiring-soon seed triggers refresh; refreshed creds returned + persisted", () =>
    Effect.gen(function* () {
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
          expires: 30000,
        }),
      )
      yield* Effect.promise(() =>
        runWithTestClock(
          Effect.gen(function* () {
            const svc = yield* OpenAICredentialService
            const result = yield* svc.getFresh
            expect(result.access).toBe("fresh-access")
            expect(persistState.lastWritten?.access).toBe("fresh-access")
          }).pipe(Effect.provide(layer)),
        ),
      )
    }),
  )
  it.live(
    "refresh failure surfaces ProviderAuthError + preserves rotated refresh token in cell",
    () =>
      Effect.gen(function* () {
        // Refresh failure must NOT clear the rotated refresh token. Drive
        // a successful refresh first to rotate the token, then a failing
        // refresh, then assert that a third attempt sees the ROTATED token
        // in the refresh call (not the bootstrap).
        let phase: "first" | "second" | "third" = "first"
        const callTokens: string[] = []
        const state: IOState = {
          refreshResult: (rt) => {
            callTokens.push(rt)
            if (phase === "first") {
              phase = "second"
              return Effect.succeed({
                access: "rotated-access",
                refresh: "rotated-refresh",
                expires: 30000, // expiring soon so next get refreshes
              })
            }
            if (phase === "second") {
              phase = "third"
              return Effect.fail(new ProviderAuthError({ message: "OAuth 401 from refresh" }))
            }
            return Effect.succeed({
              access: "third-access",
              refresh: "third-refresh",
              expires: FAR_FUTURE,
            })
          },
        }
        const persistState: PersistState = { lastWritten: undefined, failNext: false }
        const layer = OpenAICredentialService.layerFromIO(
          makeIO(state),
          makeAuthInfo(persistState, {
            access: "seed-access",
            refresh: "seed-refresh",
            expires: 30000,
          }),
        )
        yield* Effect.promise(() =>
          runWithTestClock(
            Effect.gen(function* () {
              const svc = yield* OpenAICredentialService
              // First get: refreshes from bootstrap, rotates to "rotated-*".
              const first = yield* svc.getFresh
              expect(first.access).toBe("rotated-access")
              expect(callTokens[0]).toBe("seed-refresh")
              // Second get: rotated creds also expire soon → refresh again.
              // This call fails — must surface ProviderAuthError.
              const failure = yield* Effect.exit(svc.getFresh)
              expect(failure._tag).toBe("Failure")
              if (failure._tag === "Failure") {
                const errOpt = Cause.findErrorOption(failure.cause)
                expect(Option.isSome(errOpt)).toBe(true)
                if (Option.isSome(errOpt)) {
                  expect(errOpt.value.message).toContain("401")
                }
              }
              expect(callTokens[1]).toBe("rotated-refresh")
              // Third get: must use the ROTATED refresh token, NOT the
              // bootstrap. If the cell were cleared on failure, this would
              // see "seed-refresh" and the OAuth server might have already
              // revoked it.
              const third = yield* svc.getFresh
              expect(third.access).toBe("third-access")
              expect(callTokens[2]).toBe("rotated-refresh")
            }).pipe(Effect.provide(layer)),
          ),
        )
      }),
  )
  it.live("refresh response without accountId carries forward prior accountId", () =>
    Effect.gen(function* () {
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
          expires: 30000,
          accountId: "prior-acct",
        }),
      )
      yield* Effect.promise(() =>
        runWithTestClock(
          Effect.gen(function* () {
            const svc = yield* OpenAICredentialService
            const result = yield* svc.getFresh
            expect(result.accountId).toBe("prior-acct")
            expect(persistState.lastWritten?.accountId).toBe("prior-acct")
          }).pipe(Effect.provide(layer)),
        ),
      )
    }),
  )
})
describe("OpenAICredentialService — cache hit/miss", () => {
  it.live("returns cached creds within TTL even when source changes", () =>
    Effect.gen(function* () {
      // After the first refresh fills the cell with fresh creds, the
      // second getFresh inside the 30s TTL must NOT call refresh again.
      const fresh1 = makeCreds("k1", FAR_FUTURE)
      const fresh2 = makeCreds("k2", FAR_FUTURE)
      const callsRef: {
        current: OpenAICredentials
      } = { current: fresh1 }
      const state: IOState = {
        refreshResult: () => Effect.succeed(callsRef.current),
      }
      const persistState: PersistState = { lastWritten: undefined, failNext: false }
      const layer = OpenAICredentialService.layerFromIO(
        makeIO(state),
        makeAuthInfo(persistState, {
          access: "seed-access",
          refresh: "seed-refresh",
          expires: 30000,
        }),
      )
      yield* Effect.promise(() =>
        runWithTestClock(
          Effect.gen(function* () {
            const svc = yield* OpenAICredentialService
            const first = yield* svc.getFresh
            callsRef.current = fresh2 // would change refresh result if invoked
            const second = yield* svc.getFresh
            expect(first.access).toBe("k1-access")
            expect(second.access).toBe("k1-access")
          }).pipe(Effect.provide(layer)),
        ),
      )
    }),
  )
  it.live("seed creds still fresh enough → updates timestamp instead of refreshing", () =>
    Effect.gen(function* () {
      // Seed expires far in the future — no refresh needed even when
      // cache TTL would otherwise force a re-check.
      const state: IOState = {
        refreshResult: () =>
          Effect.fail(new ProviderAuthError({ message: "should not be called" })),
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
      yield* Effect.promise(() =>
        runWithTestClock(
          Effect.gen(function* () {
            const svc = yield* OpenAICredentialService
            const first = yield* svc.getFresh
            yield* TestClock.adjust("31 seconds")
            const second = yield* svc.getFresh
            expect(first.access).toBe("seed-access")
            expect(second.access).toBe("seed-access")
          }).pipe(Effect.provide(layer)),
        ),
      )
    }),
  )
})
describe("OpenAICredentialService — invalidate", () => {
  it.live("invalidate forces next getFresh to refresh", () =>
    Effect.gen(function* () {
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
      yield* Effect.promise(() =>
        runWithTestClock(
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
        ),
      )
    }),
  )
})
describe("OpenAICredentialService — durable persist failure", () => {
  it.live("write-back failure surfaces ProviderAuthError", () =>
    Effect.gen(function* () {
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
          expires: 30000,
        }),
      )
      const result = yield* Effect.promise(() =>
        runWithTestClock(
          Effect.gen(function* () {
            const svc = yield* OpenAICredentialService
            return yield* Effect.exit(svc.getFresh)
          }).pipe(Effect.provide(layer)),
        ),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const errOpt = Cause.findErrorOption(result.cause)
        expect(Option.isSome(errOpt)).toBe(true)
        if (Option.isSome(errOpt)) {
          expect(errOpt.value.message).toContain("Failed to persist refreshed OpenAI credentials")
        }
      }
      expect(persistState.lastWritten).toBeUndefined()
    }),
  )
  it.live("typed write-back failure retries pending persist before API use", () =>
    Effect.gen(function* () {
      const fresh = makeCreds("fresh", FAR_FUTURE)
      let refreshCount = 0
      const state: IOState = {
        refreshResult: () => {
          refreshCount += 1
          return Effect.succeed(fresh)
        },
      }
      const persistState: PersistState = { lastWritten: undefined, failNext: "typed" }
      const layer = OpenAICredentialService.layerFromIO(
        makeIO(state),
        makeAuthInfo(persistState, {
          access: "seed-access",
          refresh: "seed-refresh",
          expires: 30000,
        }),
      )
      yield* Effect.promise(() =>
        runWithTestClock(
          Effect.gen(function* () {
            const svc = yield* OpenAICredentialService
            const failure = yield* Effect.exit(svc.getFresh)
            expect(failure._tag).toBe("Failure")
            if (failure._tag === "Failure") {
              const errOpt = Cause.findErrorOption(failure.cause)
              expect(Option.isSome(errOpt)).toBe(true)
              if (Option.isSome(errOpt)) {
                expect(errOpt.value.message).toContain("typed persist failure")
              }
            }
            const retry = yield* svc.getFresh
            expect(retry.access).toBe("fresh-access")
            expect(refreshCount).toBe(1)
            expect(persistState.lastWritten?.refresh).toBe("fresh-refresh")
          }).pipe(Effect.provide(layer)),
        ),
      )
    }),
  )
})
describe("OpenAICredentialService — invalidate preserves durable refresh token", () => {
  it.live("failed durable write preserves pending rotated refresh token through invalidate", () =>
    Effect.gen(function* () {
      // A failed durable write must fail the current request, but OpenAI
      // refresh-token rotation means the newly-issued refresh token is the
      // only future recovery path. Keep it pending, then retry persist
      // before any API use.
      const callTokens: string[] = []
      let phase: "first" | "after-invalidate" = "first"
      const state: IOState = {
        refreshResult: (rt) => {
          callTokens.push(rt)
          if (phase === "first") {
            phase = "after-invalidate"
            return Effect.succeed({
              access: "rotated-access",
              refresh: "rotated-refresh",
              expires: FAR_FUTURE,
            })
          }
          return Effect.succeed({
            access: "post-invalidate-access",
            refresh: "post-invalidate-refresh",
            expires: FAR_FUTURE,
          })
        },
      }
      // persist defects on the first write — exactly the lossy path
      // the rotated token must survive.
      const persistState: PersistState = { lastWritten: undefined, failNext: true }
      const layer = OpenAICredentialService.layerFromIO(
        makeIO(state),
        makeAuthInfo(persistState, {
          access: "seed-access",
          refresh: "seed-refresh",
          expires: 30000, // forces refresh on first getFresh
        }),
      )
      yield* Effect.promise(() =>
        runWithTestClock(
          Effect.gen(function* () {
            const svc = yield* OpenAICredentialService
            const failure = yield* Effect.exit(svc.getFresh)
            expect(failure._tag).toBe("Failure")
            if (failure._tag === "Failure") {
              const errOpt = Cause.findErrorOption(failure.cause)
              expect(Option.isSome(errOpt)).toBe(true)
              if (Option.isSome(errOpt)) {
                expect(errOpt.value.message).toContain(
                  "Failed to persist refreshed OpenAI credentials",
                )
              }
            }
            expect(callTokens[0]).toBe("seed-refresh")
            expect(persistState.lastWritten).toBeUndefined()
            yield* svc.invalidate
            const second = yield* svc.getFresh
            expect(second.access).toBe("post-invalidate-access")
            expect(callTokens[1]).toBe("rotated-refresh")
          }).pipe(Effect.provide(layer)),
        ),
      )
    }),
  )
  it.live("invalidate on an empty cell stays empty (no synthetic cell creation)", () =>
    Effect.gen(function* () {
      // Edge case: invalidate must not invent a cell when there's nothing
      // there to begin with. The "no usable refresh token" error path
      // depends on EMPTY_CREDENTIAL_CELL staying empty.
      const state: IOState = {
        refreshResult: () =>
          Effect.fail(new ProviderAuthError({ message: "should not be called" })),
      }
      const authInfo: ProviderAuthInfo = { type: "oauth", access: "", refresh: "", expires: 0 }
      const layer = OpenAICredentialService.layerFromIO(makeIO(state), authInfo)
      yield* Effect.promise(() =>
        runWithTestClock(
          Effect.gen(function* () {
            const svc = yield* OpenAICredentialService
            // Invalidate before any successful refresh — cell is empty.
            yield* svc.invalidate
            const result = yield* Effect.exit(svc.getFresh)
            expect(result._tag).toBe("Failure")
            if (result._tag === "Failure") {
              const errOpt = Cause.findErrorOption(result.cause)
              expect(Option.isSome(errOpt)).toBe(true)
              if (Option.isSome(errOpt)) {
                expect(errOpt.value.message).toContain("unavailable")
              }
            }
          }).pipe(Effect.provide(layer)),
        ),
      )
    }),
  )
})
describe("OpenAICredentialService — layerFromRef preserves cell across builds", () => {
  it.live("warm cellRef beats a different authInfo seed on second build", () =>
    Effect.gen(function* () {
      // The actual seed-only-if-empty invariant. Build 1 fills the cell
      // with rotated creds. Build 2 arrives with a DIFFERENT authInfo
      // (different access/refresh) — the warm cell must win.
      let refreshCount = 0
      const state: IOState = {
        refreshResult: () => {
          refreshCount += 1
          return Effect.succeed({
            access: "rotated-access",
            refresh: "rotated-refresh",
            expires: FAR_FUTURE,
          })
        },
      }
      const persistState: PersistState = { lastWritten: undefined, failNext: false }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const cellRef = yield* Ref.make<CredentialCacheCell>(EMPTY_CREDENTIAL_CELL)
          // Build 1: authInfo with EXPIRING access → forces refresh.
          // After this, cellRef holds {access: "rotated-access", ...}.
          yield* Effect.gen(function* () {
            const svc = yield* OpenAICredentialService
            const result = yield* svc.getFresh
            expect(result.access).toBe("rotated-access")
          }).pipe(
            Effect.provide(
              OpenAICredentialService.layerFromRefAndIO(
                cellRef,
                makeIO(state),
                makeAuthInfo(persistState, {
                  access: "build1-access",
                  refresh: "build1-refresh",
                  expires: 30000,
                }),
              ),
            ),
          )
          expect(refreshCount).toBe(1)
          // Build 2: DIFFERENT authInfo (different bootstrap creds).
          // The warm cell must beat this seed — getFresh must return
          // the rotated creds from build 1, NOT "build2-access".
          yield* Effect.gen(function* () {
            const svc = yield* OpenAICredentialService
            const result = yield* svc.getFresh
            expect(result.access).toBe("rotated-access")
            expect(result.access).not.toBe("build2-access")
          }).pipe(
            Effect.provide(
              OpenAICredentialService.layerFromRefAndIO(
                cellRef,
                makeIO(state),
                makeAuthInfo(persistState, {
                  access: "build2-access",
                  refresh: "build2-refresh",
                  expires: FAR_FUTURE, // even fresh — cell still wins
                }),
              ),
            ),
          )
          // No additional refresh — build 2 read straight from cell.
          expect(refreshCount).toBe(1)
        }),
      ).pipe(Effect.provide(TestClock.layer())) as Effect.Effect<void, unknown, never>
    }),
  )
  it.live("two layer builds sharing the same cellRef share the cache", () =>
    Effect.gen(function* () {
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
        expires: 30000, // forces refresh on first getFresh
      })
      yield* Effect.scoped(
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
      ).pipe(Effect.provide(TestClock.layer())) as Effect.Effect<void, unknown, never>
    }),
  )
})
// Suppress unused-warning for Layer (intentional helper import)
void Layer
