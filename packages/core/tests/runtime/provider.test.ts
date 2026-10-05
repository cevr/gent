import { describe, expect, it } from "effect-bun-test"
import {
  Cause,
  ConfigProvider,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Ref,
  Schema,
  Stream,
} from "effect"
import { TestClock } from "effect/testing"
import * as AiError from "effect/ai/AiError"
import {
  type ApiClassContribution,
  type ApiClassRequest,
  AuthMethod,
  CredentialSlot,
  catalogModelEntry,
  DEFAULT_CREDENTIAL_SLOT,
  DEFAULT_RETRY_POLICY,
  isContextOverflow,
  type ModelCatalogView,
  type ModelDriverContribution,
  modelFromCatalog,
  ProviderAuthError,
  type ProviderAuthInfo,
  type ProviderResolution,
} from "../../src/domain/driver"
import { ProviderError } from "../../src/domain/errors"
import {
  Auth,
  AuthApi,
  AuthError,
  listAuthProviders,
  captureProviderLogin,
  AuthInfo,
  type AuthService,
  serializeAuthStore,
  ModelResolver,
  authorizeProvider,
  completeProviderAuth,
  DecisionModelResolver,
  removeSignIn,
  listAuthMethods,
  limitResetAt,
  listCatalogProviders,
  makeExtensionModels,
  retryProviderCall,
  listModelCatalog,
  type LoadedModelCatalog,
  modelCatalogFromBodies,
  ModelCatalogRecord,
  ModelCatalogSource,
  ModelRegistry,
  modelCatalog,
  finishPart,
  resolveDriverModel,
  textStep,
  toolCallPart,
} from "../../src/runtime/provider"
import { BunServices } from "@effect/platform-bun"
import { Decision, DecisionModel, Model as AiModel, LanguageModel } from "effect/ai"
import { test as bunTest } from "bun:test"
import { ExtensionRegistry, resolveExtensions } from "../../src/runtime/extension-host"
import type { LoadedExtension } from "../../src/domain/extension.js"
import {
  AgentDefinition,
  DEFAULT_AGENT_NAME,
  ModelId,
  ProviderId,
  Model,
  type ReasoningEffort,
} from "../../src/domain/agent"
import { BranchId, ExtensionId, MessageId, SessionId, ToolCallId } from "../../src/domain/ids"
import { GentPlatform } from "../../src/runtime/gent-platform"
import type { ProviderConfig } from "../../src/runtime/config"
import {
  defineExtension,
  ExtensionHost,
  tool,
  type ToolCapability,
} from "@gent/core/extensions/api"
import { LanguageModelLayers } from "../../src/test-utils/language-model"
import {
  createRpcHarness,
  fixtureModelCatalog,
  fixtureModelCatalogSource,
  MODEL_CATALOG_FIXTURE,
  modelCatalogFixture,
  type ModelCatalogFixtureRequest,
  testSqliteStorage,
} from "../../src/test-utils/harness"
import { ModelCatalogSnapshotStorage } from "../../src/storage/storage"
import { HttpClient, HttpClientResponse } from "effect/http"
import { convertTools } from "../../src/runtime/tools"
import { toPrompt } from "../../src/runtime/model-context"
import { dateFromMillis, Message } from "../../src/domain/message"
import { toCodecAnthropic } from "effect/ai/AnthropicStructuredOutput"
import * as AiTool from "effect/ai/Tool"
import type * as AiToolkit from "effect/ai/Toolkit"
import type { ToolkitInput } from "effect/ai/LanguageModel"
import * as Prompt from "effect/ai/Prompt"
import type * as AiResponse from "effect/ai/Response"

// ── provider retry ──────────────────────────────────────────────────────────

/**
 * Provider retry: which failures are retried, how long the schedule waits,
 * and what it reports. The only interface is `retryProviderCall` under a
 * driver `RetryPolicy`.
 */

/** The wire shapes the shipped Anthropic and OpenAI drivers name as transient. */
const transientStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["overloaded_error", "api_error", "rate_limit_error"]),
  }),
  Schema.Struct({ code: Schema.Literals(["server_error", "rate_limit_exceeded"]) }),
])
const policy = { ...DEFAULT_RETRY_POLICY, transientStreamEvent }
const fast = { ...policy, initialDelay: 1, maxDelay: 1, maxAttempts: 3 }

const rateLimited = (retryAfter: Duration.Duration) =>
  new ProviderError({
    message: "Rate limit",
    model: "test",
    cause: AiError.make({
      module: "Test",
      method: "streamText",
      reason: new AiError.RateLimitError({ retryAfter }),
    }),
  })

/** A rate limit with no retry-after: the reset, if any, is in the body only the driver reads. */
const usageLimited = new ProviderError({
  message: "Usage limit",
  model: "test",
  cause: AiError.make({
    module: "Test",
    method: "streamText",
    reason: new AiError.RateLimitError({}),
  }),
})

const invalidKey = new ProviderError({
  message: "Invalid API key",
  model: "test",
  cause: AiError.make({
    module: "Test",
    method: "streamText",
    reason: new AiError.AuthenticationError({ kind: "InvalidKey" }),
  }),
})

const streamEvent = (cause: { type: string } | { code: string }) =>
  new ProviderError({ message: "stream ended with an error event", model: "test", cause })

/** Fails `failures` times with `error`, then succeeds; records every retry delay. */
const failThenSucceed = (error: ProviderOrAuth, failures: number, config = fast) => {
  const delays: Array<number> = []
  let calls = 0
  const run = Effect.gen(function* () {
    calls += 1
    if (calls <= failures) return yield* error
    return "ok"
  }).pipe(
    retryProviderCall(config, {
      onRetry: ({ delayMs }) => Effect.sync(() => void delays.push(delayMs)),
    }),
  )
  return { run, delays, calls: () => calls }
}
type ProviderOrAuth = ProviderError | ProviderAuthError

describe("provider retry", () => {
  it.effect("waits the provider's retry-after before retrying a typed rate limit", () =>
    Effect.gen(function* () {
      const { run, delays } = failThenSucceed(rateLimited(Duration.seconds(30)), 1, {
        ...fast,
        maxDelay: 60_000,
      })
      const fiber = yield* Effect.forkChild(run)
      yield* TestClock.adjust("30 seconds")
      expect(yield* Fiber.join(fiber)).toBe("ok")
      expect(delays).toEqual([30_000])
    }),
  )

  // A usage limit (OpenCode Go, a free tier) answers 429 with a retry-after of
  // hours: no retry inside the cap can succeed, so the limit fails the call.
  it.effect("a retry-after longer than the configured maximum fails without a retry", () =>
    Effect.gen(function* () {
      const { run, delays, calls } = failThenSucceed(rateLimited(Duration.hours(5)), 1, {
        ...fast,
        maxDelay: 30_000,
      })
      const exit = yield* Effect.exit(run)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls()).toBe(1)
      expect(delays).toEqual([])
    }),
  )

  it.effect("backs off exponentially with bounded jitter for a mid-stream overload", () =>
    Effect.gen(function* () {
      const { run, delays } = failThenSucceed(streamEvent({ type: "overloaded_error" }), 2, {
        ...policy,
        initialDelay: 1000,
        maxDelay: 60_000,
        backoffFactor: 2,
        maxAttempts: 3,
      })
      const fiber = yield* Effect.forkChild(run)
      yield* TestClock.adjust("1250 millis")
      yield* TestClock.adjust("2500 millis")
      expect(yield* Fiber.join(fiber)).toBe("ok")
      expect(delays).toHaveLength(2)
      expect(delays[0]).toBeGreaterThanOrEqual(1000)
      expect(delays[0]).toBeLessThanOrEqual(1250)
      expect(delays[1]).toBeGreaterThanOrEqual(2000)
      expect(delays[1]).toBeLessThanOrEqual(2500)
    }),
  )

  it.live("retries an OpenAI stream error code and reports each attempt", () =>
    Effect.gen(function* () {
      const attempts: Array<{ attempt: number; maxAttempts: number; error: string }> = []
      let calls = 0
      const result = yield* Effect.gen(function* () {
        calls += 1
        if (calls < 3) return yield* streamEvent({ code: "server_error" })
        return "ok"
      }).pipe(
        retryProviderCall(fast, {
          onRetry: ({ attempt, maxAttempts, error }) =>
            Effect.sync(() => void attempts.push({ attempt, maxAttempts, error: error.message })),
        }),
      )
      expect(result).toBe("ok")
      expect(attempts).toEqual([
        { attempt: 1, maxAttempts: 3, error: "stream ended with an error event" },
        { attempt: 2, maxAttempts: 3, error: "stream ended with an error event" },
      ])
    }),
  )

  it.live("gives up after the last attempt and fails with the provider error", () =>
    Effect.gen(function* () {
      const { run, delays, calls } = failThenSucceed(streamEvent({ type: "api_error" }), 5)
      const exit = yield* Effect.exit(run)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls()).toBe(3)
      expect(delays).toHaveLength(2)
    }),
  )

  it.live("a credential failure escapes without a retry", () =>
    Effect.gen(function* () {
      const typed = failThenSucceed(invalidKey, 1)
      expect(Exit.isFailure(yield* Effect.exit(typed.run))).toBe(true)
      expect(typed.calls()).toBe(1)

      const auth = failThenSucceed(new ProviderAuthError({ message: "no credentials" }), 1)
      expect(Exit.isFailure(yield* Effect.exit(auth.run))).toBe(true)
      expect(auth.calls()).toBe(1)

      const untyped = failThenSucceed(
        new ProviderError({ message: "Rate limit exceeded (429)", model: "test" }),
        1,
      )
      expect(Exit.isFailure(yield* Effect.exit(untyped.run))).toBe(true)
      expect(untyped.calls()).toBe(1)
    }),
  )

  // A ChatGPT usage limit names its reset in the body, not in a retry-after.
  it.effect("a reset time past maxDelay that the driver reads fails at once without a retry", () =>
    Effect.gen(function* () {
      const { run, delays, calls } = failThenSucceed(usageLimited, 1, {
        ...fast,
        maxDelay: 30_000,
        retryAt: (_cause, nowMs) => Option.some(nowMs + Duration.toMillis(Duration.hours(5))),
      })
      const exit = yield* Effect.exit(run)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls()).toBe(1)
      expect(delays).toEqual([])
    }),
  )

  it.effect("a reset time inside maxDelay is the wait before the retry", () =>
    Effect.gen(function* () {
      const { run, delays } = failThenSucceed(usageLimited, 1, {
        ...fast,
        maxDelay: 60_000,
        retryAt: (_cause, nowMs) => Option.some(nowMs + 20_000),
      })
      const fiber = yield* Effect.forkChild(run)
      yield* TestClock.adjust("20 seconds")
      expect(yield* Fiber.join(fiber)).toBe("ok")
      expect(delays).toEqual([20_000])
    }),
  )

  it.effect("the default reset time is the retry-after counted from now", () =>
    Effect.sync(() => {
      const hinted = rateLimited(Duration.seconds(30))
      expect(DEFAULT_RETRY_POLICY.retryAt(hinted.cause, 1_000)).toEqual(Option.some(31_000))
      expect(DEFAULT_RETRY_POLICY.retryAt(usageLimited.cause, 1_000)).toEqual(Option.none())
    }),
  )

  it.effect("only a reset past maxDelay is a limit reset the turn reports", () =>
    Effect.sync(() => {
      const capped = { ...policy, maxDelay: 30_000 }
      expect(limitResetAt(capped, rateLimited(Duration.hours(5)), 0)).toEqual(
        Option.some(Duration.toMillis(Duration.hours(5))),
      )
      expect(limitResetAt(capped, rateLimited(Duration.seconds(10)), 0)).toEqual(Option.none())
      expect(limitResetAt(capped, usageLimited, 0)).toEqual(Option.none())
    }),
  )
})

// ── context overflow ────────────────────────────────────────────────────────

const refused = (description: string) =>
  AiError.make({
    module: "AnthropicLanguageModel",
    method: "streamText",
    reason: new AiError.InvalidRequestError({ description }),
  })

describe("context overflow", () => {
  bunTest("a request refused as longer than the model accepts is an overflow", () => {
    expect(isContextOverflow(refused("prompt is too long: 213462 tokens > 200000 maximum"))).toBe(
      true,
    )
    expect(
      isContextOverflow(
        refused("input length and `max_tokens` exceed context limit: 188240 + 21333 > 200000"),
      ),
    ).toBe(true)
    expect(
      isContextOverflow({
        code: "context_length_exceeded",
        message: "Your input exceeds the context window of this model.",
      }),
    ).toBe(true)
  })

  bunTest("a rate limit or an unrelated failure is not an overflow", () => {
    expect(
      isContextOverflow(
        AiError.make({
          module: "Test",
          method: "streamText",
          reason: new AiError.RateLimitError({}),
        }),
      ),
    ).toBe(false)
    // A raw rate-limit event whose text also reads like an overflow stays a rate limit.
    expect(
      isContextOverflow({
        code: "rate_limit_exceeded",
        message: "Rate limit reached: reduce the length of the messages or try again later",
      }),
    ).toBe(false)
    expect(isContextOverflow(refused("temperature must be at most 1"))).toBe(false)
    // Anthropic's 413 is a byte cap: an oversized attachment, not a long history.
    expect(
      isContextOverflow({
        code: "request_too_large",
        message: "Request exceeds the maximum size",
      }),
    ).toBe(false)
    expect(isContextOverflow("boom")).toBe(false)
  })
})

// ── model catalog resolution ────────────────────────────────────────────────

/**
 * ModelRegistry concatenates what each driver lists. Where a driver's
 * catalog comes from -- the models.dev fetch, its disk cache, its staleness --
 * is the driver's own concern and is covered by
 * `packages/extensions/tests/providers.test.ts`.
 */

const unusedResolution = (): Effect.Effect<ProviderResolution> =>
  Effect.succeed(AiModel.make("test", "model", LanguageModelLayers.failing))

// oxlint-disable-next-line effect/noNullish -- The auth store answers undefined for a provider with no key.
const noStoredAuth: AuthInfo | undefined = undefined

/** A catalog with no provider: the drivers under test are the whole profile. */
const emptyCatalogLayer = ModelCatalogSource.fixed(
  modelCatalogFromBodies({ chat: "{}", decision: "{}" }),
)

const authLayer = Auth.Test()

const failingReadAuthLayer = Layer.succeed(
  Auth,
  Auth.of(
    serializeAuthStore({
      list: Effect.fail(new AuthError({ message: "read failed" })),
      listSlots: () => Effect.fail(new AuthError({ message: "read failed" })),
      get: () => Effect.fail(new AuthError({ message: "read failed" })),
      set: () => Effect.void,
      remove: () => Effect.void,
    }),
  ),
)

const catalogModel = (id: string, releaseDate?: string): Model => {
  const base = {
    id: ModelId.make(id),
    name: id,
    provider: ProviderId.make(id.split("/", 1)[0] ?? id),
    contextLength: 1_000,
  }
  if (Predicate.isUndefined(releaseDate)) return Model.make(base)
  return Model.make({ ...base, releaseDate })
}

const makeRegistryLayerWithDrivers = (
  modelDrivers: ReadonlyArray<ModelDriverContribution>,
  overrideAuthLayer: Layer.Layer<Auth> = authLayer,
) =>
  ModelRegistry.Live.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ExtensionRegistry.fromResolved(
          resolveExtensions([
            {
              manifest: { id: ExtensionId.make("catalog-drivers") },
              scope: "builtin",
              sourcePath: "test",
              contributions: { modelDrivers },
            },
          ]),
        ),
        overrideAuthLayer,
        ModelCatalogRecord.Live,
        fixtureModelCatalogSource,
      ),
    ),
  )

const loadRegistryWithDrivers = (
  modelDrivers: ReadonlyArray<ModelDriverContribution>,
  overrideAuthLayer: Layer.Layer<Auth> = authLayer,
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      makeRegistryLayerWithDrivers(modelDrivers, overrideAuthLayer),
    )
    const raw = Context.get(context, ModelRegistry)
    const drivers = Context.get(context, ExtensionRegistry)
    const auth = Context.get(context, Auth)
    const catalogRecord = Context.get(context, ModelCatalogRecord)
    const catalogSource = Context.get(context, ModelCatalogSource)
    const catalog = modelCatalog().pipe(
      Effect.provideService(ExtensionRegistry, drivers),
      Effect.provideService(Auth, auth),
      Effect.provideService(ModelCatalogRecord, catalogRecord),
      Effect.provideService(ModelCatalogSource, catalogSource),
    )
    return {
      raw,
      catalog,
      lastFailures: catalogRecord.lastFailures(drivers.getResolved()),
      list: Effect.map(catalog, (listed) => listed.models),
      get: (modelId: string) =>
        raw.get(modelId).pipe(Effect.provideService(ExtensionRegistry, drivers)),
    }
  })

describe("model catalog resolution", () => {
  it.scopedLive("reads the drivers of the caller's profile, not the launch profile", () =>
    Effect.gen(function* () {
      const launch = yield* loadRegistryWithDrivers([
        {
          id: "openai",
          name: "OpenAI",
          resolveModel: unusedResolution,
          listModels: () => Effect.succeed([catalogModel("openai/gpt-5.4")]),
        },
      ])
      const projectProfile = ExtensionRegistry.of({
        getResolved: () =>
          resolveExtensions([
            {
              manifest: { id: ExtensionId.make("project-driver") },
              scope: "project",
              sourcePath: "test",
              contributions: {
                modelDrivers: [
                  {
                    id: "local",
                    name: "Local",
                    resolveModel: unusedResolution,
                    listModels: () => Effect.succeed([catalogModel("local/tiny")]),
                  },
                ],
              },
            },
          ]),
        providerConfig: Effect.succeed({}),
      })
      const inProject = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.provideService(effect, ExtensionRegistry, projectProfile)

      const found = yield* inProject(launch.raw.get("local/tiny"))
      const launchModel = yield* inProject(launch.raw.get("openai/gpt-5.4"))

      expect(Option.map(found, (model) => model.id)).toEqual(
        Option.some(ModelId.make("local/tiny")),
      )
      expect(Option.isNone(launchModel)).toBe(true)
    }),
  )

  it.scopedLive("concatenates the catalog each model driver lists", () =>
    Effect.gen(function* () {
      const registry = yield* loadRegistryWithDrivers([
        {
          id: "openai",
          name: "OpenAI",
          resolveModel: unusedResolution,
          listModels: () => Effect.succeed([catalogModel("openai/gpt-5.4")]),
        },
        {
          id: "anthropic",
          name: "Anthropic",
          resolveModel: unusedResolution,
          listModels: () => Effect.succeed([catalogModel("anthropic/claude-opus-5")]),
        },
      ])

      const models = yield* registry.list

      expect(models.map((model) => model.id)).toEqual([
        ModelId.make("openai/gpt-5.4"),
        ModelId.make("anthropic/claude-opus-5"),
      ])
    }),
  )

  it.scopedLive("gives each driver the auth stored for its own id", () =>
    Effect.gen(function* () {
      const oauthLayer = Auth.Test({
        openai: AuthInfo.cases.Api.make({ type: "api", key: "sk-openai" }),
      })
      const seen: Array<string> = []
      const registry = yield* loadRegistryWithDrivers(
        [
          {
            id: "openai",
            name: "OpenAI",
            resolveModel: unusedResolution,
            listModels: (_catalog, auth) =>
              Effect.sync(() => {
                if (auth?._tag === "Api") seen.push(`openai:${auth.key}`)
                return [catalogModel("openai/gpt-5.4")]
              }),
          },
          {
            id: "anthropic",
            name: "Anthropic",
            resolveModel: unusedResolution,
            listModels: (_catalog, auth) =>
              Effect.sync(() => {
                if (Predicate.isUndefined(auth)) seen.push("anthropic:none")
                return [catalogModel("anthropic/claude-opus-5")]
              }),
          },
        ],
        oauthLayer,
      )

      yield* registry.list

      expect(seen).toEqual(["openai:sk-openai", "anthropic:none"])
    }),
  )

  it.scopedLive("a malformed catalog is left out and reported; other drivers still list", () =>
    Effect.gen(function* () {
      const malformed = catalogModel("openai/broken")
      Reflect.set(malformed, "name", 42)
      const registry = yield* loadRegistryWithDrivers([
        {
          id: "malformed-driver",
          name: "Malformed driver",
          resolveModel: unusedResolution,
          listModels: () => Effect.succeed([malformed]),
        },
        {
          id: "openai",
          name: "OpenAI",
          resolveModel: unusedResolution,
          listModels: () => Effect.succeed([catalogModel("openai/gpt-5.4")]),
        },
      ])

      const catalog = yield* registry.catalog

      expect(catalog.models.map((model) => model.id)).toEqual([ModelId.make("openai/gpt-5.4")])
      expect(catalog.failures).toHaveLength(1)
      expect(catalog.failures[0]?.driverId).toBe("malformed-driver")
      expect(catalog.failures[0]?.error).toContain("returned an invalid model catalog")
    }),
  )

  // An auth store that cannot be read is not one driver's catalog problem: the
  // catalog and a turn's model lookup fail as auth errors, not as UnknownModel.
  it.scopedLive("an auth store read failure fails the catalog and get as an auth error", () =>
    Effect.gen(function* () {
      let listed = false
      const registry = yield* loadRegistryWithDrivers(
        [
          {
            id: "auth-driver",
            name: "Auth driver",
            resolveModel: unusedResolution,
            listModels: () =>
              Effect.sync(() => {
                listed = true
                return [catalogModel("auth-driver/one")]
              }),
          },
        ],
        failingReadAuthLayer,
      )

      const catalogError = yield* Effect.flip(registry.catalog)
      const getError = yield* Effect.flip(registry.get("auth-driver/one"))

      expect(listed).toBe(false)
      expect(catalogError._tag).toBe("ProviderAuthError")
      expect(catalogError.message).toContain('Failed to read auth for provider "auth-driver"')
      expect(getError._tag).toBe("ProviderAuthError")
    }),
  )

  it.scopedLive("lists models newest release first, undated last", () =>
    Effect.gen(function* () {
      const registry = yield* loadRegistryWithDrivers([
        {
          id: "anthropic",
          name: "Anthropic",
          resolveModel: unusedResolution,
          listModels: () =>
            Effect.succeed([
              catalogModel("anthropic/claude-sonnet-4-6", "2026-02-17"),
              catalogModel("anthropic/undated"),
              catalogModel("anthropic/claude-opus-5", "2026-07-24"),
              catalogModel("anthropic/claude-opus-4-6", "2026-02"),
            ]),
        },
      ])

      const models = yield* registry.list

      expect(models.map((model) => model.id)).toEqual([
        ModelId.make("anthropic/claude-opus-5"),
        ModelId.make("anthropic/claude-sonnet-4-6"),
        ModelId.make("anthropic/claude-opus-4-6"),
        ModelId.make("anthropic/undated"),
      ])
    }),
  )

  it.scopedLive("get resolves one model out of the concatenated catalog", () =>
    Effect.gen(function* () {
      const registry = yield* loadRegistryWithDrivers([
        {
          id: "openai",
          name: "OpenAI",
          resolveModel: unusedResolution,
          listModels: () => Effect.succeed([catalogModel("openai/gpt-5.4")]),
        },
      ])

      const found = yield* registry.get("openai/gpt-5.4")
      const missing = yield* registry.get("openai/absent")

      expect(Option.isSome(found)).toBe(true)
      expect(Option.isNone(missing)).toBe(true)
    }),
  )

  // A turn reads its model through `get`; one unreachable driver must not stop it.
  it.scopedLive("get still resolves a model while another driver's catalog fails", () =>
    Effect.gen(function* () {
      const registry = yield* loadRegistryWithDrivers([
        {
          id: "local",
          name: "Local server",
          resolveModel: unusedResolution,
          listModels: () => Effect.die(new Error("connect ECONNREFUSED 127.0.0.1:11434")),
        },
        {
          id: "openai",
          name: "OpenAI",
          resolveModel: unusedResolution,
          listModels: () => Effect.succeed([catalogModel("openai/gpt-5.4")]),
        },
      ])

      expect(Option.isNone(yield* registry.lastFailures)).toBe(true)
      const found = yield* registry.get("openai/gpt-5.4")

      expect(Option.map(found, (model) => model.id)).toEqual(
        Option.some(ModelId.make("openai/gpt-5.4")),
      )
      // The turn's lookup records the failure health reads.
      expect(
        Option.map(yield* registry.lastFailures, (failures) =>
          failures.map((failure) => failure.driverId),
        ),
      ).toEqual(Option.some(["local"]))
    }),
  )
})

// ── auth ────────────────────────────────────────────────────────────────────

/**
 * The `Auth` credential store: writes are serialized per provider, and
 * `Auth.Live` persists to a real on-disk directory, discarding a corrupt
 * entry.
 */

describe("Auth", () => {
  describe("credential store serialization", () => {
    it.live("an update in flight holds back a set for the same provider", () =>
      Effect.gen(function* () {
        const auth = yield* Auth
        const oauth = (refresh: string) =>
          AuthInfo.cases.Oauth.make({ type: "oauth", access: "a", refresh, expires: 0 })
        const storedRefresh = auth.get("openai").pipe(
          Effect.map((info) =>
            Option.fromUndefinedOr(info).pipe(
              Option.flatMap((stored) => {
                if (stored.type !== "oauth") return Option.none<string>()
                return Option.some(stored.refresh)
              }),
            ),
          ),
        )
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const updating = yield* auth
          .update("openai", () =>
            Effect.gen(function* () {
              yield* Deferred.completeWith(entered, Effect.void)
              yield* Deferred.await(release)
              const written: readonly [boolean, Option.Option<AuthInfo>] = [
                true,
                Option.some(oauth("from-update")),
              ]
              return written
            }),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const setting = yield* auth.set("openai", oauth("from-set")).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        expect(yield* storedRefresh).toEqual(Option.some("seed"))
        yield* Deferred.completeWith(release, Effect.void)
        yield* Fiber.join(updating)
        yield* Fiber.join(setting)
        expect(yield* storedRefresh).toEqual(Option.some("from-set"))
      }).pipe(
        Effect.timeout("4 seconds"),
        Effect.provide(
          Auth.Test({
            openai: AuthInfo.cases.Oauth.make({
              type: "oauth",
              access: "a",
              refresh: "seed",
              expires: 0,
            }),
          }),
        ),
      ),
    )
  })

  describe("Auth.Live", () => {
    it.scopedLive("successful persistence publishes exactly once and failure never publishes", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const auth = Context.get(yield* Layer.build(Auth.Live(dir)), Auth)
        const slot = CredentialSlot.make("personal")
        const published = yield* Ref.make(0)
        yield* auth.set(
          "publish",
          AuthApi.make({ type: "api", key: "fake-written" }),
          slot,
          Ref.update(published, (count) => count + 1),
        )
        expect(yield* Ref.get(published)).toBe(1)
        expect(
          Option.exists(
            Option.fromUndefinedOr(yield* auth.get("publish", slot)),
            (stored) => stored.type === "api" && stored.key === "fake-written",
          ),
        ).toBe(true)
        yield* fs.makeDirectory(dir + "/.slots/publish/blocked")
        const failed = yield* Effect.exit(
          auth.set(
            "publish",
            AuthApi.make({ type: "api", key: "fake-failed" }),
            CredentialSlot.make("blocked"),
            Ref.update(published, (count) => count + 1),
          ),
        )
        expect(Exit.isFailure(failed)).toBe(true)
        expect(yield* Ref.get(published)).toBe(1)
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("5 seconds")),
    )

    it.scopedLive(
      "publication writes remain cancellable while provider or SQLite acquisition waits",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          for (const separateStore of [false, true]) {
            const dir = yield* fs.makeTempDirectoryScoped()
            const holder = Context.get(yield* Layer.build(Auth.Live(dir)), Auth)
            let waiter = holder
            if (separateStore) waiter = Context.get(yield* Layer.build(Auth.Live(dir)), Auth)
            const slot = CredentialSlot.make("personal")
            yield* holder.set("publish", AuthApi.make({ type: "api", key: "fake-old" }), slot)
            const inside = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            const holding = yield* holder
              .update(
                "publish",
                () =>
                  Effect.gen(function* () {
                    yield* Deferred.completeWith(inside, Effect.void)
                    yield* Deferred.await(release)
                    return [true, Option.none<AuthInfo>()] as const
                  }),
                slot,
              )
              .pipe(Effect.forkScoped)
            yield* Deferred.await(inside)
            const published = yield* Ref.make(0)
            const waiting = yield* waiter
              .set(
                "publish",
                AuthApi.make({ type: "api", key: "fake-new" }),
                slot,
                Ref.update(published, (count) => count + 1),
              )
              .pipe(Effect.forkScoped)
            yield* Effect.yieldNow
            const ended = yield* Fiber.interrupt(waiting).pipe(Effect.timeoutOption("300 millis"))
            yield* Deferred.completeWith(release, Effect.void)
            yield* Fiber.join(holding)
            expect(Option.isSome(ended)).toBe(true)
            expect(yield* Ref.get(published)).toBe(0)
            expect(
              Option.exists(
                Option.fromUndefinedOr(yield* holder.get("publish", slot)),
                (stored) => stored.type === "api" && stored.key === "fake-old",
              ),
            ).toBe(true)
          }
        }).pipe(Effect.provide(BunServices.layer), Effect.timeout("5 seconds")),
    )

    it.scopedLive("dot-segment slot discovery returns only its credential labels", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const auth = Context.get(yield* Layer.build(Auth.Live(dir)), Auth)
        const personal = CredentialSlot.make("personal")
        yield* auth.set("unrelated", AuthApi.make({ type: "api", key: "fake-default" }))
        const original = yield* fs.readFileString(dir + "/unrelated")
        for (const provider of [".", ".."]) {
          yield* auth.set(provider, AuthApi.make({ type: "api", key: "fake-named" }), personal)
          expect(yield* auth.listSlots(provider)).toEqual([personal])
        }
        expect(yield* auth.listSlots("unrelated")).toEqual([CredentialSlot.make("default")])
        expect((yield* auth.list).slice().sort()).toEqual([".", "..", "unrelated"])
        expect((yield* fs.readFileString(dir + "/unrelated")) === original).toBe(true)
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("5 seconds")),
    )

    it.scopedLive("named provider addresses cannot escape the slots directory", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const auth = Context.get(yield* Layer.build(Auth.Live(dir)), Auth)
        const slot = CredentialSlot.make("personal")
        const info = AuthApi.make({ type: "api", key: "fake-named" })
        for (const [provider, encoded] of [
          ["..", "%2E%2E"],
          ["vendor/team", "vendor%2Fteam"],
        ] as const) {
          yield* auth.set(provider, info, slot)
          expect(yield* fs.exists(dir + "/.slots/" + encoded + "/personal")).toBe(true)
          expect(
            Option.exists(
              Option.fromUndefinedOr(yield* auth.get(provider, slot)),
              (stored) => stored.type === "api" && stored.key === info.key,
            ),
          ).toBe(true)
        }
        expect(yield* fs.exists(dir + "/personal")).toBe(false)
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("5 seconds")),
    )

    it.scopedLive(
      "a failed named rotation write leaves the default unchanged and the old entry recoverable",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const dir = yield* fs.makeTempDirectoryScoped()
          const auth = Context.get(yield* Layer.build(Auth.Live(dir)), Auth)
          const slot = CredentialSlot.make("personal")
          const old = AuthInfo.cases.Oauth.make({
            type: "oauth",
            access: "fake-old",
            refresh: "fake-old-refresh",
            expires: 1,
          })
          const next = AuthInfo.cases.Oauth.make({
            type: "oauth",
            access: "fake-next",
            refresh: "fake-next-refresh",
            expires: 2,
          })
          yield* auth.set("anthropic", AuthApi.make({ type: "api", key: "fake-default" }))
          yield* auth.set("anthropic", old, slot)
          const original = yield* fs.readFileString(dir + "/anthropic")
          const file = dir + "/.slots/anthropic/personal"
          const failed = yield* Effect.exit(
            auth.update(
              "anthropic",
              () =>
                Effect.gen(function* () {
                  // Keep the old entry, and make the atomic rename fail against a directory.
                  yield* fs.rename(file, file + ".old")
                  yield* fs.makeDirectory(file)
                  return [true, Option.some(next)] as const
                }),
              slot,
            ),
          )
          expect(Exit.isFailure(failed)).toBe(true)
          yield* fs.rename(file, file + ".blocked")
          yield* fs.rename(file + ".old", file)
          expect(
            Option.exists(
              Option.fromUndefinedOr(yield* auth.get("anthropic", slot)),
              (stored) => stored.type === "oauth" && stored.refresh === old.refresh,
            ),
          ).toBe(true)
          expect((yield* fs.readFileString(dir + "/anthropic")) === original).toBe(true)
          yield* auth.update(
            "anthropic",
            () => Effect.succeed([true, Option.some(next)] as const),
            slot,
          )
          expect(
            Option.exists(
              Option.fromUndefinedOr(yield* auth.get("anthropic", slot)),
              (stored) => stored.type === "oauth" && stored.refresh === next.refresh,
            ),
          ).toBe(true)
        }).pipe(Effect.provide(BunServices.layer), Effect.timeout("5 seconds")),
    )

    it.scopedLive(
      "named updates share the legacy provider lock across stores and remain interruptible",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const dir = yield* fs.makeTempDirectoryScoped()
          const holder = Context.get(yield* Layer.build(Auth.Live(dir)), Auth)
          const waiter = Context.get(yield* Layer.build(Auth.Live(dir)), Auth)
          const personal = CredentialSlot.make("personal")
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          let namedEntered = false
          const holding = yield* holder
            .update("openai", () =>
              Effect.gen(function* () {
                yield* Deferred.completeWith(entered, Effect.void)
                yield* Deferred.await(release)
                return [true, Option.none<AuthInfo>()] as const
              }),
            )
            .pipe(Effect.forkScoped)
          yield* Deferred.await(entered)
          const blocked = yield* waiter
            .update(
              "openai",
              () =>
                Effect.sync(() => {
                  namedEntered = true
                  return [true, Option.none<AuthInfo>()] as const
                }),
              personal,
            )
            .pipe(Effect.timeout("200 millis"), Effect.exit)
          expect(Exit.isFailure(blocked)).toBe(true)
          expect(namedEntered).toBe(false)
          yield* Deferred.completeWith(release, Effect.void)
          yield* Fiber.join(holding)
          const next = AuthInfo.cases.Oauth.make({
            type: "oauth",
            access: "fake-rotated",
            refresh: "fake-next",
            expires: 123,
          })
          yield* waiter.update(
            "openai",
            () => Effect.succeed([true, Option.some(next)] as const),
            personal,
          )
          expect(
            Option.exists(
              Option.fromUndefinedOr(yield* holder.get("openai", personal)),
              (stored) => stored.type === "oauth" && stored.refresh === next.refresh,
            ),
          ).toBe(true)
          expect(Predicate.isUndefined(yield* holder.get("openai"))).toBe(true)
        }).pipe(Effect.provide(BunServices.layer), Effect.timeout("5 seconds")),
    )

    it.scopedLive("keeps named credentials independent of the unchanged default file", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const auth = Context.get(yield* Layer.build(Auth.Live(dir)), Auth)
        const personal = CredentialSlot.make("personal")
        const legacy = AuthInfo.cases.Api.make({ type: "api", key: "fake-legacy" })
        const named = AuthInfo.cases.Api.make({ type: "api", key: "fake-personal" })
        yield* auth.set("openai", legacy)
        const original = yield* fs.readFileString(dir + "/openai")
        yield* auth.set("openai", named, personal)
        expect(
          (yield* auth.get("openai"))?.type === "api" &&
            Option.exists(
              Option.fromUndefinedOr(yield* auth.get("openai")),
              (info) => info.type === "api" && info.key === legacy.key,
            ),
        ).toBe(true)
        expect(
          Option.exists(
            Option.fromUndefinedOr(yield* auth.get("openai", personal)),
            (info) => info.type === "api" && info.key === named.key,
          ),
        ).toBe(true)
        expect((yield* fs.readFileString(dir + "/openai")) === original).toBe(true)
        expect(
          (yield* fs.readFileString(dir + "/.slots/openai/personal")) ===
            (yield* Schema.encodeEffect(Schema.fromJsonString(Schema.toCodecJson(AuthInfo)))(
              named,
            )),
        ).toBe(true)
        expect((yield* fs.stat(dir + "/.slots/openai/personal")).mode & 0o777).toBe(0o600)
        yield* auth.remove("openai", personal)
        expect(
          Option.exists(
            Option.fromUndefinedOr(yield* auth.get("openai")),
            (info) => info.type === "api" && info.key === legacy.key,
          ),
        ).toBe(true)
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("5 seconds")),
    )

    it.scopedLive("discovers providers stored only in named slots", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const auth = Context.get(yield* Layer.build(Auth.Live(dir)), Auth)
        yield* auth.set(
          "named-only",
          AuthInfo.cases.Api.make({ type: "api", key: "fake" }),
          CredentialSlot.make("work"),
        )
        expect(yield* auth.list).toEqual(["named-only"])
        expect(yield* auth.listSlots("named-only")).toEqual([CredentialSlot.make("work")])
        expect(Predicate.isUndefined(yield* auth.get("named-only"))).toBe(true)
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("5 seconds")),
    )

    // A named-slot directory that cannot be read hides only its named
    // credentials: the default ones still list.
    it.scopedLive("an unreadable named-slot directory keeps the default credentials", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const auth = Context.get(yield* Layer.build(Auth.Live(dir)), Auth)
        yield* auth.set("openai", AuthApi.make({ type: "api", key: "fake-default" }))
        yield* fs.writeFileString(`${dir}/.slots`, "not a directory")
        expect(yield* auth.list).toEqual(["openai"])
        expect(yield* auth.listSlots("openai")).toEqual([CredentialSlot.make("default")])
        yield* fs.remove(`${dir}/.slots`)
        yield* fs.makeDirectory(`${dir}/.slots`)
        yield* fs.writeFileString(`${dir}/.slots/broken`, "not a directory")
        yield* auth.set(
          "named",
          AuthApi.make({ type: "api", key: "fake-named" }),
          CredentialSlot.make("work"),
        )
        expect([...(yield* auth.list)].sort()).toEqual(["named", "openai"])
        expect(yield* auth.listSlots("broken")).toEqual([])
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("5 seconds")),
    )

    it.scopedLive("persists round-trip to disk", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()

        const writer = Effect.gen(function* () {
          const auth = yield* Auth
          yield* auth.set("openai", AuthInfo.cases.Api.make({ type: "api", key: "sk-on-disk" }))
        }).pipe(Effect.provide(Auth.Live(dir)))
        yield* writer

        const reader = Effect.gen(function* () {
          const auth = yield* Auth
          return yield* auth.get("openai")
        }).pipe(Effect.provide(Auth.Live(dir)))
        const fetched = yield* reader

        expect(fetched?.type).toBe("api")
        if (fetched?.type === "api") expect(fetched.key).toBe("sk-on-disk")
      }).pipe(Effect.provide(BunServices.layer)),
    )

    // A sign-in's prompt answers are an additive field: a key stored before
    // them still reads, without any.
    it.scopedLive("keeps an API key's prompt answers, and reads a key stored without them", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        yield* fs.writeFileString(`${dir}/older`, '{"_tag":"Api","type":"api","key":"sk-older"}')
        const stored = yield* Effect.gen(function* () {
          const auth = yield* Auth
          yield* auth.set(
            "cloudflare",
            AuthInfo.cases.Api.make({
              type: "api",
              key: "cf-token",
              metadata: { accountId: "acct-1", gatewayId: "gw-1" },
            }),
          )
          return [yield* auth.get("cloudflare"), yield* auth.get("older")] as const
        }).pipe(Effect.provide(Auth.Live(dir)))
        const reread = yield* Effect.gen(function* () {
          return yield* (yield* Auth).get("cloudflare")
        }).pipe(Effect.provide(Auth.Live(dir)))

        const withAnswers = AuthInfo.cases.Api.make({
          type: "api",
          key: "cf-token",
          metadata: { accountId: "acct-1", gatewayId: "gw-1" },
        })
        expect(stored[0]).toEqual(withAnswers)
        expect(reread).toEqual(withAnswers)
        expect(stored[1]).toEqual({ _tag: "Api", type: "api", key: "sk-older" })
      }).pipe(Effect.provide(BunServices.layer)),
    )

    it.scopedLive("discards a corrupt entry and returns undefined", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        // Write a malformed entry directly. The store URL-encodes the key
        // into the file basename; `openai` has nothing to escape.
        yield* fs.writeFileString(`${dir}/openai`, "not-json-at-all")

        const result = yield* Effect.gen(function* () {
          const auth = yield* Auth
          return yield* auth.get("openai")
        }).pipe(Effect.provide(Auth.Live(dir)))
        expect(result).toBeUndefined()

        // Recovery is not just "swallow" — the broken file should be
        // removed so the next launch isn't held back by it.
        const stillThere = yield* fs.exists(`${dir}/openai`)
        expect(stillThere).toBe(false)
      }).pipe(Effect.provide(BunServices.layer)),
    )

    // Two stores over one directory stand for two gent processes: each has
    // its own in-process lock, so only the directory's lock orders them.
    it.scopedLive("updates from two stores over one directory run one at a time", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const first = Context.get(yield* Layer.build(Auth.Live(dir)), Auth)
        const second = Context.get(yield* Layer.build(Auth.Live(dir)), Auth)
        const counter = (info: Option.Option<AuthInfo>): number =>
          Option.match(info, {
            onNone: () => 0,
            onSome: (found) => {
              if (found.type !== "api") return 0
              return Number(found.key)
            },
          })
        const write = (count: number) =>
          Option.some(AuthInfo.cases.Api.make({ type: "api", key: String(count) }))
        const firstInside = yield* Deferred.make<boolean>()
        const secondInside = yield* Deferred.make<boolean>()
        // The first update holds its read until the second is inside its
        // own update, or until it is clear the second is kept out.
        const firstUpdate = yield* first
          .update("openai", (current) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(firstInside, true)
              yield* Deferred.await(secondInside).pipe(Effect.timeoutOption("300 millis"))
              return ["first", write(counter(current) + 1)] satisfies readonly [
                string,
                Option.Option<AuthInfo>,
              ]
            }),
          )
          .pipe(Effect.forkScoped)
        yield* Deferred.await(firstInside)
        yield* second.update("openai", (current) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(secondInside, true)
            return ["second", write(counter(current) + 1)] satisfies readonly [
              string,
              Option.Option<AuthInfo>,
            ]
          }),
        )
        yield* Fiber.join(firstUpdate)
        // Both increments land: neither update read the value the other replaced.
        expect(counter(Option.fromUndefinedOr(yield* first.get("openai")))).toBe(2)
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("5 seconds")),
    )

    // A write that truncates the file in place shows a reader in another
    // process an empty file for a moment. A reader that opened the file
    // before the write sees the same inode: it must still read the whole
    // credential it opened, never a truncated or mixed one.
    it.scopedLive("a write from another store never truncates the file a reader has open", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const writer = Context.get(yield* Layer.build(Auth.Live(dir)), Auth)
        const reader = Context.get(yield* Layer.build(Auth.Live(dir)), Auth)
        yield* writer.set("openai", AuthInfo.cases.Api.make({ type: "api", key: "sk-old" }))
        const opened = yield* fs.open(`${dir}/openai`, { flag: "r" })
        yield* writer.set("openai", AuthInfo.cases.Api.make({ type: "api", key: "sk-new" }))
        const buffer = new Uint8Array(4096)
        const size = yield* opened.read(buffer)
        const seen = new TextDecoder().decode(buffer.subarray(0, Number(size)))
        expect(seen).toContain('"sk-old"')
        const read = yield* reader.get("openai")
        expect(read).toEqual(AuthInfo.cases.Api.make({ type: "api", key: "sk-new" }))
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("5 seconds")),
    )

    it.scopedLive(
      "a corrupt read waits for the writer holding the lock, then reads its value",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const dir = yield* fs.makeTempDirectoryScoped()
          const holder = Context.get(yield* Layer.build(Auth.Live(dir)), Auth)
          const reader = Context.get(yield* Layer.build(Auth.Live(dir)), Auth)
          yield* holder.set("openai", AuthInfo.cases.Api.make({ type: "api", key: "sk-old" }))
          const inside = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          // The holder stands for an older binary that writes in place: while
          // it holds the lock, the file is empty.
          const updating = yield* holder
            .update("openai", () =>
              Effect.gen(function* () {
                yield* fs.writeFileString(`${dir}/openai`, "")
                yield* Deferred.completeWith(inside, Effect.void)
                yield* Deferred.await(release)
                return [
                  "written",
                  Option.some(AuthInfo.cases.Api.make({ type: "api", key: "sk-written" })),
                ] satisfies readonly [string, Option.Option<AuthInfo>]
              }),
            )
            .pipe(Effect.forkScoped)
          yield* Deferred.await(inside)
          const reading = yield* reader.get("openai").pipe(Effect.forkScoped)
          yield* Effect.yieldNow
          yield* Deferred.completeWith(release, Effect.void)
          yield* Fiber.join(updating)
          const read = yield* Fiber.join(reading)
          expect(read).toEqual(AuthInfo.cases.Api.make({ type: "api", key: "sk-written" }))
          expect(yield* fs.exists(`${dir}/openai`)).toBe(true)
        }).pipe(Effect.provide(BunServices.layer), Effect.timeout("5 seconds")),
    )

    // A cancel of a turn waiting on another process's refresh must end the
    // wait, not sit out the holder's refresh or the whole 30 s poll.
    it.scopedLive("a wait for a lock another store holds ends when it is interrupted", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const holder = Context.get(yield* Layer.build(Auth.Live(dir)), Auth)
        const waiter = Context.get(yield* Layer.build(Auth.Live(dir)), Auth)
        const inside = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const holding = yield* holder
          .update("openai", () =>
            Effect.gen(function* () {
              yield* Deferred.completeWith(inside, Effect.void)
              yield* Deferred.await(release)
              return ["held", Option.none()] satisfies readonly [string, Option.Option<AuthInfo>]
            }),
          )
          .pipe(Effect.forkScoped)
        yield* Deferred.await(inside)
        const waiting = yield* waiter
          .update("openai", () =>
            Effect.succeed(["waited", Option.none()] satisfies readonly [
              string,
              Option.Option<AuthInfo>,
            ]),
          )
          .pipe(Effect.timeout("300 millis"), Effect.exit, Effect.forkScoped)
        // The holder is still inside: only an interruptible wait ends here.
        const ended = yield* Fiber.await(waiting).pipe(Effect.timeoutOption("3 seconds"))
        yield* Deferred.completeWith(release, Effect.void)
        yield* Fiber.join(holding)
        expect(Option.isSome(ended)).toBe(true)
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("10 seconds")),
    )

    it.scopedLive("stores a credential readable only by its owner", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const auth = Context.get(yield* Layer.build(Auth.Live(dir)), Auth)
        yield* auth.set("openai", AuthInfo.cases.Api.make({ type: "api", key: "sk-secret" }))
        expect(((yield* fs.stat(`${dir}/openai`)).mode & 0o777).toString(8)).toBe("600")
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("5 seconds")),
    )
  })
})

// ── auth provider listing ───────────────────────────────────────────────────

/**
 * listAuthProviders tests
 */

const stubModel = AiModel.make("test", "model", LanguageModelLayers.failing)

const testProviders: ModelDriverContribution[] = [
  { id: "anthropic", name: "Anthropic", resolveModel: () => Effect.succeed(stubModel) },
  { id: "openai", name: "OpenAI", resolveModel: () => Effect.succeed(stubModel) },
  { id: "google", name: "Google", resolveModel: () => Effect.succeed(stubModel) },
  { id: "mistral", name: "Mistral", resolveModel: () => Effect.succeed(stubModel) },
]

const testRegistryLayer = ExtensionRegistry.fromResolved(
  resolveExtensions([
    {
      manifest: { id: ExtensionId.make("test-providers") },
      scope: "builtin",
      sourcePath: "test",
      contributions: { modelDrivers: testProviders },
    } satisfies LoadedExtension,
  ]),
)

describe("listAuthProviders", () => {
  const apiInfo = (key: string): AuthInfo => AuthApi.make({ type: "api", key })
  const list = (seed: Record<string, AuthInfo>, driverIds: ReadonlyArray<string>) =>
    listAuthProviders(driverIds).pipe(
      Effect.provide(Layer.mergeAll(Auth.Test(seed), testRegistryLayer, emptyCatalogLayer)),
    )
  const opus = "anthropic"

  it.live("only the given drivers are marked required", () =>
    Effect.gen(function* () {
      const result = yield* list({}, [opus, "google"])
      expect(result.filter((p) => p.required).map((p) => p.provider)).toEqual([
        ProviderId.make("anthropic"),
        ProviderId.make("google"),
      ])
    }),
  )

  it.live("every provider reports its own stored key, required or not", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<{
        readonly seed: Record<string, AuthInfo>
        readonly withKey: ReadonlyArray<string>
      }> = [
        { seed: {}, withKey: [] },
        { seed: { anthropic: apiInfo("sk-anthropic") }, withKey: ["anthropic"] },
        { seed: { openai: apiInfo("sk-openai") }, withKey: ["openai"] },
      ]
      for (const { seed, withKey } of cases) {
        const result = yield* list(seed, [opus])
        expect(result.map((p) => [String(p.provider), p.required, p.hasKey])).toEqual([
          ["anthropic", true, withKey.includes("anthropic")],
          ["openai", false, withKey.includes("openai")],
          ["google", false, false],
          ["mistral", false, false],
        ])
      }
    }),
  )

  it.live("a key that lacks an answer a needed prompt asks is not ready and names it", () =>
    Effect.gen(function* () {
      const prompted: ModelDriverContribution = {
        id: "prompted",
        name: "Prompted",
        resolveModel: () => Effect.succeed(stubModel),
        auth: {
          methods: [
            AuthMethod.make({
              type: "api",
              label: "API",
              prompts: [
                { key: "account", label: "Account" },
                { key: "region", label: "Region", optional: true },
              ],
            }),
          ],
        },
      }
      const registry = ExtensionRegistry.fromResolved(
        resolveExtensions([
          {
            manifest: { id: ExtensionId.make("test-prompted") },
            scope: "builtin",
            sourcePath: "test",
            contributions: { modelDrivers: [prompted] },
          } satisfies LoadedExtension,
        ]),
      )
      const row = (metadata: Record<string, string>) =>
        listAuthProviders([]).pipe(
          Effect.provide(
            Layer.mergeAll(
              Auth.Test({ prompted: AuthApi.make({ type: "api", key: "k", metadata }) }),
              registry,
              emptyCatalogLayer,
            ),
          ),
          Effect.map(([listed]) => [listed?.hasKey, Option.fromNullishOr(listed?.missing)]),
        )
      expect(yield* row({})).toEqual([false, Option.some(["Account"])])
      expect(yield* row({ account: "" })).toEqual([false, Option.some(["Account"])])
      expect(yield* row({ account: "a-1" })).toEqual([true, Option.none()])
    }),
  )

  it.live("a key ready under one of a driver's sign-ins is ready", () =>
    Effect.gen(function* () {
      const twoWays: ModelDriverContribution = {
        id: "two-ways",
        name: "Two Ways",
        resolveModel: () => Effect.succeed(stubModel),
        auth: {
          methods: [
            AuthMethod.make({
              type: "api",
              label: "Personal",
              prompts: [{ key: "user", label: "User ID", env: "TWO_WAYS_USER" }],
            }),
            AuthMethod.make({
              type: "api",
              label: "Business",
              prompts: [
                { key: "org", label: "Organization" },
                { key: "team", label: "Team" },
              ],
            }),
          ],
        },
      }
      const registry = ExtensionRegistry.fromResolved(
        resolveExtensions([
          {
            manifest: { id: ExtensionId.make("test-two-ways") },
            scope: "builtin",
            sourcePath: "test",
            contributions: { modelDrivers: [twoWays] },
          } satisfies LoadedExtension,
        ]),
      )
      const row = (metadata: Record<string, string>, env: Record<string, string> = {}) =>
        listAuthProviders([]).pipe(
          Effect.provide(
            Layer.mergeAll(
              Auth.Test({ "two-ways": AuthApi.make({ type: "api", key: "k", metadata }) }),
              registry,
              emptyCatalogLayer,
              ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
            ),
          ),
          Effect.map(([listed]) => [listed?.hasKey, Option.fromNullishOr(listed?.missing)]),
        )
      expect(yield* row({ user: "u-1" })).toEqual([true, Option.none()])
      expect(yield* row({ org: "o-1", team: "t-1" })).toEqual([true, Option.none()])
      // A variable completes the personal sign-in under a half-filled business one.
      expect(yield* row({ org: "o-1" }, { TWO_WAYS_USER: "u-1" })).toEqual([true, Option.none()])
      // Not ready under any sign-in: the row names what the closest one lacks.
      expect(yield* row({ org: "o-1" })).toEqual([false, Option.some(["Team"])])
      expect(yield* row({})).toEqual([false, Option.some(["User ID"])])
    }),
  )

  it.live("every provider carries its driver's display name", () =>
    Effect.gen(function* () {
      const result = yield* list({ anthropic: apiInfo("sk-test") }, [opus])
      expect(result.map((p) => [p.provider, p.name])).toEqual([
        ["anthropic", "Anthropic"],
        ["openai", "OpenAI"],
        ["google", "Google"],
        ["mistral", "Mistral"],
      ])
    }),
  )
})

// ── provider auth ───────────────────────────────────────────────────────────

const pendingCallbacks = new Map<string, (code?: string) => string>()
const oauthProvider: ModelDriverContribution = {
  id: "openai",
  name: "OpenAI",
  resolveModel: () => Effect.succeed(stubModel),
  auth: {
    methods: [AuthMethod.make({ type: "oauth", label: "OAuth" })],
    authorize: (ctx) =>
      Effect.sync(() => {
        pendingCallbacks.set(ctx.authorizationId, (code) => code ?? "")
        return Option.some({
          url: "http://example.com/auth",
          method: "code",
          instructions: "Paste code",
        })
      }),
    callback: (ctx) =>
      Effect.gen(function* () {
        const cb = pendingCallbacks.get(ctx.authorizationId)
        pendingCallbacks.delete(ctx.authorizationId)
        let apiKey = ""
        if (!Predicate.isUndefined(cb)) apiKey = cb(ctx.code)
        yield* ctx.persist({ type: "api", key: apiKey })
      }),
  },
}
const noopProvider: ModelDriverContribution = {
  id: "anthropic",
  name: "Anthropic",
  resolveModel: () => Effect.succeed(stubModel),
  auth: {
    methods: [AuthMethod.make({ type: "api", label: "API" })],
  },
}
const persistDuringAuthorizeProvider: ModelDriverContribution = {
  id: "persisting",
  name: "Persisting",
  resolveModel: () => Effect.succeed(stubModel),
  auth: {
    methods: [AuthMethod.make({ type: "oauth", label: "Done" })],
    authorize: (ctx) =>
      Effect.gen(function* () {
        yield* ctx.persist({ type: "api", key: "sk-authorize" })
        return Option.some({
          url: "",
          method: "done",
        })
      }),
  },
}
const testResolvedProviderAuth = resolveExtensions([
  {
    manifest: { id: ExtensionId.make("test") },
    scope: "builtin",
    sourcePath: "test",
    contributions: { modelDrivers: [oauthProvider, noopProvider, persistDuringAuthorizeProvider] },
  } satisfies LoadedExtension,
])
const testRegistry = ExtensionRegistry.fromResolved(testResolvedProviderAuth)
const failingAuthStoreLayer = Layer.succeed(
  Auth,
  Auth.of(
    serializeAuthStore({
      list: Effect.succeed([]),
      listSlots: () => Effect.succeed([]),
      get: () => Effect.succeed(noStoredAuth),
      set: () => Effect.fail(new AuthError({ message: "write failed" })),
      remove: () => Effect.void,
    }),
  ),
)
describe("provider login", () => {
  it.live("extension authorize + callback stores credentials", () =>
    Effect.gen(function* () {
      pendingCallbacks.clear()
      const authLayer = Auth.Test()
      const layer = Layer.mergeAll(authLayer, testRegistry, GentPlatform.Test())
      const result = yield* Effect.gen(function* () {
        const store = yield* Auth
        const authResult = yield* authorizeProvider(SessionId.make("s1"), "openai", 0)
        if (Option.isNone(authResult)) return { ok: false }
        yield* completeProviderAuth(
          SessionId.make("s1"),
          "openai",
          0,
          authResult.value.authorizationId,
          "sk-test-key",
        )
        const stored = yield* store.get("openai")
        return { ok: true, stored }
      }).pipe(Effect.provide(layer))
      if (!result.ok) return yield* Effect.die(new Error("auth setup failed"))
      const stored = Option.fromUndefinedOr(result.stored)
      expect(Option.isSome(stored)).toBe(true)
      if (Option.isNone(stored)) return
      expect(stored.value.type).toBe("api")
      if (stored.value.type !== "api") return
      expect(stored.value.key).toBe("sk-test-key")
    }),
  )
  it.live("listMethods returns methods from extension providers", () =>
    Effect.gen(function* () {
      const authLayer = Auth.Test()
      const layer = Layer.mergeAll(authLayer, testRegistry, GentPlatform.Test(), emptyCatalogLayer)
      const methods = yield* listAuthMethods().pipe(Effect.provide(layer))
      expect(Object.keys(methods)).toContain("openai")
      expect(Object.keys(methods)).toContain("anthropic")
      expect(Object.keys(methods)).toContain("persisting")
      expect(methods["openai"]?.length).toBe(1)
    }),
  )
  it.live("authorize surfaces credential persistence failures", () =>
    Effect.gen(function* () {
      const layer = Layer.mergeAll(failingAuthStoreLayer, testRegistry, GentPlatform.Test())
      const exit = yield* Effect.exit(
        authorizeProvider(SessionId.make("s1"), "persisting", 0),
      ).pipe(Effect.provide(layer))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        expect(exit.cause.toString()).toContain("Failed to persist auth")
      }
    }),
  )
  it.live("callback surfaces credential persistence failures", () =>
    Effect.gen(function* () {
      pendingCallbacks.clear()
      const layer = Layer.mergeAll(failingAuthStoreLayer, testRegistry, GentPlatform.Test())
      const exit = yield* Effect.gen(function* () {
        const authResult = yield* authorizeProvider(SessionId.make("s1"), "openai", 0)
        if (Option.isNone(authResult)) return yield* Effect.die("auth setup failed")
        return yield* Effect.exit(
          completeProviderAuth(
            SessionId.make("s1"),
            "openai",
            0,
            authResult.value.authorizationId,
            "sk-test-key",
          ),
        )
      }).pipe(Effect.provide(layer))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        expect(exit.cause.toString()).toContain("Failed to persist auth")
      }
    }),
  )
})

// ── provider model resolution ───────────────────────────────────────────────

// oxlint-disable-next-line effect/noNullish -- AuthService uses undefined to represent missing credentials.
const missingAuthInfo: AuthInfo | undefined = undefined
const testAuthStorage: AuthService = serializeAuthStore({
  list: Effect.succeed([]),
  listSlots: () => Effect.succeed([]),
  get: () => Effect.succeed(missingAuthInfo),
  set: () => Effect.void,
  remove: () => Effect.void,
})
/** Create a fake upstream model with a stub LanguageModel layer */
const fakeResolution = (): ProviderResolution =>
  AiModel.make("test", "model", LanguageModelLayers.failing)
// The live-path tests read the options gent hands the LanguageModel service
// itself (the toolkit identity, disableToolCallResolution, the raw prompt),
// which `LanguageModel.make` consumes before a `makeLanguageModelLayer`
// stream sees them, so they stub the service. Unset methods fail.
interface ServiceCallOptions {
  readonly disableToolCallResolution?: boolean
  readonly toolkit?: unknown
  readonly prompt?: Prompt.RawInput
}
interface ServiceOverrides<Options extends ServiceCallOptions> {
  readonly streamText?: (options: Options) => Stream.Stream<unknown, unknown>
}
const stubFailure = (method: string) =>
  AiError.make({
    module: "Test",
    method,
    reason: new AiError.UnknownError({ description: "stub" }),
  })
const makeLanguageModel = <Options extends ServiceCallOptions = ServiceCallOptions>(
  overrides: ServiceOverrides<Options> = {},
): LanguageModel.LanguageModel =>
  // oxlint-disable-next-line effect/noAs, effect/noChainedTypeAssertions -- The overloaded service contract is adapted to one call shape here only.
  ({
    [LanguageModel.TypeId]: LanguageModel.TypeId,
    generateText: () => Effect.fail(stubFailure("generateText")),
    generateObject: () => Effect.fail(stubFailure("generateObject")),
    streamText: () => Stream.fail(stubFailure("streamText")),
    ...overrides,
  }) as unknown as LanguageModel.LanguageModel
const modelFromService = (
  provider: string,
  service: LanguageModel.LanguageModel,
): ProviderResolution =>
  AiModel.make(provider, "model", Layer.succeed(LanguageModel.LanguageModel, service))
const assertProviderResolutionRejectsBareLayer = () => {
  const bareLayer = LanguageModelLayers.failing
  // @ts-expect-error -- ProviderResolution must come from Effect AI Model.make metadata.
  const resolution: ProviderResolution = bareLayer
  return resolution
}
// If ProviderResolution ever stops requiring Model.make metadata, this
// assignment compiles and @ts-expect-error flips the guard red.
void assertProviderResolutionRejectsBareLayer
const makeProvider = (id: string, name?: string): ModelDriverContribution => ({
  id,
  name: name ?? id,
  resolveModel: () => Effect.succeed(fakeResolution()),
})
const EchoParams = Schema.Struct({ text: Schema.String })
const echoCapability: ToolCapability = tool({
  id: "echo",
  description: "Echo input",
  params: EchoParams,
  output: Schema.String,
  execute: () => Effect.succeed("echoed"),
})
const makeExt = (extId: string, modelDrivers: ModelDriverContribution[]): LoadedExtension => ({
  manifest: { id: ExtensionId.make(extId) },
  scope: "builtin",
  sourcePath: "test",
  contributions: { modelDrivers },
})
interface ModelRequest {
  readonly model: string
  readonly reasoning?: ReasoningEffort
  readonly maxTokens?: number
  readonly temperature?: number
  readonly driverId?: string
  readonly credentialSlot?: CredentialSlot
}

const buildProviderLayer = (
  extensions: LoadedExtension[],
  authStore: AuthService = testAuthStorage,
) => {
  const resolved = resolveExtensions(extensions)
  const registryLayer = ExtensionRegistry.fromResolved(resolved)
  const authLayer = Layer.succeed(Auth, authStore)
  return Layer.provideMerge(
    ModelResolver.Live,
    Layer.mergeAll(authLayer, registryLayer, fixtureModelCatalogSource),
  )
}
const resolveModel = (request: ModelRequest) =>
  Effect.gen(function* () {
    const resolver = yield* ModelResolver
    return yield* resolver.resolve({
      modelId: request.model,
      hints: {
        reasoning: request.reasoning,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
      },
      driverId: request.driverId,
      credentialSlot: request.credentialSlot,
    })
  })
/** A tool whose parameters encode without services, as `streamText` requires with `disableToolCallResolution`. */
type ServiceFreeTool = AiTool.Tool<
  string,
  {
    readonly parameters: Schema.Codec<unknown, unknown, never, never>
    readonly success: Schema.Top
    readonly failure: Schema.Top
    readonly failureMode: AiTool.FailureMode
  },
  never
>
const streamResolvedModel = <
  Tools extends Record<string, ServiceFreeTool> = Record<string, ServiceFreeTool>,
>(
  request: ModelRequest & {
    readonly prompt: Prompt.RawInput
    readonly tools?: ReadonlyArray<ToolCapability>
    readonly toolkit?: ToolkitInput<Tools, never, never>
  },
) =>
  Effect.gen(function* () {
    const model = yield* resolveModel(request)
    if (!Predicate.isUndefined(request.toolkit)) {
      return yield* model
        .streamText({
          prompt: request.prompt,
          toolkit: request.toolkit,
          disableToolCallResolution: true,
        })
        .pipe(Stream.runCollect)
    }
    if (!Predicate.isUndefined(request.tools)) {
      return yield* model
        .streamText({
          prompt: request.prompt,
          toolkit: convertTools(request.tools),
          disableToolCallResolution: true,
        })
        .pipe(Stream.runCollect)
    }
    return yield* model.streamText({ prompt: request.prompt }).pipe(Stream.runCollect)
  })
describe("Provider model resolution", () => {
  it.scoped("ModelResolver resolves the LanguageModel service directly", () =>
    Effect.gen(function* () {
      const languageModel = makeLanguageModel({
        streamText: () => Stream.fromIterable([finishPart({ finishReason: "stop" })]),
      })
      const layer = buildProviderLayer([
        makeExt("direct-ext", [
          {
            id: "direct",
            name: "Direct",
            resolveModel: () => Effect.succeed(modelFromService("direct", languageModel)),
          },
        ]),
      ])
      const model = yield* resolveModel({ model: "direct/gpt-5" }).pipe(Effect.provide(layer))
      const result = yield* model.streamText({ prompt: [] }).pipe(Stream.runCollect)
      expect(Array.from(result)).toEqual([expect.objectContaining({ type: "finish" })])
    }),
  )
  it.scoped("errors for unregistered provider", () =>
    Effect.gen(function* () {
      const layer = buildProviderLayer([])
      const result = yield* Effect.exit(
        resolveModel({
          model: "unknown-provider/some-model",
        }).pipe(Effect.provide(layer)),
      )
      expect(result._tag).toBe("Failure")
    }),
  )
  it.scoped("wraps extension resolveModel errors as ProviderError preserving cause", () =>
    Effect.gen(function* () {
      // oxlint-disable-next-line effect/noNewError -- The defect identity is part of this cause-preservation assertion.
      const original = new Error("kaboom")
      const throwingProvider: ModelDriverContribution = {
        id: "broken",
        name: "Broken",
        resolveModel: () => Effect.die(original),
      }
      const layer = buildProviderLayer([makeExt("broken-ext", [throwingProvider])])
      const result = yield* Effect.exit(
        resolveModel({
          model: "broken/model",
        }).pipe(Effect.provide(layer)),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const errOpt = Cause.findErrorOption(result.cause)
        expect(errOpt._tag).toBe("Some")
        if (errOpt._tag === "Some") {
          const err = errOpt.value
          // The original `Error` thrown from the driver must be
          // preserved as `cause` so the upstream chain is debuggable.
          expect(err._tag).toBe("ProviderError")
          expect(err.cause).toBe(original)
        }
      }
    }),
  )
  it.scoped("driver ProviderAuthError surfaces typed at the provider boundary", () =>
    Effect.gen(function* () {
      // Drivers that fail closed at credential resolution return a typed
      // ProviderAuthError from `resolveModel`. The boundary must keep it
      // typed so `GentRpcError` (which has
      // `ProviderAuthError` as a first-class union arm) receives the typed
      // tag — not a generic `ProviderError` with the auth error demoted to
      // a defect-encoded cause.
      const failingAuthProvider: ModelDriverContribution = {
        id: "auth-missing",
        name: "AuthMissing",
        resolveModel: () =>
          Effect.fail(
            new ProviderAuthError({
              message: "credentials unavailable: no OAuth, API key, or env var",
            }),
          ),
      }
      const layer = buildProviderLayer([makeExt("auth-missing-ext", [failingAuthProvider])])
      const result = yield* Effect.exit(
        resolveModel({
          model: "auth-missing/model",
        }).pipe(Effect.provide(layer)),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const errOpt = Cause.findErrorOption(result.cause)
        expect(errOpt._tag).toBe("Some")
        if (errOpt._tag === "Some") {
          const err = errOpt.value
          expect(Schema.is(ProviderAuthError)(err)).toBe(true)
          if (Schema.is(ProviderAuthError)(err)) {
            expect(err.message).toContain("credentials unavailable")
          }
        }
      }
    }),
  )
  it.scoped("auth store read failures fail closed before resolving the model", () =>
    Effect.gen(function* () {
      let resolved = false
      const provider: ModelDriverContribution = {
        id: "auth-fails",
        name: "AuthFails",
        resolveModel: () =>
          Effect.sync(() => {
            resolved = true
            return fakeResolution()
          }),
      }
      const authStore: AuthService = {
        ...testAuthStorage,
        get: () => Effect.fail(new AuthError({ message: "read failed" })),
      }
      const layer = buildProviderLayer([makeExt("auth-fails-ext", [provider])], authStore)
      const result = yield* Effect.exit(
        resolveModel({
          model: "auth-fails/model",
        }).pipe(Effect.provide(layer)),
      )
      expect(result._tag).toBe("Failure")
      expect(resolved).toBe(false)
      expect(result.toString()).toContain('Failed to read auth for provider "auth-fails"')
    }),
  )
  // ── Per-turn registry (per-cwd profile shadowing) ──
  it.scoped("resolution reads the extension registry of the calling turn", () =>
    Effect.gen(function* () {
      // The launch registry has only "captured-only", so "shadowed" is unknown there.
      const capturedLayer = buildProviderLayer([
        makeExt("captured", [makeProvider("captured-only", "Captured")]),
      ])
      // The turn registry has "shadowed" and must win.
      const turnRegistry = yield* Effect.service(ExtensionRegistry).pipe(
        Effect.provide(
          ExtensionRegistry.fromResolved(
            resolveExtensions([makeExt("shadowed", [makeProvider("shadowed", "Shadowed")])]),
          ),
        ),
      )
      const launch = yield* Effect.exit(
        resolveModel({ model: "shadowed/some-model" }).pipe(Effect.provide(capturedLayer)),
      )
      expect(launch._tag).toBe("Failure")
      const turn = yield* Effect.exit(
        resolveModel({ model: "shadowed/some-model" }).pipe(
          Effect.provideService(ExtensionRegistry, turnRegistry),
          Effect.provide(capturedLayer),
        ),
      )
      expect(turn._tag).toBe("Success")
    }),
  )
  // ── ModelDriverRef.id override ──
  it.scoped("driverId override picks a driver other than the one parsed from modelId", () =>
    Effect.gen(function* () {
      // Both drivers registered. Default parse from "primary/foo" → "primary".
      // We force "alt" via driverId override and check `alt` was chosen by giving it
      // a recognizable resolveModel side effect.
      let chosenDriver = "unset"
      const layer = buildProviderLayer([
        makeExt("primary-ext", [
          {
            id: "primary",
            name: "Primary",
            resolveModel: () =>
              Effect.sync(() => {
                chosenDriver = "primary"
                return fakeResolution()
              }),
          },
        ]),
        makeExt("alt-ext", [
          {
            id: "alt",
            name: "Alt",
            resolveModel: () =>
              Effect.sync(() => {
                chosenDriver = "alt"
                return fakeResolution()
              }),
          },
        ]),
      ])
      yield* Effect.exit(
        resolveModel({
          model: "primary/foo",
          driverId: "alt",
        }).pipe(Effect.provide(layer)),
      )
      expect(chosenDriver).toBe("alt")
    }),
  )
  it.scoped("runtime tools advertise capabilities through the live stream path", () =>
    Effect.gen(function* () {
      type CapturedTools = {
        readonly disableToolCallResolution: Option.Option<boolean>
        readonly toolkit: Option.Option<
          | AiToolkit.Toolkit<Record<string, AiTool.Any>>
          | AiToolkit.WithHandler<Record<string, AiTool.Any>>
        >
      }
      const captured: CapturedTools[] = []
      const streamingProvider: ModelDriverContribution = {
        id: "tools-live",
        name: "ToolsLive",
        resolveModel: () =>
          Effect.succeed(
            modelFromService(
              "tools-live",
              makeLanguageModel<{
                readonly disableToolCallResolution?: boolean
                readonly toolkit?:
                  | AiToolkit.Toolkit<Record<string, AiTool.Any>>
                  | AiToolkit.WithHandler<Record<string, AiTool.Any>>
              }>({
                streamText: (options) => {
                  captured.push({
                    disableToolCallResolution: Option.fromUndefinedOr(
                      options.disableToolCallResolution,
                    ),
                    toolkit: Option.fromUndefinedOr(options.toolkit),
                  })
                  return Stream.fromIterable([
                    toolCallPart("echo", { text: "hi" }, { toolCallId: ToolCallId.make("tc-1") }),
                    finishPart({
                      finishReason: "tool-calls",
                      usage: { inputTokens: 10, outputTokens: 20 },
                    }),
                  ])
                },
              }),
            ),
          ),
      }
      const layer = buildProviderLayer([makeExt("tools-live-ext", [streamingProvider])])
      const parts = yield* streamResolvedModel({
        model: "tools-live/gpt-5",
        prompt: [],
        tools: [echoCapability],
      }).pipe(Effect.provide(layer))
      expect(captured).toHaveLength(1)
      const capturedTools = captured[0]
      if (Predicate.isUndefined(capturedTools)) return
      expect(Option.isSome(capturedTools.disableToolCallResolution)).toBe(true)
      if (Option.isSome(capturedTools.disableToolCallResolution)) {
        expect(capturedTools.disableToolCallResolution.value).toBe(true)
      }
      expect(Option.isSome(capturedTools.toolkit)).toBe(true)
      if (Option.isNone(capturedTools.toolkit)) return
      const toolkit = capturedTools.toolkit.value
      expect(Object.keys(toolkit.tools)).toEqual(["echo"])
      expect(toolkit.tools["echo"]?.name).toBe("echo")
      const advertisedTool = toolkit.tools["echo"]
      expect(advertisedTool).toBeDefined()
      if (!Predicate.isUndefined(advertisedTool)) {
        expect(() => toCodecAnthropic(advertisedTool.parametersSchema)).not.toThrow()
      }
      const collected = Array.from(parts)
      expect(collected).toHaveLength(2)
      expect(collected[0]).toEqual(
        expect.objectContaining({
          type: "tool-call",
          name: "echo",
          params: { text: "hi" },
        }),
      )
      expect(collected[1]).toEqual(
        expect.objectContaining({
          type: "finish",
          reason: "tool-calls",
        }),
      )
    }),
  )
  it.scoped("runtime toolkit preserves typed Effect tool maps through the live stream path", () =>
    Effect.gen(function* () {
      const typedEchoTool = AiTool.dynamic("typedEcho", {
        description: "Typed echo input",
        parameters: Schema.Struct({ text: Schema.String }),
      })
      type TypedTools = {
        readonly typedEcho: typeof typedEchoTool
      }
      const typedToolkit = {
        tools: { typedEcho: typedEchoTool },
        handle: (name) =>
          Effect.fail(
            AiError.make({
              module: "Test",
              method: "typedToolkit.handle",
              reason: new AiError.ToolConfigurationError({
                toolName: String(name),
                description: "unused in provider advertising test",
              }),
            }),
          ),
      } satisfies AiToolkit.WithHandler<TypedTools>
      let capturedToolkit: Option.Option<AiToolkit.WithHandler<TypedTools>> = Option.none()
      const streamingProvider: ModelDriverContribution = {
        id: "typed-toolkit-live",
        name: "TypedToolkitLive",
        resolveModel: () =>
          Effect.succeed(
            modelFromService(
              "typed-toolkit-live",
              makeLanguageModel<{
                readonly toolkit?: AiToolkit.WithHandler<TypedTools>
              }>({
                streamText: (options) => {
                  capturedToolkit = Option.fromUndefinedOr(options.toolkit)
                  return Stream.fromIterable([
                    toolCallPart(
                      "typedEcho",
                      { text: "hi" },
                      { toolCallId: ToolCallId.make("typed-tc-1") },
                    ),
                    finishPart({
                      finishReason: "tool-calls",
                      usage: { inputTokens: 1, outputTokens: 1 },
                    }),
                  ])
                },
              }),
            ),
          ),
      }
      const layer = buildProviderLayer([makeExt("typed-toolkit-live-ext", [streamingProvider])])
      const parts = yield* streamResolvedModel<TypedTools>({
        model: "typed-toolkit-live/gpt-5",
        prompt: [],
        toolkit: typedToolkit,
      }).pipe(Effect.provide(layer))
      expect(Option.isSome(capturedToolkit)).toBe(true)
      if (Option.isSome(capturedToolkit)) expect(capturedToolkit.value).toBe(typedToolkit)
      const collected = Array.from(parts)
      expect(collected[0]).toEqual(
        expect.objectContaining({
          type: "tool-call",
          name: "typedEcho",
          params: { text: "hi" },
        }),
      )
    }),
  )
  it.scoped("live stream path builds Effect Prompt with multimodal and reasoning parts", () =>
    Effect.gen(function* () {
      let capturedPrompt: Option.Option<Prompt.Prompt> = Option.none()
      const streamingProvider: ModelDriverContribution = {
        id: "prompt-live",
        name: "PromptLive",
        resolveModel: () =>
          Effect.succeed(
            modelFromService(
              "prompt-live",
              makeLanguageModel<{
                readonly prompt?: Prompt.RawInput
              }>({
                streamText: (options) => {
                  capturedPrompt = Option.some(Prompt.make(options.prompt ?? []))
                  return Stream.fromIterable([
                    finishPart({
                      finishReason: "stop",
                      usage: { inputTokens: 3, outputTokens: 1 },
                    }),
                  ])
                },
              }),
            ),
          ),
      }
      const layer = buildProviderLayer([makeExt("prompt-live-ext", [streamingProvider])])
      yield* Effect.gen(function* () {
        const parts = yield* streamResolvedModel({
          model: "prompt-live/gpt-5",
          prompt: toPrompt(
            [
              Message.cases.regular.make({
                id: MessageId.make("user-image"),
                sessionId: SessionId.make("prompt-session"),
                branchId: BranchId.make("prompt-branch"),
                role: "user",
                parts: [
                  Prompt.textPart({ text: "inspect" }),
                  Prompt.filePart({
                    data: "data:image/jpeg;base64,abc",
                    mediaType: "image/jpeg",
                  }),
                ],
                createdAt: dateFromMillis(0),
              }),
              Message.cases.regular.make({
                id: MessageId.make("assistant-reasoning"),
                sessionId: SessionId.make("prompt-session"),
                branchId: BranchId.make("prompt-branch"),
                role: "assistant",
                parts: [Prompt.reasoningPart({ text: "look at image metadata" })],
                createdAt: dateFromMillis(0),
              }),
              Message.cases.regular.make({
                id: MessageId.make("hidden"),
                sessionId: SessionId.make("prompt-session"),
                branchId: BranchId.make("prompt-branch"),
                role: "user",
                parts: [Prompt.textPart({ text: "should not reach model" })],
                createdAt: dateFromMillis(0),
                metadata: { hidden: true },
              }),
            ],
            { systemPrompt: ["System policy."] },
          ),
        })
        expect(parts.length).toBe(1)
      }).pipe(Effect.provide(layer))
      expect(Option.isSome(capturedPrompt)).toBe(true)
      if (Option.isNone(capturedPrompt)) return
      expect(capturedPrompt.value.content.map((message) => message.role)).toEqual([
        "system",
        "user",
        "assistant",
      ])
      const userMessage = capturedPrompt.value.content[1]
      expect(userMessage?.role).toBe("user")
      if (userMessage?.role === "user") {
        expect(userMessage.content[1]).toEqual(
          expect.objectContaining({
            type: "file",
            mediaType: "image/jpeg",
            data: "data:image/jpeg;base64,abc",
          }),
        )
      }
      const assistantMessage = capturedPrompt.value.content[2]
      expect(assistantMessage?.role).toBe("assistant")
      if (assistantMessage?.role === "assistant") {
        expect(assistantMessage.content[0]).toEqual(
          expect.objectContaining({
            type: "reasoning",
            text: "look at image metadata",
          }),
        )
      }
      expect(
        capturedPrompt.value.content.some((message) => {
          if (message.role === "user") {
            return message.content.some(
              (part) => part.type === "text" && part.text === "should not reach model",
            )
          }
          return false
        }),
      ).toBe(false)
    }),
  )
})

// ── shared sign-in ──────────────────────────────────────────────────────────

/**
 * Two drivers one account serves: `gateway-plus` uses `gateway`'s sign-in.
 * Each driver records the API key every call hands it (`none` for no stored
 * credential).
 */
const sharedSignInDrivers = (seen: Array<string>): ReadonlyArray<ModelDriverContribution> => {
  const keyOf = (auth?: ProviderAuthInfo) =>
    Option.fromUndefinedOr(auth).pipe(
      Option.flatMap((info) => {
        if (info._tag === "Api") return Option.some(info.key)
        return Option.none()
      }),
      Option.getOrElse(() => "none"),
    )
  const recording = (id: string, extra: Partial<ModelDriverContribution>) => ({
    id,
    name: id,
    resolveModel: (_name: string, auth?: ProviderAuthInfo) =>
      Effect.sync(() => {
        seen.push(`${id} model ${keyOf(auth)}`)
        return fakeResolution()
      }),
    listModels: (_catalog: ModelCatalogView, auth?: ProviderAuthInfo) =>
      Effect.sync(() => {
        seen.push(`${id} list ${keyOf(auth)}`)
        return [Model.make({ ...catalogModel(`${id}/judge`), kind: "classifier" })]
      }),
    resolveDecisionModel: (_name: string, auth?: ProviderAuthInfo) =>
      Effect.sync(() => seen.push(`${id} decision ${keyOf(auth)}`)).pipe(
        Effect.andThen(Effect.fail(new ProviderAuthError({ message: "recorded" }))),
      ),
    ...extra,
  })
  return [
    recording("gateway", {
      envCredential: "GATEWAY_KEY",
      auth: { methods: [AuthMethod.make({ type: "api", label: "Gateway key" })] },
    }),
    recording("gateway-plus", {
      credentialFrom: "gateway",
      envCredential: "GATEWAY_PLUS_KEY",
      auth: { methods: [AuthMethod.make({ type: "api", label: "Gateway Plus key" })] },
    }),
    recording("solo", {}),
  ]
}

const sharedSignInRegistry = (seen: Array<string>) =>
  Layer.merge(
    ExtensionRegistry.fromResolved(
      resolveExtensions([makeExt("shared-sign-in", [...sharedSignInDrivers(seen)])]),
    ),
    emptyCatalogLayer,
  )

/** Every read a turn, a catalog and both classifiers make, from a store holding `stored`. */
const readsWithStored = (stored: Record<string, string>) =>
  Effect.gen(function* () {
    const seen: Array<string> = []
    const seed = Object.fromEntries(
      Object.entries(stored).map(([id, key]) => [id, AuthApi.make({ type: "api", key })]),
    )
    const layer = Layer.mergeAll(
      ModelResolver.Live,
      DecisionModelResolver.Live,
      ModelCatalogRecord.Live,
    ).pipe(
      Layer.provideMerge(
        Layer.mergeAll(Auth.Test(seed), sharedSignInRegistry(seen), fixtureModelCatalogSource),
      ),
    )
    yield* Effect.gen(function* () {
      const resolver = yield* ModelResolver
      yield* resolver.resolve({ modelId: "gateway/m" })
      yield* resolver.resolve({ modelId: "gateway-plus/m" })
      yield* resolver.resolve({ modelId: "solo/m" })
      yield* modelCatalog()
      const classifiers = yield* DecisionModelResolver
      yield* Effect.exit((yield* classifiers.profile).resolve(Option.some("gateway/judge")))
      yield* Effect.exit((yield* classifiers.profile).resolve(Option.some("gateway-plus/judge")))
    }).pipe(Effect.provide(layer))
    return seen
  })

// ── chat aliases ────────────────────────────────────────────────────────────

const ALIAS_DRIVER = "alias-driver"

/**
 * A driver over the fixture's Anthropic entries that names `aliases`; it
 * records each model name it is asked to resolve.
 */
const aliasDriver = (
  aliases: Readonly<Record<string, string>>,
  resolvedNames: Array<string> = [],
): ModelDriverContribution => ({
  id: ALIAS_DRIVER,
  name: "Alias driver",
  catalogProvider: "anthropic",
  aliases,
  listModels: (catalog) =>
    Effect.succeed(
      Option.match(catalog.provider("anthropic"), {
        onNone: () => [],
        onSome: (provider) => provider.models.map((entry) => modelFromCatalog(ALIAS_DRIVER, entry)),
      }),
    ),
  resolveModel: (modelName) =>
    Effect.sync(() => {
      resolvedNames.push(modelName)
      return stubModel
    }),
})

/** A model's id and window, as a turn's metadata reads them. */
const idAndWindow = (model: Model) => ({ id: String(model.id), window: model.contextLength })

/** The model name a driver's `resolveModel` gets for `modelName`. */
const dispatchedName = (
  driver: ModelDriverContribution,
  resolvedNames: Array<string>,
  modelName: string,
) =>
  Effect.gen(function* () {
    yield* resolveDriverModel({
      driver,
      apiClasses: new Map(),
      modelName,
      auth: Option.none(),
      hints: Option.none(),
      catalog: fixtureModelCatalog(),
    })
    return resolvedNames.at(-1)
  })

describe("chat aliases", () => {
  it.scopedLive("an alias id reads the current model's metadata and dispatches as it", () =>
    Effect.gen(function* () {
      const resolvedNames: Array<string> = []
      const driver = aliasDriver({ "claude-old": "claude-sonnet-4-5" }, resolvedNames)
      const registry = yield* loadRegistryWithDrivers([driver])
      const metadata = yield* registry.get(`${ALIAS_DRIVER}/claude-old`)
      expect(Option.map(metadata, idAndWindow)).toEqual(
        Option.some({ id: `${ALIAS_DRIVER}/claude-sonnet-4-5`, window: 1_000_000 }),
      )
      expect(yield* dispatchedName(driver, resolvedNames, "claude-old")).toBe("claude-sonnet-4-5")
    }),
  )

  it.scopedLive(
    "an alias that equals a model id the driver's catalog lists is ignored: the real id wins for metadata and dispatch",
    () =>
      Effect.gen(function* () {
        const resolvedNames: Array<string> = []
        const driver = aliasDriver({ "claude-haiku-4-5": "claude-sonnet-4-5" }, resolvedNames)
        const registry = yield* loadRegistryWithDrivers([driver])
        const metadata = yield* registry.get(`${ALIAS_DRIVER}/claude-haiku-4-5`)
        expect(Option.map(metadata, idAndWindow)).toEqual(
          Option.some({ id: `${ALIAS_DRIVER}/claude-haiku-4-5`, window: 200_000 }),
        )
        expect(yield* dispatchedName(driver, resolvedNames, "claude-haiku-4-5")).toBe(
          "claude-haiku-4-5",
        )
      }),
  )

  it.live("a chat turn on an alias id runs with the current model's window", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        textStep("done"),
      ])
      const driverExtension = defineExtension({
        id: ALIAS_DRIVER,
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register("modelDriver", aliasDriver({ "claude-old": "claude-sonnet-4-5" }))
        }),
      })
      const { client, sessionId, branchId } = yield* createRpcHarness({
        providerLayer,
        agents: [
          AgentDefinition.make({
            name: DEFAULT_AGENT_NAME,
            model: ModelId.make(`${ALIAS_DRIVER}/claude-old`),
          }),
        ],
        extensionInputs: [driverExtension],
        models: "catalog",
      })
      const turn = yield* client.session.events({ sessionId, branchId }).pipe(
        Stream.map(({ event }) => event),
        Stream.takeUntil((event) => event._tag === "TurnCompleted"),
        Stream.runCollect,
        Effect.forkScoped,
      )
      yield* client.message.send({ sessionId, branchId, content: "hi" })
      const events = Array.from(yield* Fiber.join(turn))
      const errors = events.flatMap((event) => {
        if (event._tag !== "ErrorOccurred") return []
        return [event.error]
      })
      const windows = events.flatMap((event) => {
        if (event._tag !== "ModelContextProjected") return []
        return [event.contextLimitTokens]
      })
      expect(errors).toEqual([])
      expect(windows).toEqual([1_000_000])
      yield* controls.assertDone
    }).pipe(Effect.scoped, Effect.timeout("8 seconds")),
  )
})

describe("shared sign-in", () => {
  const rows = (stored: Record<string, AuthInfo>, required: ReadonlyArray<string>) =>
    listAuthProviders(required).pipe(
      Effect.map((providers) =>
        providers.map((row) => [String(row.provider), row.source ?? "none", row.required]),
      ),
      Effect.provide(Layer.merge(Auth.Test(stored), sharedSignInRegistry([]))),
    )

  it.live("one sign-in is listed for two drivers, required when either is", () =>
    Effect.gen(function* () {
      expect(yield* rows({}, ["gateway-plus"])).toEqual([
        ["gateway", "none", true],
        ["solo", "none", false],
      ])
      const methods = yield* listAuthMethods().pipe(
        Effect.provide(Layer.merge(Auth.Test({}), sharedSignInRegistry([]))),
      )
      expect(Object.keys(methods)).toEqual(["gateway"])
    }),
  )

  it.live("the row reads a key stored under either driver", () =>
    Effect.gen(function* () {
      const key = AuthApi.make({ type: "api", key: "sk-plus" })
      expect(yield* rows({ "gateway-plus": key }, [])).toEqual([
        ["gateway", "stored", false],
        ["solo", "none", false],
      ])
    }),
  )

  it.live(
    "the row is ready from env only when each driver that needs it reads a set variable",
    () =>
      Effect.gen(function* () {
        const withEnv = (env: Record<string, string>) => (required: ReadonlyArray<string>) =>
          rows({}, required).pipe(
            Effect.map((listed) => listed[0]),
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
          )
        const plusOnly = withEnv({ GATEWAY_PLUS_KEY: "sk-env" })
        expect(yield* plusOnly([])).toEqual(["gateway", "none", false])
        expect(yield* plusOnly(["gateway"])).toEqual(["gateway", "none", true])
        expect(yield* plusOnly(["gateway-plus"])).toEqual(["gateway", "env", true])
        expect(yield* plusOnly(["gateway", "gateway-plus"])).toEqual(["gateway", "none", true])
        const ownerOnly = withEnv({ GATEWAY_KEY: "sk-env" })
        expect(yield* ownerOnly([])).toEqual(["gateway", "env", false])
        expect(yield* ownerOnly(["gateway-plus"])).toEqual(["gateway", "none", true])
      }),
  )

  it.live("a driver naming a sharing driver, or a cycle, keeps a sign-in of its own", () =>
    Effect.gen(function* () {
      const driver = (id: string, credentialFrom: Option.Option<string>) => {
        const base: ModelDriverContribution = {
          id,
          name: id,
          resolveModel: () => Effect.succeed(fakeResolution()),
          auth: { methods: [AuthMethod.make({ type: "api", label: `${id} key` })] },
        }
        return Option.match(credentialFrom, {
          onNone: () => base,
          onSome: (owner) => ({ ...base, credentialFrom: owner }),
        })
      }
      const registry = ExtensionRegistry.fromResolved(
        resolveExtensions([
          makeExt("indirect", [
            driver("a", Option.some("b")),
            driver("b", Option.some("c")),
            driver("c", Option.none()),
            driver("x", Option.some("y")),
            driver("y", Option.some("x")),
          ]),
        ]),
      )
      const inRegistry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provide(Layer.mergeAll(Auth.Test({}), registry, emptyCatalogLayer)))
      const listed = yield* inRegistry(listAuthProviders(["a"]))
      expect(listed.map((row) => [String(row.provider), row.required])).toEqual([
        ["a", true],
        ["c", false],
        ["x", false],
        ["y", false],
      ])
      const methods = yield* inRegistry(listAuthMethods())
      expect(Object.keys(methods)).toEqual(["a", "c", "x", "y"])
    }),
  )

  it.live("one stored key serves both drivers' models, catalogs and classifiers", () =>
    Effect.gen(function* () {
      const reads = yield* readsWithStored({ gateway: "sk-one" })
      expect(reads.filter((read) => !read.includes("list"))).toEqual([
        "gateway model sk-one",
        "gateway-plus model sk-one",
        "solo model none",
        "gateway decision sk-one",
        "gateway-plus decision sk-one",
      ])
      // Which catalogs read which key, not how often or in what order.
      expect(new Set(reads.filter((read) => read.includes("list")))).toEqual(
        new Set(["gateway list sk-one", "gateway-plus list sk-one", "solo list none"]),
      )
    }).pipe(Effect.scoped),
  )

  it.live("a key stored for the sharing driver serves both until the owner has one", () =>
    Effect.gen(function* () {
      const legacy = yield* readsWithStored({ "gateway-plus": "sk-plus" })
      expect(legacy.filter((read) => !read.includes("list"))).toEqual([
        "gateway model sk-plus",
        "gateway-plus model sk-plus",
        "solo model none",
        "gateway decision sk-plus",
        "gateway-plus decision sk-plus",
      ])
      const both = yield* readsWithStored({ gateway: "sk-one", "gateway-plus": "sk-plus" })
      expect(both.slice(0, 2)).toEqual(["gateway model sk-one", "gateway-plus model sk-one"])
    }).pipe(Effect.scoped),
  )

  it.live("signing out removes every key the sign-in reads, and no other", () =>
    Effect.gen(function* () {
      const key = (value: string) => AuthApi.make({ type: "api", key: value })
      const stored = {
        gateway: key("sk-one"),
        "gateway-plus": key("sk-plus"),
        solo: key("sk-solo"),
      }
      const left = yield* Effect.gen(function* () {
        yield* removeSignIn("gateway")
        const auth = yield* Auth
        return yield* Effect.forEach(["gateway", "gateway-plus", "solo"], (id) =>
          Effect.map(auth.get(id), Option.fromUndefinedOr),
        )
      }).pipe(Effect.provide(Layer.merge(Auth.Test(stored), sharedSignInRegistry([]))))
      expect(left).toEqual([Option.none(), Option.none(), Option.some(key("sk-solo"))])
    }),
  )
})

describe("classifier availability", () => {
  /**
   * A classifier driver that lists its classifier only when it has a
   * credential (an authed remote list), counting its catalog runs.
   */
  const classifierDriver = (id: string, listed: Array<string>): ModelDriverContribution => ({
    id,
    name: id,
    resolveModel: () => Effect.succeed(fakeResolution()),
    listModels: (_catalog, authInfo) =>
      Effect.sync(() => {
        listed.push(id)
        if (Predicate.isUndefined(authInfo)) return []
        return [Model.make({ ...catalogModel(`${id}/jev-1`), kind: "classifier" })]
      }),
    resolveDecisionModel: () => Effect.fail(new ProviderAuthError({ message: "unused" })),
  })

  /** One availability answer per check; each check first stores the keys it names. */
  const available = (
    drivers: ReadonlyArray<ModelDriverContribution>,
    checks: ReadonlyArray<Record<string, string>>,
  ) =>
    Effect.gen(function* () {
      const registry = ExtensionRegistry.fromResolved(
        resolveExtensions([makeExt("classifiers", [...drivers])]),
      )
      return yield* Effect.gen(function* () {
        const resolver = yield* DecisionModelResolver
        const auth = yield* Auth
        const answers: Array<boolean> = []
        for (const keys of checks) {
          for (const [id, key] of Object.entries(keys)) {
            yield* auth.set(id, AuthApi.make({ type: "api", key }))
          }
          answers.push(yield* (yield* resolver.profile).hasCredential)
        }
        return answers
      }).pipe(
        Effect.provide(
          DecisionModelResolver.Live.pipe(
            Layer.provideMerge(Layer.mergeAll(Auth.Test({}), registry, fixtureModelCatalogSource)),
          ),
        ),
      )
    })

  it.live("a sign-in after the first check turns availability on", () =>
    Effect.gen(function* () {
      const judge = classifierDriver("judge", [])
      expect(yield* available([judge], [{}, { judge: "sk-judge" }])).toEqual([false, true])
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.live("a credential counts only for a driver that serves classifiers", () =>
    Effect.gen(function* () {
      const chat = makeProvider("chat")
      const judge = classifierDriver("judge", [])
      expect(yield* available([chat, judge], [{ chat: "sk-chat" }])).toEqual([false])
      expect(yield* available([chat, judge], [{ judge: "sk-judge" }])).toEqual([true])
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.live("availability reads no catalog, however many turns ask", () =>
    Effect.gen(function* () {
      const listed: Array<string> = []
      const judge = classifierDriver("judge", listed)
      expect(yield* available([judge], [{ judge: "sk-judge" }, {}, {}])).toEqual([true, true, true])
      expect(listed).toEqual([])
    }).pipe(Effect.timeout("4 seconds")),
  )
})

// ── classifier credential order ─────────────────────────────────────────────

describe("classifier credential order", () => {
  const personal = CredentialSlot.make("personal")
  const quotaSpent = AiError.make({
    module: "Judge",
    method: "decide",
    reason: new AiError.QuotaExhaustedError({}),
  })
  const networkFault = AiError.make({
    module: "Judge",
    method: "decide",
    reason: new AiError.NetworkError({
      reason: "TransportError",
      request: {
        method: "POST",
        url: "http://127.0.0.1/nonexistent/loop-probe-x",
        urlParams: [],
        headers: {},
      },
    }),
  })

  /**
   * One `models.decide` call through the live resolver, with `stored` keys
   * under the judge's sign-in and `order` as its `authOrder`. The judge
   * answers by the key it was built with; `asked` lists each key it got.
   */
  const decideWith = (params: {
    readonly order: ReadonlyArray<CredentialSlot>
    readonly stored: ReadonlyArray<readonly [CredentialSlot, string]>
    readonly failures: Readonly<Record<string, AiError.AiError>>
  }) =>
    Effect.gen(function* () {
      const asked: Array<string> = []
      const judge: ModelDriverContribution = {
        id: "judge",
        name: "Judge",
        resolveModel: () => Effect.succeed(fakeResolution()),
        listModels: () =>
          Effect.succeed([Model.make({ ...catalogModel("judge/jev-1"), kind: "classifier" })]),
        resolveDecisionModel: (_name, authInfo) => {
          let key = "env"
          if (authInfo?._tag === "Api") key = authInfo.key
          return Effect.succeed(
            Layer.effect(
              DecisionModel.DecisionModel,
              DecisionModel.make({
                decide: () =>
                  Effect.suspend(() => {
                    asked.push(key)
                    const failure = params.failures[key]
                    if (Predicate.isNotUndefined(failure)) return Effect.fail(failure)
                    return Effect.succeed({
                      answers: {
                        team: {
                          _tag: "Classify" as const,
                          label: "billing",
                          probabilities: { billing: 1, technical: 0 },
                          confidence: 0.9,
                        },
                      },
                      usage: { inputTokens: 1, outputTokens: 1 },
                    })
                  }),
              }),
            ),
          )
        },
      }
      const registry = ExtensionRegistry.fromResolved(
        resolveExtensions([makeExt("classifiers", [judge])]),
        Effect.succeed({ providers: { judge: { authOrder: params.order } } }),
      )
      const decided = yield* Effect.gen(function* () {
        const auth = yield* Auth
        for (const [slot, key] of params.stored) {
          yield* auth.set("judge", AuthApi.make({ type: "api", key }), slot)
        }
        const models = yield* makeExtensionModels
        return yield* Effect.exit(
          models.decide({
            definition: Decision.make({
              input: Schema.String,
              decisions: {
                team: Decision.classify({
                  instructions: "Which team",
                  criteria: { billing: "payments", technical: "bugs" },
                }),
              },
            }),
            input: "charged twice",
            model: "judge/jev-1",
          }),
        )
      }).pipe(
        Effect.provide(
          DecisionModelResolver.Live.pipe(
            Layer.provideMerge(Layer.mergeAll(Auth.Test({}), registry, fixtureModelCatalogSource)),
          ),
        ),
      )
      return { asked, decided }
    }).pipe(Effect.timeout("4 seconds"))

  it.live("a spent classifier credential hands the call to the next one of its order", () =>
    Effect.gen(function* () {
      const { asked, decided } = yield* decideWith({
        order: [DEFAULT_CREDENTIAL_SLOT, personal],
        stored: [
          [DEFAULT_CREDENTIAL_SLOT, "sk-a"],
          [personal, "sk-b"],
        ],
        failures: { "sk-a": quotaSpent },
      })
      expect(asked).toEqual(["sk-a", "sk-b"])
      expect(Exit.isSuccess(decided)).toBe(true)
    }),
  )

  it.live("any other classifier failure ends the call on its credential", () =>
    Effect.gen(function* () {
      const { asked, decided } = yield* decideWith({
        order: [DEFAULT_CREDENTIAL_SLOT, personal],
        stored: [
          [DEFAULT_CREDENTIAL_SLOT, "sk-a"],
          [personal, "sk-b"],
        ],
        failures: { "sk-a": networkFault },
      })
      expect(asked).toEqual(["sk-a"])
      expect(Exit.isFailure(decided)).toBe(true)
    }),
  )

  it.live("a classifier order of named credentials serves with no default and no environment", () =>
    Effect.gen(function* () {
      const { asked, decided } = yield* decideWith({
        order: [personal],
        stored: [[personal, "sk-b"]],
        failures: {},
      })
      expect(asked).toEqual(["sk-b"])
      expect(Exit.isSuccess(decided)).toBe(true)
    }),
  )
})

// ── scripted debug model ────────────────────────────────────────────────────

describe("Scripted debug model tool scenario", () => {
  /** A toolkit advertising `names`, as a turn's request does; the test resolves no call. */
  const advertisedTool = (name: string) => AiTool.dynamic(name, { parameters: Schema.Unknown })
  type Advertised = Record<string, ReturnType<typeof advertisedTool>>
  type Part = AiResponse.StreamPart<Advertised>
  const advertising = (names: ReadonlyArray<string>): AiToolkit.WithHandler<Advertised> => ({
    tools: Object.fromEntries(names.map((name) => [name, advertisedTool(name)])),
    handle: (name) =>
      Effect.fail(
        AiError.make({
          module: "Test",
          method: "advertising.handle",
          reason: new AiError.ToolConfigurationError({
            toolName: String(name),
            description: "unused",
          }),
        }),
      ),
  })
  /** The prompt of the scenario's step `done`: the user's ask, then `done` answered steps. */
  const promptAfter = (done: number, ask = "run the debug tools scenario"): Prompt.RawInput => [
    { role: "user", content: ask },
    ...Array.from({ length: done }, (_, step) => [
      {
        role: "assistant" as const,
        content: [{ type: "tool-call" as const, id: `s${step}`, name: "bash", params: {} }],
      },
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            id: `s${step}`,
            name: "bash",
            isFailure: false,
            result: {},
          },
        ],
      },
    ]).flat(),
  ]
  const step = (done: number, tools: ReadonlyArray<string>, ask?: string) =>
    Effect.gen(function* () {
      const model = yield* LanguageModel.LanguageModel
      const parts = yield* model
        .streamText({
          prompt: promptAfter(done, ask),
          toolkit: advertising(tools),
          disableToolCallResolution: true,
        })
        .pipe(Stream.runCollect)
      return Array.from(parts)
    }).pipe(Effect.provide(LanguageModelLayers.debug()))
  const callsOf = (parts: ReadonlyArray<Part>) =>
    parts.flatMap((part) => {
      if (part.type !== "tool-call") return []
      return [{ name: part.name, params: part.params }]
    })

  it.live("each step calls the advertised tools in turn, with reasoning first", () =>
    Effect.gen(function* () {
      const direct = ["read", "grep", "edit", "bash"]
      const steps = yield* Effect.forEach([0, 1, 2, 3, 4, 5], (done) => step(done, direct))
      expect(steps.map((parts) => parts[0]?.type)).toEqual(Array(6).fill("reasoning-delta"))
      expect(steps.map((parts) => callsOf(parts).map((call) => call.name))).toEqual([
        ["bash"],
        ["read", "read", "read"],
        ["grep"],
        ["edit"],
        ["bash"],
        [],
      ])
      expect(callsOf(steps[1] ?? []).map((call) => call.params)).toEqual([
        { path: "gent-debug-tools/a.ts" },
        { path: "gent-debug-tools/b.ts" },
        { path: "gent-debug-tools/c.ts" },
      ])
      const answer = steps[5]?.find((part) => part.type === "text-delta")
      expect(answer).toEqual(expect.objectContaining({ delta: expect.stringContaining("d.ts") }))
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.live("debug ask asks a background question, works on its assumption, then answers", () =>
    Effect.gen(function* () {
      const tools = ["ask_user_async", "bash"]
      const steps = yield* Effect.forEach([0, 1, 2], (done) => step(done, tools, "debug ask"))
      expect(steps.map((parts) => callsOf(parts).map((call) => call.name))).toEqual([
        ["ask_user_async"],
        ["bash"],
        [],
      ])
      expect(callsOf(steps[0] ?? [])[0]?.params).toEqual(
        expect.objectContaining({
          questions: [expect.objectContaining({ header: "cache", assume: "in-memory LRU" })],
        }),
      )
      const answer = steps[2]?.find((part) => part.type === "text-delta")
      expect(answer).toEqual(expect.objectContaining({ delta: expect.stringContaining("assumed") }))
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.live("debug threads starts two threads under their wire names, lists them, then answers", () =>
    Effect.gen(function* () {
      const tools = ["thread__start", "thread__list"]
      const steps = yield* Effect.forEach([0, 1, 2], (done) => step(done, tools, "debug threads"))
      expect(steps.map((parts) => callsOf(parts).map((call) => call.name))).toEqual([
        ["thread__start", "thread__start"],
        ["thread__list"],
        [],
      ])
      // The first thread plays the tool scenario in its own session.
      expect(callsOf(steps[0] ?? [])[0]?.params).toEqual(
        expect.objectContaining({ task: "debug tools" }),
      )
      const cell = callsOf(yield* step(0, ["cell"], "debug threads"))
      expect(cell[0]?.params).toEqual({
        code: expect.stringContaining("tools.thread.start({"),
      })
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.live("debug handoff asks for a handoff, then answers", () =>
    Effect.gen(function* () {
      const steps = yield* Effect.forEach([0, 1], (done) =>
        step(done, ["handoff"], "debug handoff"),
      )
      expect(steps.map((parts) => callsOf(parts).map((call) => call.name))).toEqual([
        ["handoff"],
        [],
      ])
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.live("a turn narrowed to cell runs each step's ops as cell code", () =>
    Effect.gen(function* () {
      const reads = callsOf(yield* step(1, ["cell"]))
      expect(reads).toEqual([
        {
          name: "cell",
          params: {
            code: 'await Promise.all([tools.read({"path":"gent-debug-tools/a.ts"}), tools.read({"path":"gent-debug-tools/b.ts"}), tools.read({"path":"gent-debug-tools/c.ts"})])',
          },
        },
      ])
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.live("the first step writes the prompt cache and a later one reads it", () =>
    Effect.gen(function* () {
      const usage = (parts: ReadonlyArray<Part>) =>
        parts.flatMap((part) => {
          if (part.type !== "finish") return []
          return [part.usage]
        })[0]
      const first = usage(yield* step(0, ["bash"]))
      const later = usage(yield* step(2, ["grep"]))
      expect(first?.inputTokens.cacheWrite).toBeGreaterThan(0)
      expect(later?.inputTokens.cacheRead).toBeGreaterThan(0)
    }).pipe(Effect.timeout("4 seconds")),
  )
})

// ── models.dev catalog source ───────────────────────────────────────────────

/**
 * The models.dev snapshot core keeps in SQLite: one blocking fetch with no
 * row, then reads from memory, revalidated in the background by ETag once an
 * hour. Every request goes to the fixture client, which counts them; the
 * virtual clock moves the hours.
 */

const CHAT = "api.json"
const DECISION = "api.json?type=decision"

/** A storage context that two catalog sources can share, as two processes share one database. */
const catalogStorage = Layer.build(testSqliteStorage)

/** A catalog source over `storage`, fetching through `http`. */
const catalogSourceOver = (
  storage: Context.Context<ModelCatalogSnapshotStorage>,
  http: Layer.Layer<HttpClient.HttpClient>,
) =>
  Layer.build(
    ModelCatalogSource.Live.pipe(Layer.provide(http), Layer.provide(Layer.succeedContext(storage))),
  ).pipe(Effect.map((context) => Context.get(context, ModelCatalogSource)))

/** A catalog source over fresh storage and the counting fixture client. */
const catalogRoot = Effect.gen(function* () {
  const fixture = yield* modelCatalogFixture
  const storage = yield* catalogStorage
  const source = yield* catalogSourceOver(storage, fixture.layer)
  return { fixture, storage, source }
})

/**
 * Let the background revalidation finish: the fixture client and SQLite
 * answer at once, so the forked fiber completes within a few yields.
 */
const settle = <A, E>(effect: Effect.Effect<A, E>, done: (value: A) => boolean) => {
  const loop = (left: number): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.filterOrElse(
        (value) => done(value) || left === 0,
        () => Effect.yieldNow.pipe(Effect.andThen(loop(left - 1))),
      ),
    )
  return loop(1_000)
}

const providerModelIds = (catalog: LoadedModelCatalog, providerId: string) =>
  Option.match(catalog.provider(providerId), {
    onNone: () => [],
    onSome: (provider) => provider.models.map((model) => model.id),
  })

const sourcesOf = (requests: ReadonlyArray<ModelCatalogFixtureRequest>) =>
  requests.map((request) => request.source).toSorted()

const encodeCatalogJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
// oxlint-disable-next-line effect/noNullish -- models.dev writes the "no reasoning" effort as null
const CATALOG_NULL = null

/** A body models.dev might serve next: one Anthropic model the fixture does not hold. */
const NEXT_CHAT_BODY = encodeCatalogJson({
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    models: { "claude-next": { name: "Claude Next", tool_call: true } },
  },
})

describe("models.dev catalog source", () => {
  it.scoped("the first read fetches each source once, and a read within the hour asks nobody", () =>
    Effect.gen(function* () {
      const { fixture, storage, source } = yield* catalogRoot

      const first = yield* source.read
      expect(providerModelIds(first, "anthropic")).toContain("claude-haiku-4-5")
      expect(Option.isNone(first.failure)).toBe(true)
      // The read starts the decision source's load too; it does not wait for it.
      yield* source.readWithDecisions
      expect(sourcesOf(yield* fixture.requests)).toEqual([CHAT, DECISION])
      expect((yield* fixture.requests).every((request) => Option.isNone(request.ifNoneMatch))).toBe(
        true,
      )

      yield* TestClock.adjust("59 minutes")
      yield* source.read
      expect(yield* fixture.requests).toHaveLength(2)

      const row = yield* Context.get(storage, ModelCatalogSnapshotStorage).get(CHAT)
      expect(Option.map(row, (stored) => stored.etag)).toEqual(
        Option.some(Option.some('"fixture-chat-1"')),
      )
    }),
  )

  it.scoped(
    "a read after the hour serves the snapshot and revalidates it with its ETag; a 304 moves only the check time",
    () =>
      Effect.gen(function* () {
        const { fixture, storage, source } = yield* catalogRoot
        yield* source.readWithDecisions
        yield* TestClock.adjust("2 hours")

        const stale = yield* source.read
        expect(providerModelIds(stale, "anthropic")).toContain("claude-haiku-4-5")
        const requests = yield* settle(fixture.requests, (list) => list.length === 4)
        expect(
          requests.slice(2).map((request) => [request.source, request.ifNoneMatch] as const),
        ).toEqual(
          expect.arrayContaining([
            [CHAT, Option.some('"fixture-chat-1"')],
            [DECISION, Option.some('"fixture-decision-1"')],
          ]),
        )
        const rows = Context.get(storage, ModelCatalogSnapshotStorage)
        const row = yield* settle(rows.get(CHAT), (stored) =>
          Option.exists(stored, (value) => value.checked_at > 0),
        )
        expect(Option.map(row, (stored) => [stored.fetched_at, stored.checked_at])).toEqual(
          Option.some([0, Duration.toMillis(Duration.hours(2))]),
        )
      }),
  )

  it.scoped("a 200 replaces the snapshot, and a body that does not parse is not stored", () =>
    Effect.gen(function* () {
      const { fixture, storage, source } = yield* catalogRoot
      yield* source.readWithDecisions
      const rows = Context.get(storage, ModelCatalogSnapshotStorage)
      const etag = rows.get(CHAT).pipe(Effect.map(Option.flatMap((stored) => stored.etag)))

      yield* fixture.serve(CHAT, NEXT_CHAT_BODY, '"next"')
      yield* TestClock.adjust("2 hours")
      yield* source.read
      yield* settle(etag, (value) => Option.contains(value, '"next"'))
      expect(providerModelIds(yield* source.read, "anthropic")).toEqual(["claude-next"])

      yield* fixture.serve(CHAT, "<html>maintenance</html>", '"broken"')
      yield* TestClock.adjust("2 hours")
      yield* source.read
      yield* settle(fixture.requests, (list) => list.length === 6)
      yield* settle(source.read, (catalog) => catalog.providerIds.length > 0)
      expect(yield* etag).toEqual(Option.some('"next"'))
      expect(providerModelIds(yield* source.read, "anthropic")).toEqual(["claude-next"])
    }),
  )

  it.scoped("a new process reads the stored snapshot and fetches nothing", () =>
    Effect.gen(function* () {
      const { fixture, storage, source } = yield* catalogRoot
      yield* source.readWithDecisions
      const restarted = yield* catalogSourceOver(storage, fixture.layer)

      const catalog = yield* restarted.read

      expect(providerModelIds(catalog, "anthropic")).toContain("claude-haiku-4-5")
      expect(yield* fixture.requests).toHaveLength(2)
    }),
  )

  it.scoped(
    "with no snapshot and models.dev offline, the catalog is unavailable, and a minute later it is fetched again",
    () =>
      Effect.gen(function* () {
        const { fixture, source } = yield* catalogRoot
        yield* fixture.offline(true)

        const offline = yield* source.readWithDecisions
        expect(offline.failure).toEqual(
          Option.some(
            "models.dev catalog unavailable: no snapshot stored and models.dev unreachable",
          ),
        )
        expect(offline.providerIds).toEqual([])

        // Inside the minute the failed source is not asked again.
        yield* fixture.offline(false)
        yield* source.read
        expect(yield* fixture.requests).toHaveLength(2)

        yield* TestClock.adjust("2 minutes")
        yield* source.read
        const online = yield* settle(source.read, (catalog) => Option.isNone(catalog.failure))
        expect(Option.isNone(online.failure)).toBe(true)
        expect(providerModelIds(online, "anthropic")).toContain("claude-haiku-4-5")
      }),
  )

  it.scoped("a snapshot no fetch has confirmed for a week reports its age", () =>
    Effect.gen(function* () {
      const { fixture, source } = yield* catalogRoot
      yield* source.readWithDecisions
      yield* fixture.offline(true)
      yield* TestClock.adjust("8 days")

      yield* source.read
      yield* settle(fixture.requests, (list) => list.length === 4)
      const old = yield* source.read

      expect(old.failure).toEqual(Option.some("models.dev catalog 8 days old, offline"))
      expect(providerModelIds(old, "anthropic")).toContain("claude-haiku-4-5")
    }),
  )

  it.scoped(
    "a read stopped during the first fetch stops only its wait; the next read gets that fetch's catalog",
    () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make(0)
        const reached = yield* Deferred.make<void>()
        const answer = yield* Deferred.make<void>()
        // models.dev answers only once the test lets it: the first read is still
        // waiting when its caller stops, as an Esc during the first turn does.
        const http = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.gen(function* () {
              yield* Ref.update(calls, (n) => n + 1)
              yield* Deferred.succeed(reached, void 0)
              yield* Deferred.await(answer)
              // The decision source is the one URL with a query.
              let source: keyof typeof MODEL_CATALOG_FIXTURE = CHAT
              if (new URL(request.url).search !== "") source = DECISION
              return HttpClientResponse.fromWeb(
                request,
                new Response(MODEL_CATALOG_FIXTURE[source].body, { status: 200 }),
              )
            }),
          ),
        )
        const source = yield* catalogSourceOver(yield* catalogStorage, http)

        const first = yield* Effect.forkChild(source.read)
        yield* Deferred.await(reached)
        yield* Fiber.interrupt(first)
        const next = yield* Effect.forkChild(source.read)
        yield* Deferred.succeed(answer, void 0)
        const catalog = yield* Fiber.join(next)

        expect(providerModelIds(catalog, "anthropic")).toContain("claude-haiku-4-5")
        // The stopped read's fetch went on and served the next read.
        expect(yield* Ref.get(calls)).toBe(2)
      }),
  )

  it.scoped(
    "a stored chat snapshot serves a read at once while the decision source, with no row, is fetched; a decision read waits for it",
    () =>
      Effect.gen(function* () {
        const storage = yield* catalogStorage
        yield* Context.get(storage, ModelCatalogSnapshotStorage).put({
          source: CHAT,
          body: MODEL_CATALOG_FIXTURE[CHAT].body,
          etag: Option.some(MODEL_CATALOG_FIXTURE[CHAT].etag),
          fetched_at: 0,
          checked_at: 0,
        })
        const requested = yield* Ref.make<ReadonlyArray<string>>([])
        const reached = yield* Deferred.make<void>()
        const answer = yield* Deferred.make<void>()
        // models.dev does not answer the decision source until the test lets it.
        const http = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.gen(function* () {
              const url = new URL(request.url)
              yield* Ref.update(requested, (list) => [
                ...list,
                `${url.pathname.replace(/^\/+/, "")}${url.search}`,
              ])
              yield* Deferred.succeed(reached, void 0)
              yield* Deferred.await(answer)
              return HttpClientResponse.fromWeb(
                request,
                new Response(MODEL_CATALOG_FIXTURE[DECISION].body, { status: 200 }),
              )
            }),
          ),
        )
        const source = yield* catalogSourceOver(storage, http)

        const chatRead = yield* Effect.forkChild(source.read)
        yield* Deferred.await(reached)
        const served = yield* settle(
          Effect.sync(() => chatRead.pollUnsafe()),
          Predicate.isNotUndefined,
        )
        const chat = yield* Option.getOrThrow(Option.fromUndefinedOr(served))
        expect(providerModelIds(chat, "anthropic")).toContain("claude-haiku-4-5")
        expect(providerModelIds(chat, "cloudflare-workers-ai")).not.toContain("@cf/cloudflare/clef")

        const decisionRead = yield* Effect.forkChild(source.readWithDecisions)
        yield* Effect.yieldNow
        expect(decisionRead.pollUnsafe()).toBeUndefined()
        yield* Deferred.succeed(answer, void 0)
        const decided = yield* Fiber.join(decisionRead)
        expect(providerModelIds(decided, "cloudflare-workers-ai")).toContain("@cf/cloudflare/clef")
        expect(providerModelIds(yield* source.read, "cloudflare-workers-ai")).toContain(
          "@cf/cloudflare/clef",
        )
        // The chat read started no second fetch of the source still loading.
        expect(yield* Ref.get(requested)).toEqual([DECISION])
      }),
  )

  it.effect("each catalog model carries the fields models.dev gives it, each decoded alone", () =>
    Effect.sync(() => {
      const catalog = modelCatalogFromBodies({
        chat: encodeCatalogJson({
          openai: {
            name: "OpenAI",
            env: ["OPENAI_API_KEY"],
            npm: "@ai-sdk/openai",
            models: {
              "gpt-6.1-sol": {
                name: "GPT-6.1 Sol",
                cost: { input: 1.25, output: 10, cache_read: 0.125 },
                limit: { context: 400_000, input: 272_000, output: 128_000 },
                release_date: "2026-07-24",
                tool_call: true,
                reasoning: true,
                temperature: false,
                reasoning_options: [
                  { type: "effort", values: [CATALOG_NULL, "low", "high"] },
                  { type: "budget_tokens", min: 1024 },
                  { type: "unknown-kind" },
                ],
                interleaved: { field: "reasoning_content" },
                modalities: { input: ["text", "image", "pdf"], output: ["text"] },
                // models.dev names the wire protocol `shape`.
                provider: { npm: "@ai-sdk/openai-compatible", ["shape"]: "completions" },
              },
              "text-only": { name: "Text only", modalities: { input: ["text"] } },
              // An odd field drops itself, never the model.
              odd: { name: 42, limit: "big", tool_call: "yes", modalities: { input: "image" } },
              "not-an-object": 7,
            },
          },
        }),
        decision: encodeCatalogJson({
          openai: { name: "OpenAI", models: { judge: { name: "Judge", type: "decision" } } },
        }),
      })
      const models = Option.getOrThrow(catalog.provider("openai")).models

      expect(models).toEqual([
        {
          id: "gpt-6.1-sol",
          name: "GPT-6.1 Sol",
          cost: { input: 1.25, output: 10, cacheRead: 0.125 },
          limit: { context: 400_000, input: 272_000, output: 128_000 },
          releaseDate: "2026-07-24",
          toolCall: true,
          reasoning: true,
          temperature: false,
          reasoningOptions: [
            { type: "effort", values: ["none", "low", "high"] },
            { type: "budget_tokens", min: 1024 },
          ],
          reasoningField: "reasoning_content",
          npm: "@ai-sdk/openai-compatible",
          protocol: "completions",
          imageInput: true,
        },
        { id: "text-only", name: "Text only", imageInput: false },
        { id: "odd", name: "odd" },
        // The decision source's models follow the chat models of the same provider.
        { id: "judge", name: "Judge", decision: true },
      ])
      // The model says whether it reads images; absent when the catalog does not say.
      expect(
        models.map((entry) => Option.fromUndefinedOr(modelFromCatalog("openai", entry).imageInput)),
      ).toEqual([Option.some(true), Option.some(false), Option.none(), Option.none()])
      expect(catalog.providerIds).toEqual(["openai"])
      expect(Option.isNone(catalog.provider("absent"))).toBe(true)
    }),
  )

  it.effect(
    "a catalog that is missing or old is reported under each driver that lists models",
    () =>
      Effect.gen(function* () {
        const lists = (id: string): ModelDriverContribution => ({
          id,
          name: id,
          resolveModel: unusedResolution,
          listModels: () => Effect.succeed([]),
        })
        const resolvesOnly: ModelDriverContribution = {
          id: "plain",
          name: "plain",
          resolveModel: unusedResolution,
        }
        const offline = {
          ...fixtureModelCatalog(),
          failure: Option.some("models.dev catalog 9 days old, offline"),
        }

        const listed = yield* listModelCatalog(
          {
            modelDrivers: new Map([
              ["openai", lists("openai")],
              ["anthropic", lists("anthropic")],
              ["plain", resolvesOnly],
            ]),
            apiClasses: new Map(),
          },
          offline,
        )

        expect(listed.failures).toEqual([
          { driverId: "openai", error: "models.dev catalog 9 days old, offline" },
          { driverId: "anthropic", error: "models.dev catalog 9 days old, offline" },
        ])
      }),
  )
})

// ── driver composition ──────────────────────────────────────────────────────

/**
 * Core composes a model of a driver that names an endpoint: the catalog
 * entry, the API class that speaks it, and the driver's endpoint. A class
 * here records each request it gets instead of building a model.
 */
describe("driver composition", () => {
  /** A gateway's catalog, as models.dev writes it: one package for the provider, others per model. */
  const gatewayCatalog = modelCatalogFromBodies({
    chat: encodeCatalogJson({
      gateway: {
        id: "gateway",
        name: "Gateway",
        env: ["GATEWAY_API_KEY"],
        npm: "@ai-sdk/openai-compatible",
        api: "https://gateway.test/v1",
        models: {
          chat: { name: "Chat", tool_call: true },
          responses: { name: "Responses", tool_call: true, provider: { npm: "@ai-sdk/openai" } },
          routed: {
            name: "Routed",
            tool_call: true,
            provider: { npm: "@ai-sdk/openai", ["shape"]: "completions" },
          },
          google: { name: "Google", tool_call: true, provider: { npm: "@ai-sdk/google" } },
          wide: { name: "Wide", tool_call: true, limit: { context: 1_000_000, output: 64_000 } },
        },
      },
    }),
    decision: encodeCatalogJson({
      gateway: {
        id: "gateway",
        npm: "@ai-sdk/openai-compatible",
        models: { judge: { name: "Judge", type: "decision", tool_call: false } },
      },
    }),
  })

  const recordingClass = (
    id: string,
    npm: ReadonlyArray<string>,
    protocols: ReadonlyArray<string>,
    seen: Array<ApiClassRequest>,
  ): ApiClassContribution => ({
    id,
    npm,
    protocols,
    promptCacheTtl: Option.none(),
    resolveModel: (request) =>
      Effect.sync(() => {
        seen.push(request)
        return AiModel.make(id, request.model.id, LanguageModelLayers.failing)
      }),
  })

  const gatewayDriver: ModelDriverContribution = {
    id: "gateway",
    name: "Gateway",
    endpoint: () =>
      Effect.succeed({
        apiKey: Option.some("gateway-key"),
        baseUrl: Option.none(),
        transformClient: Option.none(),
      }),
    resolveDecisionModel: () => Effect.die("no decision in these tests"),
    overrides: [
      {
        match: /^wide$/,
        patch: (entry) => ({ ...entry, limit: { ...entry.limit, context: 200_000 } }),
        receipt: "the gateway's docs name a 200k window",
      },
    ],
  }

  const classesSeeing = (seen: Array<ApiClassRequest>) =>
    new Map(
      [
        recordingClass("chat", ["@ai-sdk/openai-compatible"], ["completions"], seen),
        recordingClass("responses", ["@ai-sdk/openai"], ["responses"], seen),
      ].map((each) => [each.id, each] as const),
    )

  const resolve = (modelName: string, seen: Array<ApiClassRequest>) =>
    resolveDriverModel({
      driver: gatewayDriver,
      apiClasses: classesSeeing(seen),
      modelName,
      auth: Option.none(),
      hints: Option.none(),
      catalog: gatewayCatalog,
    })

  it.effect("an entry that names no package of its own takes its provider's package and URL", () =>
    Effect.sync(() => {
      const entry = (key: string) => catalogModelEntry(gatewayCatalog, "gateway", key)
      expect(Option.map(entry("chat"), (each) => [each.npm, each.api])).toEqual(
        Option.some(["@ai-sdk/openai-compatible", "https://gateway.test/v1"]),
      )
      expect(Option.map(entry("responses"), (each) => each.npm)).toEqual(
        Option.some("@ai-sdk/openai"),
      )
      expect(Option.isNone(entry("absent"))).toBe(true)
    }),
  )

  it.effect(
    "the class that speaks the entry's protocol wins over its package, and the package picks otherwise",
    () =>
      Effect.gen(function* () {
        const seen: Array<ApiClassRequest> = []
        const providers = yield* Effect.forEach(["chat", "responses", "routed"], (modelName) =>
          Effect.map(resolve(modelName, seen), (resolution) => resolution.provider),
        )
        expect(providers).toEqual(["chat", "responses", "chat"])
        // The endpoint's key, and the catalog's URL where the endpoint names none.
        expect(
          seen.map((request) => [
            request.providerId,
            Option.getOrNull(request.apiKey),
            Option.getOrNull(request.baseUrl),
          ]),
        ).toEqual([
          ["gateway", "gateway-key", "https://gateway.test/v1"],
          ["gateway", "gateway-key", "https://gateway.test/v1"],
          ["gateway", "gateway-key", "https://gateway.test/v1"],
        ])
      }),
  )

  it.effect(
    "a model no class speaks, a model the catalog does not list and a decision model fail as driver errors",
    () =>
      Effect.gen(function* () {
        const reason = (modelName: string) =>
          resolve(modelName, []).pipe(
            Effect.flip,
            Effect.map((error) => {
              if (error._tag !== "DriverError") return error.message
              return error.reason
            }),
          )
        expect(yield* reason("google")).toBe(
          'Gateway model "google" speaks the @ai-sdk/google wire format, which gent does not support',
        )
        expect(yield* reason("absent")).toBe(
          'Gateway model "absent" has no entry in the models.dev catalog',
        )
        expect(yield* reason("judge")).toContain("gateway/judge is a classifier model")
      }),
  )

  it.effect("an override patches the entry the class sees and the window core lists", () =>
    Effect.gen(function* () {
      const seen: Array<ApiClassRequest> = []
      yield* resolve("wide", seen)
      expect(seen.map((request) => request.model.limit?.context)).toEqual([200_000])

      const listed = yield* listModelCatalog(
        { modelDrivers: new Map([["gateway", gatewayDriver]]), apiClasses: classesSeeing([]) },
        gatewayCatalog,
      )
      expect(
        listed.models.map((model) => [model.id, model.kind ?? "chat", model.contextLength ?? 0]),
      ).toEqual([
        [ModelId.make("gateway/chat"), "chat", 0],
        [ModelId.make("gateway/responses"), "chat", 0],
        [ModelId.make("gateway/routed"), "chat", 0],
        [ModelId.make("gateway/wide"), "chat", 200_000],
        [ModelId.make("gateway/judge"), "classifier", 0],
      ])
    }),
  )
})

describe("generic providers", () => {
  /** Four catalog providers: two a class speaks, one it does not, one an adapter serves. */
  const genericChat = encodeCatalogJson({
    open: {
      id: "open",
      name: "Open",
      env: ["OPEN_API_KEY"],
      npm: "@ai-sdk/openai-compatible",
      api: "https://open.test/v1",
      models: {
        big: { name: "Big", tool_call: true, limit: { context: 100_000, output: 8_000 } },
        google: { name: "Google", tool_call: true, provider: { npm: "@ai-sdk/google" } },
      },
    },
    regional: {
      id: "regional",
      name: "Regional",
      env: ["REGION_ID", "REGIONAL_KEY"],
      npm: "@ai-sdk/openai-compatible",
      api: "https://${REGION_ID}.regional.test/v1",
      models: { small: { name: "Small", tool_call: true } },
    },
    unspoken: {
      id: "unspoken",
      name: "Unspoken",
      env: ["UNSPOKEN_KEY"],
      npm: "@ai-sdk/google",
      models: { g: { name: "G", tool_call: true } },
    },
    adapted: {
      id: "adapted",
      name: "Adapted",
      env: ["ADAPTED_KEY"],
      npm: "@ai-sdk/openai-compatible",
      models: { a: { name: "A", tool_call: true } },
    },
  })
  const genericCatalog = modelCatalogFromBodies({ chat: genericChat, decision: "{}" })

  const chatClass = (seen: Array<ApiClassRequest>): ApiClassContribution => ({
    id: "chat",
    npm: ["@ai-sdk/openai-compatible"],
    protocols: [],
    promptCacheTtl: Option.none(),
    resolveModel: (request) =>
      Effect.sync(() => {
        seen.push(request)
        return AiModel.make("chat", request.model.id, LanguageModelLayers.failing)
      }),
  })

  const adaptedDriver: ModelDriverContribution = {
    id: "adapted",
    name: "Adapted",
    envCredential: "ADAPTED_KEY",
    endpoint: () =>
      Effect.succeed({
        apiKey: Option.some("adapter-key"),
        baseUrl: Option.none(),
        transformClient: Option.none(),
      }),
  }

  interface Setup {
    readonly stored?: Record<string, AuthInfo>
    readonly env?: Record<string, string>
    readonly config?: ProviderConfig
    readonly seen?: Array<ApiClassRequest>
    /** The catalog in place of `genericCatalog`. */
    readonly catalog?: LoadedModelCatalog
    /** The catalog once the decision source is loaded too, in place of `catalog`. */
    readonly withDecisions?: LoadedModelCatalog
    /** Gets one entry each time a reader waits for the decision source. */
    readonly decisionReads?: Array<string>
  }

  const inProfile =
    (setup: Setup) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) => {
      const chat = setup.catalog ?? genericCatalog
      const catalogSource = Layer.succeed(
        ModelCatalogSource,
        ModelCatalogSource.of({
          read: Effect.succeed(chat),
          readWithDecisions: Effect.sync(() => {
            setup.decisionReads?.push("decisions")
            return setup.withDecisions ?? chat
          }),
        }),
      )
      const registry = ExtensionRegistry.fromResolved(
        resolveExtensions([
          {
            manifest: { id: ExtensionId.make("generic-test") },
            scope: "builtin",
            sourcePath: "test",
            contributions: {
              modelDrivers: [adaptedDriver],
              apiClasses: [chatClass(setup.seen ?? [])],
            },
          },
        ]),
        Effect.succeed(setup.config ?? {}),
      )
      const services = Layer.mergeAll(ModelResolver.Live, ModelCatalogRecord.Live).pipe(
        Layer.provideMerge(Layer.mergeAll(Auth.Test(setup.stored ?? {}), registry, catalogSource)),
        Layer.merge(ConfigProvider.layer(ConfigProvider.fromEnv({ env: setup.env ?? {} }))),
      )
      return Effect.provide(effect, services)
    }

  const rows = (setup: Setup) =>
    listAuthProviders([]).pipe(
      Effect.map((listed) => listed.map((row) => [String(row.provider), row.source ?? "none"])),
      inProfile(setup),
    )

  const searched = (setup: Setup) =>
    listCatalogProviders().pipe(
      Effect.map((found) => found.providers.map((row) => String(row.provider))),
      inProfile(setup),
    )

  const resolved = (modelId: string, setup: Setup) =>
    Effect.gen(function* () {
      const resolver = yield* ModelResolver
      return yield* resolver.resolve({ modelId })
    }).pipe(Effect.scoped, inProfile(setup))

  const resolveFailure = (modelId: string, setup: Setup) =>
    resolved(modelId, setup).pipe(
      Effect.flip,
      Effect.map((error) => error.message),
    )

  it.scopedLive(
    "present unsupported named OAuth cannot dispatch a generic API request with ambient authority",
    () =>
      Effect.gen(function* () {
        const seenUnsupported: Array<ApiClassRequest> = []
        return yield* Effect.gen(function* () {
          const auth = yield* Auth
          const resolver = yield* ModelResolver
          const personal = CredentialSlot.make("personal")
          const oauth = AuthInfo.cases.Oauth.make({
            type: "oauth",
            access: "fake-access",
            refresh: "fake-refresh",
            expires: 1,
          })
          yield* auth.set("open", oauth, personal)
          const blocked = yield* Effect.exit(
            resolver.resolve({ modelId: "open/big", credentialSlot: personal }),
          )
          expect(Exit.isFailure(blocked)).toBe(true)
          expect(seenUnsupported.length).toBe(0)
          if (Exit.isFailure(blocked))
            expect(
              Option.exists(Cause.findErrorOption(blocked.cause), Schema.is(ProviderAuthError)),
            ).toBe(true)
          // Omitted/default authority keeps its existing environment behavior, even for old OAuth markers.
          yield* auth.set("open", oauth)
          yield* resolver.resolve({ modelId: "open/big" })
          yield* resolver.resolve({
            modelId: "open/big",
            credentialSlot: CredentialSlot.make("default"),
          })
          yield* auth.set("open", AuthApi.make({ type: "api", key: "fake-personal-api" }), personal)
          yield* resolver.resolve({ modelId: "open/big", credentialSlot: personal })
          expect(seenUnsupported.length).toBe(3)
        }).pipe(inProfile({ env: { OPEN_API_KEY: "fake-ambient" }, seen: seenUnsupported }))
      }).pipe(Effect.timeout("5 seconds")),
  )
  // A turn reads the credentials its order names, the default with none: a
  // key stored only in another slot lists its row, and no model a turn
  // cannot serve, until the order names that slot.
  it.live("a named-only generic key serves models only once its order names the slot", () =>
    Effect.gen(function* () {
      const work = CredentialSlot.make("work")
      const listing = (setup: Setup) =>
        Effect.gen(function* () {
          const auth = yield* Auth
          yield* auth.set("open", AuthApi.make({ type: "api", key: "fake-work" }), work)
          const listed = yield* modelCatalog()
          const rows = yield* listAuthProviders([])
          return {
            models: listed.models
              .map((model) => String(model.id))
              .filter((id) => id.startsWith("open/")),
            row: rows.find((row) => row.provider === "open"),
          }
        }).pipe(inProfile(setup))
      const unordered = yield* listing({})
      expect(unordered.models).toEqual([])
      expect(unordered.row?.hasKey).toBe(false)
      expect(
        unordered.row?.credentials?.map((entry) => `${entry.slot}:${String(entry.hasKey)}`),
      ).toEqual(["default:false", "work:true"])
      const ordered = yield* listing({ config: { providers: { open: { authOrder: [work] } } } })
      expect(ordered.models).toEqual(["open/big"])
      // A turn walks the order: the sign-in is ready on the slot it names.
      expect(ordered.row?.hasKey).toBe(true)
      expect(ordered.row?.source).toBe("stored")
    }).pipe(Effect.timeout("5 seconds")),
  )
  it.live(
    "a provider is active with a key variable set, a stored key or a config entry; the search finds the rest a class speaks",
    () =>
      Effect.gen(function* () {
        const key = AuthApi.make({ type: "api", key: "sk-stored" })
        expect(yield* rows({})).toEqual([["adapted", "none"]])
        expect(yield* searched({})).toEqual(["open", "regional"])
        expect(yield* rows({ env: { OPEN_API_KEY: "sk-env" } })).toEqual([
          ["adapted", "none"],
          ["open", "env"],
        ])
        expect(yield* searched({ env: { OPEN_API_KEY: "sk-env" } })).toEqual(["regional"])
        // The variable of a base URL holds no key: it activates nothing.
        expect(yield* rows({ env: { REGION_ID: "eu" } })).toEqual([["adapted", "none"]])
        expect(yield* rows({ stored: { regional: key } })).toEqual([
          ["adapted", "none"],
          ["regional", "stored"],
        ])
        expect(yield* rows({ config: { providers: { regional: {} } } })).toEqual([
          ["adapted", "none"],
          ["regional", "none"],
        ])
        // A provider a turn routes through is listed, and required, with no key.
        const required = yield* listAuthProviders(["open"]).pipe(
          Effect.map((listed) => listed.map((row) => [String(row.provider), row.required])),
          inProfile({}),
        )
        expect(required).toEqual([
          ["adapted", false],
          ["open", true],
        ])
      }),
  )

  it.live("each ${VAR} of a base URL is a prompt of the sign-in", () =>
    Effect.gen(function* () {
      const found = yield* listCatalogProviders().pipe(inProfile({}))
      expect(
        found.methods["open"]?.map((method) => [
          method.label,
          Option.fromUndefinedOr(method.prompts),
        ]),
      ).toEqual([["Open API key", Option.none()]])
      expect(found.methods["regional"]?.map((method) => method.prompts)).toEqual([
        [{ key: "REGION_ID", label: "REGION_ID", env: "REGION_ID" }],
      ])
      // A set variable is not asked, as for an adapter's prompt.
      const withRegion = yield* listAuthMethods().pipe(
        inProfile({ env: { REGION_ID: "eu" }, config: { providers: { regional: {} } } }),
      )
      expect(withRegion["regional"]?.map((method) => method.prompts)).toEqual([[]])
    }),
  )

  it.live(
    "an active provider lists the models a class speaks and resolves with the stored key, then the variable",
    () =>
      Effect.gen(function* () {
        const listed = yield* modelCatalog().pipe(inProfile({ env: { OPEN_API_KEY: "sk-env" } }))
        // The registered drivers' models come first, then each generic provider's.
        expect(listed.models.map((model) => [model.id, model.contextLength ?? 0])).toEqual([
          [ModelId.make("adapted/a"), 0],
          [ModelId.make("open/big"), 100_000],
        ])
        const seen: Array<ApiClassRequest> = []
        yield* resolved("open/big", { env: { OPEN_API_KEY: "sk-env" }, seen })
        yield* resolved("open/big", {
          env: { OPEN_API_KEY: "sk-env" },
          stored: { open: AuthApi.make({ type: "api", key: "sk-stored" }) },
          seen,
        })
        expect(
          seen.map((request) => [
            request.providerId,
            Option.getOrNull(request.apiKey),
            Option.getOrNull(request.baseUrl),
          ]),
        ).toEqual([
          ["open", "sk-env", "https://open.test/v1"],
          ["open", "sk-stored", "https://open.test/v1"],
        ])
        expect(yield* resolveFailure("open/google", { env: { OPEN_API_KEY: "sk-env" } })).toContain(
          "speaks the @ai-sdk/google wire format, which gent does not support",
        )
        expect(yield* resolveFailure("open/big", {})).toBe(
          "Open credentials unavailable: no stored API key and no OPEN_API_KEY env var; sign in with /auth",
        )
      }),
  )

  it.live("a base URL variable is filled from the stored answer, then the variable", () =>
    Effect.gen(function* () {
      const seen: Array<ApiClassRequest> = []
      const answered = AuthApi.make({ type: "api", key: "sk", metadata: { REGION_ID: "eu" } })
      const bare = AuthApi.make({ type: "api", key: "sk" })
      yield* resolved("regional/small", { stored: { regional: answered }, seen })
      yield* resolved("regional/small", {
        stored: { regional: bare },
        env: { REGION_ID: "us" },
        seen,
      })
      expect(seen.map((request) => Option.getOrNull(request.baseUrl))).toEqual([
        "https://eu.regional.test/v1",
        "https://us.regional.test/v1",
      ])
      expect(yield* resolveFailure("regional/small", { stored: { regional: bare } })).toBe(
        "Regional needs REGION_ID: none stored with the sign-in and no REGION_ID env var; sign in again with /auth",
      )
    }),
  )

  /** Base URLs as models.dev writes Neon's (a variable holds the origin) and Infomaniak's (one path segment). */
  const urlCatalog = modelCatalogFromBodies({
    chat: encodeCatalogJson({
      gateway: {
        id: "gateway",
        name: "Gateway",
        env: ["GATEWAY_BASE_URL", "GATEWAY_KEY"],
        npm: "@ai-sdk/openai-compatible",
        api: "${GATEWAY_BASE_URL}/v1",
        models: { m: { name: "M", tool_call: true } },
      },
      product: {
        id: "product",
        name: "Product",
        env: ["PRODUCT_ID", "PRODUCT_KEY"],
        npm: "@ai-sdk/openai-compatible",
        api: "https://product.test/2/ai/${PRODUCT_ID}/openai/v1",
        models: { m: { name: "M", tool_call: true } },
      },
      regional: {
        id: "regional",
        name: "Regional",
        env: ["REGION_ID", "REGIONAL_KEY"],
        npm: "@ai-sdk/openai-compatible",
        api: "https://${REGION_ID}.regional.test/v1",
        models: { small: { name: "Small", tool_call: true } },
      },
    }),
    decision: "{}",
  })

  /** The base URL one model resolves with when `variable` holds `value`. */
  const baseUrlWith = (modelId: string, provider: string, variable: string, value: string) =>
    Effect.gen(function* () {
      const seen: Array<ApiClassRequest> = []
      const stored = { [provider]: AuthApi.make({ type: "api", key: "sk" }) }
      const outcome = yield* resolved(modelId, {
        catalog: urlCatalog,
        stored,
        env: { [variable]: value },
        seen,
      }).pipe(
        Effect.map(() => Option.getOrNull(seen[0]?.baseUrl ?? Option.none())),
        Effect.catch((error) => Effect.succeed(`failed: ${error.message}`)),
      )
      return outcome
    })

  // Neon's gateway URL is the user's own: the variable is a whole https
  // origin, kept as typed, never percent-encoded into a path.
  it.live(
    "a variable that begins a base URL takes a whole https URL; one with another scheme, a user or a query fails",
    () =>
      Effect.gen(function* () {
        const gateway = (value: string) =>
          baseUrlWith("gateway/m", "gateway", "GATEWAY_BASE_URL", value)
        expect(yield* gateway("https://gw.example.test")).toBe("https://gw.example.test/v1")
        expect(yield* gateway("https://gw.example.test/team/")).toBe(
          "https://gw.example.test/team/v1",
        )
        const refused =
          "failed: Gateway needs GATEWAY_BASE_URL as an https URL with no user, password, query or fragment; sign in again with /auth"
        for (const value of [
          "gw.example.test",
          "http://gw.example.test",
          "file:///etc/passwd",
          "https://user:secret@gw.example.test",
          "https://gw.example.test@evil.test",
          "https://gw.example.test/?next=https://evil.test",
          "https://gw.example.test#evil.test",
        ]) {
          expect(yield* gateway(value)).toBe(refused)
        }
      }),
  )

  // A variable inside a URL fills one host label or path segment: a value
  // cannot add a host, a user, a path or a query, so the key goes only to
  // the host the catalog and the user typed.
  it.live("a variable inside a base URL fills one component and cannot move the host", () =>
    Effect.gen(function* () {
      expect(yield* baseUrlWith("product/m", "product", "PRODUCT_ID", "1/../../x?y")).toBe(
        "https://product.test/2/ai/1%2F..%2F..%2Fx%3Fy/openai/v1",
      )
      expect(yield* baseUrlWith("regional/small", "regional", "REGION_ID", "eu-1")).toBe(
        "https://eu-1.regional.test/v1",
      )
      const refused =
        "failed: Regional base URL https://${REGION_ID}.regional.test/v1 is no valid URL once REGION_ID is filled; sign in again with /auth"
      for (const value of ["evil.test/steal?", "user@evil.test", "evil.test#"]) {
        expect(yield* baseUrlWith("regional/small", "regional", "REGION_ID", value)).toBe(refused)
      }
    }),
  )

  // URL parsing reads a bare trailing `?` or `#` as an empty query or
  // fragment, so the parsed URL alone cannot tell; `/v1` would land inside it.
  it.live("a variable that begins a base URL with a bare ? or # fails", () =>
    Effect.gen(function* () {
      const gateway = (value: string) =>
        baseUrlWith("gateway/m", "gateway", "GATEWAY_BASE_URL", value)
      const refused =
        "failed: Gateway needs GATEWAY_BASE_URL as an https URL with no user, password, query or fragment; sign in again with /auth"
      for (const value of [
        "https://gw.example.test?",
        "https://gw.example.test/team#",
        "https://gw.example.test/?#",
      ]) {
        expect(yield* gateway(value)).toBe(refused)
      }
      expect(yield* gateway("https://gw.example.test/team")).toBe("https://gw.example.test/team/v1")
    }),
  )

  // encodeURIComponent leaves dots alone, and URL parsing collapses a `.` or
  // `..` segment: `/2/ai/../openai/v1` would leave the product's path.
  it.live("a variable inside a base URL that is . or .. fails", () =>
    Effect.gen(function* () {
      const product = (value: string) => baseUrlWith("product/m", "product", "PRODUCT_ID", value)
      for (const value of [".", ".."]) {
        expect(yield* product(value)).toBe(
          `failed: Product needs PRODUCT_ID as one URL component, not "${value}"; sign in again with /auth`,
        )
      }
      expect(yield* product("...")).toBe("https://product.test/2/ai/.../openai/v1")
      expect(yield* product("team.1")).toBe("https://product.test/2/ai/team.1/openai/v1")
    }),
  )

  it.live(
    "a providers config entry adds a provider and patches a model's limits; disabledProviders hides one",
    () =>
      Effect.gen(function* () {
        const config: ProviderConfig = {
          providers: {
            open: { models: { big: { limit: { context: 200_000, output: 16_000 } } } },
            proxy: {
              name: "My proxy",
              class: "chat",
              api: "https://proxy.test/v1",
              env: ["PROXY_KEY"],
              headers: { "x-team": "core" },
              models: { m: { name: "M", tool_call: true } },
            },
          },
          disabledProviders: ["regional"],
        }
        const listed = yield* modelCatalog().pipe(inProfile({ config }))
        expect(
          listed.models.map((model) => [model.id, model.name, model.contextLength ?? 0]),
        ).toEqual([
          [ModelId.make("adapted/a"), "A", 0],
          [ModelId.make("open/big"), "Big", 200_000],
          [ModelId.make("proxy/m"), "M", 0],
        ])
        expect(yield* rows({ config })).toEqual([
          ["adapted", "none"],
          ["open", "none"],
          ["proxy", "none"],
        ])
        expect(yield* searched({ config })).toEqual([])

        const seen: Array<ApiClassRequest> = []
        yield* resolved("proxy/m", { config, env: { PROXY_KEY: "sk-proxy" }, seen })
        const request = seen[0]
        expect(request?.providerId).toBe("proxy")
        expect(Option.getOrNull(request?.apiKey ?? Option.none())).toBe("sk-proxy")
        expect(Option.getOrNull(request?.baseUrl ?? Option.none())).toBe("https://proxy.test/v1")
        // The config's headers go with every request.
        const sent = yield* Ref.make<Record<string, string>>({})
        const client = HttpClient.make((outgoing) =>
          Effect.as(
            Ref.set(sent, outgoing.headers),
            HttpClientResponse.fromWeb(outgoing, new Response("", { status: 200 })),
          ),
        )
        const transform = Option.flatMap(
          Option.fromUndefinedOr(request),
          (each) => each.transformClient,
        )
        expect(Option.isSome(transform)).toBe(true)
        if (Option.isSome(transform)) yield* transform.value(client).get("https://proxy.test/v1")
        expect((yield* Ref.get(sent))["x-team"]).toBe("core")

        expect(yield* resolveFailure("regional/small", { config })).toBe(
          "Unknown provider: regional",
        )
      }),
  )

  it.live(
    "an adapter's catalog provider resolves through the adapter, never a generic driver",
    () =>
      Effect.gen(function* () {
        const seen: Array<ApiClassRequest> = []
        yield* resolved("adapted/a", { env: { ADAPTED_KEY: "sk-env" }, seen })
        expect(seen.map((request) => Option.getOrNull(request.apiKey))).toEqual(["adapter-key"])
        expect(yield* searched({ env: { ADAPTED_KEY: "sk-env" } })).toEqual(["open", "regional"])
      }),
  )

  it.live(
    "a turn model the chat catalog lists resolves at once; one it lacks waits for the decision source, where a classifier runs no turn",
    () =>
      Effect.gen(function* () {
        const withDecisions = modelCatalogFromBodies({
          chat: genericChat,
          decision: encodeCatalogJson({
            adapted: {
              id: "adapted",
              name: "Adapted",
              models: { judge: { name: "Judge", type: "decision", tool_call: false } },
            },
          }),
        })
        const decisionReads: Array<string> = []
        const setup = { env: { ADAPTED_KEY: "sk-env" }, withDecisions, decisionReads }

        yield* resolved("adapted/a", setup)
        expect(decisionReads).toEqual([])

        expect(yield* resolveFailure("adapted/judge", setup)).toContain(
          "adapted/judge is a classifier model",
        )
        expect(decisionReads).toEqual(["decisions"])
      }),
  )
})

describe("named provider resolution", () => {
  it.scopedLive("named OAuth refresh retains its physical legacy alias and label", () =>
    Effect.gen(function* () {
      const auth = Context.get(yield* Layer.build(Auth.Test()), Auth)
      const slot = CredentialSlot.make("personal")
      const legacy = AuthApi.make({ type: "api", key: "fake-default" })
      yield* auth.set("alias-slot", legacy)
      yield* auth.set(
        "alias-slot",
        AuthInfo.cases.Oauth.make({
          type: "oauth",
          access: "fake-old",
          refresh: "fake-refresh",
          expires: 1,
        }),
        slot,
      )
      const owner: ModelDriverContribution = {
        id: "owner-slot",
        name: "Owner",
        resolveModel: () => Effect.succeed(fakeResolution()),
      }
      const alias: ModelDriverContribution = {
        id: "alias-slot",
        name: "Alias",
        credentialFrom: owner.id,
        resolveModel: (_model, info) =>
          Effect.gen(function* () {
            expect(info?.slot).toBe(slot)
            if (info?._tag !== "Oauth") return yield* Effect.die("expected named OAuth")
            yield* info.update((current) =>
              Effect.succeed([
                true,
                Option.map(current, (stored) => ({
                  ...stored,
                  access: "fake-new",
                  refresh: "fake-rotated",
                })),
              ] as const),
            )
            return fakeResolution()
          }),
      }
      yield* resolveModel({ model: "alias-slot/model", credentialSlot: slot }).pipe(
        Effect.provide(buildProviderLayer([makeExt("named-alias", [owner, alias])], auth)),
      )
      expect(Predicate.isUndefined(yield* auth.get(owner.id, slot))).toBe(true)
      expect(
        Option.exists(
          Option.fromUndefinedOr(yield* auth.get(alias.id, slot)),
          (stored) => stored.type === "oauth" && stored.refresh === "fake-rotated",
        ),
      ).toBe(true)
      expect(
        Option.exists(
          Option.fromUndefinedOr(yield* auth.get(alias.id)),
          (stored) => stored.type === "api" && stored.key === legacy.key,
        ),
      ).toBe(true)
    }).pipe(Effect.timeout("5 seconds")),
  )

  it.scopedLive("a conflicting canonical order fails its own sign-in and leaves the others", () =>
    Effect.gen(function* () {
      const owner = makeProvider("order-owner")
      const alias = { ...makeProvider("order-alias"), credentialFrom: owner.id }
      const other = makeProvider("order-other")
      const resolved = resolveExtensions([makeExt("order-alias", [owner, alias, other])])
      const first = CredentialSlot.make("default")
      const second = CredentialSlot.make("personal")
      const auth = Context.get(yield* Layer.build(Auth.Test()), Auth)
      yield* auth.set(owner.id, AuthApi.make({ type: "api", key: "fake-owner" }))
      yield* auth.set(other.id, AuthApi.make({ type: "api", key: "fake-other" }))
      const isConflict = (exit: Exit.Exit<unknown, unknown>) =>
        Exit.isFailure(exit) &&
        Option.exists(
          Cause.findErrorOption(exit.cause),
          (error) =>
            Schema.is(ProviderAuthError)(error) &&
            error.message.includes("Conflicting credential orders"),
        )
      for (const providers of [
        {
          "order-owner": { authOrder: [first, second] },
          "order-alias": { authOrder: [second, first] },
        },
        {
          "order-alias": { authOrder: [second, first] },
          "order-owner": { authOrder: [first, second] },
        },
      ]) {
        const registry = Layer.succeed(
          ExtensionRegistry,
          ExtensionRegistry.of({
            getResolved: () => resolved,
            providerConfig: Effect.succeed({ providers }),
          }),
        )
        const layer = Layer.provideMerge(
          ModelResolver.Live,
          Layer.mergeAll(Layer.succeed(Auth, auth), registry, fixtureModelCatalogSource),
        )
        const rows = yield* listAuthProviders([]).pipe(Effect.provide(layer))
        const ownerRow = rows.find((row) => row.provider === owner.id)
        expect(ownerRow?.hasKey).toBe(false)
        expect(ownerRow?.orderConflict).toEqual(["order-alias", "order-owner"])
        const otherRow = rows.find((row) => row.provider === other.id)
        expect(otherRow?.hasKey).toBe(true)
        expect(otherRow?.orderConflict).toBeUndefined()
        expect(
          isConflict(
            yield* Effect.exit(
              resolveModel({ model: "order-alias/model" }).pipe(Effect.provide(layer)),
            ),
          ),
        ).toBe(true)
        expect(
          isConflict(
            yield* Effect.exit(
              resolveModel({ model: "order-owner/model" }).pipe(Effect.provide(layer)),
            ),
          ),
        ).toBe(true)
        expect(
          Exit.isSuccess(
            yield* Effect.exit(
              resolveModel({ model: "order-other/model" }).pipe(Effect.provide(layer)),
            ),
          ),
        ).toBe(true)
        expect(
          isConflict(
            yield* Effect.exit(captureProviderLogin(owner.id, 0).pipe(Effect.provide(layer))),
          ),
        ).toBe(true)
        expect(
          Exit.isSuccess(
            yield* Effect.exit(captureProviderLogin(other.id, 0).pipe(Effect.provide(layer))),
          ),
        ).toBe(true)
      }
    }).pipe(Effect.scoped, Effect.timeout("5 seconds")),
  )

  it.scopedLive("a missing named slot cannot impersonate a default environment credential", () =>
    Effect.gen(function* () {
      const auth = Context.get(yield* Layer.build(Auth.Test()), Auth)
      let dispatched = false
      const driver: ModelDriverContribution = {
        id: "slot-env",
        name: "Slot Env",
        envCredential: "SLOT_ENV_KEY",
        resolveModel: () =>
          Effect.sync(() => {
            dispatched = true
            return fakeResolution()
          }),
      }
      const layer = buildProviderLayer([makeExt("slot-env", [driver])], auth)
      const result = yield* Effect.exit(
        resolveModel({
          model: "slot-env/model",
          credentialSlot: CredentialSlot.make("missing"),
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              layer,
              ConfigProvider.layer(ConfigProvider.fromEnv({ env: { SLOT_ENV_KEY: "fake-env" } })),
            ),
          ),
        ),
      )
      expect(Exit.isFailure(result)).toBe(true)
      expect(dispatched).toBe(false)
      yield* resolveModel({ model: "slot-env/model" }).pipe(Effect.provide(layer))
      expect(dispatched).toBe(true)
    }).pipe(Effect.timeout("5 seconds")),
  )
})
