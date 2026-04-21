/**
 * OpenAIExtension model-driver wiring — extension-level regression
 * coverage for `buildOpenAIModelDriver` / `resolveModel`.
 *
 * The leaf-service suites (`openai-credential-service.test.ts`,
 * `openai-codex-transform.test.ts`) cover services in isolation. Those
 * passed throughout O1–O4 even though the production wiring was still
 * the legacy `createOpenAIOAuthFetch` (Promise edge). This file drives
 * one real `LanguageModel.generateText` through the resolved layer with
 * a captured fake `fetch`, then asserts on the outbound request shape.
 * That proves the resolved layer's production wiring uses the
 * test-owned `Ref` and applies the Codex transforms (or doesn't, on the
 * API-key branch).
 *
 * Mirrors `anthropic-extension-driver.test.ts`. Counsel C3 HIGH #1
 * (Anthropic) called this out as the missing regression seam — the
 * leaf-service suites passed even when `resolveModel` regressed to
 * allocating a fresh internal Ref per call. The same trap exists for
 * OpenAI's credential cache cell.
 */
import { describe, test, expect } from "bun:test"
import { Effect, Ref } from "effect"
import { buildOpenAIModelDriver } from "@gent/extensions/openai"
import {
  EMPTY_CREDENTIAL_CELL,
  type CredentialCacheCell,
} from "@gent/extensions/openai/credential-service"
import type { ProviderAuthInfo } from "@gent/core/extensions/api"
import {
  makeFakeFetchState,
  oneGenerate,
  type FakeFetchState,
} from "@gent/core/test-utils/fake-fetch"

// Far-future expiry so cache hits the warm branch and `getFresh` skips
// the refresh round-trip (avoids hitting auth.openai.com from tests).
const FAR_FUTURE_MS = (): number => Date.now() + 24 * 60 * 60 * 1000

const makeOAuthInfo = (): ProviderAuthInfo => ({
  type: "oauth",
  access: "test-access",
  refresh: "test-refresh",
  expires: FAR_FUTURE_MS(),
})

const makeApiAuthInfo = (key: string): ProviderAuthInfo => ({
  type: "api",
  key,
})

const noopCallbacks = () => new Map()

/**
 * OpenAI Chat Completions happy-path response. `LanguageModel.generateText`
 * parses this into a successful result so tests stay on the success branch
 * and assertions can focus on outbound request shape.
 */
const openaiHappyResponse = () => ({
  status: 200,
  body: JSON.stringify({
    id: "chatcmpl-test-1",
    object: "chat.completion",
    created: 1_700_000_000,
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

const runOne = (layer: Parameters<typeof oneGenerate>[0], state: FakeFetchState): Promise<void> =>
  Effect.runPromise(oneGenerate(layer, state, openaiHappyResponse))

describe("buildOpenAIModelDriver — OAuth path uses external cache Ref (counsel C3 HIGH #1 mirror)", () => {
  test("OAuth resolveModel layer reads Bearer from credentialCellRef the test owns", async () => {
    const credentialCellRef = Ref.makeUnsafe<CredentialCacheCell>(EMPTY_CREDENTIAL_CELL)
    const driver = buildOpenAIModelDriver(credentialCellRef, noopCallbacks())

    // Pre-seed the cred Ref directly (test owns it). If
    // `makeOauthOpenAILayer` regressed to allocating its own internal
    // Ref via `OpenAICredentialService.layer(authInfo)`, the production
    // credential service would fall back to `authInfo.access` instead
    // of seeing this seed. Asserting the captured Authorization header
    // reflects the seed pins the Ref-sharing semantics.
    Effect.runSync(
      Ref.set(credentialCellRef, {
        creds: {
          access: "seeded-bearer-token",
          refresh: "r",
          expires: FAR_FUTURE_MS(),
        },
        at: Date.now(),
      }),
    )

    const { layer } = driver.resolveModel("gpt-5.4", makeOAuthInfo())
    const fetchState = makeFakeFetchState()
    await runOne(layer, fetchState)

    expect(fetchState.captured.length).toBeGreaterThan(0)
    const lastReq = fetchState.captured[fetchState.captured.length - 1]!
    expect(lastReq.headers["authorization"]).toBe("Bearer seeded-bearer-token")
  })

  test("OAuth resolveModel layer rewrites URL to Codex backend + sets responses=experimental beta", async () => {
    const credentialCellRef = Ref.makeUnsafe<CredentialCacheCell>(EMPTY_CREDENTIAL_CELL)
    Effect.runSync(
      Ref.set(credentialCellRef, {
        creds: { access: "t", refresh: "r", expires: FAR_FUTURE_MS() },
        at: Date.now(),
      }),
    )

    const driver = buildOpenAIModelDriver(credentialCellRef, noopCallbacks())
    const { layer } = driver.resolveModel("gpt-5.4", makeOAuthInfo())
    const fetchState = makeFakeFetchState()
    await runOne(layer, fetchState)

    const lastReq = fetchState.captured.at(-1)!
    // Codex transform replaces the SDK's `/chat/completions` target
    // with the ChatGPT backend Codex endpoint.
    expect(lastReq.url).toBe("https://chatgpt.com/backend-api/codex/responses")
    // Codex requires the `responses=experimental` beta token. The
    // transform merges it into any existing OpenAI-Beta value (counsel
    // O3 MEDIUM #2). The SDK does not set its own OpenAI-Beta header,
    // so this should be the only token.
    const beta = lastReq.headers["openai-beta"] ?? ""
    expect(beta).toContain("responses=experimental")
  })

  test("OAuth resolveModel layer omits x-api-key (no SDK-injected Bearer placeholder)", async () => {
    const credentialCellRef = Ref.makeUnsafe<CredentialCacheCell>(EMPTY_CREDENTIAL_CELL)
    Effect.runSync(
      Ref.set(credentialCellRef, {
        creds: { access: "t", refresh: "r", expires: FAR_FUTURE_MS() },
        at: Date.now(),
      }),
    )

    const driver = buildOpenAIModelDriver(credentialCellRef, noopCallbacks())
    const { layer } = driver.resolveModel("gpt-5.4", makeOAuthInfo())
    const fetchState = makeFakeFetchState()
    await runOne(layer, fetchState)

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
  })

  test("two OAuth resolveModel calls share the credentialCellRef — second sees first call's mutation", async () => {
    const credentialCellRef = Ref.makeUnsafe<CredentialCacheCell>(EMPTY_CREDENTIAL_CELL)

    Effect.runSync(
      Ref.set(credentialCellRef, {
        creds: { access: "first-token", refresh: "r", expires: FAR_FUTURE_MS() },
        at: Date.now(),
      }),
    )

    const driver = buildOpenAIModelDriver(credentialCellRef, noopCallbacks())

    const layer1 = driver.resolveModel("gpt-5.4", makeOAuthInfo()).layer
    const fetchState1 = makeFakeFetchState()
    await runOne(layer1, fetchState1)
    expect(fetchState1.captured.at(-1)!.headers["authorization"]).toBe("Bearer first-token")

    // Mutate the test-owned Ref between calls. If the second
    // `resolveModel` allocated a fresh internal Ref (the C3 regression
    // mirrored from Anthropic), the second request would still see
    // "first-token". Asserting the second request observes "second-token"
    // pins the Ref-sharing semantics that survives across resolveModel.
    Effect.runSync(
      Ref.set(credentialCellRef, {
        creds: { access: "second-token", refresh: "r", expires: FAR_FUTURE_MS() },
        at: Date.now(),
      }),
    )

    const layer2 = driver.resolveModel("gpt-5.4", makeOAuthInfo()).layer
    const fetchState2 = makeFakeFetchState()
    await runOne(layer2, fetchState2)
    expect(fetchState2.captured.at(-1)!.headers["authorization"]).toBe("Bearer second-token")
  })

  test("OAuth resolveModel rejects models outside OPENAI_OAUTH_ALLOWED_MODELS", () => {
    const credentialCellRef = Ref.makeUnsafe<CredentialCacheCell>(EMPTY_CREDENTIAL_CELL)
    const driver = buildOpenAIModelDriver(credentialCellRef, noopCallbacks())

    expect(() => driver.resolveModel("gpt-3.5-turbo", makeOAuthInfo())).toThrow(
      /not available with ChatGPT OAuth/,
    )
  })
})

describe("buildOpenAIModelDriver — API-key path is plain SDK", () => {
  test("API-key resolveModel layer sends Bearer with the API key (no Codex backend rewrite)", async () => {
    const credentialCellRef = Ref.makeUnsafe<CredentialCacheCell>(EMPTY_CREDENTIAL_CELL)
    const driver = buildOpenAIModelDriver(credentialCellRef, noopCallbacks())

    const { layer } = driver.resolveModel("gpt-5.4", makeApiAuthInfo("sk-test-1234"))
    const fetchState = makeFakeFetchState()
    await runOne(layer, fetchState)

    const lastReq = fetchState.captured.at(-1)!
    // SDK injects standard Bearer auth from apiKey
    expect(lastReq.headers["authorization"]).toBe("Bearer sk-test-1234")
    // No Codex backend rewrite on the API-key path
    expect(lastReq.url).toBe("https://api.openai.com/v1/chat/completions")
    // No Codex beta header
    expect(lastReq.headers["openai-beta"]).toBeUndefined()
  })

  test("API-key path does not touch the OAuth credential cell Ref", async () => {
    const credentialCellRef = Ref.makeUnsafe<CredentialCacheCell>(EMPTY_CREDENTIAL_CELL)
    const driver = buildOpenAIModelDriver(credentialCellRef, noopCallbacks())

    const { layer } = driver.resolveModel("gpt-5.4", makeApiAuthInfo("sk-test-1234"))
    const fetchState = makeFakeFetchState()
    await runOne(layer, fetchState)

    expect(Ref.getUnsafe(credentialCellRef)).toBe(EMPTY_CREDENTIAL_CELL)
  })
})
