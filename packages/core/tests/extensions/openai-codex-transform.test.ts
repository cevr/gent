/**
 * codexTransformClient — auth-headers middleware (O2).
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
import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import type { Cause } from "effect"
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http"
import { HttpClientError, TransportError } from "effect/unstable/http/HttpClientError"
import { buildCodexTransformClient } from "@gent/extensions/openai/codex-transform"
import {
  OpenAICredentialService,
  type OpenAICredentialIO,
  type OpenAICredentialServiceShape,
  type OpenAICredentials,
} from "@gent/extensions/openai/credential-service"
import { ProviderAuthError, type ProviderAuthInfo } from "@gent/core/extensions/api"

// ── Fake HttpClient ──

interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}

interface TransportFailure {
  readonly _tag: "TransportFailure"
  readonly message: string
}
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

// ── Service-instance extraction ──

// Capture the credential-service "instance" by running its layer once
// and grabbing the service from context. The transform takes this
// instance directly (closure-based, not yielded from R).
const buildCreds = async (
  io: OpenAICredentialIO,
  authInfo: ProviderAuthInfo,
): Promise<OpenAICredentialServiceShape> => {
  const layer = OpenAICredentialService.layerFromIO(io, authInfo)
  return await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        return yield* OpenAICredentialService
      }).pipe(Effect.provide(layer)),
    ),
  )
}

// Real Clock here (no TestClock) — `expires` must be a real future
// Unix-millis timestamp comfortably outside the 60s freshness margin.
const FAR_FUTURE_MS = () => Date.now() + 10 * 60 * 60 * 1000

const validAuthInfo = (
  overrides?: Partial<{ access: string; refresh: string; accountId: string }>,
): ProviderAuthInfo => ({
  type: "oauth",
  access: overrides?.access ?? "fresh-access",
  refresh: overrides?.refresh ?? "fresh-refresh",
  expires: FAR_FUTURE_MS(),
  ...(overrides?.accountId !== undefined ? { accountId: overrides.accountId } : {}),
})

const noopRefreshIO = (): OpenAICredentialIO => ({
  refresh: () => Effect.fail(new ProviderAuthError({ message: "should not be called" })),
})

// `HttpBody.jsonUnsafe` mirrors how the OpenAI-compat SDK serializes
// outgoing JSON bodies (via `bodyJsonUnsafe`/`bodyText` → Uint8Array).
const jsonBody = (payload: Record<string, unknown>) => HttpBody.jsonUnsafe(payload)

const runOk = <A, E>(eff: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(Effect.scoped(eff.pipe(Effect.orDie)))

// ── Tests ──

describe("codexTransformClient — auth headers (O2)", () => {
  test("injects Authorization Bearer from credential service", async () => {
    const creds = await buildCreds(noopRefreshIO(), validAuthInfo({ access: "k1-access" }))
    const fakeState: FakeClientState = {
      captured: [],
      responder: () => new Response("ok", { status: 200 }),
    }
    const transform = buildCodexTransformClient(creds)
    const wrapped = transform(makeFakeClient(fakeState))

    await runOk(
      wrapped.post("https://api.openai.com/v1/chat/completions", {
        body: jsonBody({ model: "gpt-5.4" }),
      }),
    )

    expect(fakeState.captured).toHaveLength(1)
    expect(fakeState.captured[0]!.headers["authorization"]).toBe("Bearer k1-access")
  })

  test("overrides any pre-existing Authorization header", async () => {
    // Defensive: if anything upstream injected a placeholder Bearer,
    // the transform must replace it with the OAuth value.
    const creds = await buildCreds(noopRefreshIO(), validAuthInfo({ access: "k1-access" }))
    const fakeState: FakeClientState = {
      captured: [],
      responder: () => new Response("ok", { status: 200 }),
    }
    const transform = buildCodexTransformClient(creds)
    const wrapped = transform(makeFakeClient(fakeState))

    await runOk(
      wrapped.post("https://api.openai.com/v1/chat/completions", {
        headers: { authorization: "Bearer placeholder" },
        body: jsonBody({ model: "gpt-5.4" }),
      }),
    )

    expect(fakeState.captured[0]!.headers["authorization"]).toBe("Bearer k1-access")
  })

  test("sets ChatGPT-Account-Id when present in credentials", async () => {
    const creds = await buildCreds(
      noopRefreshIO(),
      validAuthInfo({ access: "k1-access", accountId: "acct-123" }),
    )
    const fakeState: FakeClientState = {
      captured: [],
      responder: () => new Response("ok", { status: 200 }),
    }
    const transform = buildCodexTransformClient(creds)
    const wrapped = transform(makeFakeClient(fakeState))

    await runOk(
      wrapped.post("https://api.openai.com/v1/chat/completions", {
        body: jsonBody({ model: "gpt-5.4" }),
      }),
    )

    expect(fakeState.captured[0]!.headers["chatgpt-account-id"]).toBe("acct-123")
  })

  test("omits ChatGPT-Account-Id when accountId absent", async () => {
    const creds = await buildCreds(noopRefreshIO(), validAuthInfo({ access: "k1-access" }))
    const fakeState: FakeClientState = {
      captured: [],
      responder: () => new Response("ok", { status: 200 }),
    }
    const transform = buildCodexTransformClient(creds)
    const wrapped = transform(makeFakeClient(fakeState))

    await runOk(
      wrapped.post("https://api.openai.com/v1/chat/completions", {
        body: jsonBody({ model: "gpt-5.4" }),
      }),
    )

    expect(fakeState.captured[0]!.headers["chatgpt-account-id"]).toBeUndefined()
  })

  test("sets default originator + user-agent when upstream omits them", async () => {
    const creds = await buildCreds(noopRefreshIO(), validAuthInfo({ access: "k1-access" }))
    const fakeState: FakeClientState = {
      captured: [],
      responder: () => new Response("ok", { status: 200 }),
    }
    const transform = buildCodexTransformClient(creds)
    const wrapped = transform(makeFakeClient(fakeState))

    await runOk(
      wrapped.post("https://api.openai.com/v1/chat/completions", {
        body: jsonBody({ model: "gpt-5.4" }),
      }),
    )

    expect(fakeState.captured[0]!.headers["originator"]).toBe("gent")
    expect(fakeState.captured[0]!.headers["user-agent"]).toMatch(/^gent \(/)
  })

  test("preserves upstream originator + user-agent when already set", async () => {
    const creds = await buildCreds(noopRefreshIO(), validAuthInfo({ access: "k1-access" }))
    const fakeState: FakeClientState = {
      captured: [],
      responder: () => new Response("ok", { status: 200 }),
    }
    const transform = buildCodexTransformClient(creds)
    const wrapped = transform(makeFakeClient(fakeState))

    await runOk(
      wrapped.post("https://api.openai.com/v1/chat/completions", {
        headers: { originator: "custom-app", "user-agent": "custom-ua/1.0" },
        body: jsonBody({ model: "gpt-5.4" }),
      }),
    )

    expect(fakeState.captured[0]!.headers["originator"]).toBe("custom-app")
    expect(fakeState.captured[0]!.headers["user-agent"]).toBe("custom-ua/1.0")
  })

  test("preserves request method, url, and body for non-Codex paths", async () => {
    // The OpenAI-compat SDK ALSO talks to `/embeddings` and other
    // non-Codex endpoints. Those must pass through untouched (auth
    // headers still applied — see other tests). Use the embeddings
    // path here as a non-Codex example.
    const creds = await buildCreds(noopRefreshIO(), validAuthInfo({ access: "k1-access" }))
    const fakeState: FakeClientState = {
      captured: [],
      responder: () => new Response("ok", { status: 200 }),
    }
    const transform = buildCodexTransformClient(creds)
    const wrapped = transform(makeFakeClient(fakeState))

    await runOk(
      wrapped.post("https://api.openai.com/v1/embeddings", {
        body: jsonBody({ model: "text-embedding-3-small", input: "hello" }),
      }),
    )

    const seen = fakeState.captured[0]!
    expect(seen.method).toBe("POST")
    expect(seen.url).toBe("https://api.openai.com/v1/embeddings")
    expect(seen.body).toBeDefined()
    const parsed = JSON.parse(seen.body ?? "{}") as { model: string; input: string }
    expect(parsed.model).toBe("text-embedding-3-small")
    expect(parsed.input).toBe("hello")
    // No Codex beta header on non-Codex paths.
    expect(seen.headers["openai-beta"]).toBeUndefined()
  })

  test("surfaces ProviderAuthError from getFresh as HttpClientError", async () => {
    // When credentials are unavailable, the typed ProviderAuthError
    // must reach the client surface as the standard transport error
    // type — that's what keeps the SDK's `transformClient` signature
    // satisfied (`With<HttpClientError, never>`).
    const refreshFails: OpenAICredentialIO = {
      refresh: () => Effect.fail(new ProviderAuthError({ message: "no usable refresh token" })),
    }
    // authInfo with stale access + non-empty refresh forces refresh.
    const stalAuthInfo: ProviderAuthInfo = {
      type: "oauth",
      access: "stale-access",
      refresh: "stale-refresh",
      expires: 0, // already expired → forces refresh
    }
    const creds = await buildCreds(refreshFails, stalAuthInfo)
    const fakeState: FakeClientState = {
      captured: [],
      responder: () => new Response("ok", { status: 200 }),
    }
    const transform = buildCodexTransformClient(creds)
    const wrapped = transform(makeFakeClient(fakeState))

    const result = await Effect.runPromise(
      Effect.scoped(
        wrapped
          .post("https://api.openai.com/v1/chat/completions", {
            body: jsonBody({ model: "gpt-5.4" }),
          })
          .pipe(Effect.exit),
      ),
    )

    expect(result._tag).toBe("Failure")
    // Capture stays empty — the request never hit the wire.
    expect(fakeState.captured).toHaveLength(0)

    // The failure surface must be the standard transport error type
    // (HttpClientError with a TransportError reason) so the wrapped
    // client signature stays `With<HttpClientError, never>`. The
    // original ProviderAuthError must be reachable as the cause so
    // upstream error classifiers can still see it.
    if (result._tag !== "Failure") throw new Error("expected failure")
    const failReason = result.cause.reasons.find(
      (r): r is Cause.Fail<HttpClientError> => r._tag === "Fail",
    )
    expect(failReason).toBeDefined()
    const err = failReason!.error
    expect(err).toBeInstanceOf(HttpClientError)
    expect(err.reason).toBeInstanceOf(TransportError)
    const reason = err.reason as TransportError
    expect(reason.cause).toBeInstanceOf(ProviderAuthError)
    expect((reason.cause as ProviderAuthError).message).toBe("no usable refresh token")
    expect(reason.description).toBe("no usable refresh token")
  })

  test("calls getFresh per-request (rotated cell wins on second call)", async () => {
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
            expires: FAR_FUTURE_MS(),
          })
        }
        return Effect.fail(new ProviderAuthError({ message: "should not be called twice" }))
      },
    }
    const stalAuthInfo: ProviderAuthInfo = {
      type: "oauth",
      access: "seed-access",
      refresh: "seed-refresh",
      expires: 0, // forces refresh on first getFresh
    }
    const creds = await buildCreds(rotateIO, stalAuthInfo)
    const fakeState: FakeClientState = {
      captured: [],
      responder: () => new Response("ok", { status: 200 }),
    }
    const transform = buildCodexTransformClient(creds)
    const wrapped = transform(makeFakeClient(fakeState))

    await runOk(
      wrapped.post("https://api.openai.com/v1/chat/completions", {
        body: jsonBody({ model: "gpt-5.4" }),
      }),
    )
    await runOk(
      wrapped.post("https://api.openai.com/v1/chat/completions", {
        body: jsonBody({ model: "gpt-5.4" }),
      }),
    )

    expect(fakeState.captured).toHaveLength(2)
    // First call refreshes seed → rotated; second hits cache and reuses.
    expect(fakeState.captured[0]!.headers["authorization"]).toBe("Bearer rotated-access")
    expect(fakeState.captured[1]!.headers["authorization"]).toBe("Bearer rotated-access")
  })
})

describe("codexTransformClient — URL/body/beta rewrite (O3)", () => {
  // Helpers local to O3 — keep the auth-header tests above untouched.
  const okResponse = (): FakeClientState => ({
    captured: [],
    responder: () => new Response("ok", { status: 200 }),
  })

  const buildWrapped = async (state: FakeClientState) => {
    const creds = await buildCreds(noopRefreshIO(), validAuthInfo({ access: "k1-access" }))
    return buildCodexTransformClient(creds)(makeFakeClient(state))
  }

  test("rewrites /v1/chat/completions URL to the Codex backend endpoint", async () => {
    const state = okResponse()
    const wrapped = await buildWrapped(state)
    await runOk(
      wrapped.post("https://api.openai.com/v1/chat/completions", {
        body: jsonBody({ model: "gpt-5.4", messages: [{ role: "user", content: "hi" }] }),
      }),
    )
    expect(state.captured[0]!.url).toBe("https://chatgpt.com/backend-api/codex/responses")
  })

  test("rewrites /v1/responses URL to the Codex backend endpoint", async () => {
    const state = okResponse()
    const wrapped = await buildWrapped(state)
    await runOk(
      wrapped.post("https://api.openai.com/v1/responses", {
        body: jsonBody({ model: "gpt-5.4", input: [{ role: "user", content: "hi" }] }),
      }),
    )
    expect(state.captured[0]!.url).toBe("https://chatgpt.com/backend-api/codex/responses")
  })

  test("does NOT rewrite paths that are not exactly chat/completions or responses", async () => {
    // Counsel correction: legacy used `includes(...)` which would match
    // sub-resources. Lock to exact equality.
    const state = okResponse()
    const wrapped = await buildWrapped(state)
    await runOk(
      wrapped.post("https://api.openai.com/v1/chat/completions/foo", {
        body: jsonBody({ model: "gpt-5.4" }),
      }),
    )
    expect(state.captured[0]!.url).toBe("https://api.openai.com/v1/chat/completions/foo")
    expect(state.captured[0]!.headers["openai-beta"]).toBeUndefined()
  })

  test("sets OpenAI-Beta header on Codex-bound paths", async () => {
    const state = okResponse()
    const wrapped = await buildWrapped(state)
    await runOk(
      wrapped.post("https://api.openai.com/v1/chat/completions", {
        body: jsonBody({ model: "gpt-5.4" }),
      }),
    )
    expect(state.captured[0]!.headers["openai-beta"]).toBe("responses=experimental")
  })

  test("merges responses=experimental into a pre-existing OpenAI-Beta header (preserve other tokens)", async () => {
    // Counsel O3 MEDIUM #2: if upstream sets a custom beta value, we
    // must still ensure `responses=experimental` is present — pure
    // preservation would let Codex reject our traffic if the SDK ever
    // starts injecting a different beta token. Append the required
    // token if missing; preserve every other token unchanged.
    const state = okResponse()
    const wrapped = await buildWrapped(state)
    await runOk(
      wrapped.post("https://api.openai.com/v1/chat/completions", {
        headers: { "openai-beta": "custom=value" },
        body: jsonBody({ model: "gpt-5.4" }),
      }),
    )
    expect(state.captured[0]!.headers["openai-beta"]).toBe("custom=value, responses=experimental")
  })

  test("does not duplicate responses=experimental when it's already present", async () => {
    const state = okResponse()
    const wrapped = await buildWrapped(state)
    await runOk(
      wrapped.post("https://api.openai.com/v1/chat/completions", {
        headers: { "openai-beta": "custom=value, responses=experimental" },
        body: jsonBody({ model: "gpt-5.4" }),
      }),
    )
    expect(state.captured[0]!.headers["openai-beta"]).toBe("custom=value, responses=experimental")
  })

  test("structured (non-string) system/developer content stays in input, NOT silently dropped", async () => {
    // Counsel O3 MEDIUM #1: only string content lifts to top-level
    // `instructions`. Items with structured content (e.g. ReadonlyArray
    // of InputContent for system/developer per the OpenAI-compat
    // schema) must remain in `filteredInput` so the Codex backend still
    // sees them — silently dropping would corrupt the prompt.
    const state = okResponse()
    const wrapped = await buildWrapped(state)
    const structured = { role: "system", content: [{ type: "input_text", text: "structured" }] }
    await runOk(
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
    const parsed = JSON.parse(state.captured[0]!.body!) as {
      instructions?: string
      input?: unknown[]
    }
    expect(parsed.instructions).toBe("string-instructions")
    // Structured system item retained in input (alongside the user msg).
    expect(parsed.input).toEqual([structured, { role: "user", content: "hi" }])
  })

  test("rewrites JSON body: lifts system/developer items into top-level instructions, sets store=false", async () => {
    const state = okResponse()
    const wrapped = await buildWrapped(state)
    await runOk(
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
    const parsed = JSON.parse(seen.body!) as {
      instructions?: string
      input?: unknown[]
      store?: boolean
      model?: string
    }
    expect(parsed.instructions).toBe("You are gent.\n\nBe terse.")
    expect(parsed.input).toEqual([{ role: "user", content: "hi" }])
    expect(parsed.store).toBe(false)
    expect(parsed.model).toBe("gpt-5.4")
  })

  test("body without an `input` array passes through unchanged on Codex paths", async () => {
    // Chat-completions payloads (`messages` instead of `input`) are
    // forwarded as-is to the Codex endpoint — the backend tolerates
    // the legacy shape today, and the SDK only emits this form on
    // /chat/completions today.
    const state = okResponse()
    const wrapped = await buildWrapped(state)
    const original = { model: "gpt-5.4", messages: [{ role: "user", content: "hi" }] }
    await runOk(
      wrapped.post("https://api.openai.com/v1/chat/completions", {
        body: jsonBody(original),
      }),
    )
    const parsed = JSON.parse(state.captured[0]!.body!)
    expect(parsed).toEqual(original)
  })

  test("body without input array: store flag NOT injected", async () => {
    // Make sure we never set `store: false` on a body that didn't
    // have an `input` array — the rewrite is gated on the input split.
    const state = okResponse()
    const wrapped = await buildWrapped(state)
    await runOk(
      wrapped.post("https://api.openai.com/v1/chat/completions", {
        body: jsonBody({ model: "gpt-5.4", messages: [] }),
      }),
    )
    const parsed = JSON.parse(state.captured[0]!.body!) as { store?: boolean }
    expect(parsed.store).toBeUndefined()
  })

  test("body with input but no system/developer items: instructions NOT injected, store=false set", async () => {
    const state = okResponse()
    const wrapped = await buildWrapped(state)
    await runOk(
      wrapped.post("https://api.openai.com/v1/responses", {
        body: jsonBody({
          model: "gpt-5.4",
          input: [{ role: "user", content: "hi" }],
        }),
      }),
    )
    const parsed = JSON.parse(state.captured[0]!.body!) as {
      instructions?: string
      input?: unknown[]
      store?: boolean
    }
    expect(parsed.instructions).toBeUndefined()
    expect(parsed.input).toEqual([{ role: "user", content: "hi" }])
    expect(parsed.store).toBe(false)
  })

  test("non-Codex path: body untouched even when it carries an input array", async () => {
    const state = okResponse()
    const wrapped = await buildWrapped(state)
    const original = {
      model: "text-embedding-3-small",
      input: [{ role: "system", content: "should-not-be-lifted" }],
    }
    await runOk(
      wrapped.post("https://api.openai.com/v1/embeddings", {
        body: jsonBody(original),
      }),
    )
    const parsed = JSON.parse(state.captured[0]!.body!)
    expect(parsed).toEqual(original)
    expect(state.captured[0]!.url).toBe("https://api.openai.com/v1/embeddings")
  })

  test("auth headers still apply on Codex-rewritten requests", async () => {
    // Belt-and-suspenders: the URL/body rewrite path must not strip
    // the OAuth Bearer / ChatGPT-Account-Id added by the auth-header
    // preprocess.
    const creds = await buildCreds(
      noopRefreshIO(),
      validAuthInfo({ access: "k1-access", accountId: "acc-123" }),
    )
    const state = okResponse()
    const wrapped = buildCodexTransformClient(creds)(makeFakeClient(state))
    await runOk(
      wrapped.post("https://api.openai.com/v1/chat/completions", {
        body: jsonBody({ model: "gpt-5.4" }),
      }),
    )
    expect(state.captured[0]!.headers["authorization"]).toBe("Bearer k1-access")
    expect(state.captured[0]!.headers["chatgpt-account-id"]).toBe("acc-123")
    expect(state.captured[0]!.url).toBe("https://chatgpt.com/backend-api/codex/responses")
  })
})

describe("codexTransformClient — 401 recovery (O4)", () => {
  // The credential cache TTL (30s) can outlive a token's last minute,
  // and OAuth tokens can be revoked server-side between cache fill and
  // wire send. On 401: invalidate the cache + retry once. A second 401
  // surfaces the response so the user can re-authorize.

  test("stale token + 401 → invalidate + retry succeeds with rotated token", async () => {
    // First refresh seeds with "stale-access" (expired authInfo); after
    // the wire returns 401, the credential service is invalidated, and
    // the next preprocess re-enters → second refresh returns
    // "rotated-access". The retried request goes through and succeeds.
    let refreshCount = 0
    const rotateIO: OpenAICredentialIO = {
      refresh: () =>
        Effect.sync(() => {
          refreshCount += 1
          return refreshCount === 1
            ? {
                access: "stale-access",
                refresh: "stale-refresh",
                expires: FAR_FUTURE_MS(),
              }
            : {
                access: "rotated-access",
                refresh: "rotated-refresh",
                expires: FAR_FUTURE_MS(),
              }
        }),
    }
    // Empty access on authInfo forces an initial refresh (otherwise the
    // cache hits with the seed token and never calls our IO).
    const stalAuthInfo: ProviderAuthInfo = {
      type: "oauth",
      access: "",
      refresh: "seed-refresh",
      expires: 0,
    }
    const creds = await buildCreds(rotateIO, stalAuthInfo)
    const state: FakeClientState = {
      captured: [],
      // First call returns 401, second returns 200.
      responder: (call) =>
        call === 0
          ? new Response("unauthorized", { status: 401 })
          : new Response("ok", { status: 200 }),
    }
    const wrapped = buildCodexTransformClient(creds)(makeFakeClient(state))

    const response = await runOk(
      wrapped.post("https://api.openai.com/v1/chat/completions", {
        body: jsonBody({ model: "gpt-5.4" }),
      }),
    )

    expect(response.status).toBe(200)
    expect(state.captured).toHaveLength(2)
    // First attempt used the stale token; the retry used the rotated.
    expect(state.captured[0]!.headers["authorization"]).toBe("Bearer stale-access")
    expect(state.captured[1]!.headers["authorization"]).toBe("Bearer rotated-access")
    expect(refreshCount).toBe(2)
  })

  test("double 401 surfaces the response (no infinite retry)", async () => {
    // Both wire attempts return 401. After invalidate + retry, the
    // second 401 must surface as a 401 response (not a typed error,
    // not another retry) so user-facing recovery can kick in.
    const noopRotateIO: OpenAICredentialIO = {
      refresh: () =>
        Effect.succeed<OpenAICredentials>({
          access: "always-stale",
          refresh: "always-stale-refresh",
          expires: FAR_FUTURE_MS(),
        }),
    }
    const stalAuthInfo: ProviderAuthInfo = {
      type: "oauth",
      access: "",
      refresh: "seed",
      expires: 0,
    }
    const creds = await buildCreds(noopRotateIO, stalAuthInfo)
    const state: FakeClientState = {
      captured: [],
      responder: () => new Response("unauthorized", { status: 401 }),
    }
    const wrapped = buildCodexTransformClient(creds)(makeFakeClient(state))

    const response = await runOk(
      wrapped.post("https://api.openai.com/v1/chat/completions", {
        body: jsonBody({ model: "gpt-5.4" }),
      }),
    )

    expect(response.status).toBe(401)
    // Exactly two attempts: original + one retry.
    expect(state.captured).toHaveLength(2)
  })

  test("non-401 errors do NOT trigger retry", async () => {
    // 500 (or any non-401) must pass through verbatim — only 401 is
    // the auth-recovery signal.
    const noopRotateIO: OpenAICredentialIO = {
      refresh: () => Effect.fail(new ProviderAuthError({ message: "should not be called" })),
    }
    const validInfo = validAuthInfo({ access: "fresh-access" })
    const creds = await buildCreds(noopRotateIO, validInfo)
    const state: FakeClientState = {
      captured: [],
      responder: () => new Response("server error", { status: 500 }),
    }
    const wrapped = buildCodexTransformClient(creds)(makeFakeClient(state))

    const response = await runOk(
      wrapped.post("https://api.openai.com/v1/chat/completions", {
        body: jsonBody({ model: "gpt-5.4" }),
      }),
    )

    expect(response.status).toBe(500)
    // No retry on 500 → exactly one attempt.
    expect(state.captured).toHaveLength(1)
  })

  test("200 OK never triggers retry", async () => {
    const noopRotateIO: OpenAICredentialIO = {
      refresh: () => Effect.fail(new ProviderAuthError({ message: "should not be called" })),
    }
    const creds = await buildCreds(noopRotateIO, validAuthInfo({ access: "fresh-access" }))
    const state: FakeClientState = {
      captured: [],
      responder: () => new Response("ok", { status: 200 }),
    }
    const wrapped = buildCodexTransformClient(creds)(makeFakeClient(state))

    const response = await runOk(
      wrapped.post("https://api.openai.com/v1/chat/completions", {
        body: jsonBody({ model: "gpt-5.4" }),
      }),
    )

    expect(response.status).toBe(200)
    expect(state.captured).toHaveLength(1)
  })
})
