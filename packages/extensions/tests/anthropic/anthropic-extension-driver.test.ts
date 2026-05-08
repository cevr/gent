/**
 * AnthropicExtension model-driver wiring — extension-level regression
 * coverage for `buildAnthropicModelDriver` / `resolveModel`.
 *
 * The leaf-service suites (`anthropic-credential-service.test.ts`,
 * `anthropic-beta-cache.test.ts`, `anthropic-keychain-transform.test.ts`)
 * cover services in isolation. Those passed even when two HIGH-severity
 * wiring bugs slipped in:
 *
 *   1. **Cache-Ref lifetime**: `resolveModel` runs once per model resolution.
 *      Allocating
 *      `Ref<CredentialCacheCell>` and `Ref<BetaCacheCell>` inside
 *      `makeOauthAnthropicLayer` gave each request a fresh empty
 *      cache — cross-request beta learning + credential reuse were
 *      silently dead.
 *   2. **API-key path wrapped in keychainClient**: only OAuth should
 *      flow through `keychainClient` (which injects Claude Code OAuth
 *      billing-header system blocks + identity prefix). Extending the
 *      wrapper to the API-key branch is incorrect.
 *
 * Seam-only probes (sibling `layerFromRef`) are coverage theater — the
 * production layer is never actually built or invoked. This file drives
 * one real `LanguageModel.generateText` call through each layer with a
 * captured fake `fetch`, then asserts on the outbound request shape.
 * That proves the resolved layer's production wiring uses the
 * test-owned Refs and applies the right keychain transforms (or
 * doesn't, on the API-key branch).
 */
import { describe, expect, it } from "effect-bun-test"
import { Clock, Effect, Ref, Schema, SynchronizedRef } from "effect"
import { buildAnthropicModelDriver as buildAnthropicModelDriverLive } from "@gent/extensions/anthropic"
import {
  EMPTY_CREDENTIAL_CELL,
  type CredentialCacheCell,
} from "@gent/extensions/anthropic/credential-service"
import { EMPTY_BETA_CELL, type BetaCacheCell } from "@gent/extensions/anthropic/beta-cache"
import { initAnthropicKeychainEnv, SYSTEM_IDENTITY_PREFIX } from "@gent/extensions/anthropic/oauth"
import { ExtensionHostProcessError, type ProviderAuthInfo } from "@gent/core/extensions/api"
import { AnthropicPlatform } from "../../src/anthropic/platform-adapter.js"
import {
  makeFakeFetchState,
  oneGenerate,
  type FakeFetchState,
} from "@gent/core-internal/test-utils/fake-fetch"
const FUTURE_MS = 1_800_000_000_000
const testPlatform = AnthropicPlatform.of({
  platform: "darwin",
  home: "/tmp/gent-test-home",
  parentEnv: {},
  runProcess: (command) =>
    Effect.fail(
      new ExtensionHostProcessError({
        command,
        message: "test runProcess unavailable",
      }),
    ),
})
const buildAnthropicModelDriver = (
  ...args: Parameters<typeof buildAnthropicModelDriverLive> extends [
    infer CredentialCell,
    infer BetaCell,
    infer EnvApiKey,
    ...ReadonlyArray<unknown>,
  ]
    ? [CredentialCell, BetaCell, EnvApiKey]
    : never
) => buildAnthropicModelDriverLive(...args, testPlatform)
const makeOAuthInfo = (): ProviderAuthInfo => ({
  type: "oauth",
  access: "test-access",
  refresh: "test-refresh",
  expires: FUTURE_MS,
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
  Effect.runPromise(oneGenerate(layer, state, anthropicHappyResponse).pipe(Effect.orDie))
const JsonRecord = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const parsePayload = (body: string | undefined): Record<string, unknown> => {
  expect(body).toBeDefined()
  return Schema.decodeUnknownSync(JsonRecord)(body)
}
describe("buildAnthropicModelDriver — OAuth path uses external cache Refs", () => {
  it.live("OAuth resolveModel layer reads Bearer from credentialCellRef the test owns", () =>
    Effect.gen(function* () {
      initAnthropicKeychainEnv({})
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell>(EMPTY_CREDENTIAL_CELL)
      const betaCellRef = yield* Ref.make<BetaCacheCell>(EMPTY_BETA_CELL)
      const driver = buildAnthropicModelDriver(credentialCellRef, betaCellRef, undefined)
      // Pre-seed the cred Ref directly (test owns it). If
      // `makeOauthAnthropicLayer` regressed to allocating its own internal
      // Ref via `AnthropicCredentialService.layer(authInfo)`, the
      // production credential service would NOT see this seeded creds —
      // the IO path would try to read keychain, fail/refresh, etc. We
      // assert the captured Authorization header reflects the seed, so
      // any regression that ignores the external Ref breaks the test.
      yield* SynchronizedRef.set(credentialCellRef, {
        creds: {
          accessToken: "seeded-bearer-token",
          refreshToken: "r",
          expiresAt: FUTURE_MS,
        },
        at: yield* Clock.currentTimeMillis,
      })
      const model = driver.resolveModel("claude-opus-4-6", makeOAuthInfo())
      const fetchState = makeFakeFetchState()
      yield* Effect.promise(() => runOne(model, fetchState))
      expect(fetchState.captured.length).toBeGreaterThan(0)
      const lastReq = fetchState.captured[fetchState.captured.length - 1]!
      expect(lastReq.headers["authorization"]).toBe("Bearer seeded-bearer-token")
    }),
  )
  it.live(
    "OAuth resolveModel layer applies keychainClient transforms (system identity prefix)",
    () =>
      Effect.gen(function* () {
        initAnthropicKeychainEnv({})
        const credentialCellRef =
          yield* SynchronizedRef.make<CredentialCacheCell>(EMPTY_CREDENTIAL_CELL)
        const betaCellRef = yield* Ref.make<BetaCacheCell>(EMPTY_BETA_CELL)
        yield* SynchronizedRef.set(credentialCellRef, {
          creds: { accessToken: "t", refreshToken: "r", expiresAt: FUTURE_MS },
          at: yield* Clock.currentTimeMillis,
        })
        const driver = buildAnthropicModelDriver(credentialCellRef, betaCellRef, undefined)
        const model = driver.resolveModel("claude-opus-4-6", makeOAuthInfo())
        const fetchState = makeFakeFetchState()
        yield* Effect.promise(() => runOne(model, fetchState))
        const payload = parsePayload(fetchState.captured.at(-1)?.body)
        // keychainClient injects the SYSTEM_IDENTITY_PREFIX block. If the
        // OAuth path stops being wrapped, the system block disappears.
        const systemBlocks = payload["system"]
        expect(Array.isArray(systemBlocks)).toBe(true)
        expect(Bun.inspect(systemBlocks)).toContain(SYSTEM_IDENTITY_PREFIX)
      }),
  )
  it.live(
    "two OAuth resolveModel calls share the credentialCellRef — second sees first call's invalidation",
    () =>
      Effect.gen(function* () {
        initAnthropicKeychainEnv({})
        const credentialCellRef =
          yield* SynchronizedRef.make<CredentialCacheCell>(EMPTY_CREDENTIAL_CELL)
        const betaCellRef = yield* Ref.make<BetaCacheCell>(EMPTY_BETA_CELL)
        yield* SynchronizedRef.set(credentialCellRef, {
          creds: {
            accessToken: "first-token",
            refreshToken: "r",
            expiresAt: FUTURE_MS,
          },
          at: yield* Clock.currentTimeMillis,
        })
        const driver = buildAnthropicModelDriver(credentialCellRef, betaCellRef, undefined)
        const model1 = driver.resolveModel("claude-opus-4-6", makeOAuthInfo())
        const fetchState1 = makeFakeFetchState()
        yield* Effect.promise(() => runOne(model1, fetchState1))
        expect(fetchState1.captured.at(-1)!.headers["authorization"]).toBe("Bearer first-token")
        // Mutate the test-owned Ref between calls. If the second
        // `resolveModel` allocated a fresh internal Ref (the  regression),
        // the second request would still use "first-token" — instead of
        // observing this update through the shared Ref. Asserting the second
        // request uses "second-token" pins the Ref-sharing semantics.
        yield* SynchronizedRef.set(credentialCellRef, {
          creds: {
            accessToken: "second-token",
            refreshToken: "r",
            expiresAt: FUTURE_MS,
          },
          at: yield* Clock.currentTimeMillis,
        })
        const model2 = driver.resolveModel("claude-opus-4-6", makeOAuthInfo())
        const fetchState2 = makeFakeFetchState()
        yield* Effect.promise(() => runOne(model2, fetchState2))
        expect(fetchState2.captured.at(-1)!.headers["authorization"]).toBe("Bearer second-token")
      }),
  )
  it.live("OAuth resolveModel layer reads beta exclusions from betaCellRef the test owns", () =>
    Effect.gen(function* () {
      initAnthropicKeychainEnv({})
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell>(EMPTY_CREDENTIAL_CELL)
      const betaCellRef = yield* Ref.make<BetaCacheCell>(EMPTY_BETA_CELL)
      yield* SynchronizedRef.set(credentialCellRef, {
        creds: { accessToken: "t", refreshToken: "r", expiresAt: FUTURE_MS },
        at: yield* Clock.currentTimeMillis,
      })
      // Pre-seed beta exclusions so the model's default 1M-context beta
      // is NOT sent. If the production beta cache used a fresh internal
      // Ref, this seeded exclusion wouldn't apply and the header would
      // include `context-1m-2025-08-07`.
      yield* Ref.set(betaCellRef, {
        map: new Map([["claude-opus-4-6", new Set(["context-1m-2025-08-07"])]]),
        lastBetaFlags: undefined,
        lastModelId: "claude-opus-4-6",
      })
      const driver = buildAnthropicModelDriver(credentialCellRef, betaCellRef, undefined)
      const model = driver.resolveModel("claude-opus-4-6", makeOAuthInfo())
      const fetchState = makeFakeFetchState()
      yield* Effect.promise(() => runOne(model, fetchState))
      const sentBeta = fetchState.captured.at(-1)!.headers["anthropic-beta"] ?? ""
      expect(sentBeta).not.toContain("context-1m-2025-08-07")
    }),
  )
})
describe("buildAnthropicModelDriver — API-key path is plain SDK", () => {
  it.live("API-key resolveModel layer sends x-api-key (no Bearer)", () =>
    Effect.gen(function* () {
      initAnthropicKeychainEnv({})
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell>(EMPTY_CREDENTIAL_CELL)
      const betaCellRef = yield* Ref.make<BetaCacheCell>(EMPTY_BETA_CELL)
      const driver = buildAnthropicModelDriver(credentialCellRef, betaCellRef, undefined)
      const model = driver.resolveModel("claude-opus-4-6", makeApiAuthInfo("sk-test-1234"))
      const fetchState = makeFakeFetchState()
      yield* Effect.promise(() => runOne(model, fetchState))
      const headers = fetchState.captured.at(-1)!.headers
      expect(headers["x-api-key"]).toBe("sk-test-1234")
      expect(headers["authorization"]).toBeUndefined()
    }),
  )
  it.live(
    "API-key resolveModel does NOT inject keychainClient transforms (no SYSTEM_IDENTITY_PREFIX)",
    () =>
      Effect.gen(function* () {
        initAnthropicKeychainEnv({})
        const credentialCellRef =
          yield* SynchronizedRef.make<CredentialCacheCell>(EMPTY_CREDENTIAL_CELL)
        const betaCellRef = yield* Ref.make<BetaCacheCell>(EMPTY_BETA_CELL)
        const driver = buildAnthropicModelDriver(credentialCellRef, betaCellRef, undefined)
        const model = driver.resolveModel("claude-opus-4-6", makeApiAuthInfo("sk-test-1234"))
        const fetchState = makeFakeFetchState()
        yield* Effect.promise(() => runOne(model, fetchState))
        const payload = parsePayload(fetchState.captured.at(-1)?.body)
        // No keychainClient wrapper → no system block, no identity prefix
        // injection. The API-key branch must not wrap.
        expect(Bun.inspect(payload["system"] ?? "")).not.toContain(SYSTEM_IDENTITY_PREFIX)
      }),
  )
  it.live("API-key path does not touch the OAuth cache Refs", () =>
    Effect.gen(function* () {
      initAnthropicKeychainEnv({})
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell>(EMPTY_CREDENTIAL_CELL)
      const betaCellRef = yield* Ref.make<BetaCacheCell>(EMPTY_BETA_CELL)
      const driver = buildAnthropicModelDriver(credentialCellRef, betaCellRef, undefined)
      const model = driver.resolveModel("claude-opus-4-6", makeApiAuthInfo("sk-test-1234"))
      const fetchState = makeFakeFetchState()
      yield* Effect.promise(() => runOne(model, fetchState))
      expect(yield* SynchronizedRef.get(credentialCellRef)).toBe(EMPTY_CREDENTIAL_CELL)
      expect(yield* Ref.get(betaCellRef)).toBe(EMPTY_BETA_CELL)
    }),
  )
})
