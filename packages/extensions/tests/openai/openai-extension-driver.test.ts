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
import { describe, expect, it } from "effect-bun-test"
import { Effect, Layer, Option, Schema, Stream, SynchronizedRef } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { encodeExternalJson } from "../helpers/external-wire.js"
import { buildOpenAIModelDriver } from "../../src/openai/index.js"
import type { OpenAICredentials } from "../../src/openai/credential-service.js"
import { EMPTY_CREDENTIAL_CELL, type CredentialCacheCell } from "../../src/providers.js"
import type { ProviderAuthInfo } from "@gent/core/extensions/api"
import {
  makeFakeFetchState,
  fakeFetchLayer,
  oneGenerate,
  type CapturedRequest,
  type FakeFetchState,
} from "@gent/core-internal/test-utils/fake-fetch"
import { SessionId } from "@gent/core-internal/domain/ids"
// Far-future expiry so cache hits the warm branch and `getFresh` skips
// the refresh round-trip (avoids hitting auth.openai.com from tests).
const NOW_MS = 1_700_000_000_000
const FAR_FUTURE_MS = 1_800_000_000_000
const makeOAuthInfo = (): ProviderAuthInfo => ({
  type: "oauth",
  access: "test-access",
  refresh: "test-refresh",
  expires: FAR_FUTURE_MS,
})
const makeApiAuthInfo = (key: string): ProviderAuthInfo => ({
  type: "api",
  key,
})
const makeDurableCell = (creds: OpenAICredentials): CredentialCacheCell<OpenAICredentials> => ({
  _tag: "Durable",
  creds,
  at: NOW_MS,
  invalidated: false,
})
const noopCallbacks = () => new Map()
const openaiResponsesHappyResponse = () => ({
  status: 200,
  body: encodeExternalJson({
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
  }),
})
const openaiChatHappyResponse = () => ({
  status: 200,
  body: encodeExternalJson({
    id: "chatcmpl-test-1",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-5.4",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }),
})
const responseForRequest = (request: CapturedRequest) => {
  if (request.url === "https://api.openai.com/v1/chat/completions") {
    return openaiChatHappyResponse()
  }
  return openaiResponsesHappyResponse()
}
const runOne = (layer: Parameters<typeof oneGenerate>[0], state: FakeFetchState) =>
  oneGenerate(layer, state, responseForRequest).pipe(Effect.orDie)

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
            id: "chatcmpl-cache",
            object: "chat.completion.chunk",
            created: 1700000000,
            model: "gpt-5.4",
            choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
          })}\n\ndata: [DONE]\n\n`,
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
      const driver = buildOpenAIModelDriver(credentialCellRef, noopCallbacks(), Option.none())
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
            expect(request.url).toBe("https://api.openai.com/v1/chat/completions")
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
      const driver = buildOpenAIModelDriver(credentialCellRef, noopCallbacks(), Option.none())
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
})

describe("buildOpenAIModelDriver — OAuth callback state", () => {
  it.live("stale callback state fails instead of reporting success", () =>
    Effect.gen(function* () {
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL)
      const driver = buildOpenAIModelDriver(credentialCellRef, noopCallbacks(), Option.none())
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
describe("buildOpenAIModelDriver — OAuth path uses external cache Ref", () => {
  it.live("OAuth resolveModel layer reads Bearer from credentialCellRef the test owns", () =>
    Effect.gen(function* () {
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL)
      const driver = buildOpenAIModelDriver(credentialCellRef, noopCallbacks(), Option.none())
      // Pre-seed the cred Ref directly (test owns it). If
      // `makeOauthOpenAILayer` regressed to allocating its own internal
      // Ref via `OpenAICredentialService.layer(authInfo)`, the production
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
        const driver = buildOpenAIModelDriver(credentialCellRef, noopCallbacks(), Option.none())
        const model = yield* driver.resolveModel("gpt-5.4", makeOAuthInfo())
        const fetchState = makeFakeFetchState()
        yield* runOne(model, fetchState)
        const lastReq = fetchState.captured.at(-1)!
        // Codex transform replaces the SDK's `/chat/completions` target
        // with the ChatGPT backend Codex endpoint.
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
      const driver = buildOpenAIModelDriver(credentialCellRef, noopCallbacks(), Option.none())
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
        const driver = buildOpenAIModelDriver(credentialCellRef, noopCallbacks(), Option.none())
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
  it.live("OAuth resolves the Astra review model", () =>
    Effect.gen(function* () {
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL)
      const driver = buildOpenAIModelDriver(credentialCellRef, noopCallbacks(), Option.none())
      const model = yield* driver.resolveModel("gpt-6-astra", makeOAuthInfo())
      const fetchState = makeFakeFetchState()
      yield* runOne(model, fetchState)
      expect(
        fetchState.captured.some(
          (request) =>
            request.url === "https://chatgpt.com/backend-api/codex/responses" &&
            request.body?.includes("gpt-6-astra"),
        ),
      ).toBe(true)
    }),
  )
  it.live("OAuth resolveModel rejects models the Codex backend does not serve", () =>
    Effect.gen(function* () {
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL)
      const driver = buildOpenAIModelDriver(credentialCellRef, noopCallbacks(), Option.none())
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
        const driver = buildOpenAIModelDriver(credentialCellRef, noopCallbacks(), Option.none())
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
        const driver = buildOpenAIModelDriver(credentialCellRef, noopCallbacks(), Option.none())
        const model = yield* driver.resolveModel("gpt-5.4", makeApiAuthInfo("sk-test-1234"))
        const fetchState = makeFakeFetchState()
        yield* runOne(model, fetchState)
        const lastReq = fetchState.captured.at(-1)!
        // SDK injects standard Bearer auth from apiKey
        expect(lastReq.headers["authorization"]).toBe("Bearer sk-test-1234")
        // No Codex backend rewrite on the API-key path
        expect(lastReq.url).toBe("https://api.openai.com/v1/chat/completions")
        // No Codex beta header
        expect(lastReq.headers["openai-beta"]).toBeUndefined()
      }),
  )
  it.live("API-key path does not touch the OAuth credential cell Ref", () =>
    Effect.gen(function* () {
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL)
      const driver = buildOpenAIModelDriver(credentialCellRef, noopCallbacks(), Option.none())
      const model = yield* driver.resolveModel("gpt-5.4", makeApiAuthInfo("sk-test-1234"))
      const fetchState = makeFakeFetchState()
      yield* runOne(model, fetchState)
      expect(yield* SynchronizedRef.get(credentialCellRef)).toBe(EMPTY_CREDENTIAL_CELL)
    }),
  )
})
