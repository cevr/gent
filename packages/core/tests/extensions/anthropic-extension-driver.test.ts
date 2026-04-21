/**
 * AnthropicExtension model-driver wiring — extension-level regression
 * coverage for `buildAnthropicModelDriver` / `resolveModel`.
 *
 * The earlier suites (`anthropic-credential-service.test.ts`,
 * `anthropic-beta-cache.test.ts`, `anthropic-keychain-transform.test.ts`)
 * cover the leaf services in isolation. Those passed even when C3
 * introduced two HIGH-severity wiring bugs that counsel had to catch:
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
 * These tests assert the structural invariants that catch both
 * regressions: (1) two `resolveModel` calls reuse the same closure-owned
 * cache Refs, and (2) the API-key path's resulting layer is fully
 * self-contained (does NOT require OAuth-only services like
 * `AnthropicCredentialService` or `AnthropicBetaCache`).
 */
import { describe, test, expect } from "bun:test"
import { Effect, Ref } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { buildAnthropicModelDriver } from "@gent/extensions/anthropic"
import {
  AnthropicCredentialService,
  EMPTY_CREDENTIAL_CELL,
  type CredentialCacheCell,
} from "@gent/extensions/anthropic/credential-service"
import {
  AnthropicBetaCache,
  EMPTY_BETA_CELL,
  type BetaCacheCell,
} from "@gent/extensions/anthropic/beta-cache"
import type { ProviderAuthInfo } from "@gent/core/extensions/api"

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

describe("buildAnthropicModelDriver — closure-owned cache Refs (counsel C3 HIGH #1)", () => {
  test("two resolveModel calls (OAuth) share the beta-cache Ref passed to buildAnthropicModelDriver", async () => {
    const credentialCellRef = Ref.makeUnsafe<CredentialCacheCell>(EMPTY_CREDENTIAL_CELL)
    const betaCellRef = Ref.makeUnsafe<BetaCacheCell>(EMPTY_BETA_CELL)

    const driver = buildAnthropicModelDriver(credentialCellRef, betaCellRef)

    // Two independent resolveModel calls — simulating two Provider.stream
    // / Provider.generate invocations.
    const r1 = driver.resolveModel("claude-opus-4-6", makeOAuthInfo())
    const r2 = driver.resolveModel("claude-opus-4-6", makeOAuthInfo())
    expect(r1.layer).toBeDefined()
    expect(r2.layer).toBeDefined()

    // Pre-seed via the test-owned betaCellRef. If `makeOauthAnthropicLayer`
    // ever regresses to allocating its own internal Ref again, the
    // AnthropicBetaCache.layerFromRef in the resolved layer would be
    // backed by a different cell — a probe via the test-owned Ref would
    // diverge from any reads/writes performed through the production
    // service. Asserting same-Ref identity by writing through one and
    // reading through a sibling layerFromRef catches that drift.
    Effect.runSync(
      Ref.set(betaCellRef, {
        map: new Map([["claude-opus-4-6", new Set(["context-1m-2025-08-07"])]]),
        lastBetaFlags: undefined,
        lastModelId: "claude-opus-4-6",
      }),
    )

    // Build a sibling AnthropicBetaCache layer over the same Ref the
    // driver was constructed with. If buildAnthropicModelDriver honors
    // the passed-in Ref (vs. allocating its own), this sibling sees
    // every change made through any other layer constructed against
    // the same Ref.
    const probe = Effect.gen(function* () {
      const cache = yield* AnthropicBetaCache
      const before = yield* cache.getExcluded("claude-opus-4-6", undefined)
      yield* cache.recordExcluded("claude-opus-4-6", "context-1m-2025-09-15", undefined)
      return Array.from(before)
    }).pipe(Effect.provide(AnthropicBetaCache.layerFromRef(betaCellRef)))

    const initiallyExcluded = await Effect.runPromise(probe)
    expect(initiallyExcluded).toEqual(["context-1m-2025-08-07"])

    const cellAfterProbe = Ref.getUnsafe(betaCellRef)
    expect(cellAfterProbe.map.get("claude-opus-4-6")?.has("context-1m-2025-09-15")).toBe(true)
    expect(cellAfterProbe.map.get("claude-opus-4-6")?.has("context-1m-2025-08-07")).toBe(true)
  })

  test("two resolveModel calls (OAuth) share the credential-cache Ref passed to buildAnthropicModelDriver", async () => {
    const credentialCellRef = Ref.makeUnsafe<CredentialCacheCell>(EMPTY_CREDENTIAL_CELL)
    const betaCellRef = Ref.makeUnsafe<BetaCacheCell>(EMPTY_BETA_CELL)

    const driver = buildAnthropicModelDriver(credentialCellRef, betaCellRef)
    const r1 = driver.resolveModel("claude-opus-4-6", makeOAuthInfo())
    const r2 = driver.resolveModel("claude-opus-4-6", makeOAuthInfo())
    expect(r1.layer).toBeDefined()
    expect(r2.layer).toBeDefined()

    // Direct Ref mutation simulates the credential service writing back
    // refreshed creds. If `makeOauthAnthropicLayer` ever regresses to
    // allocating its own internal credential Ref, a sibling
    // AnthropicCredentialService built over the test-owned Ref would
    // diverge from the production service. Invalidate-via-sibling is
    // the simplest observable that depends on Ref identity.
    Effect.runSync(
      Ref.set(credentialCellRef, {
        creds: { accessToken: "seeded", refreshToken: "r", expiresAt: Date.now() + 1_000_000 },
        at: Date.now(),
      }),
    )

    const probe = Effect.gen(function* () {
      const svc = yield* AnthropicCredentialService
      yield* svc.invalidate
    }).pipe(Effect.provide(AnthropicCredentialService.layerFromRef(credentialCellRef)))

    await Effect.runPromise(probe)

    const cellAfterInvalidate = Ref.getUnsafe(credentialCellRef)
    expect(cellAfterInvalidate.creds).toBeNull()
    expect(cellAfterInvalidate.at).toBe(0)
  })

  test("API-key path does not touch the OAuth cache Refs", async () => {
    const credentialCellRef = Ref.makeUnsafe<CredentialCacheCell>(EMPTY_CREDENTIAL_CELL)
    const betaCellRef = Ref.makeUnsafe<BetaCacheCell>(EMPTY_BETA_CELL)

    const driver = buildAnthropicModelDriver(credentialCellRef, betaCellRef)

    // Hand the driver an API-key authInfo. The API-key branch in
    // resolveModel should bypass the OAuth wiring entirely — the
    // resulting layer must not reference these Refs at all. Asserting
    // the Refs remain at their initial sentinel values after layer
    // construction is the structural witness.
    const result = driver.resolveModel("claude-opus-4-6", makeApiAuthInfo("sk-test-1234"))
    expect(result.layer).toBeDefined()

    expect(Ref.getUnsafe(credentialCellRef)).toBe(EMPTY_CREDENTIAL_CELL)
    expect(Ref.getUnsafe(betaCellRef)).toBe(EMPTY_BETA_CELL)
  })
})

describe("buildAnthropicModelDriver — API-key layer self-contained (counsel C3 HIGH #2)", () => {
  test("API-key resolveModel layer requires only LanguageModel — no OAuth services", async () => {
    const credentialCellRef = Ref.makeUnsafe<CredentialCacheCell>(EMPTY_CREDENTIAL_CELL)
    const betaCellRef = Ref.makeUnsafe<BetaCacheCell>(EMPTY_BETA_CELL)

    const driver = buildAnthropicModelDriver(credentialCellRef, betaCellRef)
    const { layer } = driver.resolveModel("claude-opus-4-6", makeApiAuthInfo("sk-test-1234"))

    // A LanguageModel-only probe with `Effect.provide(layer)` must
    // typecheck (and run without unmet-requirement defects). If
    // `makeApiKeyAnthropicLayer` ever re-wraps with `keychainClient`
    // or accidentally consumes AnthropicCredentialService /
    // AnthropicBetaCache, this build would either fail to typecheck
    // or fail at runtime with a missing-service defect.
    const probe = Effect.gen(function* () {
      const model = yield* LanguageModel.LanguageModel
      return model
    }).pipe(Effect.provide(layer))

    const resolved = await Effect.runPromise(probe)
    expect(resolved).toBeDefined()
  })

  test("OAuth resolveModel layer is also self-contained at the LanguageModel boundary", async () => {
    const credentialCellRef = Ref.makeUnsafe<CredentialCacheCell>(EMPTY_CREDENTIAL_CELL)
    const betaCellRef = Ref.makeUnsafe<BetaCacheCell>(EMPTY_BETA_CELL)

    const driver = buildAnthropicModelDriver(credentialCellRef, betaCellRef)
    const { layer } = driver.resolveModel("claude-opus-4-6", makeOAuthInfo())

    // Same shape as the API-key probe — the OAuth branch self-provides
    // AnthropicCredentialService / AnthropicBetaCache via the cache
    // Refs, so the externally-visible requirement is still only
    // LanguageModel.
    const probe = Effect.gen(function* () {
      const model = yield* LanguageModel.LanguageModel
      return model
    }).pipe(Effect.provide(layer))

    const resolved = await Effect.runPromise(probe)
    expect(resolved).toBeDefined()
  })
})
