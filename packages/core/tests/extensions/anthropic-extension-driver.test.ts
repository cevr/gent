/**
 * AnthropicExtension model-driver wiring — extension-level regression
 * coverage for `buildAnthropicModelDriver` / `resolveModel`.
 *
 * The leaf-service suites (`anthropic-credential-service.test.ts`,
 * `anthropic-beta-cache.test.ts`, `anthropic-keychain-transform.test.ts`)
 * cover services in isolation. Those passed even when C3 introduced
 * two HIGH-severity wiring bugs that counsel had to catch:
 *
 *   1. **Cache-Ref lifetime**: `resolveModel` runs once per
 *      `Provider.stream`/`Provider.generate` call. The original C3
 *      shape allocated `Ref<CredentialCacheCell>` and `Ref<BetaCacheCell>`
 *      inside `makeOauthAnthropicLayer`, so each request got a fresh
 *      empty cache — cross-request beta learning + credential reuse
 *      were silently dead.
 *   2. **API-key path wrapped in keychainClient**: pre-C3, only OAuth
 *      flowed through `keychainClient` (which injects Claude Code OAuth
 *      billing-header system blocks + identity prefix). C3 incorrectly
 *      extended the wrapper to the API-key branch.
 *
 * Earlier iterations of this file tested those invariants only at the
 * seam (sibling `layerFromRef` probes), which counsel correctly flagged
 * as coverage theater — the production layer was never actually built
 * or invoked. This file now drives one real `LanguageModel.generateText`
 * call through each layer with a captured fake `fetch`, then asserts
 * on the outbound request shape. That proves the resolved layer's
 * production wiring uses the test-owned Refs and applies the right
 * keychain transforms (or doesn't, on the API-key branch).
 */
import { describe, test, expect } from "bun:test"
import { Effect, Ref } from "effect"
import { buildAnthropicModelDriver } from "@gent/extensions/anthropic"
import {
  EMPTY_CREDENTIAL_CELL,
  type CredentialCacheCell,
} from "@gent/extensions/anthropic/credential-service"
import { EMPTY_BETA_CELL, type BetaCacheCell } from "@gent/extensions/anthropic/beta-cache"
import { initAnthropicKeychainEnv, SYSTEM_IDENTITY_PREFIX } from "@gent/extensions/anthropic/oauth"
import type { ProviderAuthInfo } from "@gent/core/extensions/api"
import {
  makeFakeFetchState,
  oneGenerate,
  type FakeFetchState,
} from "@gent/core/test-utils/fake-fetch"

const makeOAuthInfo = (): ProviderAuthInfo => ({
  type: "oauth",
  access: "test-access",
  refresh: "test-refresh",
  expires: Date.now() + 10 * 60 * 60 * 1000,
})

const makeApiAuthInfo = (key: string): ProviderAuthInfo => ({
  type: "api",
  key,
})

/**
 * Anthropic's `BetaMessage` happy-path response. `LanguageModel.generateText`
 * parses this into a successful result so tests stay on the success branch
 * and assertions can focus on outbound request shape.
 */
const anthropicHappyResponse = () => ({
  status: 200,
  body: JSON.stringify({
    id: "msg_test_1",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    model: "claude-opus-4-6",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      service_tier: null,
    },
  }),
})

const runOne = (layer: Parameters<typeof oneGenerate>[0], state: FakeFetchState): Promise<void> =>
  Effect.runPromise(oneGenerate(layer, state, anthropicHappyResponse))

const parsePayload = (body: string | undefined): Record<string, unknown> => {
  expect(body).toBeDefined()
  return JSON.parse(body!) as Record<string, unknown>
}

describe("buildAnthropicModelDriver — OAuth path uses external cache Refs (counsel C3 HIGH #1)", () => {
  test("OAuth resolveModel layer reads Bearer from credentialCellRef the test owns", async () => {
    initAnthropicKeychainEnv({})
    const credentialCellRef = Ref.makeUnsafe<CredentialCacheCell>(EMPTY_CREDENTIAL_CELL)
    const betaCellRef = Ref.makeUnsafe<BetaCacheCell>(EMPTY_BETA_CELL)
    const driver = buildAnthropicModelDriver(credentialCellRef, betaCellRef)

    // Pre-seed the cred Ref directly (test owns it). If
    // `makeOauthAnthropicLayer` regressed to allocating its own internal
    // Ref via `AnthropicCredentialService.layer(authInfo)`, the
    // production credential service would NOT see this seeded creds —
    // the IO path would try to read keychain, fail/refresh, etc. We
    // assert the captured Authorization header reflects the seed, so
    // any regression that ignores the external Ref breaks the test.
    Effect.runSync(
      Ref.set(credentialCellRef, {
        creds: {
          accessToken: "seeded-bearer-token",
          refreshToken: "r",
          expiresAt: Date.now() + 60 * 60 * 1000,
        },
        at: Date.now(),
      }),
    )

    const { layer } = driver.resolveModel("claude-opus-4-6", makeOAuthInfo())
    const fetchState = makeFakeFetchState()
    await runOne(layer, fetchState)

    expect(fetchState.captured.length).toBeGreaterThan(0)
    const lastReq = fetchState.captured[fetchState.captured.length - 1]!
    expect(lastReq.headers["authorization"]).toBe("Bearer seeded-bearer-token")
  })

  test("OAuth resolveModel layer applies keychainClient transforms (system identity prefix)", async () => {
    initAnthropicKeychainEnv({})
    const credentialCellRef = Ref.makeUnsafe<CredentialCacheCell>(EMPTY_CREDENTIAL_CELL)
    const betaCellRef = Ref.makeUnsafe<BetaCacheCell>(EMPTY_BETA_CELL)
    Effect.runSync(
      Ref.set(credentialCellRef, {
        creds: { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 60 * 60 * 1000 },
        at: Date.now(),
      }),
    )

    const driver = buildAnthropicModelDriver(credentialCellRef, betaCellRef)
    const { layer } = driver.resolveModel("claude-opus-4-6", makeOAuthInfo())
    const fetchState = makeFakeFetchState()
    await runOne(layer, fetchState)

    const payload = parsePayload(fetchState.captured.at(-1)?.body)
    // keychainClient injects the SYSTEM_IDENTITY_PREFIX block. If the
    // OAuth path stops being wrapped, the system block disappears.
    const systemBlocks = payload["system"]
    expect(Array.isArray(systemBlocks)).toBe(true)
    expect(JSON.stringify(systemBlocks)).toContain(SYSTEM_IDENTITY_PREFIX)
  })

  test("two OAuth resolveModel calls share the credentialCellRef — second sees first call's invalidation", async () => {
    initAnthropicKeychainEnv({})
    const credentialCellRef = Ref.makeUnsafe<CredentialCacheCell>(EMPTY_CREDENTIAL_CELL)
    const betaCellRef = Ref.makeUnsafe<BetaCacheCell>(EMPTY_BETA_CELL)

    Effect.runSync(
      Ref.set(credentialCellRef, {
        creds: {
          accessToken: "first-token",
          refreshToken: "r",
          expiresAt: Date.now() + 60_000_000,
        },
        at: Date.now(),
      }),
    )

    const driver = buildAnthropicModelDriver(credentialCellRef, betaCellRef)

    const layer1 = driver.resolveModel("claude-opus-4-6", makeOAuthInfo()).layer
    const fetchState1 = makeFakeFetchState()
    await runOne(layer1, fetchState1)
    expect(fetchState1.captured.at(-1)!.headers["authorization"]).toBe("Bearer first-token")

    // Mutate the test-owned Ref between calls. If the second
    // `resolveModel` allocated a fresh internal Ref (the C3 regression),
    // the second request would still use "first-token" — instead of
    // observing this update through the shared Ref. Asserting the second
    // request uses "second-token" pins the Ref-sharing semantics.
    Effect.runSync(
      Ref.set(credentialCellRef, {
        creds: {
          accessToken: "second-token",
          refreshToken: "r",
          expiresAt: Date.now() + 60_000_000,
        },
        at: Date.now(),
      }),
    )

    const layer2 = driver.resolveModel("claude-opus-4-6", makeOAuthInfo()).layer
    const fetchState2 = makeFakeFetchState()
    await runOne(layer2, fetchState2)
    expect(fetchState2.captured.at(-1)!.headers["authorization"]).toBe("Bearer second-token")
  })

  test("OAuth resolveModel layer reads beta exclusions from betaCellRef the test owns", async () => {
    initAnthropicKeychainEnv({})
    const credentialCellRef = Ref.makeUnsafe<CredentialCacheCell>(EMPTY_CREDENTIAL_CELL)
    const betaCellRef = Ref.makeUnsafe<BetaCacheCell>(EMPTY_BETA_CELL)
    Effect.runSync(
      Ref.set(credentialCellRef, {
        creds: { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 60_000_000 },
        at: Date.now(),
      }),
    )

    // Pre-seed beta exclusions so the model's default 1M-context beta
    // is NOT sent. If the production beta cache used a fresh internal
    // Ref, this seeded exclusion wouldn't apply and the header would
    // include `context-1m-2025-08-07`.
    Effect.runSync(
      Ref.set(betaCellRef, {
        map: new Map([["claude-opus-4-6", new Set(["context-1m-2025-08-07"])]]),
        lastBetaFlags: undefined,
        lastModelId: "claude-opus-4-6",
      }),
    )

    const driver = buildAnthropicModelDriver(credentialCellRef, betaCellRef)
    const { layer } = driver.resolveModel("claude-opus-4-6", makeOAuthInfo())
    const fetchState = makeFakeFetchState()
    await runOne(layer, fetchState)

    const sentBeta = fetchState.captured.at(-1)!.headers["anthropic-beta"] ?? ""
    expect(sentBeta).not.toContain("context-1m-2025-08-07")
  })
})

describe("buildAnthropicModelDriver — API-key path is plain SDK (counsel C3 HIGH #2)", () => {
  test("API-key resolveModel layer sends x-api-key (no Bearer)", async () => {
    initAnthropicKeychainEnv({})
    const credentialCellRef = Ref.makeUnsafe<CredentialCacheCell>(EMPTY_CREDENTIAL_CELL)
    const betaCellRef = Ref.makeUnsafe<BetaCacheCell>(EMPTY_BETA_CELL)
    const driver = buildAnthropicModelDriver(credentialCellRef, betaCellRef)

    const { layer } = driver.resolveModel("claude-opus-4-6", makeApiAuthInfo("sk-test-1234"))
    const fetchState = makeFakeFetchState()
    await runOne(layer, fetchState)

    const headers = fetchState.captured.at(-1)!.headers
    expect(headers["x-api-key"]).toBe("sk-test-1234")
    expect(headers["authorization"]).toBeUndefined()
  })

  test("API-key resolveModel does NOT inject keychainClient transforms (no SYSTEM_IDENTITY_PREFIX)", async () => {
    initAnthropicKeychainEnv({})
    const credentialCellRef = Ref.makeUnsafe<CredentialCacheCell>(EMPTY_CREDENTIAL_CELL)
    const betaCellRef = Ref.makeUnsafe<BetaCacheCell>(EMPTY_BETA_CELL)
    const driver = buildAnthropicModelDriver(credentialCellRef, betaCellRef)

    const { layer } = driver.resolveModel("claude-opus-4-6", makeApiAuthInfo("sk-test-1234"))
    const fetchState = makeFakeFetchState()
    await runOne(layer, fetchState)

    const payload = parsePayload(fetchState.captured.at(-1)?.body)
    // No keychainClient wrapper → no system block, no identity prefix
    // injection. Pre-C3 production code did NOT wrap the API-key
    // branch; counsel C3 HIGH #2 caught the regression.
    expect(JSON.stringify(payload["system"] ?? "")).not.toContain(SYSTEM_IDENTITY_PREFIX)
  })

  test("API-key path does not touch the OAuth cache Refs", async () => {
    initAnthropicKeychainEnv({})
    const credentialCellRef = Ref.makeUnsafe<CredentialCacheCell>(EMPTY_CREDENTIAL_CELL)
    const betaCellRef = Ref.makeUnsafe<BetaCacheCell>(EMPTY_BETA_CELL)
    const driver = buildAnthropicModelDriver(credentialCellRef, betaCellRef)

    const { layer } = driver.resolveModel("claude-opus-4-6", makeApiAuthInfo("sk-test-1234"))
    const fetchState = makeFakeFetchState()
    await runOne(layer, fetchState)

    expect(Ref.getUnsafe(credentialCellRef)).toBe(EMPTY_CREDENTIAL_CELL)
    expect(Ref.getUnsafe(betaCellRef)).toBe(EMPTY_BETA_CELL)
  })
})
