/**
 * keychainTransformClient — auth-headers middleware (Commit 2a).
 *
 * Builds a fake `HttpClient` (via `HttpClient.make`) that captures
 * incoming requests and returns canned responses. The transform under
 * test wraps that fake client; tests assert that headers seen by the
 * fake match the expected OAuth shape.
 *
 * No global mutation. No `globalThis.fetch` swap. No Reference
 * memoization concerns. The fake is a real `HttpClient.HttpClient`
 * passed via Layer — the same composition production uses.
 */
import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http"
import { HttpClientError, TransportError } from "effect/unstable/http/HttpClientError"
import { buildKeychainTransformClient } from "@gent/extensions/anthropic/keychain-transform"
import { initAnthropicKeychainEnv } from "@gent/extensions/anthropic/oauth"
import type {
  AnthropicCredentialServiceShape,
  AnthropicCredentialIO,
} from "@gent/extensions/anthropic/credential-service"
import { AnthropicCredentialService } from "@gent/extensions/anthropic/credential-service"
import {
  AnthropicBetaCache,
  type AnthropicBetaCacheShape,
} from "@gent/extensions/anthropic/beta-cache"
import type { ClaudeCredentials } from "@gent/extensions/anthropic/oauth"
import { ProviderAuthError } from "@gent/core/extensions/api"
// ── Helpers ──
// Real Clock here (no TestClock), so expiresAt must be a real future
// Unix-millis timestamp. 10h from real now is comfortably outside the
// 60s freshness margin.
const makeCreds = (label: string): ClaudeCredentials => ({
  accessToken: `${label}-access`,
  refreshToken: `${label}-refresh`,
  expiresAt: Date.now() + 10 * 60 * 60 * 1000,
})
interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}
// Sentinel object the responder can return to ask the fake client to
// emit `HttpClientError(TransportError)` instead of a successful
// response — exercises the wire-failure retry branch.
interface TransportFailure {
  readonly _tag: "TransportFailure"
  readonly message: string
}
const transportFailure = (message: string): TransportFailure => ({
  _tag: "TransportFailure",
  message,
})
const isTransportFailure = (v: Response | TransportFailure): v is TransportFailure =>
  (v as TransportFailure)._tag === "TransportFailure"
interface FakeClientState {
  captured: Array<CapturedRequest>
  responder: (call: number) => Response | TransportFailure
}
const makeFakeClient = (state: FakeClientState): HttpClient.HttpClient =>
  HttpClient.make((request) => {
    const headersObj: Record<string, string> = {}
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headersObj[key] = value
    }
    let bodyText: string | undefined
    if (request.body._tag === "Uint8Array") {
      bodyText = new TextDecoder().decode(request.body.body)
    } else if (request.body._tag === "Raw" && typeof request.body.body === "string") {
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
// Capture the credential-service "instance" by running its layer once
// and grabbing the service from context. The transform takes this
// instance directly (closure-based, not yielded from R).
const buildCreds = (io: AnthropicCredentialIO): Promise<AnthropicCredentialServiceShape> => {
  const layer = AnthropicCredentialService.layerFromIO(io).pipe(Layer.provide(BunServices.layer))
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        return yield* AnthropicCredentialService
      }).pipe(Effect.provide(layer)),
    ),
  )
}
// Same instance-extraction trick for AnthropicBetaCache. Each call
// returns a FRESH cache (the layer builds a new Ref) so tests are
// isolated.
const buildBetaCache = (): Promise<AnthropicBetaCacheShape> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        return yield* AnthropicBetaCache
      }).pipe(Effect.provide(AnthropicBetaCache.layer)),
    ),
  )
const validCredsIO = (label: string): AnthropicCredentialIO => ({
  read: Effect.succeed(makeCreds(label)),
  refresh: Effect.fail(new ProviderAuthError({ message: "should not be called" })),
})
// `HttpBody.jsonUnsafe` mirrors how the Anthropic SDK serializes
// outgoing JSON bodies (via `text` → Uint8Array). The transform reads
// the body via `requestBodyText` which decodes that Uint8Array back to
// a string, so this matches production representation.
const jsonBody = (payload: Record<string, unknown>) => HttpBody.jsonUnsafe(payload)
// `Effect.orDie` collapses typed errors to defects so test bodies can
// assert success without `as Effect<unknown, never, never>` casts.
const runOk = <A, E>(eff: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(Effect.scoped(eff.pipe(Effect.orDie)))
// Drives Schedule.exponential("1 second") in virtual time. Used by
// any test path that crosses a retry sleep — primarily 2b's transient
// retry but also 2d's parity-drift test for 429+long-context-body.
const runWithTestClock = <A, E>(eff: Effect.Effect<A, E, never>): Promise<A> => {
  const program = Effect.gen(function* () {
    const fiber = yield* Effect.scoped(eff).pipe(Effect.forkChild)
    // Walk past the exponential backoff window deterministically.
    // 1s + 2s = 3s covers 2 retries with `Schedule.exponential("1 second")`.
    yield* TestClock.adjust("3 seconds")
    return yield* Fiber.join(fiber)
  })
  return Effect.runPromise(
    Effect.scoped(program).pipe(Effect.provide(TestClock.layer())) as Effect.Effect<A, E, never>,
  )
}
// ── Tests ──
describe("keychainTransformClient — auth headers (Commit 2a)", () => {
  // Reset module env to defaults before each test that touches headers
  // sensitive to env (UA, betas).
  const resetEnv = () => initAnthropicKeychainEnv({})
  it.live("injects Authorization Bearer from credential service", () =>
    Effect.gen(function* () {
      resetEnv()
      const creds = yield* Effect.promise(() => buildCreds(validCredsIO("k1")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        responder: () => new Response("ok", { status: 200 }),
      }
      const transform = buildKeychainTransformClient(creds, cache)
      const wrapped = transform(makeFakeClient(fakeState))
      yield* Effect.promise(() =>
        runOk(
          wrapped.post("https://api.anthropic.com/v1/messages", {
            body: jsonBody({ model: "claude-opus-4-6" }),
          }),
        ),
      )
      expect(fakeState.captured).toHaveLength(1)
      expect(fakeState.captured[0]!.headers["authorization"]).toBe("Bearer k1-access")
    }),
  )
  it.live("removes x-api-key (would otherwise conflict with OAuth Bearer)", () =>
    Effect.gen(function* () {
      resetEnv()
      const creds = yield* Effect.promise(() => buildCreds(validCredsIO("k1")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        responder: () => new Response("ok", { status: 200 }),
      }
      const transform = buildKeychainTransformClient(creds, cache)
      const wrapped = transform(makeFakeClient(fakeState))
      // Simulate the SDK's baseline by injecting x-api-key on the
      // outgoing request. The transform must strip it.
      yield* Effect.promise(() =>
        runOk(
          wrapped.post("https://api.anthropic.com/v1/messages", {
            headers: { "x-api-key": "oauth-placeholder", "anthropic-version": "2023-06-01" },
            body: jsonBody({ model: "claude-opus-4-6" }),
          }),
        ),
      )
      expect(fakeState.captured[0]!.headers["x-api-key"]).toBeUndefined()
      // Preserves SDK baseline header
      expect(fakeState.captured[0]!.headers["anthropic-version"]).toBe("2023-06-01")
    }),
  )
  it.live("sets x-app, user-agent, anthropic-dangerous-direct-browser-access", () =>
    Effect.gen(function* () {
      resetEnv()
      const creds = yield* Effect.promise(() => buildCreds(validCredsIO("k1")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        responder: () => new Response("ok", { status: 200 }),
      }
      const transform = buildKeychainTransformClient(creds, cache)
      const wrapped = transform(makeFakeClient(fakeState))
      yield* Effect.promise(() =>
        runOk(
          wrapped.post("https://api.anthropic.com/v1/messages", {
            body: jsonBody({ model: "claude-opus-4-6" }),
          }),
        ),
      )
      const headers = fakeState.captured[0]!.headers
      expect(headers["x-app"]).toBe("cli")
      expect(headers["user-agent"]).toMatch(/^claude-cli\/.+ \(external, cli\)$/)
      expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true")
    }),
  )
  it.live("merges anthropic-beta with model defaults", () =>
    Effect.gen(function* () {
      resetEnv()
      const creds = yield* Effect.promise(() => buildCreds(validCredsIO("k1")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        responder: () => new Response("ok", { status: 200 }),
      }
      const transform = buildKeychainTransformClient(creds, cache)
      const wrapped = transform(makeFakeClient(fakeState))
      // Body declares claude-opus-4-6, which has model-default betas
      // (base set + 1M-context + effort-2025-11-24 from the override).
      // Incoming "incoming-beta-1" must merge with those, not replace.
      yield* Effect.promise(() =>
        runOk(
          wrapped.post("https://api.anthropic.com/v1/messages", {
            headers: { "anthropic-beta": "incoming-beta-1" },
            body: jsonBody({ model: "claude-opus-4-6" }),
          }),
        ),
      )
      const beta = fakeState.captured[0]!.headers["anthropic-beta"]
      expect(beta).toBeDefined()
      const betas = beta!.split(",").map((s) => s.trim())
      // Incoming preserved
      expect(betas).toContain("incoming-beta-1")
      // Model default present (oauth-2025-04-20 is in MODEL_CONFIG.baseBetas)
      expect(betas).toContain("oauth-2025-04-20")
      // Per-model-override present (effort-2025-11-24 is added for "4-6")
      expect(betas).toContain("effort-2025-11-24")
    }),
  )
  it.live("credential-service failure surfaces as HttpClientError (transport)", () =>
    Effect.gen(function* () {
      resetEnv()
      const creds = yield* Effect.promise(() =>
        buildCreds({
          read: Effect.fail(new ProviderAuthError({ message: "no keychain entry" })),
          refresh: Effect.fail(new ProviderAuthError({ message: "no refresh token either" })),
        }),
      )
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        responder: () => new Response("ok", { status: 200 }),
      }
      const transform = buildKeychainTransformClient(creds, cache)
      const wrapped = transform(makeFakeClient(fakeState))
      // The credential failure flows through the transient retry layer
      // (`Schedule.exponential("1 second")` + 2 retries = 3s real-clock).
      // Drive the schedule via TestClock so the test stays instant.
      const exit = yield* Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.scoped(
            Effect.exit(
              wrapped.post("https://api.anthropic.com/v1/messages", {
                body: jsonBody({ model: "claude-opus-4-6" }),
              }),
            ),
          ).pipe(Effect.forkChild)
          yield* TestClock.adjust("3 seconds")
          return yield* Fiber.join(fiber)
        }),
      ).pipe(Effect.provide(TestClock.layer()))
      // The fake client never saw the request — the transform short-
      // circuited at the credential read.
      expect(fakeState.captured).toHaveLength(0)
      expect(exit._tag).toBe("Failure")
    }),
  )
})
describe("keychainTransformClient — 429/529 retry (Commit 2b)", () => {
  it.live("429 once then 200 — retry succeeds, caller sees 200", () =>
    Effect.gen(function* () {
      initAnthropicKeychainEnv({})
      const creds = yield* Effect.promise(() => buildCreds(validCredsIO("k1")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        responder: (call) =>
          call === 0
            ? new Response("rate limited", { status: 429 })
            : new Response("ok", { status: 200 }),
      }
      const transform = buildKeychainTransformClient(creds, cache)
      const wrapped = transform(makeFakeClient(fakeState))
      const response = yield* Effect.promise(() =>
        runWithTestClock(
          wrapped
            .post("https://api.anthropic.com/v1/messages", {
              body: jsonBody({ model: "claude-opus-4-6" }),
            })
            .pipe(Effect.orDie),
        ),
      )
      expect(fakeState.captured).toHaveLength(2)
      expect(response.status).toBe(200)
    }),
  )
  it.live("529 once then 200 — retry includes 529 (which retryTransient does not)", () =>
    Effect.gen(function* () {
      initAnthropicKeychainEnv({})
      const creds = yield* Effect.promise(() => buildCreds(validCredsIO("k1")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        responder: (call) =>
          call === 0
            ? new Response("overloaded", { status: 529 })
            : new Response("ok", { status: 200 }),
      }
      const transform = buildKeychainTransformClient(creds, cache)
      const wrapped = transform(makeFakeClient(fakeState))
      const response = yield* Effect.promise(() =>
        runWithTestClock(
          wrapped
            .post("https://api.anthropic.com/v1/messages", {
              body: jsonBody({ model: "claude-opus-4-6" }),
            })
            .pipe(Effect.orDie),
        ),
      )
      expect(fakeState.captured).toHaveLength(2)
      expect(response.status).toBe(200)
    }),
  )
  it.live("3 consecutive 429 — budget exhausted, final 429 surfaces", () =>
    Effect.gen(function* () {
      initAnthropicKeychainEnv({})
      const creds = yield* Effect.promise(() => buildCreds(validCredsIO("k1")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        responder: () => new Response("rate limited", { status: 429 }),
      }
      const transform = buildKeychainTransformClient(creds, cache)
      const wrapped = transform(makeFakeClient(fakeState))
      const response = yield* Effect.promise(() =>
        runWithTestClock(
          wrapped
            .post("https://api.anthropic.com/v1/messages", {
              body: jsonBody({ model: "claude-opus-4-6" }),
            })
            .pipe(Effect.orDie),
        ),
      )
      // 1 initial + 2 retries = 3 attempts
      expect(fakeState.captured).toHaveLength(3)
      expect(response.status).toBe(429)
    }),
  )
  it.live(
    "transport failure (HttpClientError) once then 200 — retried like legacy fetch synthetic-500",
    () =>
      Effect.gen(function* () {
        // Legacy `fetchOnce` (oauth.ts:813-838) caught thrown fetch errors,
        // mapped them to a synthetic 500 response, and retried. The new
        // middleware widens retry to ALL errors in the channel — both
        // TransientResponseError (429/529) and HttpClientError from the
        // wire — preserving that resilience contract.
        initAnthropicKeychainEnv({})
        const creds = yield* Effect.promise(() => buildCreds(validCredsIO("k1")))
        const cache = yield* Effect.promise(() => buildBetaCache())
        const fakeState: FakeClientState = {
          captured: [],
          responder: (call) =>
            call === 0 ? transportFailure("socket hang up") : new Response("ok", { status: 200 }),
        }
        const transform = buildKeychainTransformClient(creds, cache)
        const wrapped = transform(makeFakeClient(fakeState))
        const response = yield* Effect.promise(() =>
          runWithTestClock(
            wrapped
              .post("https://api.anthropic.com/v1/messages", {
                body: jsonBody({ model: "claude-opus-4-6" }),
              })
              .pipe(Effect.orDie),
          ),
        )
        expect(fakeState.captured).toHaveLength(2)
        expect(response.status).toBe(200)
      }),
  )
  it.live("3 consecutive transport failures — budget exhausted, error propagates", () =>
    Effect.gen(function* () {
      initAnthropicKeychainEnv({})
      const creds = yield* Effect.promise(() => buildCreds(validCredsIO("k1")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        responder: () => transportFailure("connection refused"),
      }
      const transform = buildKeychainTransformClient(creds, cache)
      const wrapped = transform(makeFakeClient(fakeState))
      const exit = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const fiber = yield* Effect.scoped(
              wrapped.post("https://api.anthropic.com/v1/messages", {
                body: jsonBody({ model: "claude-opus-4-6" }),
              }),
            ).pipe(Effect.forkChild)
            yield* TestClock.adjust("3 seconds")
            return yield* Fiber.join(fiber)
          }),
        ).pipe(Effect.provide(TestClock.layer())),
      )
      // 1 initial + 2 retries = 3 attempts
      expect(fakeState.captured).toHaveLength(3)
      expect(exit._tag).toBe("Failure")
    }),
  )
  it.live("non-transient 4xx (e.g. 400) does not trigger retry", () =>
    Effect.gen(function* () {
      initAnthropicKeychainEnv({})
      const creds = yield* Effect.promise(() => buildCreds(validCredsIO("k1")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        responder: () => new Response("bad request", { status: 400 }),
      }
      const transform = buildKeychainTransformClient(creds, cache)
      const wrapped = transform(makeFakeClient(fakeState))
      const response = yield* Effect.promise(() =>
        runWithTestClock(
          wrapped
            .post("https://api.anthropic.com/v1/messages", {
              body: jsonBody({ model: "claude-opus-4-6" }),
            })
            .pipe(Effect.orDie),
        ),
      )
      expect(fakeState.captured).toHaveLength(1)
      expect(response.status).toBe(400)
    }),
  )
})
describe("keychainTransformClient — long-context beta retry (Commit 2d)", () => {
  // Long-context error markers Anthropic returns in the 400 body.
  // `keychain-transform` matches via `isLongContextError(body)`.
  const LONG_CONTEXT_BODY =
    '{"type":"error","error":{"message":"Extra usage is required for long context requests"}}'
  const NON_LONG_CONTEXT_400 = '{"type":"error","error":{"message":"some other 400"}}'
  it.live("400 long-context once → drops one beta → retry succeeds", () =>
    Effect.gen(function* () {
      initAnthropicKeychainEnv({})
      const creds = yield* Effect.promise(() => buildCreds(validCredsIO("k1")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        responder: (call) =>
          call === 0
            ? new Response(LONG_CONTEXT_BODY, { status: 400 })
            : new Response("ok", { status: 200 }),
      }
      const transform = buildKeychainTransformClient(creds, cache)
      const wrapped = transform(makeFakeClient(fakeState))
      const response = yield* Effect.promise(() =>
        runOk(
          wrapped.post("https://api.anthropic.com/v1/messages", {
            body: jsonBody({ model: "claude-opus-4-6" }),
          }),
        ),
      )
      expect(fakeState.captured).toHaveLength(2)
      expect(response.status).toBe(200)
      // The retry sent fewer betas than the initial request (one was
      // recorded as excluded after the 400). Compare beta cardinality.
      const initialBetas = fakeState.captured[0]!.headers["anthropic-beta"]!.split(",").length
      const retryBetas = fakeState.captured[1]!.headers["anthropic-beta"]!.split(",").length
      expect(retryBetas).toBe(initialBetas - 1)
    }),
  )
  it.live("learning persists into the cache — next request starts pre-narrowed", () =>
    Effect.gen(function* () {
      initAnthropicKeychainEnv({})
      const creds = yield* Effect.promise(() => buildCreds(validCredsIO("k1")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        responder: (call) =>
          call === 0
            ? new Response(LONG_CONTEXT_BODY, { status: 400 })
            : new Response("ok", { status: 200 }),
      }
      const transform = buildKeychainTransformClient(creds, cache)
      const wrapped = transform(makeFakeClient(fakeState))
      // First request: 400 → retry → 200. Two captures.
      yield* Effect.promise(() =>
        runOk(
          wrapped
            .post("https://api.anthropic.com/v1/messages", {
              body: jsonBody({ model: "claude-opus-4-6" }),
            })
            .pipe(Effect.orDie),
        ),
      )
      expect(fakeState.captured).toHaveLength(2)
      const learnedBetaCount = fakeState.captured[1]!.headers["anthropic-beta"]!.split(",").length
      // Second request — the cache should already have the previously
      // rejected beta, so the FIRST attempt sends the narrower set.
      yield* Effect.promise(() =>
        runOk(
          wrapped
            .post("https://api.anthropic.com/v1/messages", {
              body: jsonBody({ model: "claude-opus-4-6" }),
            })
            .pipe(Effect.orDie),
        ),
      )
      expect(fakeState.captured).toHaveLength(3)
      const nextRequestBetas = fakeState.captured[2]!.headers["anthropic-beta"]!.split(",").length
      expect(nextRequestBetas).toBe(learnedBetaCount)
    }),
  )
  it.live("429 with long-context-shaped body still retries via outer transient layer", () =>
    Effect.gen(function* () {
      // Long-context layer is 400-only. A 429 — even if its body string
      // happens to match the long-context marker — flows through to the
      // outer transient layer untouched. Two-attempt sequence: 429-LC-body
      // → 200. Asserts the outer 429 retry kicked in (2 captures), NOT
      // the long-context retry (which would have rebuilt headers; on a
      // 429 there's nothing useful to narrow because the rate limit isn't
      // beta-related).
      initAnthropicKeychainEnv({})
      const creds = yield* Effect.promise(() => buildCreds(validCredsIO("k1")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        responder: (call) =>
          call === 0
            ? new Response(LONG_CONTEXT_BODY, { status: 429 })
            : new Response("ok", { status: 200 }),
      }
      const transform = buildKeychainTransformClient(creds, cache)
      const wrapped = transform(makeFakeClient(fakeState))
      const response = yield* Effect.promise(() =>
        runWithTestClock(
          wrapped
            .post("https://api.anthropic.com/v1/messages", {
              body: jsonBody({ model: "claude-opus-4-6" }),
            })
            .pipe(Effect.orDie),
        ),
      )
      expect(fakeState.captured).toHaveLength(2)
      expect(response.status).toBe(200)
      // Crucial: header beta count unchanged between the two attempts —
      // long-context layer did NOT narrow the set on the 429.
      const initialBetas = fakeState.captured[0]!.headers["anthropic-beta"]!.split(",").length
      const retryBetas = fakeState.captured[1]!.headers["anthropic-beta"]!.split(",").length
      expect(retryBetas).toBe(initialBetas)
    }),
  )
  it.live("non-long-context 400 passes through without retry", () =>
    Effect.gen(function* () {
      initAnthropicKeychainEnv({})
      const creds = yield* Effect.promise(() => buildCreds(validCredsIO("k1")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        responder: () => new Response(NON_LONG_CONTEXT_400, { status: 400 }),
      }
      const transform = buildKeychainTransformClient(creds, cache)
      const wrapped = transform(makeFakeClient(fakeState))
      const response = yield* Effect.promise(() =>
        runOk(
          wrapped
            .post("https://api.anthropic.com/v1/messages", {
              body: jsonBody({ model: "claude-opus-4-6" }),
            })
            .pipe(Effect.orDie),
        ),
      )
      expect(fakeState.captured).toHaveLength(1)
      expect(response.status).toBe(400)
    }),
  )
  it.live("exhausted candidates surface terminal 400 (every long-context beta tried)", () =>
    Effect.gen(function* () {
      initAnthropicKeychainEnv({})
      const creds = yield* Effect.promise(() => buildCreds(validCredsIO("k1")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        // Always return long-context 400 — middleware should give up
        // after exhausting candidates and hand back the 400.
        responder: () => new Response(LONG_CONTEXT_BODY, { status: 400 }),
      }
      const transform = buildKeychainTransformClient(creds, cache)
      const wrapped = transform(makeFakeClient(fakeState))
      const response = yield* Effect.promise(() =>
        runOk(
          wrapped
            .post("https://api.anthropic.com/v1/messages", {
              body: jsonBody({ model: "claude-opus-4-6" }),
            })
            .pipe(Effect.orDie),
        ),
      )
      // claude-opus-4-6 emits 2 long-context betas
      // (context-1m-2025-08-07 + interleaved-thinking-2025-05-14).
      // Initial attempt + 2 narrowing attempts = 3 captures.
      expect(fakeState.captured).toHaveLength(3)
      expect(response.status).toBe(400)
    }),
  )
})
describe("keychainTransformClient — 401 recovery (Commit 2e)", () => {
  // IO that flips its `read` result on each call — simulates the
  // production sequence: stale cached token sent on attempt 1, 401 fires
  // creds.invalidate, attempt 2's mapRequestEffect re-reads keychain and
  // gets the fresh token. No global mutation; the toggle lives in a
  // closure over `attempt`.
  const togglingCredsIO = (staleLabel: string, freshLabel: string): AnthropicCredentialIO => {
    let attempt = 0
    return {
      read: Effect.suspend(() => {
        const label = attempt === 0 ? staleLabel : freshLabel
        attempt++
        return Effect.succeed(makeCreds(label))
      }),
      refresh: Effect.fail(new ProviderAuthError({ message: "should not be called" })),
    }
  }
  it.live("401 once → invalidate creds → retry succeeds with fresh token", () =>
    Effect.gen(function* () {
      initAnthropicKeychainEnv({})
      const creds = yield* Effect.promise(() => buildCreds(togglingCredsIO("stale", "fresh")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        responder: (call) =>
          call === 0 ? new Response("auth", { status: 401 }) : new Response("ok", { status: 200 }),
      }
      const transform = buildKeychainTransformClient(creds, cache)
      const wrapped = transform(makeFakeClient(fakeState))
      const response = yield* Effect.promise(() =>
        runOk(
          wrapped.post("https://api.anthropic.com/v1/messages", {
            body: jsonBody({ model: "claude-opus-4-6" }),
          }),
        ),
      )
      expect(fakeState.captured).toHaveLength(2)
      expect(response.status).toBe(200)
      // Crucial: token differs across attempts — invalidate forced the
      // mapRequestEffect to re-read creds, getting the fresh token.
      expect(fakeState.captured[0]!.headers["authorization"]).toBe("Bearer stale-access")
      expect(fakeState.captured[1]!.headers["authorization"]).toBe("Bearer fresh-access")
    }),
  )
  it.live("two consecutive 401s — second surfaces (real auth failure, no infinite loop)", () =>
    Effect.gen(function* () {
      initAnthropicKeychainEnv({})
      const creds = yield* Effect.promise(() => buildCreds(togglingCredsIO("stale", "still-bad")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        // Both attempts get 401 — the second 401 is a real auth failure
        // (revoked session, missing scope) and must reach the caller.
        responder: () => new Response("auth", { status: 401 }),
      }
      const transform = buildKeychainTransformClient(creds, cache)
      const wrapped = transform(makeFakeClient(fakeState))
      const response = yield* Effect.promise(() =>
        runOk(
          wrapped.post("https://api.anthropic.com/v1/messages", {
            body: jsonBody({ model: "claude-opus-4-6" }),
          }),
        ),
      )
      // 1 initial + 1 retry = 2 attempts (no third)
      expect(fakeState.captured).toHaveLength(2)
      expect(response.status).toBe(401)
    }),
  )
  it.live("non-401 failure does not invalidate creds", () =>
    Effect.gen(function* () {
      // Fire TWO sequential requests (500 then 200) on the same creds
      // service. If a non-401 mistakenly invalidated the cache, request
      // #2 would re-read and pick up the second token. Asserting both
      // requests use the first token proves the cache survived the 500.
      initAnthropicKeychainEnv({})
      const creds = yield* Effect.promise(() => buildCreds(togglingCredsIO("first", "second")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        responder: (call) =>
          call === 0
            ? new Response("server error", { status: 500 })
            : new Response("ok", { status: 200 }),
      }
      const transform = buildKeychainTransformClient(creds, cache)
      const wrapped = transform(makeFakeClient(fakeState))
      const r1 = yield* Effect.promise(() =>
        runOk(
          wrapped.post("https://api.anthropic.com/v1/messages", {
            body: jsonBody({ model: "claude-opus-4-6" }),
          }),
        ),
      )
      const r2 = yield* Effect.promise(() =>
        runOk(
          wrapped.post("https://api.anthropic.com/v1/messages", {
            body: jsonBody({ model: "claude-opus-4-6" }),
          }),
        ),
      )
      expect(fakeState.captured).toHaveLength(2)
      expect(r1.status).toBe(500)
      expect(r2.status).toBe(200)
      // Both requests used the cached "first" token. If the 500 had
      // wrongly invalidated, request #2 would carry "second-access".
      expect(fakeState.captured[0]!.headers["authorization"]).toBe("Bearer first-access")
      expect(fakeState.captured[1]!.headers["authorization"]).toBe("Bearer first-access")
    }),
  )
})
// Suppress unused-warning for Layer/Ref imports kept for symmetry with
// other test files in this directory.
void Layer
void Ref
