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
  type CapturedRequest,
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

describe("buildOpenAIModelDriver — 401 invalidate seam fires through the rewired layer", () => {
  // Driver-level seam test. Proves the wiring, not the full retry-success
  // path. Asserts:
  //   1. the first wire attempt uses the seeded stale token (production
  //      `mapRequestEffect` runs through the rewired
  //      `OpenAiClient.layer({ transformClient })` path)
  //   2. after the 401, invalidate fires on the closure-owned cell —
  //      `.access` cleared, `.refresh` preserved, `.expires` zeroed
  //
  // Does NOT prove: the retry actually re-attempts with a refreshed
  // token. The production driver wires `OpenAICredentialService.layerFromRef`
  // with `realIO` (live `refreshOpenAIOauth`), so simulating a successful
  // post-invalidate refresh would require an IO seam the driver does not
  // expose. Full success path is covered by the codex-transform leaf
  // test (`401 → invalidate → retry succeeds with refreshed token`).

  test("401 fires invalidate on the closure-owned cell via OpenAiClient.layer({ transformClient })", async () => {
    const credentialCellRef = Ref.makeUnsafe<CredentialCacheCell>(EMPTY_CREDENTIAL_CELL)
    Effect.runSync(
      Ref.set(credentialCellRef, {
        creds: { access: "stale-token", refresh: "r", expires: FAR_FUTURE_MS() },
        at: Date.now(),
      }),
    )

    const driver = buildOpenAIModelDriver(credentialCellRef, noopCallbacks())
    const { layer } = driver.resolveModel("gpt-5.4", makeOAuthInfo())
    const fetchState = makeFakeFetchState()

    // 401 triggers tapError(invalidate). The retry's preprocess sees
    // the invalidated cell and attempts a live refresh, which fails
    // (no IO seam in the production driver) — Effect.exit preserves
    // the failure so the post-condition assertions still run.
    const responder = (req: CapturedRequest) => {
      void req
      return { status: 401, body: "unauthorized", headers: { "content-type": "text/plain" } }
    }

    await Effect.runPromise(
      // @effect-diagnostics-next-line strictEffectProvide:off test entry point
      oneGenerate(layer, fetchState, responder).pipe(Effect.exit),
    )

    // First wire attempt fired with the seeded token — proves the
    // production mapRequestEffect ran preprocess through the rewired
    // OpenAiClient.layer({ transformClient }) path.
    expect(fetchState.captured.length).toBeGreaterThanOrEqual(1)
    expect(fetchState.captured[0]!.headers["authorization"]).toBe("Bearer stale-token")
    expect(fetchState.captured[0]!.url).toBe("https://chatgpt.com/backend-api/codex/responses")

    // Driver-level seam: invalidate fired on the closure-owned cell
    // after the 401:
    //   - .access cleared (so the next request would have to re-auth)
    //   - .refresh preserved (rotated refresh token survives invalidate)
    //   - .expires zeroed (forces refresh on next getFresh)
    // If transformResponse weren't wired into the production layer,
    // the cell would still hold the original "stale-token".
    const finalCell = Ref.getUnsafe(credentialCellRef)
    expect(finalCell.creds?.access).toBe("")
    expect(finalCell.creds?.refresh).toBe("r")
    expect(finalCell.creds?.expires).toBe(0)
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
