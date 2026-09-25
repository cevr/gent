import { describe, expect, it } from "effect-bun-test"
import {
  Cause,
  Crypto,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Ref,
  Schema,
  Semaphore,
  Stream,
  SynchronizedRef,
} from "effect"
import { TestClock } from "effect/testing"
import {
  authorizeOpenAIDevice,
  buildCodexTransformClient,
  buildOpenAIModelDriver,
  type OAuthError,
  type OpenAICredentialIO,
  type OpenAICredentials,
  makeOpenAICredentialCache,
  OAuthRedirectPort,
} from "../src/openai.js"
import { type CredentialCacheCell, EMPTY_CREDENTIAL_CELL } from "../src/providers.js"
import {
  ProviderAuthError,
  ProviderAuthInfo,
  type ProviderHints,
  RequestId,
  type StoredOAuthCredentials,
  type UpdateStoredOAuth,
} from "@gent/core/extensions/api"
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { EncodeError, HttpClientError, TransportError } from "effect/unstable/http/HttpClientError"
import { AiError, LanguageModel, Prompt, Tool, Toolkit } from "effect/unstable/ai"
import { encodeExternalJson } from "./helpers/external-wire.js"
import { testCatalogSource } from "./helpers/catalog-source.js"
import { e2ePreset } from "./helpers/test-preset.js"
import {
  type CapturedRequest,
  fakeFetchLayer,
  type FakeFetchState,
  makeFakeFetchState,
  createRpcHarness,
  oneGenerate,
  turnNoticesText,
  waitFor,
} from "@gent/core/test-utils"
import { SessionId } from "@gent/core/protocol"
import { BunCrypto } from "@effect/platform-bun"

/** The Crypto a host provides; the OpenAI driver captures it at setup. */
const hostCrypto = Effect.runSync(
  Effect.service(Crypto.Crypto).pipe(Effect.provide(BunCrypto.layer)),
)

// ── credential cache ────────────────────────────────────────────────────────

/**
 * OpenAI credential cache — Effect-native, over `makeCredentialCache`.
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
// ── Helpers ──
const makeCreds = (label: string, expires: number): OpenAICredentials => ({
  access: `${label}-access`,
  refresh: `${label}-refresh`,
  expires,
  accountId: Option.some(`${label}-account`),
})
interface IOState {
  refreshResult: (refreshToken: string) => Effect.Effect<OpenAICredentials, ProviderAuthError>
}
const makeIO = (state: IOState): OpenAICredentialIO => ({
  refresh: (rt) => Effect.suspend(() => state.refreshResult(rt)),
})
interface PersistState {
  lastWritten: Option.Option<StoredOAuthCredentials>
  failNext: boolean | "typed"
}
const toStoredCredentials = (creds: OpenAICredentials): StoredOAuthCredentials => {
  const fields = { access: creds.access, refresh: creds.refresh, expires: creds.expires }
  if (Option.isNone(creds.accountId)) return fields
  return { ...fields, accountId: creds.accountId.value }
}
/**
 * The gent auth store as core runs it: one lock per provider, shared by
 * every profile. `update` is what a refresh uses; `write` is the sign-in
 * callback's `ctx.persist`. `failNext` makes the next write fail.
 */
const makeFakeAuthStore = (state: PersistState, initial: Option.Option<StoredOAuthCredentials>) => {
  let stored = initial
  const writes: Array<StoredOAuthCredentials> = []
  const lock = Semaphore.makeUnsafe(1)
  const put = (next: StoredOAuthCredentials) =>
    Effect.suspend(() => {
      if (state.failNext) {
        const failure = state.failNext
        state.failNext = false
        if (failure === "typed") {
          return Effect.fail(new ProviderAuthError({ message: "typed persist failure" }))
        }
        return Effect.die(new Error("simulated persist failure"))
      }
      stored = Option.some(next)
      writes.push(next)
      state.lastWritten = Option.some(next)
      return Effect.void
    })
  const update: UpdateStoredOAuth = (f) =>
    Effect.gen(function* () {
      const pair = yield* f(stored)
      if (Option.isSome(pair[1])) yield* put(pair[1].value)
      return pair[0]
    }).pipe(lock.withPermits(1))
  const write = (next: StoredOAuthCredentials) => put(next).pipe(lock.withPermits(1))
  const read = () => stored
  // The credential a `resolveModel` call receives: the stored one plus `update`.
  const authInfo = (): ProviderAuthInfo => ProviderAuthInfo.cases.Oauth.make({ update })
  return { update, write, read, authInfo, writes }
}
const makeAuthInfo = (state: PersistState, credentials: OpenAICredentials): ProviderAuthInfo =>
  makeFakeAuthStore(state, Option.some(toStoredCredentials(credentials))).authInfo()
// A credential cache over a fresh cell.
// A ChatGPT sign-in held in its own fake store.
const oauthInfo = (stored: StoredOAuthCredentials): ProviderAuthInfo =>
  makeFakeAuthStore({ lastWritten: Option.none(), failNext: false }, Option.some(stored)).authInfo()
// The store access of a sign-in; an API key has none.
const updateOf = (authInfo: ProviderAuthInfo): UpdateStoredOAuth => {
  if (authInfo._tag === "Oauth") return authInfo.update
  return () => Effect.die(new Error("an API key has no OAuth store"))
}
const credentialCache = (io: OpenAICredentialIO, authInfo: ProviderAuthInfo) =>
  SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL).pipe(
    Effect.flatMap((cellRef) => makeOpenAICredentialCache(cellRef, io, updateOf(authInfo))),
  )
// TestClock starts at time 0, so `expires` values are absolute offsets.
const FAR_FUTURE = 10 * 60 * 1000
const COMPLETE = Option.getOrUndefined(Option.none<void>())
const EMPTY_PERSISTED_CREDENTIALS = Option.none<StoredOAuthCredentials>()
const runWithTestClock = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  Effect.scoped(eff).pipe(Effect.provide(TestClock.layer()))
// ── Tests ──
describe("OpenAI credential cache — initial seed from authInfo", () => {
  it.live("seed creds from authInfo are returned without invoking refresh", () =>
    Effect.gen(function* () {
      const state: IOState = {
        refreshResult: () =>
          Effect.fail(new ProviderAuthError({ message: "should not be called" })),
      }
      const cache = credentialCache(
        makeIO(state),
        makeAuthInfo(
          { lastWritten: EMPTY_PERSISTED_CREDENTIALS, failNext: false },
          {
            access: "seed-access",
            refresh: "seed-refresh",
            expires: FAR_FUTURE,
            accountId: Option.some("acct1"),
          },
        ),
      )
      yield* runWithTestClock(
        Effect.gen(function* () {
          const svc = yield* cache
          const result = yield* svc.getFresh
          expect(result.access).toBe("seed-access")
          expect(result.accountId).toEqual(Option.some("acct1"))
        }),
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
      const authInfo = oauthInfo({
        access: "",
        refresh: "",
        expires: 0,
      })
      const cache = credentialCache(makeIO(state), authInfo)
      const result = yield* runWithTestClock(
        Effect.gen(function* () {
          const svc = yield* cache
          return yield* Effect.exit(svc.getFresh)
        }),
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
describe("OpenAI credential cache — token endpoint timeout", () => {
  it.live("a token endpoint that never answers fails the refresh instead of holding the lock", () =>
    Effect.gen(function* () {
      let fetchCalls = 0
      const hangingFetch = Object.assign(
        () => {
          fetchCalls += 1
          // The endpoint accepted the socket and went silent: a fetch that never settles.
          // oxlint-disable-next-line effect/noNewPromise -- The fake implements the Promise-based Fetch contract.
          return Promise.race<Response>([])
        },
        { preconnect: () => {} },
      )
      const cellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL)
      const driver = buildOpenAIModelDriver(
        cellRef,
        new Map(),
        Option.none(),
        testCatalogSource(),
        hostCrypto,
      )
      const store = makeFakeAuthStore(
        { lastWritten: Option.none(), failNext: false },
        Option.some({ access: "stale-access", refresh: "stale-refresh", expires: 0 }),
      )
      const authInfo = store.authInfo()
      const exit = yield* runWithTestClock(
        Effect.gen(function* () {
          // resolveModel checks the credential, so it runs the refresh.
          const fiber = yield* Effect.forkChild(
            Effect.exit(driver.resolveModel("gpt-5.4", authInfo)),
          )
          yield* Effect.yieldNow.pipe(Effect.repeat({ until: () => fetchCalls > 0, times: 1000 }))
          expect(fetchCalls).toBe(1)
          yield* TestClock.adjust("31 seconds")
          return yield* Fiber.join(fiber)
        }).pipe(Effect.provide(Layer.succeed(FetchHttpClient.Fetch, hangingFetch))),
      ).pipe(Effect.timeout("3 seconds"))
      // The timed-out refresh is a failure that passes: resolveModel returns
      // (the request then fails as retryable), and the stored refresh token
      // is kept for the retry. Without the timeout the join never returns
      // and the 3 s bound fails.
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(Option.map(store.read(), (stored) => stored.refresh)).toEqual(
        Option.some("stale-refresh"),
      )
    }),
  )
})
describe("OpenAI credential cache — refresh on stale", () => {
  it.live("concurrent stale calls share one refresh", () =>
    Effect.gen(function* () {
      const fresh = makeCreds("fresh", FAR_FUTURE)
      const refreshStarted = yield* Deferred.make<void>()
      const releaseRefresh = yield* Deferred.make<void>()
      let refreshCount = 0
      const state: IOState = {
        refreshResult: () =>
          Effect.gen(function* () {
            refreshCount += 1
            yield* Deferred.succeed(refreshStarted, COMPLETE)
            yield* Deferred.await(releaseRefresh)
            return fresh
          }),
      }
      const persistState: PersistState = {
        lastWritten: EMPTY_PERSISTED_CREDENTIALS,
        failNext: false,
      }
      const cache = credentialCache(
        makeIO(state),
        makeAuthInfo(persistState, {
          access: "seed-access",
          refresh: "seed-refresh",
          expires: 30000,
          accountId: Option.none(),
        }),
      )
      yield* runWithTestClock(
        Effect.gen(function* () {
          const svc = yield* cache
          const fiber = yield* Effect.all([svc.getFresh, svc.getFresh], {
            concurrency: 2,
          }).pipe(Effect.forkChild)
          yield* Deferred.await(refreshStarted)
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          expect(refreshCount).toBe(1)
          yield* Deferred.succeed(releaseRefresh, COMPLETE)
          const results = yield* Fiber.join(fiber)
          expect(results[0].access).toBe("fresh-access")
          expect(results[1].access).toBe("fresh-access")
          expect(refreshCount).toBe(1)
          expect(Option.map(persistState.lastWritten, (value) => value.access)).toEqual(
            Option.some("fresh-access"),
          )
        }),
      )
    }),
  )
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
      const persistState: PersistState = {
        lastWritten: EMPTY_PERSISTED_CREDENTIALS,
        failNext: false,
      }
      const cache = credentialCache(
        makeIO(state),
        makeAuthInfo(persistState, {
          access: "seed-access",
          refresh: "seed-refresh",
          expires: 30000,
          accountId: Option.none(),
        }),
      )
      yield* runWithTestClock(
        Effect.gen(function* () {
          const svc = yield* cache
          const result = yield* svc.getFresh
          expect(result.access).toBe("fresh-access")
          expect(Option.map(persistState.lastWritten, (value) => value.access)).toEqual(
            Option.some("fresh-access"),
          )
        }),
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
                accountId: Option.none(),
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
              accountId: Option.none(),
            })
          },
        }
        const persistState: PersistState = {
          lastWritten: EMPTY_PERSISTED_CREDENTIALS,
          failNext: false,
        }
        const cache = credentialCache(
          makeIO(state),
          makeAuthInfo(persistState, {
            access: "seed-access",
            refresh: "seed-refresh",
            expires: 30000,
            accountId: Option.none(),
          }),
        )
        yield* runWithTestClock(
          Effect.gen(function* () {
            const svc = yield* cache
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
          }),
        )
      }),
  )
  it.live("refresh response without accountId carries forward prior accountId", () =>
    Effect.gen(function* () {
      const refreshed: OpenAICredentials = {
        access: "fresh-access",
        refresh: "fresh-refresh",
        expires: FAR_FUTURE,
        accountId: Option.none(),
      }
      const state: IOState = {
        refreshResult: () => Effect.succeed(refreshed),
      }
      const persistState: PersistState = {
        lastWritten: EMPTY_PERSISTED_CREDENTIALS,
        failNext: false,
      }
      const cache = credentialCache(
        makeIO(state),
        makeAuthInfo(persistState, {
          access: "seed-access",
          refresh: "seed-refresh",
          expires: 30000,
          accountId: Option.some("prior-acct"),
        }),
      )
      yield* runWithTestClock(
        Effect.gen(function* () {
          const svc = yield* cache
          const result = yield* svc.getFresh
          expect(result.accountId).toEqual(Option.some("prior-acct"))
          expect(Option.map(persistState.lastWritten, (value) => value.accountId)).toEqual(
            Option.some("prior-acct"),
          )
        }),
      )
    }),
  )
})
describe("OpenAI credential cache — cache hit/miss", () => {
  it.live("returns cached creds within TTL even when source changes", () =>
    Effect.gen(function* () {
      // After the first refresh fills the cell with fresh creds, the
      // second getFresh inside the 30s TTL must NOT call refresh again.
      const fresh1 = makeCreds("k1", FAR_FUTURE)
      const fresh2 = makeCreds("k2", FAR_FUTURE)
      const callsRef = { current: fresh1 } satisfies { current: OpenAICredentials }
      const state: IOState = {
        refreshResult: () => Effect.succeed(callsRef.current),
      }
      const persistState: PersistState = {
        lastWritten: EMPTY_PERSISTED_CREDENTIALS,
        failNext: false,
      }
      const cache = credentialCache(
        makeIO(state),
        makeAuthInfo(persistState, {
          access: "seed-access",
          refresh: "seed-refresh",
          expires: 30000,
          accountId: Option.none(),
        }),
      )
      yield* runWithTestClock(
        Effect.gen(function* () {
          const svc = yield* cache
          const first = yield* svc.getFresh
          callsRef.current = fresh2 // would change refresh result if invoked
          const second = yield* svc.getFresh
          expect(first.access).toBe("k1-access")
          expect(second.access).toBe("k1-access")
        }),
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
      const persistState: PersistState = {
        lastWritten: EMPTY_PERSISTED_CREDENTIALS,
        failNext: false,
      }
      const cache = credentialCache(
        makeIO(state),
        makeAuthInfo(persistState, {
          access: "seed-access",
          refresh: "seed-refresh",
          expires: FAR_FUTURE,
          accountId: Option.none(),
        }),
      )
      yield* runWithTestClock(
        Effect.gen(function* () {
          const svc = yield* cache
          const first = yield* svc.getFresh
          yield* TestClock.adjust("31 seconds")
          const second = yield* svc.getFresh
          expect(first.access).toBe("seed-access")
          expect(second.access).toBe("seed-access")
        }),
      )
    }),
  )
})
describe("OpenAI credential cache — invalidate", () => {
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
      const persistState: PersistState = {
        lastWritten: EMPTY_PERSISTED_CREDENTIALS,
        failNext: false,
      }
      const cache = credentialCache(
        makeIO(state),
        makeAuthInfo(persistState, {
          access: "seed-access",
          refresh: "seed-refresh",
          expires: FAR_FUTURE,
          accountId: Option.none(),
        }),
      )
      yield* runWithTestClock(
        Effect.gen(function* () {
          const svc = yield* cache
          // Seed creds are already fresh — no refresh on first call.
          const seeded = yield* svc.getFresh
          expect(refreshCount).toBe(0)
          // After invalidate the cell is empty, so even with no
          // accessible authInfo seed (cell holds null), the service
          // falls back to authInfo.refresh and forces a refresh call.
          yield* svc.invalidate(seeded)
          const after = yield* svc.getFresh
          expect(after.access).toBe("fresh-access")
          expect(refreshCount).toBe(1)
        }),
      )
    }),
  )
})
describe("OpenAI credential cache — durable persist failure", () => {
  it.live("write-back failure surfaces ProviderAuthError", () =>
    Effect.gen(function* () {
      const fresh = makeCreds("fresh", FAR_FUTURE)
      const state: IOState = {
        refreshResult: () => Effect.succeed(fresh),
      }
      const persistState: PersistState = {
        lastWritten: EMPTY_PERSISTED_CREDENTIALS,
        failNext: true,
      }
      const cache = credentialCache(
        makeIO(state),
        makeAuthInfo(persistState, {
          access: "seed-access",
          refresh: "seed-refresh",
          expires: 30000,
          accountId: Option.none(),
        }),
      )
      const result = yield* runWithTestClock(
        Effect.gen(function* () {
          const svc = yield* cache
          return yield* Effect.exit(svc.getFresh)
        }),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const errOpt = Cause.findErrorOption(result.cause)
        expect(Option.isSome(errOpt)).toBe(true)
        if (Option.isSome(errOpt)) {
          expect(errOpt.value.message).toContain("Failed to persist refreshed OpenAI credentials")
        }
      }
      expect(Option.isNone(persistState.lastWritten)).toBe(true)
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
      const persistState: PersistState = {
        lastWritten: EMPTY_PERSISTED_CREDENTIALS,
        failNext: "typed",
      }
      const cache = credentialCache(
        makeIO(state),
        makeAuthInfo(persistState, {
          access: "seed-access",
          refresh: "seed-refresh",
          expires: 30000,
          accountId: Option.none(),
        }),
      )
      yield* runWithTestClock(
        Effect.gen(function* () {
          const svc = yield* cache
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
          expect(Option.map(persistState.lastWritten, (value) => value.refresh)).toEqual(
            Option.some("fresh-refresh"),
          )
        }),
      )
    }),
  )
})
describe("OpenAI credential cache — invalidate preserves durable refresh token", () => {
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
              accountId: Option.none(),
            })
          }
          return Effect.succeed({
            access: "post-invalidate-access",
            refresh: "post-invalidate-refresh",
            expires: FAR_FUTURE,
            accountId: Option.none(),
          })
        },
      }
      // persist defects on the first write — exactly the lossy path
      // the rotated token must survive.
      const persistState: PersistState = {
        lastWritten: EMPTY_PERSISTED_CREDENTIALS,
        failNext: true,
      }
      const cache = credentialCache(
        makeIO(state),
        makeAuthInfo(persistState, {
          access: "seed-access",
          refresh: "seed-refresh",
          expires: 30000, // forces refresh on first getFresh
          accountId: Option.none(),
        }),
      )
      yield* runWithTestClock(
        Effect.gen(function* () {
          const svc = yield* cache
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
          expect(Option.isNone(persistState.lastWritten)).toBe(true)
          // The rotated credential is the one the cell holds.
          yield* svc.invalidate({
            access: "rotated-access",
            refresh: "rotated-refresh",
            expires: FAR_FUTURE,
            accountId: Option.none(),
          })
          const second = yield* svc.getFresh
          expect(second.access).toBe("post-invalidate-access")
          expect(callTokens[1]).toBe("rotated-refresh")
        }),
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
      const authInfo = oauthInfo({ access: "", refresh: "", expires: 0 })
      const cache = credentialCache(makeIO(state), authInfo)
      yield* runWithTestClock(
        Effect.gen(function* () {
          const svc = yield* cache
          // Invalidate before any successful refresh — cell is empty.
          yield* svc.invalidate(makeCreds("never-held", 0))
          const result = yield* Effect.exit(svc.getFresh)
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
    }),
  )
})
describe("OpenAI credential cache — a shared cell survives rebuilds", () => {
  it.live("two layer builds sharing the same cellRef share the cache", () =>
    Effect.gen(function* () {
      // Counsel  fix: extension-closure-owned Ref must survive across
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
      const persistState: PersistState = {
        lastWritten: EMPTY_PERSISTED_CREDENTIALS,
        failNext: false,
      }
      const authInfo = makeAuthInfo(persistState, {
        access: "seed-access",
        refresh: "seed-refresh",
        expires: 30000, // forces refresh on first getFresh
        accountId: Option.none(),
      })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const cellRef =
            yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(
              EMPTY_CREDENTIAL_CELL,
            )
          // First "resolveModel" build — refreshes once.
          const first = yield* makeOpenAICredentialCache(cellRef, makeIO(state), updateOf(authInfo))
          yield* first.getFresh
          // Second "resolveModel" build with same Ref — must hit cache.
          const second = yield* makeOpenAICredentialCache(
            cellRef,
            makeIO(state),
            updateOf(authInfo),
          )
          const result = yield* second.getFresh
          expect(result.access).toBe("fresh-access")
          expect(refreshCount).toBe(1)
        }),
      ).pipe(Effect.provide(TestClock.layer()), Effect.orDie)
    }),
  )
})
// Suppress unused-warning for Layer (intentional helper import)
void Layer

// ── device-code login ───────────────────────────────────────────────────────

/**
 * OpenAI device-code login. Stubs the three auth.openai.com endpoints
 * through `HttpClient.make` and drives polling with `TestClock`, so the
 * RFC 8628 semantics (pending, slow_down, deadline, denial) are
 * observable without network access.
 */

interface Recorded {
  readonly path: string
  readonly body: string
}

interface StubState {
  readonly calls: Array<Recorded>
  tokenPolls: number
  readonly pollResponses: Array<() => Response>
  readonly usercode: () => Response
}

const json = (status: number, body: string) =>
  new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  })

const requestBody = (request: HttpClientRequest.HttpClientRequest): string => {
  const body = request.body
  if (body._tag === "Uint8Array") return new TextDecoder().decode(body.body)
  return ""
}

const stubLayer = (state: StubState) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.sync(() => {
        state.calls.push({ path: url.pathname, body: requestBody(request) })
        if (url.pathname === "/api/accounts/deviceauth/usercode") {
          return HttpClientResponse.fromWeb(request, state.usercode())
        }
        if (url.pathname === "/api/accounts/deviceauth/token") {
          const next = Option.fromNullishOr(state.pollResponses[state.tokenPolls])
          state.tokenPolls += 1
          const response = Option.match(next, {
            onNone: () => json(403, "{}"),
            onSome: (make) => make(),
          })
          return HttpClientResponse.fromWeb(request, response)
        }
        if (url.pathname === "/oauth/token") {
          return HttpClientResponse.fromWeb(
            request,
            json(
              200,
              '{"access_token":"device-access","refresh_token":"device-refresh","expires_in":3600}',
            ),
          )
        }
        return HttpClientResponse.fromWeb(request, json(500, '{"error":"unexpected"}'))
      }),
    ),
  )

const usercodeOk = () =>
  json(200, '{"device_auth_id":"device-auth-1","user_code":"ABCD-1234","interval":"1"}')

const makeState = (
  pollResponses: Array<() => Response>,
  usercode: () => Response = usercodeOk,
): StubState => ({ calls: [], tokenPolls: 0, pollResponses, usercode })

const settle = Effect.yieldNow

/** A device login end to end: wait for the grant, then trade it. */
const signIn = (flow: Effect.Success<typeof authorizeOpenAIDevice>) =>
  flow.grant().pipe(Effect.flatMap(flow.exchange))

const run = <A, E>(state: StubState, eff: Effect.Effect<A, E, HttpClient.HttpClient>) =>
  Effect.scoped(eff).pipe(Effect.provide(Layer.mergeAll(TestClock.layer(), stubLayer(state))))

const errorReason = (exit: Exit.Exit<unknown, OAuthError>): Option.Option<OAuthError["reason"]> => {
  if (!Exit.isFailure(exit)) return Option.none()
  return Cause.findErrorOption(exit.cause).pipe(Option.map((error) => error.reason))
}

const causeText = (exit: Exit.Exit<unknown, OAuthError>): string => {
  if (!Exit.isFailure(exit)) return ""
  return String(exit.cause)
}

describe("OpenAI device-code login", () => {
  const approvedAfterSlowDown = () =>
    makeState([
      () => json(403, "{}"),
      () => json(400, '{"code":"slow_down"}'),
      () => json(200, '{"authorization_code":"auth-code-1","code_verifier":"verifier-1"}'),
    ])

  it.live("shows the verification URL with the user code and polls until approved", () => {
    const state = approvedAfterSlowDown()
    return run(
      state,
      Effect.gen(function* () {
        const flow = yield* authorizeOpenAIDevice
        expect(flow.authorization.method).toBe("auto")
        expect(flow.authorization.url).toBe("https://auth.openai.com/codex/device")
        // The code stands on its own line, so no wrap splits it.
        expect(flow.authorization.instructions?.split("\n")).toContain("ABCD-1234")
        expect(state.calls[0]?.body).toContain("app_EMoamEEZ73f0CkXaXp7hrann")

        const fiber = yield* Effect.forkChild(signIn(flow))
        yield* settle
        expect(state.tokenPolls).toBe(0)

        yield* TestClock.adjust("1 second")
        yield* settle
        expect(state.tokenPolls).toBe(1)

        yield* TestClock.adjust("1 second")
        yield* settle
        expect(state.tokenPolls).toBe(2)

        // slow_down adds five seconds to the one-second interval.
        yield* TestClock.adjust("5 seconds")
        yield* settle
        expect(state.tokenPolls).toBe(2)

        yield* TestClock.adjust("1 second")
        const tokens = yield* Fiber.join(fiber)
        expect(state.tokenPolls).toBe(3)
        expect(tokens.access).toBe("device-access")
        expect(tokens.refresh).toBe("device-refresh")

        const exchange = state.calls.find((call) => call.path === "/oauth/token")
        expect(exchange?.body).toContain("code=auth-code-1")
        expect(exchange?.body).toContain("code_verifier=verifier-1")
        expect(exchange?.body).toContain(
          `redirect_uri=${encodeURIComponent("https://auth.openai.com/deviceauth/callback")}`,
        )
        const poll = state.calls.find((call) => call.path === "/api/accounts/deviceauth/token")
        expect(poll?.body).toContain('"device_auth_id":"device-auth-1"')
        expect(poll?.body).toContain('"user_code":"ABCD-1234"')
      }),
    )
  })

  it.live("reports device login disabled when the code endpoint returns 404", () => {
    const state = makeState([], () => json(404, "{}"))
    return run(
      state,
      Effect.gen(function* () {
        const exit = yield* Effect.exit(authorizeOpenAIDevice)
        expect(errorReason(exit)).toEqual(Option.some("device-code-failed"))
        expect(causeText(exit)).toContain("not enabled")
      }),
    )
  })

  it.live("fails with device-code-denied when the user rejects the code", () => {
    const state = makeState([() => json(400, '{"code":"access_denied"}')])
    return run(
      state,
      Effect.gen(function* () {
        const flow = yield* authorizeOpenAIDevice
        const fiber = yield* Effect.forkChild(signIn(flow))
        yield* TestClock.adjust("1 second")
        const exit = yield* Fiber.await(fiber)
        expect(errorReason(exit)).toEqual(Option.some("device-code-denied"))
      }),
    )
  })

  it.live("times out after fifteen minutes of pending polls", () => {
    const state = makeState([])
    return run(
      state,
      Effect.gen(function* () {
        const flow = yield* authorizeOpenAIDevice
        const fiber = yield* Effect.forkChild(signIn(flow))
        yield* TestClock.adjust("14 minutes")
        yield* settle
        expect(state.tokenPolls).toBeGreaterThan(0)
        yield* TestClock.adjust("1 minute")
        const exit = yield* Fiber.await(fiber)
        expect(errorReason(exit)).toEqual(Option.some("device-code-timeout"))
      }),
    )
  })

  it.live("registers the device-code method between the browser and API-key methods", () =>
    Effect.gen(function* () {
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL)
      const driver = buildOpenAIModelDriver(
        credentialCellRef,
        new Map(),
        Option.none(),
        testCatalogSource(),
        hostCrypto,
      )
      const methods = Option.fromNullishOr(driver.auth?.methods).pipe(Option.getOrElse(() => []))
      expect(methods.map((method) => `${method.type}:${method.label}`)).toEqual([
        "oauth:ChatGPT Pro/Plus (browser)",
        "oauth:ChatGPT Pro/Plus (device code)",
        "api:Manually enter API key",
      ])
    }),
  )
})

// ── codex transform client ──────────────────────────────────────────────────

/**
 * codexTransformClient — auth-headers middleware.
 *
 * Builds a fake `HttpClient` (via `HttpClient.make`) that captures
 * incoming requests and returns canned responses. The transform under
 * test wraps that fake client; tests assert that the headers seen by
 * the fake match the expected ChatGPT OAuth shape.
 *
 * No global fetch swap; the fake is a real `HttpClient.HttpClient`
 * passed in directly — same composition production uses.
 *
 * Mirrors `anthropic-keychain-transform.test.ts`.
 */
// ── Fake HttpClient ──
interface CapturedRequestCodexTransform {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}
interface TransportFailure {
  readonly _tag: "TransportFailure"
  readonly message: string
}
const hasTransportFailureTag = Predicate.isTagged("TransportFailure")
const isTransportFailure = (v: Response | TransportFailure): v is TransportFailure =>
  hasTransportFailureTag(v)
interface FakeClientState {
  captured: Array<CapturedRequestCodexTransform>
  responder: (call: number) => Response | TransportFailure
}
const respondFirstWith =
  (first: Response | TransportFailure, later: Response | TransportFailure) =>
  (call: number): Response | TransportFailure => {
    if (call === 0) return first
    return later
  }
const makeFakeClient = (state: FakeClientState): HttpClient.HttpClient =>
  HttpClient.make((request) => {
    const headersObj: Record<string, string> = {}
    for (const [key, value] of Object.entries(request.headers)) {
      if (Schema.is(Schema.String)(value)) headersObj[key] = value
    }
    let bodyText = Option.getOrUndefined(Option.none<string>())
    if (request.body._tag === "Uint8Array") {
      bodyText = new TextDecoder().decode(request.body.body)
    } else if (request.body._tag === "Raw" && Schema.is(Schema.String)(request.body.body)) {
      bodyText = request.body.body
    }
    state.captured.push({
      url: request.url,
      method: request.method,
      headers: headersObj,
      body: bodyText,
    })
    const result = state.responder(state.captured.length - 1)
    if (isTransportFailure(result)) {
      return Effect.fail(
        new HttpClientError({
          reason: new TransportError({
            request,
            cause: result,
            description: result.message,
          }),
        }),
      )
    }
    return Effect.succeed(HttpClientResponse.fromWeb(request, result))
  })
const JsonRecordSchema = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
type JsonRecord = Schema.Schema.Type<typeof JsonRecordSchema>
const decodeJsonRecord = (raw: string): Effect.Effect<JsonRecord> =>
  Schema.decodeEffect(JsonRecordSchema)(raw).pipe(Effect.orDie)
// Real Clock here (no TestClock) — `expires` must be a real future
// Unix-millis timestamp comfortably outside the 60s freshness margin.
const FAR_FUTURE_MS = 1_800_000_000_000
const validAuthInfo = (
  overrides?: Partial<{
    access: string
    refresh: string
    accountId: string
  }>,
): ProviderAuthInfo => {
  const access = Option.getOrElse(Option.fromUndefinedOr(overrides?.access), () => "fresh-access")
  const refresh = Option.getOrElse(
    Option.fromUndefinedOr(overrides?.refresh),
    () => "fresh-refresh",
  )
  const accountId = Option.fromUndefinedOr(overrides?.accountId)
  const base = { access, refresh, expires: FAR_FUTURE_MS }
  if (Option.isNone(accountId)) return oauthInfo(base)
  return oauthInfo({ ...base, accountId: accountId.value })
}
const noopRefreshIO = (): OpenAICredentialIO => ({
  refresh: () => Effect.fail(new ProviderAuthError({ message: "should not be called" })),
})
// `HttpBody.jsonUnsafe` mirrors how the OpenAI-compat SDK serializes
// outgoing JSON bodies (via `bodyJsonUnsafe`/`bodyText` → Uint8Array).
const jsonBody = (payload: JsonRecord) => HttpBody.jsonUnsafe(payload)
const runOk = <A, E, R>(eff: Effect.Effect<A, E, R>) => Effect.scoped(eff.pipe(Effect.orDie))
// ── Tests ──
describe("codexTransformClient — auth headers", () => {
  it.scopedLive("injects Authorization Bearer from credential service", () =>
    Effect.gen(function* () {
      const creds = yield* credentialCache(noopRefreshIO(), validAuthInfo({ access: "k1-access" }))
      const fakeState: FakeClientState = {
        captured: [],
        responder: () => new Response("ok", { status: 200 }),
      }
      const transform = buildCodexTransformClient(creds)
      const wrapped = transform(makeFakeClient(fakeState))
      yield* runOk(
        wrapped.post("https://api.openai.com/v1/responses", {
          body: jsonBody({ model: "gpt-5.4" }),
        }),
      )
      expect(fakeState.captured).toHaveLength(1)
      expect(fakeState.captured[0]!.headers["authorization"]).toBe("Bearer k1-access")
    }),
  )
  it.scopedLive("overrides any pre-existing Authorization header", () =>
    Effect.gen(function* () {
      // Defensive: if anything upstream injected a placeholder Bearer,
      // the transform must replace it with the OAuth value.
      const creds = yield* credentialCache(noopRefreshIO(), validAuthInfo({ access: "k1-access" }))
      const fakeState: FakeClientState = {
        captured: [],
        responder: () => new Response("ok", { status: 200 }),
      }
      const transform = buildCodexTransformClient(creds)
      const wrapped = transform(makeFakeClient(fakeState))
      yield* runOk(
        wrapped.post("https://api.openai.com/v1/responses", {
          headers: { authorization: "Bearer placeholder" },
          body: jsonBody({ model: "gpt-5.4" }),
        }),
      )
      expect(fakeState.captured[0]!.headers["authorization"]).toBe("Bearer k1-access")
    }),
  )
  it.scopedLive("sets ChatGPT-Account-Id when present in credentials", () =>
    Effect.gen(function* () {
      const creds = yield* credentialCache(
        noopRefreshIO(),
        validAuthInfo({ access: "k1-access", accountId: "acct-123" }),
      )
      const fakeState: FakeClientState = {
        captured: [],
        responder: () => new Response("ok", { status: 200 }),
      }
      const transform = buildCodexTransformClient(creds)
      const wrapped = transform(makeFakeClient(fakeState))
      yield* runOk(
        wrapped.post("https://api.openai.com/v1/responses", {
          body: jsonBody({ model: "gpt-5.4" }),
        }),
      )
      expect(fakeState.captured[0]!.headers["chatgpt-account-id"]).toBe("acct-123")
    }),
  )
  it.scopedLive("omits ChatGPT-Account-Id when accountId absent", () =>
    Effect.gen(function* () {
      const creds = yield* credentialCache(noopRefreshIO(), validAuthInfo({ access: "k1-access" }))
      const fakeState: FakeClientState = {
        captured: [],
        responder: () => new Response("ok", { status: 200 }),
      }
      const transform = buildCodexTransformClient(creds)
      const wrapped = transform(makeFakeClient(fakeState))
      yield* runOk(
        wrapped.post("https://api.openai.com/v1/responses", {
          body: jsonBody({ model: "gpt-5.4" }),
        }),
      )
      expect(fakeState.captured[0]!.headers["chatgpt-account-id"]).toBeUndefined()
    }),
  )
  it.scopedLive("sets default originator + user-agent when upstream omits them", () =>
    Effect.gen(function* () {
      const creds = yield* credentialCache(noopRefreshIO(), validAuthInfo({ access: "k1-access" }))
      const fakeState: FakeClientState = {
        captured: [],
        responder: () => new Response("ok", { status: 200 }),
      }
      const transform = buildCodexTransformClient(creds)
      const wrapped = transform(makeFakeClient(fakeState))
      yield* runOk(
        wrapped.post("https://api.openai.com/v1/responses", {
          body: jsonBody({ model: "gpt-5.4" }),
        }),
      )
      expect(fakeState.captured[0]!.headers["originator"]).toBe("gent")
      expect(fakeState.captured[0]!.headers["user-agent"]).toBe("gent")
    }),
  )
  it.scopedLive("preserves upstream originator + user-agent when already set", () =>
    Effect.gen(function* () {
      const creds = yield* credentialCache(noopRefreshIO(), validAuthInfo({ access: "k1-access" }))
      const fakeState: FakeClientState = {
        captured: [],
        responder: () => new Response("ok", { status: 200 }),
      }
      const transform = buildCodexTransformClient(creds)
      const wrapped = transform(makeFakeClient(fakeState))
      yield* runOk(
        wrapped.post("https://api.openai.com/v1/responses", {
          headers: { originator: "custom-app", "user-agent": "custom-ua/1.0" },
          body: jsonBody({ model: "gpt-5.4" }),
        }),
      )
      expect(fakeState.captured[0]!.headers["originator"]).toBe("custom-app")
      expect(fakeState.captured[0]!.headers["user-agent"]).toBe("custom-ua/1.0")
    }),
  )
  it.scopedLive("preserves request method, url, and body for non-Codex paths", () =>
    Effect.gen(function* () {
      // The OpenAI-compat SDK ALSO talks to `/embeddings` and other
      // non-Codex endpoints. Those must pass through untouched (auth
      // headers still applied — see other tests). Use the embeddings
      // path here as a non-Codex example.
      const creds = yield* credentialCache(noopRefreshIO(), validAuthInfo({ access: "k1-access" }))
      const fakeState: FakeClientState = {
        captured: [],
        responder: () => new Response("ok", { status: 200 }),
      }
      const transform = buildCodexTransformClient(creds)
      const wrapped = transform(makeFakeClient(fakeState))
      yield* runOk(
        wrapped.post("https://api.openai.com/v1/embeddings", {
          body: jsonBody({ model: "text-embedding-3-small", input: "hello" }),
        }),
      )
      const seen = fakeState.captured[0]!
      expect(seen.method).toBe("POST")
      expect(seen.url).toBe("https://api.openai.com/v1/embeddings")
      expect(seen.body).toBeDefined()
      const parsed = yield* decodeJsonRecord(seen.body ?? "{}")
      expect(parsed["model"]).toBe("text-embedding-3-small")
      expect(parsed["input"]).toBe("hello")
      // No Codex beta header on non-Codex paths.
      expect(seen.headers["openai-beta"]).toBeUndefined()
    }),
  )
  it.scopedLive("surfaces ProviderAuthError from getFresh as HttpClientError", () =>
    Effect.gen(function* () {
      // When credentials are unavailable, the typed ProviderAuthError
      // must reach the client surface as the standard transport error
      // type — that's what keeps the SDK's `transformClient` signature
      // satisfied (`With<HttpClientError, never>`).
      const refreshFails: OpenAICredentialIO = {
        refresh: () => Effect.fail(new ProviderAuthError({ message: "no usable refresh token" })),
      }
      // authInfo with stale access + non-empty refresh forces refresh.
      const stalAuthInfo = oauthInfo({
        access: "stale-access",
        refresh: "stale-refresh",
        expires: 0, // already expired → forces refresh
      })
      const creds = yield* credentialCache(refreshFails, stalAuthInfo)
      const fakeState: FakeClientState = {
        captured: [],
        responder: () => new Response("ok", { status: 200 }),
      }
      const transform = buildCodexTransformClient(creds)
      const wrapped = transform(makeFakeClient(fakeState))
      const result = yield* Effect.scoped(
        wrapped
          .post("https://api.openai.com/v1/responses", {
            body: jsonBody({ model: "gpt-5.4" }),
          })
          .pipe(Effect.exit),
      )
      expect(result._tag).toBe("Failure")
      // Capture stays empty — the request never hit the wire.
      expect(fakeState.captured).toHaveLength(0)
      // The failure surface must be the standard transport error type
      // (HttpClientError with a TransportError reason) so the wrapped
      // client signature stays `With<HttpClientError, never>`. The
      // original ProviderAuthError must be reachable as the cause so
      // upstream error classifiers can still see it.
      if (result._tag !== "Failure") return yield* Effect.die(new Error("expected failure"))
      const failReason = result.cause.reasons.find(
        (r): r is Cause.Fail<HttpClientError> => r._tag === "Fail",
      )
      expect(failReason).toBeDefined()
      const failReasonOption = Option.fromUndefinedOr(failReason)
      if (Option.isNone(failReasonOption)) {
        return yield* Effect.die(new Error("expected fail reason"))
      }
      const err = failReasonOption.value.error
      expect(err).toBeInstanceOf(HttpClientError)
      expect(err.reason).toBeInstanceOf(EncodeError)
      if (!(err.reason instanceof EncodeError)) {
        return yield* Effect.die(new Error("expected request-build error"))
      }
      const reason = err.reason
      expect(Schema.is(ProviderAuthError)(reason.cause)).toBe(true)
      if (!Schema.is(ProviderAuthError)(reason.cause)) {
        return yield* Effect.die(new Error("expected provider auth error"))
      }
      expect(reason.cause.message).toBe("no usable refresh token")
      expect(reason.description).toBe("no usable refresh token")
    }),
  )
  it.scopedLive("calls getFresh per-request (rotated cell wins on second call)", () =>
    Effect.gen(function* () {
      // Ensure the closure-captured creds dispatcher reads the live Ref
      // every time, not a snapshot. Simulate by driving the credential
      // cache through a refresh between two requests.
      let phase: "first" | "after-rotate" = "first"
      const rotateIO: OpenAICredentialIO = {
        refresh: () => {
          if (phase === "first") {
            phase = "after-rotate"
            return Effect.succeed<OpenAICredentials>({
              access: "rotated-access",
              refresh: "rotated-refresh",
              expires: FAR_FUTURE_MS,
              accountId: Option.none(),
            })
          }
          return Effect.fail(new ProviderAuthError({ message: "should not be called twice" }))
        },
      }
      const stalAuthInfo = oauthInfo({
        access: "seed-access",
        refresh: "seed-refresh",
        expires: 0, // forces refresh on first getFresh
      })
      const creds = yield* credentialCache(rotateIO, stalAuthInfo)
      const fakeState: FakeClientState = {
        captured: [],
        responder: () => new Response("ok", { status: 200 }),
      }
      const transform = buildCodexTransformClient(creds)
      const wrapped = transform(makeFakeClient(fakeState))
      yield* runOk(
        wrapped.post("https://api.openai.com/v1/responses", {
          body: jsonBody({ model: "gpt-5.4" }),
        }),
      )
      yield* runOk(
        wrapped.post("https://api.openai.com/v1/responses", {
          body: jsonBody({ model: "gpt-5.4" }),
        }),
      )
      expect(fakeState.captured).toHaveLength(2)
      // First call refreshes seed → rotated; second hits cache and reuses.
      expect(fakeState.captured[0]!.headers["authorization"]).toBe("Bearer rotated-access")
      expect(fakeState.captured[1]!.headers["authorization"]).toBe("Bearer rotated-access")
    }),
  )
})
describe("codexTransformClient — URL/body/beta rewrite", () => {
  // Helpers local to the rewrite tests — keep the auth-header tests above untouched.
  const okResponse = (): FakeClientState => ({
    captured: [],
    responder: () => new Response("ok", { status: 200 }),
  })
  const buildWrapped = (state: FakeClientState) =>
    Effect.gen(function* () {
      const creds = yield* credentialCache(noopRefreshIO(), validAuthInfo({ access: "k1-access" }))
      return buildCodexTransformClient(creds)(makeFakeClient(state))
    })
  it.scopedLive("rewrites /v1/responses URL to the Codex backend endpoint", () =>
    Effect.gen(function* () {
      const state = okResponse()
      const wrapped = yield* buildWrapped(state)
      yield* runOk(
        wrapped.post("https://api.openai.com/v1/responses", {
          body: jsonBody({ model: "gpt-5.4", input: [{ role: "user", content: "hi" }] }),
        }),
      )
      expect(state.captured[0]!.url).toBe("https://chatgpt.com/backend-api/codex/responses")
    }),
  )
  it.scopedLive("does NOT rewrite paths that are not exactly responses", () =>
    Effect.gen(function* () {
      // Exact path equality avoids rewriting sub-resources and other APIs.
      const state = okResponse()
      const wrapped = yield* buildWrapped(state)
      for (const url of [
        "https://api.openai.com/v1/responses/foo",
        "https://api.openai.com/v1/chat/completions",
      ]) {
        yield* runOk(wrapped.post(url, { body: jsonBody({ model: "gpt-5.4" }) }))
      }
      expect(state.captured.map((request) => request.url)).toEqual([
        "https://api.openai.com/v1/responses/foo",
        "https://api.openai.com/v1/chat/completions",
      ])
      expect(state.captured[0]!.headers["openai-beta"]).toBeUndefined()
      expect(state.captured[1]!.headers["openai-beta"]).toBeUndefined()
    }),
  )
  it.scopedLive("sets OpenAI-Beta header on Codex-bound paths", () =>
    Effect.gen(function* () {
      const state = okResponse()
      const wrapped = yield* buildWrapped(state)
      yield* runOk(
        wrapped.post("https://api.openai.com/v1/responses", {
          body: jsonBody({ model: "gpt-5.4" }),
        }),
      )
      expect(state.captured[0]!.headers["openai-beta"]).toBe("responses=experimental")
    }),
  )
  it.scopedLive(
    "merges responses=experimental into a pre-existing OpenAI-Beta header (preserve other tokens)",
    () =>
      Effect.gen(function* () {
        // If upstream sets a custom beta value, we must still ensure
        // `responses=experimental` is present — pure preservation would
        // let Codex reject our traffic if the SDK ever starts injecting a
        // different beta token. Append the required token if missing;
        // preserve every other token unchanged.
        const state = okResponse()
        const wrapped = yield* buildWrapped(state)
        yield* runOk(
          wrapped.post("https://api.openai.com/v1/responses", {
            headers: { "openai-beta": "custom=value" },
            body: jsonBody({ model: "gpt-5.4" }),
          }),
        )
        expect(state.captured[0]!.headers["openai-beta"]).toBe(
          "custom=value, responses=experimental",
        )
      }),
  )
  it.scopedLive("does not duplicate responses=experimental when it's already present", () =>
    Effect.gen(function* () {
      const state = okResponse()
      const wrapped = yield* buildWrapped(state)
      yield* runOk(
        wrapped.post("https://api.openai.com/v1/responses", {
          headers: { "openai-beta": "custom=value, responses=experimental" },
          body: jsonBody({ model: "gpt-5.4" }),
        }),
      )
      expect(state.captured[0]!.headers["openai-beta"]).toBe("custom=value, responses=experimental")
    }),
  )
  it.scopedLive("structured input_text system/developer content lifts into instructions", () =>
    Effect.gen(function* () {
      const state = okResponse()
      const wrapped = yield* buildWrapped(state)
      const structured = { role: "system", content: [{ type: "input_text", text: "structured" }] }
      yield* runOk(
        wrapped.post("https://api.openai.com/v1/responses", {
          body: jsonBody({
            model: "gpt-5.4",
            input: [
              { role: "system", content: "string-instructions" },
              structured,
              { role: "user", content: "hi" },
            ],
          }),
        }),
      )
      const parsed = yield* decodeJsonRecord(state.captured[0]!.body!)
      expect(parsed["instructions"]).toBe("string-instructions\n\nstructured")
      expect(parsed["input"]).toEqual([{ role: "user", content: "hi" }])
    }),
  )
  it.scopedLive("later context updates preserve the instruction prefix and tool history", () =>
    Effect.gen(function* () {
      const state = okResponse()
      const wrapped = yield* buildWrapped(state)
      const history = [
        { role: "user", content: "Read the file." },
        { type: "function_call", call_id: "stable-call", name: "cell", arguments: "{}" },
        { type: "function_call_output", call_id: "stable-call", output: "saved result" },
      ]
      const update = { role: "system", content: "Today's date is now: 2026-09-09" }
      for (const tail of [history, [...history, update]]) {
        yield* wrapped.post("https://api.openai.com/v1/responses", {
          body: jsonBody({
            model: "gpt-5.6-luna",
            instructions: "Fixed provider instructions.",
            input: [{ role: "system", content: "Fixed session instructions." }, ...tail],
          }),
        })
      }
      const bodies = yield* Effect.forEach(state.captured, (request) =>
        decodeJsonRecord(Option.getOrThrow(Option.fromUndefinedOr(request.body))),
      )
      const first = Option.getOrThrow(Option.fromUndefinedOr(bodies[0]))
      const second = Option.getOrThrow(Option.fromUndefinedOr(bodies[1]))
      expect(first["instructions"]).toBe(
        "Fixed provider instructions.\n\nFixed session instructions.",
      )
      expect(second["instructions"]).toBe(first["instructions"])
      expect(first["input"]).toEqual(history)
      expect(second["input"]).toEqual([...history, { ...update, role: "developer" }])
    }),
  )
  it.scopedLive("a turn notice arrives after the conversation as the host, not the user", () =>
    Effect.gen(function* () {
      const state = okResponse()
      const wrapped = yield* buildWrapped(state)
      const conversation = [{ role: "user", content: "What is running?" }]
      const notice = Option.getOrThrow(
        turnNoticesText([{ id: "stopped", content: "# Stopped children\n\n- one", keys: [] }]),
      )
      for (const tail of [conversation, [...conversation, { role: "system", content: notice }]]) {
        yield* wrapped.post("https://api.openai.com/v1/responses", {
          body: jsonBody({
            model: "gpt-5.6-luna",
            input: [{ role: "system", content: "Fixed session instructions." }, ...tail],
          }),
        })
      }
      const [plain, noticed] = yield* Effect.forEach(state.captured, (request) =>
        decodeJsonRecord(Option.getOrThrow(Option.fromUndefinedOr(request.body))),
      )
      expect(noticed?.["instructions"]).toBe(plain?.["instructions"])
      expect(noticed?.["input"]).toEqual([
        ...conversation,
        {
          role: "developer",
          content:
            "Host status for this turn, not a message from the user.\n\n# Stopped children\n\n- one",
        },
      ])
    }),
  )
  it.scopedLive("drops sampling limits the Codex backend rejects", () =>
    Effect.gen(function* () {
      const state = okResponse()
      const wrapped = yield* buildWrapped(state)
      yield* runOk(
        wrapped.post("https://api.openai.com/v1/responses", {
          body: jsonBody({
            model: "gpt-5.6-luna",
            max_output_tokens: 4096,
            temperature: 0.2,
            reasoning: { effort: "max" },
            input: [{ role: "user", content: "hi" }],
          }),
        }),
      )
      const parsed = yield* decodeJsonRecord(state.captured[0]!.body!)
      expect(parsed["max_output_tokens"]).toBeUndefined()
      expect(parsed["temperature"]).toBeUndefined()
      expect(parsed["reasoning"]).toEqual({ effort: "max" })
    }),
  )
  it.scopedLive(
    "rewrites JSON body: lifts system/developer items into top-level instructions, sets store=false",
    () =>
      Effect.gen(function* () {
        const state = okResponse()
        const wrapped = yield* buildWrapped(state)
        yield* runOk(
          wrapped.post("https://api.openai.com/v1/responses", {
            body: jsonBody({
              model: "gpt-5.4",
              input: [
                { role: "system", content: "You are gent." },
                { role: "developer", content: "Be terse." },
                { role: "user", content: "hi" },
              ],
            }),
          }),
        )
        const seen = state.captured[0]!
        expect(seen.body).toBeDefined()
        const parsed = yield* decodeJsonRecord(seen.body!)
        expect(parsed["instructions"]).toBe("You are gent.\n\nBe terse.")
        expect(parsed["input"]).toEqual([{ role: "user", content: "hi" }])
        expect(parsed["store"]).toBe(false)
        expect(parsed["model"]).toBe("gpt-5.4")
      }),
  )
  it.scopedLive("Codex-bound body with no instructions gets a non-empty default", () =>
    Effect.gen(function* () {
      const state = okResponse()
      const wrapped = yield* buildWrapped(state)
      yield* runOk(
        wrapped.post("https://api.openai.com/v1/responses", {
          body: jsonBody({ model: "gpt-5.4", input: [] }),
        }),
      )
      const parsed = yield* decodeJsonRecord(state.captured[0]!.body!)
      expect(parsed["instructions"]).toBe("You are a helpful assistant.")
      expect(parsed["store"]).toBe(false)
    }),
  )
  it.scopedLive(
    "body with input but no system/developer items: default instructions injected, store=false set",
    () =>
      Effect.gen(function* () {
        const state = okResponse()
        const wrapped = yield* buildWrapped(state)
        yield* runOk(
          wrapped.post("https://api.openai.com/v1/responses", {
            body: jsonBody({
              model: "gpt-5.4",
              input: [{ role: "user", content: "hi" }],
            }),
          }),
        )
        const parsed = yield* decodeJsonRecord(state.captured[0]!.body!)
        expect(parsed["instructions"]).toBe("You are a helpful assistant.")
        expect(parsed["input"]).toEqual([{ role: "user", content: "hi" }])
        expect(parsed["store"]).toBe(false)
      }),
  )
  it.scopedLive("non-Codex path: body untouched even when it carries an input array", () =>
    Effect.gen(function* () {
      const state = okResponse()
      const wrapped = yield* buildWrapped(state)
      const original = {
        model: "text-embedding-3-small",
        input: [{ role: "system", content: "should-not-be-lifted" }],
      }
      yield* runOk(
        wrapped.post("https://api.openai.com/v1/embeddings", {
          body: jsonBody(original),
        }),
      )
      const parsed = yield* decodeJsonRecord(state.captured[0]!.body!)
      expect(parsed).toEqual(original)
      expect(state.captured[0]!.url).toBe("https://api.openai.com/v1/embeddings")
    }),
  )
  it.scopedLive("auth headers still apply on Codex-rewritten requests", () =>
    Effect.gen(function* () {
      // Belt-and-suspenders: the URL/body rewrite path must not strip
      // the OAuth Bearer / ChatGPT-Account-Id added by the auth-header
      // preprocess.
      const creds = yield* credentialCache(
        noopRefreshIO(),
        validAuthInfo({ access: "k1-access", accountId: "acc-123" }),
      )
      const state = okResponse()
      const wrapped = buildCodexTransformClient(creds)(makeFakeClient(state))
      yield* runOk(
        wrapped.post("https://api.openai.com/v1/responses", {
          body: jsonBody({ model: "gpt-5.4" }),
        }),
      )
      expect(state.captured[0]!.headers["authorization"]).toBe("Bearer k1-access")
      expect(state.captured[0]!.headers["chatgpt-account-id"]).toBe("acc-123")
      expect(state.captured[0]!.url).toBe("https://chatgpt.com/backend-api/codex/responses")
    }),
  )
})
describe("codexTransformClient — 401 recovery", () => {
  // The credential cache TTL (30s) can outlive a token's last minute,
  // and OAuth tokens can be revoked server-side between cache fill and
  // wire send. On 401: invalidate the cache + retry once. A second 401
  // surfaces the response so the user can re-authorize.
  it.scopedLive("stale token + 401 → invalidate + retry succeeds with rotated token", () =>
    Effect.gen(function* () {
      // First refresh seeds with "stale-access" (expired authInfo); after
      // the wire returns 401, the credential service is invalidated, and
      // the next preprocess re-enters → second refresh returns
      // "rotated-access". The retried request goes through and succeeds.
      let refreshCount = 0
      const rotateIO: OpenAICredentialIO = {
        refresh: () =>
          Effect.sync(() => {
            refreshCount += 1
            if (refreshCount === 1) {
              return {
                access: "stale-access",
                refresh: "stale-refresh",
                expires: FAR_FUTURE_MS,
                accountId: Option.none(),
              }
            }
            return {
              access: "rotated-access",
              refresh: "rotated-refresh",
              accountId: Option.none(),
              expires: FAR_FUTURE_MS,
            }
          }),
      }
      // Empty access on authInfo forces an initial refresh (otherwise the
      // cache hits with the seed token and never calls our IO).
      const stalAuthInfo = oauthInfo({
        access: "",
        refresh: "seed-refresh",
        expires: 0,
      })
      const creds = yield* credentialCache(rotateIO, stalAuthInfo)
      const state: FakeClientState = {
        captured: [],
        // First call returns 401, second returns 200.
        responder: respondFirstWith(
          new Response("unauthorized", { status: 401 }),
          new Response("ok", { status: 200 }),
        ),
      }
      const wrapped = buildCodexTransformClient(creds)(makeFakeClient(state))
      const response = yield* runOk(
        wrapped.post("https://api.openai.com/v1/responses", {
          body: jsonBody({ model: "gpt-5.4" }),
        }),
      )
      expect(response.status).toBe(200)
      expect(state.captured).toHaveLength(2)
      // First attempt used the stale token; the retry used the rotated.
      expect(state.captured[0]!.headers["authorization"]).toBe("Bearer stale-access")
      expect(state.captured[1]!.headers["authorization"]).toBe("Bearer rotated-access")
      expect(refreshCount).toBe(2)
    }),
  )
  it.scopedLive("double 401 surfaces the response (no infinite retry)", () =>
    Effect.gen(function* () {
      // Both wire attempts return 401. After invalidate + retry, the
      // second 401 must surface as a 401 response (not a typed error,
      // not another retry) so user-facing recovery can kick in.
      const noopRotateIO: OpenAICredentialIO = {
        refresh: () =>
          Effect.succeed<OpenAICredentials>({
            access: "always-stale",
            refresh: "always-stale-refresh",
            expires: FAR_FUTURE_MS,
            accountId: Option.none(),
          }),
      }
      const stalAuthInfo = oauthInfo({
        access: "",
        refresh: "seed",
        expires: 0,
      })
      const creds = yield* credentialCache(noopRotateIO, stalAuthInfo)
      const state: FakeClientState = {
        captured: [],
        responder: () => new Response("unauthorized", { status: 401 }),
      }
      const wrapped = buildCodexTransformClient(creds)(makeFakeClient(state))
      const response = yield* runOk(
        wrapped.post("https://api.openai.com/v1/responses", {
          body: jsonBody({ model: "gpt-5.4" }),
        }),
      )
      expect(response.status).toBe(401)
      // Exactly two attempts: original + one retry.
      expect(state.captured).toHaveLength(2)
    }),
  )
  it.scopedLive("non-401 errors do NOT trigger retry", () =>
    Effect.gen(function* () {
      // 500 (or any non-401) must pass through verbatim — only 401 is
      // the auth-recovery signal.
      const noopRotateIO: OpenAICredentialIO = {
        refresh: () => Effect.fail(new ProviderAuthError({ message: "should not be called" })),
      }
      const validInfo = validAuthInfo({ access: "fresh-access" })
      const creds = yield* credentialCache(noopRotateIO, validInfo)
      const state: FakeClientState = {
        captured: [],
        responder: () => new Response("server error", { status: 500 }),
      }
      const wrapped = buildCodexTransformClient(creds)(makeFakeClient(state))
      const response = yield* runOk(
        wrapped.post("https://api.openai.com/v1/responses", {
          body: jsonBody({ model: "gpt-5.4" }),
        }),
      )
      expect(response.status).toBe(500)
      // No retry on 500 → exactly one attempt.
      expect(state.captured).toHaveLength(1)
    }),
  )
  it.scopedLive("200 OK never triggers retry", () =>
    Effect.gen(function* () {
      const noopRotateIO: OpenAICredentialIO = {
        refresh: () => Effect.fail(new ProviderAuthError({ message: "should not be called" })),
      }
      const creds = yield* credentialCache(noopRotateIO, validAuthInfo({ access: "fresh-access" }))
      const state: FakeClientState = {
        captured: [],
        responder: () => new Response("ok", { status: 200 }),
      }
      const wrapped = buildCodexTransformClient(creds)(makeFakeClient(state))
      const response = yield* runOk(
        wrapped.post("https://api.openai.com/v1/responses", {
          body: jsonBody({ model: "gpt-5.4" }),
        }),
      )
      expect(response.status).toBe(200)
      expect(state.captured).toHaveLength(1)
    }),
  )
  it.scopedLive(
    "401 → invalidate → retry refresh fails surfaces ProviderAuthError as HttpClientError",
    () =>
      Effect.gen(function* () {
        // Edge case: first wire call returns 401 with a valid initial
        // token. Invalidate fires, retry triggers a re-read of creds, and
        // the rotation IO fails with ProviderAuthError on the second
        // refresh. The caller must see HttpClientError with
        // TransportError.cause = ProviderAuthError — same surface as the
        // pre-wire credential failure path. This locks in that the recovery
        // chain doesn't swallow auth errors that surface during the retry.
        let refreshCount = 0
        const rotateThenFailIO: OpenAICredentialIO = {
          refresh: () =>
            Effect.suspend(() => {
              refreshCount += 1
              if (refreshCount === 1) {
                return Effect.succeed<OpenAICredentials>({
                  access: "first-access",
                  refresh: "first-refresh",
                  expires: FAR_FUTURE_MS,
                  accountId: Option.none(),
                })
              }
              return Effect.fail(new ProviderAuthError({ message: "rotation failed mid-recovery" }))
            }),
        }
        const stalAuthInfo = oauthInfo({
          access: "",
          refresh: "seed-refresh",
          expires: 0,
        })
        const creds = yield* credentialCache(rotateThenFailIO, stalAuthInfo)
        const state: FakeClientState = {
          captured: [],
          responder: () => new Response("unauthorized", { status: 401 }),
        }
        const wrapped = buildCodexTransformClient(creds)(makeFakeClient(state))
        const result = yield* Effect.scoped(
          wrapped
            .post("https://api.openai.com/v1/responses", {
              body: jsonBody({ model: "gpt-5.4" }),
            })
            .pipe(Effect.exit),
        )
        expect(result._tag).toBe("Failure")
        if (result._tag !== "Failure") return yield* Effect.die(new Error("expected failure"))
        const failReason = result.cause.reasons.find(
          (r): r is Cause.Fail<HttpClientError> => r._tag === "Fail",
        )
        expect(failReason).toBeDefined()
        const failReasonOption = Option.fromUndefinedOr(failReason)
        if (Option.isNone(failReasonOption)) {
          return yield* Effect.die(new Error("expected fail reason"))
        }
        const err = failReasonOption.value.error
        expect(err).toBeInstanceOf(HttpClientError)
        expect(err.reason).toBeInstanceOf(EncodeError)
        if (!(err.reason instanceof EncodeError)) {
          return yield* Effect.die(new Error("expected request-build error"))
        }
        const reason = err.reason
        expect(Schema.is(ProviderAuthError)(reason.cause)).toBe(true)
        if (!Schema.is(ProviderAuthError)(reason.cause)) {
          return yield* Effect.die(new Error("expected provider auth error"))
        }
        expect(reason.cause.message).toBe("rotation failed mid-recovery")
        // Exactly one wire call: the original 401. The retry never reaches
        // the wire because preprocess (creds.getFresh) fails first.
        expect(state.captured).toHaveLength(1)
        // Two refreshes: cache fill (succeeds) + post-invalidate re-read (fails).
        expect(refreshCount).toBe(2)
      }),
  )
})

// ── model driver ────────────────────────────────────────────────────────────

/**
 * OpenAIExtension model-driver wiring — extension-level regression
 * coverage for `buildOpenAIModelDriver` / `resolveModel`.
 *
 * The leaf-service suites (`openai-credential-service.test.ts`,
 * `openai-codex-transform.test.ts`) cover services in isolation. This
 * file drives one real `LanguageModel.generateText` through the
 * resolved layer with a captured fake `fetch`, then asserts on the
 * outbound request shape. That proves the resolved layer's production
 * wiring uses the test-owned `Ref` and applies the Codex transforms
 * (or doesn't, on the API-key branch).
 *
 * Mirrors `anthropic-extension-driver.test.ts`. The leaf-service
 * suites passed even when `resolveModel` regressed to allocating a
 * fresh internal Ref per call. The same trap exists for OpenAI's
 * credential cache cell.
 */
// Far-future expiry so cache hits the warm branch and `getFresh` skips
// the refresh round-trip (avoids hitting auth.openai.com from tests).
const NOW_MS = 1_700_000_000_000
// The stored sign-in behind the cells these tests plant: the same refresh
// token ("r"), so a planted cell is that sign-in's current credential.
const makeOAuthInfo = (): ProviderAuthInfo =>
  oauthInfo({ access: "test-access", refresh: "r", expires: FAR_FUTURE_MS })
const makeApiAuthInfo = (key: string): ProviderAuthInfo => ProviderAuthInfo.cases.Api.make({ key })
const makeDurableCell = (creds: OpenAICredentials): CredentialCacheCell<OpenAICredentials> => ({
  _tag: "Durable",
  creds,
  at: NOW_MS,
  invalidated: false,
})
const noopCallbacks = () => new Map()
const openaiResponsesBody = {
  id: "resp-test-1",
  object: "response",
  created_at: 1700000000,
  model: "gpt-5.4",
  output: [
    {
      id: "msg-test-1",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "ok", annotations: [], logprobs: [] }],
    },
  ],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
}
const openaiResponsesHappyResponse = () => ({
  status: 200,
  body: encodeExternalJson(openaiResponsesBody),
})
const runOne = (layer: Parameters<typeof oneGenerate>[0], state: FakeFetchState) =>
  oneGenerate(layer, state, openaiResponsesHappyResponse).pipe(Effect.orDie)

const runStream = (layer: Parameters<typeof oneGenerate>[0], state: FakeFetchState) =>
  LanguageModel.streamText({ prompt: "hi" }).pipe(
    Stream.runDrain,
    Effect.provide(
      Layer.provideMerge(
        layer,
        fakeFetchLayer(state, () => ({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: `data: ${encodeExternalJson({
            type: "response.completed",
            sequence_number: 0,
            response: openaiResponsesBody,
          })}\n\n`,
        })),
      ),
    ),
    Effect.scoped,
  )

describe("OpenAI cache routing", () => {
  it.live("API-key requests preserve cache routing for generation and streaming", () =>
    Effect.gen(function* () {
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL)
      const driver = buildOpenAIModelDriver(
        credentialCellRef,
        noopCallbacks(),
        Option.none(),
        testCatalogSource(),
        hostCrypto,
      )
      const codec = Schema.fromJsonString(
        Schema.Struct({ prompt_cache_key: Schema.optional(Schema.String) }),
      )
      const cacheKeys = [
        Option.some("same-session"),
        Option.some("same-session"),
        Option.some("other-session"),
        Option.none<string>(),
      ]
      for (const streaming of [false, true]) {
        const fetchState = makeFakeFetchState()
        for (const cacheKey of cacheKeys) {
          const model = yield* driver.resolveModel("gpt-5.4", makeApiAuthInfo("cache-test-key"), {
            cacheKey: Option.getOrUndefined(cacheKey),
          })
          if (streaming) {
            yield* runStream(model, fetchState)
          } else {
            yield* runOne(model, fetchState)
          }
        }
        const keys = yield* Effect.forEach(fetchState.captured, (request) =>
          Effect.gen(function* () {
            expect(request.url).toBe("https://api.openai.com/v1/responses")
            expect(request.headers["authorization"]).toBe("Bearer cache-test-key")
            const body = Option.getOrThrow(Option.fromUndefinedOr(request.body))
            expect(body).not.toContain("previous_response_id")
            return Option.fromUndefinedOr(
              (yield* Schema.decodeEffect(codec)(body)).prompt_cache_key,
            )
          }),
        )
        expect(keys).toEqual(cacheKeys)
      }
    }),
  )

  it.live("OAuth requests retain the supplied cache key across calls", () =>
    Effect.gen(function* () {
      const credentialCellRef = yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(
        makeDurableCell({
          access: "cache-test-token",
          refresh: "r",
          expires: FAR_FUTURE_MS,
          accountId: Option.none(),
        }),
      )
      const driver = buildOpenAIModelDriver(
        credentialCellRef,
        noopCallbacks(),
        Option.none(),
        testCatalogSource(),
        hostCrypto,
      )
      const codec = Schema.fromJsonString(Schema.Struct({ prompt_cache_key: Schema.String }))
      const fetchState = makeFakeFetchState()
      for (const cacheKey of ["same-session", "same-session", "other-session"]) {
        const model = yield* driver.resolveModel("gpt-5.4", makeOAuthInfo(), { cacheKey })
        yield* runOne(model, fetchState)
      }
      const keys = yield* Effect.forEach(fetchState.captured, (request) =>
        Schema.decodeEffect(codec)(Option.getOrThrow(Option.fromUndefinedOr(request.body))).pipe(
          Effect.map((body) => body.prompt_cache_key),
        ),
      )
      expect(keys).toEqual(["same-session", "same-session", "other-session"])
    }),
  )

  // ChatGPT routes cache affinity by the Responses `session-id` header, not
  // by `prompt_cache_key` (codex-rs `core/src/client.rs`, `responses_session_id`).
  it.live("OAuth requests name their session in the session-id header", () =>
    Effect.gen(function* () {
      const credentialCellRef = yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(
        makeDurableCell({
          access: "cache-test-token",
          refresh: "r",
          expires: FAR_FUTURE_MS,
          accountId: Option.none(),
        }),
      )
      const driver = buildOpenAIModelDriver(
        credentialCellRef,
        noopCallbacks(),
        Option.none(),
        testCatalogSource(),
        hostCrypto,
      )
      const fetchState = makeFakeFetchState()
      for (const cacheKey of ["same-session", "same-session", "other-session"]) {
        const model = yield* driver.resolveModel("gpt-5.4", makeOAuthInfo(), { cacheKey })
        yield* runOne(model, fetchState)
      }
      const model = yield* driver.resolveModel("gpt-5.4", makeOAuthInfo())
      yield* runOne(model, fetchState)
      expect(
        fetchState.captured.map((request) => Option.fromUndefinedOr(request.headers["session-id"])),
      ).toEqual([
        Option.some("same-session"),
        Option.some("same-session"),
        Option.some("other-session"),
        Option.none(),
      ])
    }),
  )
})

const ReadTool = Tool.make("read", {
  description: "Read a file.",
  parameters: Schema.Struct({ path: Schema.String }),
  success: Schema.String,
})

const ReplayedInput = Schema.fromJsonString(
  Schema.Struct({
    input: Schema.Array(
      Schema.Struct({
        type: Schema.optional(Schema.String),
        id: Schema.optional(Schema.String),
        encrypted_content: Schema.optional(Schema.String),
      }),
    ),
  }),
)

describe("OpenAI reasoning replay", () => {
  // The parts the loop stores for a step that reasoned, then called a tool.
  const conversation = Prompt.make([
    { role: "user", content: "Read a.txt." },
    {
      role: "assistant",
      content: [
        Prompt.makePart("reasoning", {
          text: "",
          options: { openai: { itemId: "rs_1", encryptedContent: "enc-1" } },
        }),
        Prompt.makePart("tool-call", {
          id: "call_read",
          name: "read",
          params: { path: "a.txt" },
          providerExecuted: false,
          options: { openai: { itemId: "fc_1" } },
        }),
      ],
    },
    {
      role: "tool",
      content: [
        Prompt.makePart("tool-result", {
          id: "call_read",
          name: "read",
          result: "alpha",
          isFailure: false,
          providerExecuted: false,
        }),
      ],
    },
  ])

  it.live("a later step sends the encrypted reasoning item back on both paths", () =>
    Effect.gen(function* () {
      const credentialCellRef = yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(
        makeDurableCell({
          access: "replay-token",
          refresh: "r",
          expires: FAR_FUTURE_MS,
          accountId: Option.none(),
        }),
      )
      const driver = buildOpenAIModelDriver(
        credentialCellRef,
        noopCallbacks(),
        Option.none(),
        testCatalogSource(),
        hostCrypto,
      )
      for (const authInfo of [makeApiAuthInfo("sk-replay"), makeOAuthInfo()]) {
        const model = yield* driver.resolveModel("gpt-5.4", authInfo, { reasoning: "high" })
        const state = makeFakeFetchState()
        yield* LanguageModel.generateText({
          prompt: conversation,
          toolkit: Toolkit.make(ReadTool),
          disableToolCallResolution: true,
        }).pipe(
          Effect.provide(
            Layer.provideMerge(model, fakeFetchLayer(state, openaiResponsesHappyResponse)),
          ),
          Effect.scoped,
          Effect.orDie,
        )
        const sent = yield* Schema.decodeEffect(ReplayedInput)(
          Option.getOrThrow(Option.fromUndefinedOr(state.captured.at(-1)?.body)),
        )
        const reasoning = sent.input.filter((item) => item.type === "reasoning")
        expect(reasoning).toEqual([{ type: "reasoning", id: "rs_1", encrypted_content: "enc-1" }])
        // The reasoning item goes right before the call it led to.
        const types = sent.input.map((item) => item.type)
        expect(types.indexOf("function_call")).toBe(types.indexOf("reasoning") + 1)
      }
    }),
  )

  // Encrypted reasoning is bound to the model and to the organization that
  // produced it (openai/codex#17541; the LiteLLM "Encrypted Content Failures"
  // incident report: "Encrypted content organization_id did not match the
  // target organization"). A sign-in to another account, or a switch between
  // the ChatGPT sign-in and an API key, makes stored items undecryptable.
  it.live(
    "a reasoning item the account cannot decrypt is dropped and the request retried, and not sent again",
    () =>
      Effect.gen(function* () {
        const rejection = encodeExternalJson({
          error: {
            message: "The encrypted content for item rs_1 could not be verified.",
            type: "invalid_request_error",
            code: "invalid_encrypted_content",
          },
        })
        const responder = (req: { readonly body?: string }) => {
          if (req.body?.includes("enc-1") === true) {
            return { status: 400, body: rejection, headers: { "content-type": "application/json" } }
          }
          return openaiResponsesHappyResponse()
        }
        const reasoningSent = (state: FakeFetchState) =>
          state.captured.map((req) => req.body?.includes('"rs_1"') === true)
        const credentialCellRef = yield* SynchronizedRef.make<
          CredentialCacheCell<OpenAICredentials>
        >(
          makeDurableCell({
            access: "replay-token",
            refresh: "r",
            expires: FAR_FUTURE_MS,
            accountId: Option.none(),
          }),
        )
        for (const authInfo of [makeApiAuthInfo("sk-replay"), makeOAuthInfo()]) {
          const driver = buildOpenAIModelDriver(
            credentialCellRef,
            noopCallbacks(),
            Option.none(),
            testCatalogSource(),
            hostCrypto,
          )
          const generate = (state: FakeFetchState) =>
            Effect.gen(function* () {
              const model = yield* driver.resolveModel("gpt-5.4", authInfo, { reasoning: "high" })
              return yield* LanguageModel.generateText({
                prompt: conversation,
                toolkit: Toolkit.make(ReadTool),
                disableToolCallResolution: true,
              }).pipe(
                Effect.provide(Layer.provideMerge(model, fakeFetchLayer(state, responder))),
                Effect.scoped,
                Effect.orDie,
              )
            })
          const first = makeFakeFetchState()
          yield* generate(first)
          expect(reasoningSent(first)).toEqual([true, false])
          // The next step of the session leaves the rejected item out from the start.
          const later = makeFakeFetchState()
          yield* generate(later)
          expect(reasoningSent(later)).toEqual([false])
        }
      }),
  )

  it.live("another 400 on a request with reasoning is not retried and keeps its message", () =>
    Effect.gen(function* () {
      const credentialCellRef = yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(
        makeDurableCell({
          access: "replay-token",
          refresh: "r",
          expires: FAR_FUTURE_MS,
          accountId: Option.none(),
        }),
      )
      const driver = buildOpenAIModelDriver(
        credentialCellRef,
        noopCallbacks(),
        Option.none(),
        testCatalogSource(),
        hostCrypto,
      )
      const other = encodeExternalJson({
        error: {
          message: "Input exceeds the context window.",
          type: "invalid_request_error",
          param: "input",
          code: "context_length_exceeded",
        },
      })
      const state = makeFakeFetchState()
      const model = yield* driver.resolveModel("gpt-5.4", makeApiAuthInfo("sk-replay"), {
        reasoning: "high",
      })
      const exit = yield* LanguageModel.generateText({
        prompt: conversation,
        toolkit: Toolkit.make(ReadTool),
        disableToolCallResolution: true,
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            model,
            fakeFetchLayer(state, () => ({
              status: 400,
              body: other,
              headers: { "content-type": "application/json" },
            })),
          ),
        ),
        Effect.scoped,
        Effect.exit,
      )
      expect(state.captured.length).toBe(1)
      expect(Exit.isFailure(exit) && Cause.pretty(exit.cause).includes("context window")).toBe(true)
    }),
  )
})

describe("OpenAI reasoning hints", () => {
  const sentEffort = (body: string): Option.Option<unknown> => {
    const parsed = Schema.decodeOption(
      Schema.fromJsonString(
        Schema.Struct({
          reasoning: Schema.optional(Schema.Struct({ effort: Schema.String })),
        }),
      ),
    )(body)
    return Option.flatMap(parsed, (value) => Option.fromUndefinedOr(value.reasoning?.effort))
  }
  const effortsFor = (
    authInfo: ProviderAuthInfo,
    models: ReadonlyArray<string>,
    reasoning: ProviderHints["reasoning"] = "none",
    catalog: ProviderHints = {},
  ) =>
    Effect.gen(function* () {
      const credentialCellRef = yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(
        makeDurableCell({
          access: "hint-test-token",
          refresh: "r",
          expires: FAR_FUTURE_MS,
          accountId: Option.none(),
        }),
      )
      const driver = buildOpenAIModelDriver(
        credentialCellRef,
        noopCallbacks(),
        Option.none(),
        testCatalogSource(),
        hostCrypto,
      )
      const fetchState = makeFakeFetchState()
      for (const modelName of models) {
        const model = yield* driver.resolveModel(modelName, authInfo, {
          ...catalog,
          reasoning,
          maxTokens: 768,
        })
        yield* runOne(model, fetchState)
      }
      return fetchState.captured.map((request) =>
        sentEffort(Option.getOrThrow(Option.fromUndefinedOr(request.body))),
      )
    })

  it.live(
    "a request for no reasoning names the lowest effort the model accepts, on both paths",
    () =>
      Effect.gen(function* () {
        // Each floor is the model page's lowest `reasoning.effort` (developers.openai.com/api/docs/models).
        const reasoningModels = [
          "gpt-5.4",
          "gpt-5.6-sol",
          "gpt-5-mini",
          "gpt-5.1-codex",
          "gpt-6-astra",
          "gpt-6-sol",
          "gpt-6-luna",
        ]
        const lowest = [
          Option.some("none"),
          Option.some("none"),
          Option.some("minimal"),
          Option.some("low"),
          Option.some("low"),
          Option.some("none"),
          Option.some("none"),
        ]
        expect(yield* effortsFor(makeApiAuthInfo("hint-test-key"), reasoningModels)).toEqual(lowest)
        expect(yield* effortsFor(makeOAuthInfo(), reasoningModels)).toEqual(lowest)
        // Pro tiers accept only "high", and only through an API key.
        expect(yield* effortsFor(makeApiAuthInfo("hint-test-key"), ["gpt-5-pro"])).toEqual([
          Option.some("high"),
        ])
      }),
  )

  it.live("the catalog's reasoning flag, not the model name, decides whether effort is sent", () =>
    Effect.gen(function* () {
      const auth = makeApiAuthInfo("hint-test-key")
      // A model the catalog says does not reason gets no effort at all.
      expect(
        yield* effortsFor(auth, ["gpt-4.1", "o4-mini"], "high", { supportsReasoning: false }),
      ).toEqual([Option.none(), Option.none()])
      // A reasoning model gets its effort whatever its name looks like.
      expect(
        yield* effortsFor(auth, ["gpt-4.1-reasoner", "chatgpt-5-latest"], "high", {
          supportsReasoning: true,
        }),
      ).toEqual([Option.some("high"), Option.some("high")])
    }),
  )

  it.live("an effort the model does not accept becomes the nearest one it does", () =>
    Effect.gen(function* () {
      // The accepted values are each model page's `reasoning.effort` list
      // (developers.openai.com/api/docs/models).
      const cases: ReadonlyArray<readonly [string, ProviderHints["reasoning"], string]> = [
        // Above the ceiling: the highest accepted.
        ["gpt-5-mini", "max", "high"],
        ["gpt-5.4", "max", "xhigh"],
        ["gpt-5.1", "xhigh", "high"],
        ["gpt-5.1-codex", "max", "high"],
        ["gpt-5.2-pro", "max", "xhigh"],
        // o-series pro models take the o-series levels, not the GPT-5 Pro ones.
        ["o3-pro", "max", "high"],
        ["o1-pro", "max", "high"],
        // A level the model skips: the next one up.
        ["gpt-5-pro", "low", "high"],
        ["gpt-5.4", "minimal", "low"],
        ["gpt-5.4-pro", "low", "medium"],
        ["o3-pro", "low", "low"],
        // Accepted as sent.
        ["gpt-5.6-sol", "max", "max"],
        ["gpt-6-astra", "max", "max"],
        ["gpt-5-mini", "minimal", "minimal"],
      ]
      for (const [model, hint, sent] of cases) {
        const expected = [Option.some(sent)]
        expect({
          model,
          hint,
          api: yield* effortsFor(makeApiAuthInfo("hint-test-key"), [model], hint),
        }).toEqual({ model, hint, api: expected })
      }
      // The ChatGPT sign-in path reads the same table.
      expect(yield* effortsFor(makeOAuthInfo(), ["gpt-5-mini"], "max")).toEqual([
        Option.some("high"),
      ])
    }),
  )
})

describe("buildOpenAIModelDriver — OAuth callback state", () => {
  it.live("stale callback state fails instead of reporting success", () =>
    Effect.gen(function* () {
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL)
      const driver = buildOpenAIModelDriver(
        credentialCellRef,
        noopCallbacks(),
        Option.none(),
        testCatalogSource(),
        hostCrypto,
      )
      const callback = Option.fromUndefinedOr(driver.auth?.callback)
      if (Option.isNone(callback)) {
        return yield* Effect.die(new Error("OpenAI driver callback missing"))
      }
      const exit = yield* Effect.exit(
        callback.value({
          sessionId: SessionId.make("s1"),
          methodIndex: 0,
          authorizationId: "missing-authorization",
          code: "code",
          persist: () => Effect.void,
        }),
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        expect(exit.cause.toString()).toContain("missing or expired")
      }
    }),
  )
})
describe("buildOpenAIModelDriver — OAuth login lifetime", () => {
  type PendingCallbacks = Parameters<typeof buildOpenAIModelDriver>[1]
  const makeDriver = (pending: PendingCallbacks) =>
    Effect.gen(function* () {
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL)
      const driver = buildOpenAIModelDriver(
        credentialCellRef,
        pending,
        Option.none(),
        testCatalogSource(),
        hostCrypto,
      )
      const authorize = Option.fromUndefinedOr(driver.auth?.authorize)
      const callback = Option.fromUndefinedOr(driver.auth?.callback)
      if (Option.isNone(authorize) || Option.isNone(callback)) {
        return yield* Effect.die(new Error("OpenAI driver auth hooks missing"))
      }
      return { authorize: authorize.value, callback: callback.value }
    })
  /** End a login a test left pending: stop its timer and close its listener. */
  const dropLogin = (pending: PendingCallbacks, authorizationId: string) =>
    Effect.gen(function* () {
      const held = Option.fromNullishOr(pending.get(authorizationId))
      pending.delete(authorizationId)
      if (Option.isNone(held)) return
      if (Option.isSome(held.value.timer)) yield* Fiber.interrupt(held.value.timer.value)
      yield* held.value.close
    })
  const authContext = (methodIndex: number, authorizationId: string) => ({
    sessionId: SessionId.make("s1"),
    methodIndex,
    authorizationId,
    persist: () => Effect.void,
  })

  it.live("drops an abandoned login after five minutes", () =>
    Effect.gen(function* () {
      const pending: PendingCallbacks = new Map()
      const { authorize } = yield* makeDriver(pending)
      const fetchState = makeFakeFetchState()
      yield* runWithTestClock(
        Effect.gen(function* () {
          // Production runs `authorize` in its own request fiber, which ends when it returns.
          const request = yield* Effect.forkChild(authorize(authContext(1, "abandoned")))
          yield* Fiber.join(request)
          expect(pending.has("abandoned")).toBe(true)
          yield* TestClock.adjust("5 minutes")
          yield* Effect.yieldNow.pipe(
            Effect.repeat({ until: () => !pending.has("abandoned"), times: 100 }),
          )
          expect(pending.has("abandoned")).toBe(false)
        }).pipe(
          Effect.provide(
            fakeFetchLayer(fetchState, () => ({
              status: 200,
              body: '{"device_auth_id":"device-auth-1","user_code":"ABCD-1234","interval":"1"}',
            })),
          ),
        ),
      )
    }),
  )

  /**
   * A listener on a port the OS picks, held until the scope closes. The
   * browser-login tests run on such a port, never on the registered 1455, so
   * two test processes do not contend for it.
   */
  const heldPort = Effect.acquireRelease(
    Effect.sync(() =>
      // oxlint-disable-next-line effect/noGlobals -- Plays a foreign process that already holds the port.
      Bun.serve({ port: 0, fetch: () => new Response("busy") }),
    ),
    (held) => Effect.promise(() => held.stop(true)),
  )

  /** A port no listener holds: the OS picks it for a listener that stops at once. */
  const freePort = Effect.scoped(heldPort.pipe(Effect.map((held) => held.port)))

  it.live("the browser login listens on the port OpenAI registers", () =>
    Effect.gen(function* () {
      expect(yield* OAuthRedirectPort).toBe(1455)
    }),
  )

  it.scopedLive("a redirect server that cannot bind fails the waiting callback", () =>
    Effect.gen(function* () {
      // Hold the redirect port so the login's own server cannot bind it.
      const held = yield* heldPort
      const pending: PendingCallbacks = new Map()
      const { authorize, callback } = yield* makeDriver(pending)
      yield* authorize(authContext(0, "blocked")).pipe(
        Effect.provideService(OAuthRedirectPort, held.port),
      )
      const exit = yield* Effect.exit(callback({ ...authContext(0, "blocked") })).pipe(
        Effect.timeout("3 seconds"),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("redirect server failed")
      yield* dropLogin(pending, "blocked")
    }),
  )

  it.live("escapes the provider's error text on the redirect page", () =>
    Effect.gen(function* () {
      const port = yield* freePort
      const pending: PendingCallbacks = new Map()
      const { authorize, callback } = yield* makeDriver(pending)
      const authorization = yield* authorize(authContext(0, "escaped")).pipe(
        Effect.provideService(OAuthRedirectPort, port),
      )
      if (Option.isNone(authorization)) return yield* Effect.die(new Error("no authorization"))
      const state = new URL(authorization.value.url).searchParams.get("state") ?? ""
      const query = new URLSearchParams({
        state,
        error: "access_denied",
        error_description: "<script>alert(1)</script>",
      })
      // The redirect server starts on its own fiber; retry until it listens.
      const page = yield* waitFor(
        HttpClient.get(`http://localhost:${port}/auth/callback?${query.toString()}`).pipe(
          Effect.flatMap((response) => response.text),
          Effect.provide(FetchHttpClient.layer),
        ),
        () => true,
        2_000,
        "redirect server",
      )
      expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
      expect(page).not.toContain("<script>alert")
      // The provider's error fails the browser wait; the login stays for a pasted code.
      yield* Effect.exit(callback(authContext(0, "escaped")))
      yield* dropLogin(pending, "escaped")
    }),
  )

  const tokenReply = () => ({
    status: 200,
    body: '{"access_token":"new-access","refresh_token":"new-refresh","expires_in":3600}',
  })
  const exchangedCodes = (state: FakeFetchState) =>
    state.captured
      .filter((request) => request.url.endsWith("/oauth/token"))
      .map((request) => new URLSearchParams(request.body ?? "").get("code"))

  it.scopedLive("a failed browser wait keeps the login, and a pasted code finishes it", () =>
    Effect.gen(function* () {
      const held = yield* heldPort
      const pending: PendingCallbacks = new Map()
      const { authorize, callback } = yield* makeDriver(pending)
      const authorization = yield* authorize(authContext(0, "pasted")).pipe(
        Effect.provideService(OAuthRedirectPort, held.port),
      )
      if (Option.isNone(authorization)) return yield* Effect.die(new Error("no authorization"))
      const state = new URL(authorization.value.url).searchParams.get("state") ?? ""
      const bare = yield* Effect.exit(callback(authContext(0, "pasted"))).pipe(
        Effect.timeout("3 seconds"),
      )
      expect(Exit.isFailure(bare)).toBe(true)
      expect(pending.has("pasted")).toBe(true)

      const fetchState = makeFakeFetchState()
      const pasted = yield* Effect.exit(
        callback({ ...authContext(0, "pasted"), code: `pasted-code#${state}` }),
      ).pipe(Effect.provide(fakeFetchLayer(fetchState, tokenReply)))
      expect(Exit.isSuccess(pasted)).toBe(true)
      expect(exchangedCodes(fetchState)).toEqual(["pasted-code"])
      expect(pending.has("pasted")).toBe(false)
    }),
  )

  it.live("a request with another state leaves the browser wait running", () =>
    Effect.gen(function* () {
      const port = yield* freePort
      const pending: PendingCallbacks = new Map()
      const { authorize, callback } = yield* makeDriver(pending)
      const authorization = yield* authorize(authContext(0, "stale-tab")).pipe(
        Effect.provideService(OAuthRedirectPort, port),
      )
      if (Option.isNone(authorization)) return yield* Effect.die(new Error("no authorization"))
      const state = new URL(authorization.value.url).searchParams.get("state") ?? ""
      const fetchState = makeFakeFetchState()
      const wait = yield* Effect.forkChild(
        callback(authContext(0, "stale-tab")).pipe(
          Effect.provide(fakeFetchLayer(fetchState, tokenReply)),
        ),
      )
      const visit = (query: URLSearchParams) =>
        HttpClient.get(`http://localhost:${port}/auth/callback?${query.toString()}`).pipe(
          Effect.map((response) => response.status),
          Effect.provide(FetchHttpClient.layer),
        )
      // The redirect server starts on its own fiber; retry until it listens.
      const stale = yield* waitFor(
        visit(new URLSearchParams({ state: "another-login", code: "stale-code" })),
        () => true,
        2_000,
        "redirect server",
      )
      expect(stale).toBe(400)
      expect(yield* visit(new URLSearchParams({ state, code: "browser-code" }))).toBe(200)
      const exit = yield* Fiber.await(wait).pipe(Effect.timeout("3 seconds"))
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(exchangedCodes(fetchState)).toEqual(["browser-code"])
      expect(pending.has("stale-tab")).toBe(false)
    }),
  )

  it.live("a browser callback and a pasted code at once exchange and persist once", () =>
    Effect.gen(function* () {
      const port = yield* freePort
      const pending: PendingCallbacks = new Map()
      const { authorize, callback } = yield* makeDriver(pending)
      const authorization = yield* authorize(authContext(0, "both")).pipe(
        Effect.provideService(OAuthRedirectPort, port),
      )
      if (Option.isNone(authorization)) return yield* Effect.die(new Error("no authorization"))
      const state = new URL(authorization.value.url).searchParams.get("state") ?? ""
      const fetchState = makeFakeFetchState()
      // The token endpoint answers only once both callers are in.
      const exchangeStarted = yield* Deferred.make<void>()
      const releaseExchange = yield* Deferred.make<void>()
      const slowTokens = fakeFetchLayer(fetchState, () =>
        Deferred.succeed(exchangeStarted, void 0).pipe(
          Effect.andThen(Deferred.await(releaseExchange)),
          Effect.as(tokenReply()),
        ),
      )
      const persisted = yield* Ref.make(0)
      const context = {
        ...authContext(0, "both"),
        persist: () => Ref.update(persisted, (n) => n + 1),
      }
      const browser = yield* Effect.forkChild(callback(context).pipe(Effect.provide(slowTokens)))
      const query = new URLSearchParams({ state, code: "browser-code" })
      yield* waitFor(
        HttpClient.get(`http://localhost:${port}/auth/callback?${query.toString()}`).pipe(
          Effect.map((response) => response.status),
          Effect.provide(FetchHttpClient.layer),
        ),
        () => true,
        2_000,
        "redirect server",
      )
      yield* Deferred.await(exchangeStarted)
      const pasted = yield* Effect.forkChild(
        callback({ ...context, code: `pasted-code#${state}` }).pipe(Effect.provide(slowTokens)),
      )
      // The paste reaches the exchange, or its wait for it, before the answer.
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 50 }))
      yield* Deferred.succeed(releaseExchange, void 0)
      const results = yield* Effect.all([Fiber.await(browser), Fiber.await(pasted)]).pipe(
        Effect.timeout("3 seconds"),
      )
      expect(results.map((exit) => Exit.isSuccess(exit))).toEqual([true, true])
      expect(exchangedCodes(fetchState)).toEqual(["browser-code"])
      expect(yield* Ref.get(persisted)).toBe(1)
      expect(pending.has("both")).toBe(false)
    }),
  )

  /** Device endpoints: the user code, the poll (scripted per call), and the token trade. */
  const deviceEndpoints = (
    poll: (call: number) => { status: number; body: string },
    trade: (call: number) => { status: number; body: string },
  ) => {
    let polls = 0
    let trades = 0
    return (request: { url: string }) => {
      if (request.url.endsWith("/deviceauth/usercode")) {
        return {
          status: 200,
          body: '{"device_auth_id":"device-auth-1","user_code":"ABCD-1234","interval":"1"}',
        }
      }
      if (request.url.endsWith("/deviceauth/token")) return poll(polls++)
      return trade(trades++)
    }
  }
  const deviceDone = {
    status: 200,
    body: '{"authorization_code":"device-code-1","code_verifier":"verifier-1"}',
  }
  const settleUntil = (done: () => boolean) =>
    Effect.yieldNow.pipe(Effect.repeat({ until: done, times: 1000 }))

  // Two callers on one device login: one poll fails at once, the other polls on past five minutes.
  it.live(
    "a caller still polling keeps the login past the timer another caller's failure would arm",
    () =>
      Effect.gen(function* () {
        const pending: PendingCallbacks = new Map()
        const { authorize, callback } = yield* makeDriver(pending)
        let approved = false
        const fetchState = makeFakeFetchState()
        const endpoints = fakeFetchLayer(
          fetchState,
          deviceEndpoints((call) => {
            if (call === 0) return { status: 500, body: "{}" }
            if (approved) return deviceDone
            return { status: 403, body: "{}" }
          }, tokenReply),
        )
        const persisted = yield* Ref.make(0)
        const context = {
          ...authContext(1, "polling"),
          persist: () => Ref.update(persisted, (n) => n + 1),
        }
        yield* runWithTestClock(
          Effect.gen(function* () {
            yield* authorize(authContext(1, "polling"))
            let ended = 0
            const call = Effect.exit(callback(context)).pipe(
              Effect.ensuring(Effect.sync(() => ended++)),
            )
            const first = yield* Effect.forkChild(call)
            const second = yield* Effect.forkChild(call)
            yield* TestClock.adjust("1 second")
            yield* settleUntil(() => ended === 1)
            yield* TestClock.adjust("6 minutes")
            expect(pending.has("polling")).toBe(true)
            approved = true
            yield* TestClock.adjust("2 seconds")
            const exits = yield* Effect.all([Fiber.join(first), Fiber.join(second)])
            expect(exits.filter((exit) => Exit.isSuccess(exit))).toHaveLength(1)
            expect(yield* Ref.get(persisted)).toBe(1)
            expect(pending.has("polling")).toBe(false)
          }).pipe(Effect.provide(endpoints)),
        ).pipe(Effect.timeout("5 seconds"))
      }),
  )

  // Two device polls reach Done together; the code trades once, so a second trade would fail.
  it.live("two callers whose polls finish together trade the code once and both succeed", () =>
    Effect.gen(function* () {
      const pending: PendingCallbacks = new Map()
      const { authorize, callback } = yield* makeDriver(pending)
      const fetchState = makeFakeFetchState()
      const endpoints = fakeFetchLayer(
        fetchState,
        deviceEndpoints(
          () => deviceDone,
          (call) => {
            if (call === 0) return tokenReply()
            return { status: 400, body: '{"error":"invalid_grant"}' }
          },
        ),
      )
      const persisted = yield* Ref.make(0)
      const context = {
        ...authContext(1, "together"),
        persist: () => Ref.update(persisted, (n) => n + 1),
      }
      yield* runWithTestClock(
        Effect.gen(function* () {
          yield* authorize(authContext(1, "together"))
          const first = yield* Effect.forkChild(Effect.exit(callback(context)))
          const second = yield* Effect.forkChild(Effect.exit(callback(context)))
          yield* TestClock.adjust("1 second")
          const exits = yield* Effect.all([Fiber.join(first), Fiber.join(second)])
          expect(exits.map((exit) => Exit.isSuccess(exit))).toEqual([true, true])
          expect(exchangedCodes(fetchState)).toEqual(["device-code-1"])
          expect(yield* Ref.get(persisted)).toBe(1)
        }).pipe(Effect.provide(endpoints)),
      ).pipe(Effect.timeout("5 seconds"))
    }),
  )

  const newSignInTokens = {
    type: "oauth",
    access: "a",
    refresh: "r",
    expires: FAR_FUTURE_MS,
  } satisfies {
    readonly type: "oauth"
    readonly access: string
    readonly refresh: string
    readonly expires: number
  }

  // The winner stops after it took the login and before its store: the caller waiting still hears.
  it.live("a caller stopped between the claim and the store still settles the login", () =>
    Effect.gen(function* () {
      const pending: PendingCallbacks = new Map()
      const { callback } = yield* makeDriver(pending)
      const closing = yield* Deferred.make<void>()
      const waiting = yield* Deferred.make<void>()
      const releaseGrant = yield* Deferred.make<void>()
      let grants = 0
      pending.set("claimed", {
        flow: {
          authorization: { url: "https://auth.openai.com", method: "auto", instructions: "" },
          // The first caller's grant waits until the second is stopped; the second's comes at once.
          grant: () => {
            grants++
            if (grants === 2) return Effect.succeed({ code: "code", verifier: "verifier" })
            return Deferred.succeed(waiting, void 0).pipe(
              Effect.andThen(Deferred.await(releaseGrant)),
              Effect.as({ code: "code", verifier: "verifier" }),
            )
          },
          exchange: () => Effect.succeed({ ...newSignInTokens }),
        },
        // Closing the login's scope blocks, so the first caller stops inside the claim.
        close: Deferred.succeed(closing, void 0).pipe(Effect.andThen(Effect.never)),
        finished: yield* Deferred.make<void, ProviderAuthError>(),
        exchanging: yield* Semaphore.make(1),
        inFlight: 0,
        timer: Option.none(),
      })
      const waiter = yield* Effect.forkChild(Effect.exit(callback(authContext(0, "claimed"))))
      yield* Deferred.await(waiting)
      const winner = yield* Effect.forkChild(callback(authContext(0, "claimed")))
      yield* Deferred.await(closing)
      yield* Fiber.interrupt(winner)
      yield* Deferred.succeed(releaseGrant, void 0)
      const exit = yield* Fiber.join(waiter).pipe(Effect.timeout("3 seconds"))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("stopped before it stored")
    }),
  )
})
describe("buildOpenAIModelDriver — token endpoint outage", () => {
  it.live(
    "a 503 from the token endpoint fails the attempt as retryable, and the retry succeeds",
    () =>
      Effect.gen(function* () {
        const credentialCellRef =
          yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL)
        const driver = buildOpenAIModelDriver(
          credentialCellRef,
          noopCallbacks(),
          Option.none(),
          testCatalogSource(),
          hostCrypto,
        )
        let tokenEndpointDown = true
        const fetchState = makeFakeFetchState()
        const fetchLayer = fakeFetchLayer(fetchState, (request) => {
          if (!request.url.endsWith("/oauth/token")) return openaiResponsesHappyResponse()
          if (tokenEndpointDown) return { status: 503, body: "service unavailable" }
          return {
            status: 200,
            body: '{"access_token":"new-access","refresh_token":"new-refresh","expires_in":3600}',
          }
        })
        const authInfo = oauthInfo({
          access: "expired-access",
          refresh: "old-refresh",
          expires: 0,
        })
        // One attempt of the loop: resolve the model, then send one request.
        const attempt = Effect.gen(function* () {
          const model = yield* driver.resolveModel("gpt-5.4", authInfo)
          return yield* LanguageModel.generateText({ prompt: "hi" }).pipe(
            Effect.provide(Layer.provideMerge(model, fetchLayer)),
          )
        }).pipe(Effect.scoped, Effect.provide(fetchLayer), Effect.exit)

        const first = yield* attempt
        expect(Exit.isFailure(first)).toBe(true)
        if (!Exit.isFailure(first)) return
        const error = Cause.findErrorOption(first.cause).pipe(Option.filter(AiError.isAiError))
        // The loop retries only a retryable AiError: an outage must be one.
        expect(Option.isSome(error) && error.value.isRetryable).toBe(true)

        tokenEndpointDown = false
        const retry = yield* attempt
        expect(Exit.isSuccess(retry)).toBe(true)
        expect(fetchState.captured.at(-1)?.headers["authorization"]).toBe("Bearer new-access")
      }),
  )
})
describe("buildOpenAIModelDriver — revoked sign-in", () => {
  it.live("a rejected refresh token tells the user to sign in again with /auth", () =>
    Effect.gen(function* () {
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL)
      const driver = buildOpenAIModelDriver(
        credentialCellRef,
        noopCallbacks(),
        Option.none(),
        testCatalogSource(),
        hostCrypto,
      )
      const fetchState = makeFakeFetchState()
      const fetchLayer = fakeFetchLayer(fetchState, (request) => {
        if (!request.url.endsWith("/oauth/token")) return openaiResponsesHappyResponse()
        return { status: 400, body: '{"error":"invalid_grant"}' }
      })
      const authInfo = oauthInfo({
        access: "expired-access",
        refresh: "revoked-refresh",
        expires: 0,
      })
      const exit = yield* Effect.gen(function* () {
        const model = yield* driver.resolveModel("gpt-5.4", authInfo)
        return yield* LanguageModel.generateText({ prompt: "hi" }).pipe(
          Effect.provide(Layer.provideMerge(model, fetchLayer)),
        )
      }).pipe(Effect.scoped, Effect.provide(fetchLayer), Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      // Core shows the failure's own message to the user.
      const shown = Option.match(Cause.findErrorOption(exit.cause), {
        onNone: () => "",
        onSome: (error) => error.message,
      })
      expect(shown).toContain("Sign in again with /auth.")
      expect(shown).toContain("400")
      expect(shown).not.toContain("request body")
      // The model request is never sent with the rejected credential.
      expect(fetchState.captured.every((request) => request.url.endsWith("/oauth/token"))).toBe(
        true,
      )
    }),
  )
  it.live("a sign-in revoked mid-turn tells the user to sign in again with /auth", () =>
    Effect.gen(function* () {
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL)
      const driver = buildOpenAIModelDriver(
        credentialCellRef,
        noopCallbacks(),
        Option.none(),
        testCatalogSource(),
        hostCrypto,
      )
      // The held token passes the resolve-time check; the server then
      // revokes it: the model request gets a 401 and the refresh a 400.
      const fetchState = makeFakeFetchState()
      const fetchLayer = fakeFetchLayer(fetchState, (request) => {
        if (request.url.endsWith("/oauth/token")) {
          return { status: 400, body: '{"error":"invalid_grant"}' }
        }
        return { status: 401, body: '{"error":{"message":"token revoked"}}' }
      })
      const authInfo = oauthInfo({
        access: "revoked-access",
        refresh: "revoked-refresh",
        expires: FAR_FUTURE_MS,
      })
      const shown = yield* Effect.gen(function* () {
        const model = yield* driver.resolveModel("gpt-5.4", authInfo)
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer: Layer.provide(model, fetchLayer),
        })
        const errorEvent = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.filter((envelope) => envelope.event._tag === "ErrorOccurred"),
          Stream.runHead,
          Effect.forkScoped,
        )
        yield* client.message.send({
          sessionId,
          branchId,
          content: "hello",
          requestId: RequestId.make("revoked-mid-turn"),
        })
        const event = yield* Fiber.join(errorEvent)
        if (Option.isNone(event) || event.value.event._tag !== "ErrorOccurred") {
          return yield* Effect.die("the turn ended without an error event")
        }
        return event.value.event.error
      }).pipe(Effect.timeout("10 seconds"), Effect.scoped, Effect.provide(fetchLayer))

      expect(shown).toBe(
        "ChatGPT sign-in expired: Token refresh failed: 400. Sign in again with /auth.",
      )
      // The fake endpoint answered the refresh; no request left the test.
      expect(fetchState.captured.some((request) => request.url.endsWith("/oauth/token"))).toBe(true)
    }),
  )
})
describe("buildOpenAIModelDriver — a new sign-in replaces the held account", () => {
  type PendingCallbacks = Parameters<typeof buildOpenAIModelDriver>[1]
  const oldAccount: OpenAICredentials = {
    access: "old-access",
    refresh: "old-refresh",
    expires: 0,
    accountId: Option.some("old-account"),
  }
  const newSignIn = {
    type: "oauth",
    access: "new-access",
    refresh: "new-refresh",
    expires: FAR_FUTURE_MS,
    accountId: "new-account",
  } satisfies {
    readonly type: "oauth"
    readonly access: string
    readonly refresh: string
    readonly expires: number
    readonly accountId: string
  }
  // The auth store as core holds it: the callback and a refresh write it.
  const makeStore = (
    state: PersistState = { lastWritten: EMPTY_PERSISTED_CREDENTIALS, failNext: false },
  ) => makeFakeAuthStore(state, Option.none())
  // Complete a sign-in the way core does: the callback persists the tokens.
  const signIn = (
    driver: ReturnType<typeof buildOpenAIModelDriver>,
    pending: PendingCallbacks,
    write: (updated: StoredOAuthCredentials) => Effect.Effect<void, ProviderAuthError>,
    signedIn: typeof newSignIn = newSignIn,
  ) =>
    Effect.gen(function* () {
      pending.set("sign-in", {
        flow: {
          authorization: { url: "https://auth.openai.com", method: "auto", instructions: "" },
          grant: () => Effect.succeed({ code: "code", verifier: "verifier" }),
          exchange: () => Effect.succeed(signedIn),
        },
        close: Effect.void,
        finished: yield* Deferred.make<void, ProviderAuthError>(),
        exchanging: yield* Semaphore.make(1),
        inFlight: 0,
        timer: Option.none(),
      })
      const callback = Option.getOrThrow(Option.fromUndefinedOr(driver.auth?.callback))
      yield* callback({
        sessionId: SessionId.make("s1"),
        methodIndex: 0,
        authorizationId: "sign-in",
        code: "code",
        persist: (auth) => {
          if (auth.type !== "oauth") return Effect.die("expected an OAuth sign-in")
          const { type: _type, ...updated } = auth
          return write(updated)
        },
      })
    })

  it.live("serves the new account and never refreshes with the old token", () =>
    Effect.gen(function* () {
      const credentialCellRef = yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(
        makeDurableCell(oldAccount),
      )
      const pending: PendingCallbacks = new Map()
      const driver = buildOpenAIModelDriver(
        credentialCellRef,
        pending,
        Option.none(),
        testCatalogSource(),
        hostCrypto,
      )
      const store = makeStore()
      yield* signIn(driver, pending, store.write)
      const authInfo = store.authInfo()

      const fetchState = makeFakeFetchState()
      const fetchLayer = fakeFetchLayer(fetchState, (request) => {
        if (!request.url.endsWith("/oauth/token")) return openaiResponsesHappyResponse()
        return {
          status: 200,
          body: encodeExternalJson({
            access_token: "rotated-from-old-access",
            refresh_token: "rotated-from-old-refresh",
            expires_in: 3600,
          }),
        }
      })
      yield* Effect.gen(function* () {
        const model = yield* driver.resolveModel("gpt-5.4", authInfo)
        yield* LanguageModel.generateText({ prompt: "hi" }).pipe(
          Effect.provide(Layer.provideMerge(model, fetchLayer)),
        )
      }).pipe(Effect.scoped, Effect.provide(fetchLayer))

      expect(fetchState.captured.some((request) => request.url.endsWith("/oauth/token"))).toBe(
        false,
      )
      const sent = fetchState.captured[fetchState.captured.length - 1]!
      expect(sent.headers["authorization"]).toBe("Bearer new-access")
      expect(sent.headers["chatgpt-account-id"]).toBe("new-account")
      const stored = Option.getOrThrow(store.read())
      expect(stored.refresh).toBe("new-refresh")
      expect(stored.accountId).toBe("new-account")
    }),
  )

  it.live("a sign-in after a revoked token works without a restart", () =>
    Effect.gen(function* () {
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL)
      const pending: PendingCallbacks = new Map()
      const driver = buildOpenAIModelDriver(
        credentialCellRef,
        pending,
        Option.none(),
        testCatalogSource(),
        hostCrypto,
      )
      const fetchState = makeFakeFetchState()
      const fetchLayer = fakeFetchLayer(fetchState, (request) => {
        if (!request.url.endsWith("/oauth/token")) return openaiResponsesHappyResponse()
        return { status: 400, body: '{"error":"invalid_grant"}' }
      })
      const revoked = oauthInfo({
        access: "revoked-access",
        refresh: "revoked-refresh",
        expires: 0,
      })
      const first = yield* driver
        .resolveModel("gpt-5.4", revoked)
        .pipe(Effect.scoped, Effect.provide(fetchLayer), Effect.exit)
      expect(Exit.isFailure(first)).toBe(true)

      const store = makeStore()
      yield* signIn(driver, pending, store.write)
      const tokenPostsBefore = fetchState.captured.length
      yield* Effect.gen(function* () {
        const model = yield* driver.resolveModel("gpt-5.4", store.authInfo())
        yield* LanguageModel.generateText({ prompt: "hi" }).pipe(
          Effect.provide(Layer.provideMerge(model, fetchLayer)),
        )
      }).pipe(Effect.scoped, Effect.provide(fetchLayer))

      const after = fetchState.captured.slice(tokenPostsBefore)
      expect(after.some((request) => request.url.endsWith("/oauth/token"))).toBe(false)
      expect(after[after.length - 1]!.headers["authorization"]).toBe("Bearer new-access")
    }),
  )

  // A second profile: its own cell over the same store, as each profile's
  // extension setup builds one.
  const secondProfile = (
    store: ReturnType<typeof makeStore>,
    refresh: (refreshToken: string) => Effect.Effect<OpenAICredentials, ProviderAuthError>,
  ) =>
    Effect.gen(function* () {
      const cellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL)
      return yield* makeOpenAICredentialCache(cellRef, { refresh }, store.update)
    })
  const rotatedFrom = (refreshToken: string): OpenAICredentials => ({
    access: `rotated-from-${refreshToken}-access`,
    refresh: `rotated-from-${refreshToken}`,
    expires: FAR_FUTURE,
    accountId: Option.none(),
  })
  const expiredOldAccount = toStoredCredentials(oldAccount)

  it.live("another profile refreshes the new sign-in and never writes the old account", () =>
    runWithTestClock(
      Effect.gen(function* () {
        const store = makeStore()
        yield* store.write(expiredOldAccount)
        const refreshTokens: Array<string> = []
        const profileB = yield* secondProfile(store, (refreshToken) =>
          Effect.sync(() => {
            refreshTokens.push(refreshToken)
            return rotatedFrom(refreshToken)
          }),
        )
        const cellA = yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(
          makeDurableCell(oldAccount),
        )
        const pending: PendingCallbacks = new Map()
        const driverA = buildOpenAIModelDriver(
          cellA,
          pending,
          Option.none(),
          testCatalogSource(),
          hostCrypto,
        )
        // The new sign-in expires inside the freshness margin, so profile B refreshes it.
        yield* signIn(driverA, pending, store.write, { ...newSignIn, expires: 30_000 })

        const served = yield* profileB.getFresh
        expect(refreshTokens).toEqual(["new-refresh"])
        expect(served.refresh).toBe("rotated-from-new-refresh")
        expect(Option.map(store.read(), (stored) => stored.refresh)).toEqual(
          Option.some("rotated-from-new-refresh"),
        )
        expect(store.writes.map((written) => written.refresh)).toEqual([
          "old-refresh",
          "new-refresh",
          "rotated-from-new-refresh",
        ])
      }),
    ),
  )

  it.live("a refresh in flight in another profile does not overwrite the sign-in", () =>
    runWithTestClock(
      Effect.gen(function* () {
        const store = makeStore()
        yield* store.write(expiredOldAccount)
        const refreshTokens: Array<string> = []
        const refreshStarted = yield* Deferred.make<void>()
        const releaseRefresh = yield* Deferred.make<void>()
        const profileB = yield* secondProfile(store, (refreshToken) =>
          Effect.gen(function* () {
            refreshTokens.push(refreshToken)
            yield* Deferred.completeWith(refreshStarted, Effect.void)
            yield* Deferred.await(releaseRefresh)
            return rotatedFrom(refreshToken)
          }),
        )
        const cellA = yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(
          makeDurableCell(oldAccount),
        )
        const pending: PendingCallbacks = new Map()
        const driverA = buildOpenAIModelDriver(
          cellA,
          pending,
          Option.none(),
          testCatalogSource(),
          hostCrypto,
        )

        const refreshing = yield* Effect.forkChild(profileB.getFresh)
        yield* Deferred.await(refreshStarted)
        const signingIn = yield* Effect.forkChild(signIn(driverA, pending, store.write))
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        // The sign-in waits for the refresh that holds the store.
        expect(Option.map(store.read(), (stored) => stored.refresh)).toEqual(
          Option.some("old-refresh"),
        )
        yield* Deferred.completeWith(releaseRefresh, Effect.void)
        yield* Fiber.join(refreshing)
        yield* Fiber.join(signingIn)
        expect(Option.map(store.read(), (stored) => stored.refresh)).toEqual(
          Option.some("new-refresh"),
        )

        // Once its cache lapses, profile B adopts the sign-in without a refresh.
        yield* TestClock.adjust("31 seconds")
        const served = yield* profileB.getFresh
        expect(served.refresh).toBe("new-refresh")
        expect(served.accountId).toEqual(Option.some("new-account"))
        expect(refreshTokens).toEqual(["old-refresh"])
        expect(Option.map(store.read(), (stored) => stored.refresh)).toEqual(
          Option.some("new-refresh"),
        )
      }),
    ).pipe(Effect.timeout("4 seconds")),
  )

  it.live("a refused refresh with no newer stored credential still fails", () =>
    runWithTestClock(
      Effect.gen(function* () {
        const store = makeStore()
        yield* store.write(expiredOldAccount)
        const profileB = yield* secondProfile(store, () =>
          Effect.fail(new ProviderAuthError({ message: "invalid_grant" })),
        )
        const failed = yield* Effect.exit(profileB.getFresh)
        expect(Exit.isFailure(failed)).toBe(true)
        expect(Option.map(store.read(), (stored) => stored.refresh)).toEqual(
          Option.some("old-refresh"),
        )
      }),
    ),
  )

  it.live("a rotation whose write failed does not land over a later sign-in", () =>
    runWithTestClock(
      Effect.gen(function* () {
        const state: PersistState = { lastWritten: EMPTY_PERSISTED_CREDENTIALS, failNext: false }
        const store = makeStore(state)
        yield* store.write(expiredOldAccount)
        const refreshTokens: Array<string> = []
        const profileB = yield* secondProfile(store, (refreshToken) =>
          Effect.sync(() => {
            refreshTokens.push(refreshToken)
            return rotatedFrom(refreshToken)
          }),
        )
        // Profile B rotates the old account, and the store write fails.
        state.failNext = true
        const failed = yield* Effect.exit(profileB.getFresh)
        expect(Exit.isFailure(failed)).toBe(true)

        const cellA = yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(
          makeDurableCell(oldAccount),
        )
        const pending: PendingCallbacks = new Map()
        const driverA = buildOpenAIModelDriver(
          cellA,
          pending,
          Option.none(),
          testCatalogSource(),
          hostCrypto,
        )
        yield* signIn(driverA, pending, store.write)

        // The retry finds the sign-in, not the credential the rotation replaced.
        const served = yield* profileB.getFresh
        expect(served.refresh).toBe("new-refresh")
        expect(refreshTokens).toEqual(["old-refresh"])
        expect(store.writes.map((written) => written.refresh)).toEqual([
          "old-refresh",
          "new-refresh",
        ])
      }),
    ),
  )
})

describe("buildOpenAIModelDriver — OAuth path uses external cache Ref", () => {
  it.live("OAuth resolveModel layer reads Bearer from credentialCellRef the test owns", () =>
    Effect.gen(function* () {
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL)
      const driver = buildOpenAIModelDriver(
        credentialCellRef,
        noopCallbacks(),
        Option.none(),
        testCatalogSource(),
        hostCrypto,
      )
      // Pre-seed the cred Ref directly (test owns it). If
      // `makeOauthOpenAILayer` regressed to allocating its own internal
      // Ref per call, the production
      // credential service would fall back to `authInfo.access` instead
      // of seeing this seed. Asserting the captured Authorization header
      // reflects the seed pins the Ref-sharing semantics.
      yield* SynchronizedRef.set(
        credentialCellRef,
        makeDurableCell({
          access: "seeded-bearer-token",
          refresh: "r",
          expires: FAR_FUTURE_MS,
          accountId: Option.none(),
        }),
      )
      const model = yield* driver.resolveModel("gpt-5.4", makeOAuthInfo())
      const fetchState = makeFakeFetchState()
      yield* runOne(model, fetchState)
      expect(fetchState.captured.length).toBeGreaterThan(0)
      const lastReq = fetchState.captured[fetchState.captured.length - 1]!
      expect(lastReq.headers["authorization"]).toBe("Bearer seeded-bearer-token")
    }),
  )
  it.live(
    "OAuth resolveModel layer rewrites URL to Codex backend + sets responses=experimental beta",
    () =>
      Effect.gen(function* () {
        const credentialCellRef =
          yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL)
        yield* SynchronizedRef.set(
          credentialCellRef,
          makeDurableCell({
            access: "t",
            refresh: "r",
            expires: FAR_FUTURE_MS,
            accountId: Option.none(),
          }),
        )
        const driver = buildOpenAIModelDriver(
          credentialCellRef,
          noopCallbacks(),
          Option.none(),
          testCatalogSource(),
          hostCrypto,
        )
        const model = yield* driver.resolveModel("gpt-5.4", makeOAuthInfo())
        const fetchState = makeFakeFetchState()
        yield* runOne(model, fetchState)
        const lastReq = fetchState.captured.at(-1)!
        // The Responses SDK posts `/responses` under the Codex base URL.
        expect(lastReq.url).toBe("https://chatgpt.com/backend-api/codex/responses")
        // Codex requires the `responses=experimental` beta token. The
        // transform merges it into any existing OpenAI-Beta value. The SDK
        // does not set its own OpenAI-Beta header, so this should be the
        // only token.
        const beta = lastReq.headers["openai-beta"] ?? ""
        expect(beta).toContain("responses=experimental")
      }),
  )
  it.live("OAuth resolveModel layer omits x-api-key (no SDK-injected Bearer placeholder)", () =>
    Effect.gen(function* () {
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL)
      yield* SynchronizedRef.set(
        credentialCellRef,
        makeDurableCell({
          access: "t",
          refresh: "r",
          expires: FAR_FUTURE_MS,
          accountId: Option.none(),
        }),
      )
      const driver = buildOpenAIModelDriver(
        credentialCellRef,
        noopCallbacks(),
        Option.none(),
        testCatalogSource(),
        hostCrypto,
      )
      const model = yield* driver.resolveModel("gpt-5.4", makeOAuthInfo())
      const fetchState = makeFakeFetchState()
      yield* runOne(model, fetchState)
      const headers = fetchState.captured.at(-1)!.headers
      // `OpenAiClient.layer({ transformClient: ... })` is built without
      // an `apiKey` field — the SDK only sets Bearer when apiKey is
      // defined. Counsel correction: dropping the placeholder entirely
      // avoids a brittle "scrub-the-placeholder" coupling between SDK
      // and middleware ordering. Asserting Bearer is exactly our seeded
      // OAuth token (not "Bearer oauth") proves the SDK isn't injecting
      // a competing Authorization header.
      expect(headers["authorization"]).toBe("Bearer t")
      // x-api-key should never appear on the OAuth path.
      expect(headers["x-api-key"]).toBeUndefined()
    }),
  )
  it.live(
    "two OAuth resolveModel calls share the credentialCellRef — second sees first call's mutation",
    () =>
      Effect.gen(function* () {
        const credentialCellRef =
          yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL)
        yield* SynchronizedRef.set(
          credentialCellRef,
          makeDurableCell({
            access: "first-token",
            refresh: "r",
            expires: FAR_FUTURE_MS,
            accountId: Option.none(),
          }),
        )
        const driver = buildOpenAIModelDriver(
          credentialCellRef,
          noopCallbacks(),
          Option.none(),
          testCatalogSource(),
          hostCrypto,
        )
        const model1 = yield* driver.resolveModel("gpt-5.4", makeOAuthInfo())
        const fetchState1 = makeFakeFetchState()
        yield* runOne(model1, fetchState1)
        expect(fetchState1.captured.at(-1)!.headers["authorization"]).toBe("Bearer first-token")
        // Mutate the test-owned Ref between calls. If the second
        // `resolveModel` allocated a fresh internal Ref (the  regression
        // mirrored from Anthropic), the second request would still see
        // "first-token". Asserting the second request observes "second-token"
        // pins the Ref-sharing semantics that survives across resolveModel.
        yield* SynchronizedRef.set(
          credentialCellRef,
          makeDurableCell({
            access: "second-token",
            refresh: "r",
            expires: FAR_FUTURE_MS,
            accountId: Option.none(),
          }),
        )
        const model2 = yield* driver.resolveModel("gpt-5.4", makeOAuthInfo())
        const fetchState2 = makeFakeFetchState()
        yield* runOne(model2, fetchState2)
        expect(fetchState2.captured.at(-1)!.headers["authorization"]).toBe("Bearer second-token")
      }),
  )
  it.live("OAuth resolves the GPT-6 family: Astra, Sol and Luna", () =>
    Effect.gen(function* () {
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL)
      const driver = buildOpenAIModelDriver(
        credentialCellRef,
        noopCallbacks(),
        Option.none(),
        testCatalogSource(),
        hostCrypto,
      )
      for (const modelName of ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]) {
        const model = yield* driver.resolveModel(modelName, makeOAuthInfo())
        const fetchState = makeFakeFetchState()
        yield* runOne(model, fetchState)
        expect(
          fetchState.captured.some(
            (request) =>
              request.url === "https://chatgpt.com/backend-api/codex/responses" &&
              request.body?.includes(modelName),
          ),
        ).toBe(true)
      }
    }),
  )
  it.live("OAuth resolveModel rejects models the Codex backend does not serve", () =>
    Effect.gen(function* () {
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL)
      const driver = buildOpenAIModelDriver(
        credentialCellRef,
        noopCallbacks(),
        Option.none(),
        testCatalogSource(),
        hostCrypto,
      )
      const error = yield* driver.resolveModel("gpt-3.5-turbo", makeOAuthInfo()).pipe(Effect.flip)
      expect(error.message).toMatch(/not available with ChatGPT OAuth/)
    }),
  )
})
describe("buildOpenAIModelDriver — 401 invalidate seam fires through the rewired layer", () => {
  // Driver-level seam test. Proves the wiring, not the full retry-success
  // path. Asserts:
  //   1. the first wire attempt uses the seeded stale token (production
  //      `mapRequestEffect` runs through the rewired
  //      `OpenAiClient.layer({ transformClient })` path)
  //   2. after the 401, invalidate fires on the closure-owned cell —
  //      the cell is marked invalidated and refresh token is preserved
  it.live(
    "401 fires invalidate on the closure-owned cell via OpenAiClient.layer({ transformClient })",
    () =>
      Effect.gen(function* () {
        const credentialCellRef =
          yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL)
        yield* SynchronizedRef.set(
          credentialCellRef,
          makeDurableCell({
            access: "stale-token",
            refresh: "r",
            expires: FAR_FUTURE_MS,
            accountId: Option.none(),
          }),
        )
        const driver = buildOpenAIModelDriver(
          credentialCellRef,
          noopCallbacks(),
          Option.none(),
          testCatalogSource(),
          hostCrypto,
        )
        const model = yield* driver.resolveModel("gpt-5.4", makeOAuthInfo())
        const fetchState = makeFakeFetchState()
        // 401 triggers tapError(invalidate). The retry's preprocess sees
        // the invalidated cell and attempts a live refresh. Effect.exit preserves
        // the failure so the post-condition assertions still run.
        const responder = (req: CapturedRequest) => {
          void req
          return { status: 401, body: "unauthorized", headers: { "content-type": "text/plain" } }
        }
        const exit = yield* oneGenerate(model, fetchState, responder).pipe(
          Effect.orDie,
          Effect.exit,
        )
        expect(exit._tag).toBe("Failure")
        // First wire attempt fired with the seeded token — proves the
        // production mapRequestEffect ran preprocess through the rewired
        // OpenAiClient.layer({ transformClient }) path.
        expect(fetchState.captured.length).toBeGreaterThanOrEqual(1)
        expect(fetchState.captured[0]!.headers["authorization"]).toBe("Bearer stale-token")
        expect(fetchState.captured[0]!.url).toBe("https://chatgpt.com/backend-api/codex/responses")
        // Driver-level seam: invalidate fired on the closure-owned cell
        // after the 401:
        //   - invalidated marked true (so the next request refreshes)
        //   - .refresh preserved (rotated refresh token survives invalidate)
        // If transformResponse weren't wired into the production layer,
        // the cell would not be marked invalidated.
        const finalCell = yield* SynchronizedRef.get(credentialCellRef)
        expect(finalCell._tag).toBe("Durable")
        if (finalCell._tag !== "Durable") {
          return yield* Effect.die(new Error("expected durable credential cell"))
        }
        expect(finalCell.invalidated).toBe(true)
        expect(finalCell.creds?.access).toBe("stale-token")
        expect(finalCell.creds?.refresh).toBe("r")
      }),
  )
})
describe("buildOpenAIModelDriver — API-key path is plain SDK", () => {
  it.live(
    "API-key resolveModel layer sends Bearer with the API key (no Codex backend rewrite)",
    () =>
      Effect.gen(function* () {
        const credentialCellRef =
          yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL)
        const driver = buildOpenAIModelDriver(
          credentialCellRef,
          noopCallbacks(),
          Option.none(),
          testCatalogSource(),
          hostCrypto,
        )
        const model = yield* driver.resolveModel("gpt-5.4", makeApiAuthInfo("sk-test-1234"))
        const fetchState = makeFakeFetchState()
        yield* runOne(model, fetchState)
        const lastReq = fetchState.captured.at(-1)!
        // SDK injects standard Bearer auth from apiKey
        expect(lastReq.headers["authorization"]).toBe("Bearer sk-test-1234")
        // No Codex backend rewrite on the API-key path
        expect(lastReq.url).toBe("https://api.openai.com/v1/responses")
        // No Codex beta header
        expect(lastReq.headers["openai-beta"]).toBeUndefined()
      }),
  )
  it.live(
    "an API-key request to a reasoning model uses the Responses shape: output cap, no temperature, a reasoning summary",
    () =>
      Effect.gen(function* () {
        const credentialCellRef =
          yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL)
        const driver = buildOpenAIModelDriver(
          credentialCellRef,
          noopCallbacks(),
          Option.none(),
          testCatalogSource(),
          hostCrypto,
        )
        // The compaction summary's hints (core turn.ts) plus a user-set agent temperature.
        const model = yield* driver.resolveModel("gpt-5", makeApiAuthInfo("sk-test-1234"), {
          maxTokens: 768,
          reasoning: "none",
          temperature: 0.3,
        })
        const fetchState = makeFakeFetchState()
        yield* runOne(model, fetchState)
        const request = Option.getOrThrow(Option.fromUndefinedOr(fetchState.captured.at(-1)))
        expect(request.url).toBe("https://api.openai.com/v1/responses")
        const body = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              max_tokens: Schema.optional(Schema.Finite),
              max_completion_tokens: Schema.optional(Schema.Finite),
              max_output_tokens: Schema.optional(Schema.Finite),
              temperature: Schema.optional(Schema.Finite),
              reasoning_effort: Schema.optional(Schema.String),
              reasoning: Schema.optional(
                Schema.Struct({ effort: Schema.String, summary: Schema.String }),
              ),
            }),
          ),
        )(Option.getOrThrow(Option.fromUndefinedOr(request.body)))
        expect(body).toEqual({
          max_output_tokens: 768,
          reasoning: { effort: "minimal", summary: "auto" },
        })
      }),
  )
  it.live(
    "an organization OpenAI refuses summaries to gets one retry without the summary, later requests on that key leave it out, and another key still asks",
    () =>
      Effect.gen(function* () {
        const credentialCellRef =
          yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL)
        const driver = buildOpenAIModelDriver(
          credentialCellRef,
          noopCallbacks(),
          Option.none(),
          testCatalogSource(),
          hostCrypto,
        )
        const hints: ProviderHints = { reasoning: "high" }
        // The documented refusal: developers.openai.com/api/docs/guides/reasoning.
        const refusal = encodeExternalJson({
          error: {
            message: "Your organization must be verified to generate reasoning summaries.",
            type: "invalid_request_error",
            param: "reasoning.summary",
            code: "unsupported_value",
          },
        })
        const responder = (req: { readonly body?: string }) => {
          if (req.body?.includes('"summary"') === true) {
            return { status: 400, body: refusal, headers: { "content-type": "application/json" } }
          }
          return openaiResponsesHappyResponse()
        }
        const summaries = (state: FakeFetchState) =>
          state.captured.map((req) => req.body?.includes('"summary"') === true)
        const first = makeFakeFetchState()
        const model = yield* driver.resolveModel("gpt-5", makeApiAuthInfo("sk-test-1234"), hints)
        yield* oneGenerate(model, first, responder)
        expect(summaries(first)).toEqual([true, false])
        const later = makeFakeFetchState()
        const again = yield* driver.resolveModel("gpt-5", makeApiAuthInfo("sk-test-1234"), hints)
        yield* oneGenerate(again, later, responder)
        expect(summaries(later)).toEqual([false])
        // The refusal belongs to the first key's organization, not to the driver.
        const otherKey = makeFakeFetchState()
        const other = yield* driver.resolveModel("gpt-5", makeApiAuthInfo("sk-test-5678"), hints)
        yield* oneGenerate(other, otherKey, () => openaiResponsesHappyResponse())
        expect(summaries(otherKey)).toEqual([true])
      }),
  )
  it.live("any other 400 is not retried and keeps the summary", () =>
    Effect.gen(function* () {
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL)
      const driver = buildOpenAIModelDriver(
        credentialCellRef,
        noopCallbacks(),
        Option.none(),
        testCatalogSource(),
        hostCrypto,
      )
      const state = makeFakeFetchState()
      const model = yield* driver.resolveModel("gpt-5", makeApiAuthInfo("sk-test-1234"), {
        reasoning: "high",
      })
      const other = encodeExternalJson({
        error: { message: "bad", type: "invalid_request_error", param: "input" },
      })
      const exit = yield* oneGenerate(model, state, () => ({
        status: 400,
        body: other,
        headers: { "content-type": "application/json" },
      })).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(state.captured.length).toBe(1)
    }),
  )
  it.live("an API-key request to a model that does not reason keeps its temperature", () =>
    Effect.gen(function* () {
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL)
      const driver = buildOpenAIModelDriver(
        credentialCellRef,
        noopCallbacks(),
        Option.none(),
        testCatalogSource(),
        hostCrypto,
      )
      const model = yield* driver.resolveModel("gpt-4.1", makeApiAuthInfo("sk-test-1234"), {
        temperature: 0.3,
        supportsReasoning: false,
      })
      const fetchState = makeFakeFetchState()
      yield* runOne(model, fetchState)
      const body = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.Struct({ temperature: Schema.optional(Schema.Finite) })),
      )(Option.getOrThrow(Option.fromUndefinedOr(fetchState.captured.at(-1)?.body)))
      expect(body.temperature).toBe(0.3)
    }),
  )
  it.live("API-key path does not touch the OAuth credential cell Ref", () =>
    Effect.gen(function* () {
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL)
      const driver = buildOpenAIModelDriver(
        credentialCellRef,
        noopCallbacks(),
        Option.none(),
        testCatalogSource(),
        hostCrypto,
      )
      const model = yield* driver.resolveModel("gpt-5.4", makeApiAuthInfo("sk-test-1234"))
      const fetchState = makeFakeFetchState()
      yield* runOne(model, fetchState)
      expect(yield* SynchronizedRef.get(credentialCellRef)).toBe(EMPTY_CREDENTIAL_CELL)
    }),
  )
})
