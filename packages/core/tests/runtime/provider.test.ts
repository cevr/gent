import { describe, expect, it } from "effect-bun-test"
import {
  Array as Arr,
  Cause,
  Clock,
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
  Path,
  Predicate,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect"
import { TestClock } from "effect/testing"
import * as AiError from "effect/ai/AiError"
import {
  type ApiClassContribution,
  type ApiClassRequest,
  AuthMethod,
  type CredentialReceipt,
  type ProviderLanes,
  catalogModelEntry,
  credentialFailureMetadata,
  DEFAULT_RETRY_POLICY,
  isContextOverflow,
  type LaneReport,
  type ModelCatalogView,
  type ModelDriverContribution,
  modelFromCatalog,
  type PendingRotation,
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
  CredentialPlacement,
  DecisionModelResolver,
  removeSignIn,
  renameSignIn,
  listAuthMethods,
  limitResetAt,
  listCatalogProviders,
  makeCredentialPlacement,
  makeExtensionModels,
  rankPlacement,
  requestCredentialOrder,
  retryProviderCall,
  listModelCatalog,
  type LoadedModelCatalog,
  modelCatalogFromBodies,
  ModelCatalogRecord,
  ModelCatalogSource,
  ModelRegistry,
  modelCatalog,
  credentialLane,
  finishPart,
  ProviderLock,
  resolveDriverModel,
  retryReason,
  textStep,
  toolCallPart,
} from "../../src/runtime/provider"
import { BunProviderLockLive } from "../../src/runtime/gent-platform-bun"
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
import {
  BranchId,
  CredentialSlot,
  DEFAULT_CREDENTIAL_SLOT,
  ExtensionId,
  MessageId,
  SessionId,
  ToolCallId,
} from "../../src/domain/ids"
import { GentPlatform } from "../../src/runtime/gent-platform"
import { type ProviderConfig, RuntimeEnvironment } from "../../src/runtime/config"
import {
  defineExtension,
  ExtensionHost,
  tool,
  type ToolCapability,
} from "@gent/core/extensions/api"
import {
  createRpcHarness,
  fixtureModelCatalog,
  fixtureModelCatalogSource,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  MODEL_CATALOG_FIXTURE,
  modelCatalogFixture,
  type ModelCatalogFixtureRequest,
  resolvedRotationLock,
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
import { omitUndefined } from "../../src/domain/guards"

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
    retryProviderCall(config, Option.some, {
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
        retryProviderCall(fast, Option.some, {
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

  it.effect(
    "a retry notice reads a credential failure that may pass as its own text, and any other reason as the provider gives it",
    () =>
      Effect.sync(() => {
        const failed = (reason: AiError.AiErrorReason) =>
          new ProviderError({
            message: "OpenAiClient.createResponse failed",
            model: "test",
            cause: AiError.make({ module: "OpenAiClient", method: "createResponse", reason }),
          })
        // The shape a driver gives a refresh that may pass (`explainCredentialFailure`).
        const unavailable = "ChatGPT token endpoint unavailable: Token refresh failed: 503"
        const credential = new AiError.InternalProviderError({
          description: unavailable,
          metadata: credentialFailureMetadata(new ProviderAuthError({ message: unavailable })),
        })
        expect(credential.isRetryable).toBe(true)
        expect(retryReason(failed(credential))).toBe(unavailable)
        // A provider's own internal error keeps its reason, prefix and all.
        const internal = new AiError.InternalProviderError({ description: "upstream exploded" })
        expect(retryReason(failed(internal))).toBe(internal.message)
        expect(internal.message).toContain("upstream exploded")
        const limited = new AiError.RateLimitError({ retryAfter: Duration.zero })
        expect(retryReason(failed(limited))).toBe(limited.message)
        // An error with no AiError behind it reads as itself.
        expect(retryReason(new ProviderError({ message: "socket hang up", model: "test" }))).toBe(
          "socket hang up",
        )
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
      getRotation: () => Effect.fail(new AuthError({ message: "read failed" })),
      setRotation: () => Effect.void,
      moveRotationAside: () => Effect.fail(new AuthError({ message: "read failed" })),
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

/** The Bun host of `Auth.Live`: its file system and the provider lock file every process honors. */
const fileLockHost = Layer.provideMerge(BunProviderLockLive, BunServices.layer)
/** A host whose process is the only writer of its store: the provider lock stays in memory. */
const inProcessLockHost = Layer.merge(ProviderLock.InProcess, BunServices.layer)

describe("Auth", () => {
  describe("credential sign-in stamp", () => {
    // A cache the provider wrote is the credential's: the stamp tells a new
    // sign-in on the slot from a refresh of the same one, and follows a rename.
    it.effect(
      "a sign-in stamps the credential; a refresh and a rename keep it; a new sign-in does not",
      () =>
        Effect.gen(function* () {
          const auth = yield* Auth
          const personal = CredentialSlot.make("personal")
          const home = CredentialSlot.make("home")
          const oauth = (refresh: string) =>
            AuthInfo.cases.Oauth.make({ type: "oauth", access: "a", refresh, expires: 0 })
          const stampOf = (slot: CredentialSlot) =>
            auth.get("stamped", slot).pipe(Effect.map((info) => info?.signedInAt))
          yield* TestClock.adjust("1 second")
          yield* auth.set("stamped", oauth("first"), personal)
          expect(yield* stampOf(personal)).toBe(1_000)
          yield* TestClock.adjust("1 second")
          // The driver writes its refreshed token without a stamp of its own.
          yield* auth.update(
            "stamped",
            () => Effect.succeed(["refreshed", Option.some(oauth("refreshed"))] as const),
            personal,
          )
          expect(yield* stampOf(personal)).toBe(1_000)
          yield* auth.rename("stamped", personal, home)
          expect(yield* stampOf(personal)).toBeUndefined()
          expect(yield* stampOf(home)).toBe(1_000)
          yield* TestClock.adjust("1 second")
          yield* auth.set("stamped", oauth("again"), home)
          expect(yield* stampOf(home)).toBe(3_000)
          // A label in use, or one with nothing stored, moves nothing.
          yield* auth.set("stamped", oauth("work"), personal)
          expect(Exit.isFailure(yield* Effect.exit(auth.rename("stamped", home, personal)))).toBe(
            true,
          )
          expect(
            Exit.isFailure(
              yield* Effect.exit(auth.rename("stamped", CredentialSlot.make("none"), home)),
            ),
          ).toBe(true)
          expect(yield* stampOf(home)).toBe(3_000)
        }).pipe(Effect.provide(Auth.Test())),
    )
  })

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

    it.effect(
      "a rotation the store cannot write stays held in that store's memory, unseen by another store, until a write lands or it is forgotten",
      () =>
        Effect.gen(function* () {
          // One disk under two stores, as two gent processes open one auth
          // directory; its rotation writes fail while `failing` holds.
          const disk = new Map<string, PendingRotation>()
          const diskWrites: Array<string> = []
          let failing = true
          const access = {
            list: Effect.succeed([]),
            listSlots: () => Effect.succeed([]),
            get: () => Effect.succeed(noStoredAuth),
            set: () => Effect.void,
            remove: () => Effect.void,
            getRotation: (_provider: string, source: string) =>
              Effect.sync(() => Option.fromUndefinedOr(disk.get(source))),
            setRotation: (
              _provider: string,
              source: string,
              next: Option.Option<PendingRotation>,
            ) =>
              Effect.suspend(() => {
                if (failing) {
                  return Effect.fail(new AuthError({ message: "the disk refused the write" }))
                }
                diskWrites.push(
                  Option.match(next, { onNone: () => "remove", onSome: () => "hold" }),
                )
                if (Option.isSome(next)) disk.set(source, next.value)
                else disk.delete(source)
                return Effect.void
              }),
            moveRotationAside: () => Effect.die("the fake disk holds only what decodes"),
          }
          const store = serializeAuthStore(access)
          const other = serializeAuthStore(access)
          const source = "fake-source"
          const rotation = (token: string) => ({
            rotation: { access: token, refresh: `${token}-refresh`, expires: 1 },
            base: "fake-base",
          })
          const readOn = (on: AuthService) =>
            on.withRotation("anthropic", source, (held) => held.read)
          const writeOn = (on: AuthService, next: Option.Option<PendingRotation>) =>
            on.withRotation("anthropic", source, (held) => held.write(next))

          // The disk refuses: the write succeeds all the same, held in memory.
          yield* writeOn(store, Option.some(rotation("fake-r1")))
          expect(yield* readOn(store)).toEqual(Option.some(rotation("fake-r1")))
          expect(yield* readOn(other)).toEqual(Option.none())
          expect(disk.size).toBe(0)

          // The disk takes writes: the next one lands, and memory lets go of it.
          failing = false
          yield* writeOn(store, Option.some(rotation("fake-r2")))
          expect(disk.get(source)).toEqual(rotation("fake-r2"))
          expect(yield* readOn(other)).toEqual(Option.some(rotation("fake-r2")))
          // Another store forgets it on disk: this store holds nothing of its own.
          yield* writeOn(other, Option.none())
          expect(yield* readOn(store)).toEqual(Option.none())

          // A rotation on disk, a newer one held in memory over a failing disk.
          yield* writeOn(other, Option.some(rotation("fake-r3")))
          failing = true
          yield* writeOn(store, Option.some(rotation("fake-r4")))
          expect(yield* readOn(store)).toEqual(Option.some(rotation("fake-r4")))
          // Forgetting it clears the memory alone; the disk keeps what it holds.
          const writesBefore = diskWrites.length
          yield* writeOn(store, Option.none())
          expect(diskWrites.length).toBe(writesBefore)
          expect(disk.get(source)).toEqual(rotation("fake-r3"))
          expect(yield* readOn(store)).toEqual(Option.some(rotation("fake-r3")))
          // With nothing in memory, a forget reaches the disk, and its failure stays a failure.
          const failed = yield* Effect.exit(writeOn(store, Option.none()))
          expect(Exit.isFailure(failed)).toBe(true)
          expect(disk.get(source)).toEqual(rotation("fake-r3"))
        }),
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
      }).pipe(Effect.provide(fileLockHost), Effect.timeout("5 seconds")),
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
        }).pipe(Effect.provide(fileLockHost), Effect.timeout("5 seconds")),
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
      }).pipe(Effect.provide(fileLockHost), Effect.timeout("5 seconds")),
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
      }).pipe(Effect.provide(fileLockHost), Effect.timeout("5 seconds")),
    )

    it.scopedLive(
      "a held rotation is a file of its own keyed by its source, owner-only, shared by every store over the directory, and never discarded",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const dir = yield* fs.makeTempDirectoryScoped()
          const auth = Context.get(yield* Layer.build(Auth.Live(dir)), Auth)
          const source = "60475e44c7992da8758ab6b20d184256ebbae977bbd313d882c36f8adb6d9052"
          const file = `${dir}/.rotations/anthropic/${source}`
          const rotation = {
            rotation: { access: "fake-held", refresh: "fake-held-refresh", expires: 1 },
            base: "fake-base",
          }
          const readHeld = (store: typeof auth) =>
            store.withRotation("anthropic", source, (held) => held.read)
          yield* auth.withRotation("anthropic", source, (held) => held.write(Option.some(rotation)))
          expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600)
          // Another store over the directory, as another gent process opens it, reads it.
          const other = Context.get(yield* Layer.build(Auth.Live(dir)), Auth)
          expect(yield* readHeld(other)).toEqual(Option.some(rotation))
          // It is no credential entry.
          expect(yield* auth.list).toEqual([])
          expect(yield* auth.listSlots("anthropic")).toEqual([])
          // One that does not decode fails the read and stays: it may be a login's only live token.
          yield* fs.writeFileString(file, "{torn")
          const failure = yield* Effect.flip(readHeld(auth))
          expect(failure._tag).toBe("HeldRotationUndecodable")
          expect(yield* fs.readFileString(file)).toBe("{torn")
          yield* other.withRotation("anthropic", source, (held) => held.write(Option.none()))
          expect(yield* fs.exists(file)).toBe(false)
          expect(yield* readHeld(auth)).toEqual(Option.none())
        }).pipe(Effect.provide(fileLockHost), Effect.timeout("5 seconds")),
    )

    it.scopedLive(
      "a held rotation that does not decode fails its read naming its file, and is moved aside byte for byte, never deleted",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const dir = yield* fs.makeTempDirectoryScoped()
          const auth = Context.get(yield* Layer.build(Auth.Live(dir)), Auth)
          const source = "60475e44c7992da8758ab6b20d184256ebbae977bbd313d882c36f8adb6d9052"
          const file = path.resolve(dir, ".rotations", "anthropic", source)
          yield* auth.withRotation("anthropic", source, (held) =>
            held.write(
              Option.some({
                rotation: { access: "fake-held", refresh: "fake-held-refresh", expires: 1 },
                base: "fake-base",
              }),
            ),
          )
          // Torn in place: the file keeps the owner-only mode its write gave it.
          yield* fs.writeFileString(file, "{torn")
          const readHeld = auth.withRotation("anthropic", source, (held) => held.read)
          const failure = yield* Effect.flip(readHeld)
          if (failure._tag !== "HeldRotationUndecodable") {
            return yield* Effect.die(`expected HeldRotationUndecodable, got ${failure._tag}`)
          }
          expect(failure.file).toBe(file)
          expect(path.isAbsolute(failure.file)).toBe(true)
          expect(failure.message).toContain(file)
          const aside = yield* auth.withRotation("anthropic", source, (held) =>
            held.moveAside(Option.some("fake-login-fingerprint")),
          )
          expect(path.dirname(aside)).toBe(path.dirname(file))
          expect(aside.startsWith(`${file}.undecodable-`)).toBe(true)
          expect(yield* fs.readFileString(aside)).toBe("{torn")
          expect((yield* fs.stat(aside)).mode & 0o777).toBe(0o600)
          // The record of it sits at the file's place, saved in the same step.
          expect(yield* readHeld).toEqual(
            Option.some({ quarantined: { base: "fake-login-fingerprint", file: aside } }),
          )
          expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600)
          // A source signed out keeps no record: the bytes are moved aside, and stay.
          yield* fs.writeFileString(file, "{torn again")
          const second = yield* auth.withRotation("anthropic", source, (held) =>
            held.moveAside(Option.none()),
          )
          expect(yield* fs.readFileString(second)).toBe("{torn again")
          expect(yield* fs.exists(file)).toBe(false)
          expect(yield* readHeld).toEqual(Option.none())
          expect(yield* fs.readFileString(aside)).toBe("{torn")
        }).pipe(Effect.provide(fileLockHost), Effect.timeout("5 seconds")),
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
        }).pipe(Effect.provide(fileLockHost), Effect.timeout("5 seconds")),
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
        }).pipe(Effect.provide(fileLockHost), Effect.timeout("5 seconds")),
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
        // The stored file is the credential and the time it was signed in.
        const file = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.toCodecJson(AuthInfo)),
        )(yield* fs.readFileString(dir + "/.slots/openai/personal"))
        expect(file).toMatchObject(named)
        expect(Predicate.isNumber(file.signedInAt)).toBe(true)
        expect((yield* fs.stat(dir + "/.slots/openai/personal")).mode & 0o777).toBe(0o600)
        yield* auth.remove("openai", personal)
        expect(
          Option.exists(
            Option.fromUndefinedOr(yield* auth.get("openai")),
            (info) => info.type === "api" && info.key === legacy.key,
          ),
        ).toBe(true)
      }).pipe(Effect.provide(fileLockHost), Effect.timeout("5 seconds")),
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
      }).pipe(Effect.provide(fileLockHost), Effect.timeout("5 seconds")),
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
      }).pipe(Effect.provide(fileLockHost), Effect.timeout("5 seconds")),
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
      }).pipe(Effect.provide(fileLockHost)),
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
        expect(stored[0]).toMatchObject(withAnswers)
        expect(reread).toEqual(stored[0])
        expect(stored[1]).toEqual(AuthInfo.cases.Api.make({ type: "api", key: "sk-older" }))
      }).pipe(Effect.provide(fileLockHost)),
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
      }).pipe(Effect.provide(fileLockHost)),
    )

    // Two stores over one directory stand for two gent processes: each has
    // its own in-process lock, so only the host's `ProviderLock` orders them.
    // The Bun host takes a lock file every process honors; a host that is the
    // only writer of its store orders its stores in memory.
    for (const [lock, host] of [
      ["the lock file", fileLockHost],
      ["the in-process provider lock", inProcessLockHost],
    ] as const)
      it.scopedLive(`updates from two stores over one directory run one at a time: ${lock}`, () =>
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
        }).pipe(Effect.provide(host), Effect.timeout("5 seconds")),
      )

    it.scopedLive(
      "a provider lock that times out reaches a driver as a busy store, not a failed credential",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const dir = yield* fs.makeTempDirectoryScoped()
          // Two stores over one directory, as two gent processes: only the lock file orders them.
          const holder = Context.get(yield* Layer.build(Auth.Live(dir)), Auth)
          let polls = 0
          // The waiter's lock file host makes no directory (the holder made
          // it), so each poll runs without I/O between two clock steps; it is
          // a host of its own, not the one the holder's store shares.
          const pollsOnTheClock = Layer.fresh(BunProviderLockLive).pipe(
            Layer.provide(
              Layer.succeed(FileSystem.FileSystem, {
                ...fs,
                makeDirectory: () =>
                  Effect.sync(() => {
                    polls++
                  }),
              }),
            ),
          )
          const waiter = Context.get(
            yield* Layer.build(Auth.Live(dir).pipe(Layer.provide(pollsOnTheClock))),
            Auth,
          )
          yield* holder.set(
            "anthropic",
            AuthInfo.cases.Oauth.make({
              type: "oauth",
              access: "fake-access",
              refresh: "fake-refresh",
              expires: 0,
            }),
          )
          // The lock the resolver hands a driver with the waiter's sign-in
          // (`ProviderAuthInfo.Oauth.lockSourceRotation`).
          const lock = yield* resolvedRotationLock("anthropic").pipe(
            Effect.provideService(Auth, waiter),
          )
          polls = 0
          const source = "fake-source"
          const holding = yield* Deferred.make<boolean>()
          const release = yield* Deferred.make<boolean>()
          const held = yield* holder
            .withRotation("anthropic", source, () =>
              Deferred.succeed(holding, true).pipe(Effect.andThen(Deferred.await(release))),
            )
            .pipe(Effect.forkScoped)
          yield* Deferred.await(holding)
          let ran = false
          const waited = yield* Deferred.make<boolean>()
          const waiting = yield* lock(source)(() =>
            Effect.sync(() => {
              ran = true
            }),
          ).pipe(Effect.exit, Effect.ensuring(Deferred.succeed(waited, true)), Effect.forkScoped)
          // The waiter polls the lock file on the clock, past its whole wait.
          for (let step = 0; step < 120 && !(yield* Deferred.isDone(waited)); step++) {
            yield* TestClock.adjust("1 second")
          }
          const exit = yield* Fiber.join(waiting)
          expect(polls).toBeGreaterThan(1)
          yield* Deferred.succeed(release, true)
          yield* Fiber.join(held)
          expect(ran).toBe(false)
          if (Exit.isSuccess(exit)) return yield* Effect.die("the waiter took a held lock")
          const failure = Cause.findErrorOption(exit.cause)
          expect(Option.map(failure, (error) => error._tag)).toEqual(
            Option.some("CredentialStoreBusy"),
          )
          expect(Option.exists(failure, (error) => error.message.includes("busy"))).toBe(true)
        }).pipe(
          Effect.provide(Layer.merge(fileLockHost, TestClock.layer())),
          Effect.timeout("20 seconds"),
        ),
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
        expect(read).toMatchObject(AuthInfo.cases.Api.make({ type: "api", key: "sk-new" }))
      }).pipe(Effect.provide(fileLockHost), Effect.timeout("5 seconds")),
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
          expect(read).toMatchObject(AuthInfo.cases.Api.make({ type: "api", key: "sk-written" }))
          expect(yield* fs.exists(`${dir}/openai`)).toBe(true)
        }).pipe(Effect.provide(fileLockHost), Effect.timeout("5 seconds")),
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
      }).pipe(Effect.provide(fileLockHost), Effect.timeout("10 seconds")),
    )

    it.scopedLive("stores a credential readable only by its owner", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const auth = Context.get(yield* Layer.build(Auth.Live(dir)), Auth)
        yield* auth.set("openai", AuthInfo.cases.Api.make({ type: "api", key: "sk-secret" }))
        expect(((yield* fs.stat(`${dir}/openai`)).mode & 0o777).toString(8)).toBe("600")
      }).pipe(Effect.provide(fileLockHost), Effect.timeout("5 seconds")),
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
      getRotation: () => Effect.succeedNone,
      setRotation: () => Effect.fail(new AuthError({ message: "write failed" })),
      moveRotationAside: () => Effect.fail(new AuthError({ message: "write failed" })),
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
  getRotation: () => Effect.succeedNone,
  setRotation: () => Effect.void,
  moveRotationAside: () => Effect.fail(new AuthError({ message: "no rotation file" })),
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
  const judgeRateLimited = (retryAfter: Duration.Duration) =>
    AiError.make({
      module: "Judge",
      method: "decide",
      reason: new AiError.RateLimitError({ retryAfter }),
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
    /** The caller's deadline for the call (`models.decide` `timeoutMs`). */
    readonly timeoutMs?: number
  }) =>
    Effect.gen(function* () {
      const asked: Array<string> = []
      const judge: ModelDriverContribution = {
        id: "judge",
        name: "Judge",
        resolveModel: () => Effect.succeed(fakeResolution()),
        // Each key lists the judge at its own price: sk-b's is a hundred times sk-a's.
        listModels: (_catalog, authInfo) => {
          let price = 1
          if (authInfo?._tag === "Api" && authInfo.key === "sk-b") price = 100
          return Effect.succeed([
            Model.make({
              ...catalogModel("judge/jev-1"),
              kind: "classifier",
              pricing: { input: price, output: price },
            }),
          ])
        },
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
                        // oxlint-disable-next-line effect/preferTaggedConstructors -- the raw provider answer DecisionModel.make validates; effect/ai's ProviderClassifyAnswer has no constructor
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
            ...omitUndefined({ timeoutMs: params.timeoutMs }),
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

  it.live("a classifier call is priced as the credential that answered lists it", () =>
    Effect.gen(function* () {
      const { decided } = yield* decideWith({
        order: [DEFAULT_CREDENTIAL_SLOT, personal],
        stored: [
          [DEFAULT_CREDENTIAL_SLOT, "sk-a"],
          [personal, "sk-b"],
        ],
        failures: { "sk-a": quotaSpent },
      })
      // One input and one output token at sk-b's 100 dollars per million each.
      expect(Exit.isSuccess(decided) && decided.value.costUsd).toBeCloseTo(0.0002, 10)
      const first = yield* decideWith({
        order: [DEFAULT_CREDENTIAL_SLOT, personal],
        stored: [
          [DEFAULT_CREDENTIAL_SLOT, "sk-a"],
          [personal, "sk-b"],
        ],
        failures: {},
      })
      expect(Exit.isSuccess(first.decided) && first.decided.value.costUsd).toBeCloseTo(0.000002, 10)
    }),
  )

  it.live(
    "a rate limit that clears soon gets one more try on its credential before the call moves",
    () =>
      Effect.gen(function* () {
        const soon = yield* decideWith({
          order: [DEFAULT_CREDENTIAL_SLOT, personal],
          stored: [
            [DEFAULT_CREDENTIAL_SLOT, "sk-a"],
            [personal, "sk-b"],
          ],
          failures: { "sk-a": judgeRateLimited(Duration.millis(10)) },
        })
        expect(soon.asked).toEqual(["sk-a", "sk-a", "sk-b"])
        expect(Exit.isSuccess(soon.decided)).toBe(true)
        // A reset past the driver's retry cap moves the call at once.
        const later = yield* decideWith({
          order: [DEFAULT_CREDENTIAL_SLOT, personal],
          stored: [
            [DEFAULT_CREDENTIAL_SLOT, "sk-a"],
            [personal, "sk-b"],
          ],
          failures: { "sk-a": judgeRateLimited(Duration.hours(1)) },
        })
        expect(later.asked).toEqual(["sk-a", "sk-b"])
      }),
  )

  it.live("a rate limit that clears after the caller's deadline moves the call at once", () =>
    Effect.gen(function* () {
      // The reset is within the driver's retry cap, but past what is left of
      // the caller's deadline: a wait would end the call with no answer.
      const { asked, decided } = yield* decideWith({
        order: [DEFAULT_CREDENTIAL_SLOT, personal],
        stored: [
          [DEFAULT_CREDENTIAL_SLOT, "sk-a"],
          [personal, "sk-b"],
        ],
        failures: { "sk-a": judgeRateLimited(Duration.seconds(2)) },
        timeoutMs: 500,
      })
      expect(asked).toEqual(["sk-a", "sk-b"])
      expect(Exit.isSuccess(decided)).toBe(true)
      // A reset before the deadline that leaves the retry less time than the
      // wait moves at once too: the retry would race the deadline for its answer.
      const close = yield* decideWith({
        order: [DEFAULT_CREDENTIAL_SLOT, personal],
        stored: [
          [DEFAULT_CREDENTIAL_SLOT, "sk-a"],
          [personal, "sk-b"],
        ],
        failures: { "sk-a": judgeRateLimited(Duration.millis(1_500)) },
        timeoutMs: 2_000,
      })
      expect(close.asked).toEqual(["sk-a", "sk-b"])
      expect(Exit.isSuccess(close.decided)).toBe(true)
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

  it.live(
    "debug delegate starts one delegate thread that plays the tool scenario, then answers",
    () =>
      Effect.gen(function* () {
        const tools = ["thread__start"]
        const steps = yield* Effect.forEach([0, 1], (done) => step(done, tools, "debug delegate"))
        expect(steps.map((parts) => callsOf(parts).map((call) => call.name))).toEqual([
          ["thread__start"],
          [],
        ])
        // The thread's own turn holds `debug tools`, so it runs real tools in its
        // session; its round end comes back to the starter.
        expect(callsOf(steps[0] ?? [])[0]?.params).toEqual({
          task: expect.stringContaining("debug tools"),
          agent: "delegate",
          notify: "starter",
        })
      }).pipe(Effect.timeout("4 seconds")),
  )

  it.live("debug machine defines a one-command machine, starts it, then answers", () =>
    Effect.gen(function* () {
      const tools = ["machine__define", "machine__start"]
      const steps = yield* Effect.forEach([0, 1, 2], (done) => step(done, tools, "debug machine"))
      expect(steps.map((parts) => callsOf(parts).map((call) => call.name))).toEqual([
        ["machine__define"],
        ["machine__start"],
        [],
      ])
      expect(callsOf(steps[0] ?? [])[0]?.params).toEqual({
        definition: expect.objectContaining({ name: "soak", start: "check" }),
      })
      expect(callsOf(steps[1] ?? [])[0]?.params).toEqual({ machine: "soak" })
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

  // A model's reasoning summaries open with a bold heading; the TUI's live line names it.
  it.effect("debug think opens its reasoning with a heading, then thinks before it answers", () =>
    Effect.gen(function* () {
      const first = yield* step(0, ["bash"], "debug think")
      expect(first[0]).toEqual(
        expect.objectContaining({
          type: "reasoning-delta",
          delta: expect.stringMatching(/^\*\*Investigating rendering code\*\*\n\n/),
        }),
      )
      expect(callsOf(first).map((call) => call.name)).toEqual(["bash"])
      const answer = yield* Effect.forkChild(step(1, ["bash"], "debug think"))
      yield* TestClock.adjust("3999 millis")
      expect(answer.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("1 millis")
      const parts = yield* Fiber.join(answer)
      expect(callsOf(parts)).toEqual([])
      expect(parts.find((part) => part.type === "text-delta")).toEqual(
        expect.objectContaining({ delta: expect.stringContaining("draw once") }),
      )
    }),
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

  // A driver keeps a warm credential by label; the stamp is what tells it
  // that the label now holds another sign-in.
  it.scopedLive("a driver receives the sign-in stamp of the credential it resolves", () =>
    Effect.gen(function* () {
      const auth = Context.get(yield* Layer.build(Auth.Test()), Auth)
      const slot = CredentialSlot.make("personal")
      yield* auth.set(
        "stamp-slot",
        AuthInfo.cases.Oauth.make({ type: "oauth", access: "fake", refresh: "r", expires: 1 }),
        slot,
      )
      const received: Array<Option.Option<number>> = []
      const driver: ModelDriverContribution = {
        id: "stamp-slot",
        name: "Stamped",
        resolveModel: (_model, info) =>
          Effect.sync(() => {
            if (info?._tag === "Oauth") received.push(Option.fromUndefinedOr(info.signedInAt))
            return fakeResolution()
          }),
      }
      yield* resolveModel({ model: "stamp-slot/model", credentialSlot: slot }).pipe(
        Effect.provide(buildProviderLayer([makeExt("stamp-slot", [driver])], auth)),
      )
      const stored = yield* auth.get("stamp-slot", slot)
      expect(Predicate.isNumber(stored?.signedInAt)).toBe(true)
      expect(received).toEqual([Option.fromUndefinedOr(stored?.signedInAt)])
    }).pipe(Effect.timeout("5 seconds")),
  )

  it.scopedLive(
    "an OAuth sign-in keeps its prompt answers through a refresh and a rename, and its driver reads them",
    () =>
      Effect.gen(function* () {
        const auth = Context.get(yield* Layer.build(Auth.Test()), Auth)
        const personal = CredentialSlot.make("personal")
        const home = CredentialSlot.make("home")
        const answers = { directory: "/nonexistent/gent-link/claude-personal" }
        const received: Array<Option.Option<Record<string, string>>> = []
        let refreshes = 0
        const driver: ModelDriverContribution = {
          id: "linked-meta",
          name: "Linked",
          resolveModel: (_model, info) =>
            Effect.gen(function* () {
              if (info?._tag !== "Oauth") return yield* Effect.die("expected OAuth")
              received.push(Option.fromUndefinedOr(info.metadata))
              // The driver rotates the token, as a refresh does: it writes
              // the token fields alone.
              refreshes += 1
              yield* info.update((current) =>
                Effect.succeed([
                  true,
                  Option.map(current, (stored) => ({
                    ...stored,
                    access: `fake-access-${refreshes}`,
                    refresh: `fake-refresh-${refreshes}`,
                  })),
                ] as const),
              )
              return fakeResolution()
            }),
          auth: {
            methods: [AuthMethod.make({ type: "oauth", label: "Link", credentialTarget: "named" })],
            authorize: (ctx) =>
              ctx
                .persist({
                  type: "oauth",
                  access: "fake-access-0",
                  refresh: "fake-refresh-0",
                  expires: 1,
                  ...omitUndefined({ metadata: ctx.inputs }),
                })
                .pipe(Effect.as(Option.none())),
          },
        }
        const layer = Layer.mergeAll(
          buildProviderLayer([makeExt("linked-meta", [driver])], auth),
          GentPlatform.Test(),
        )
        yield* Effect.gen(function* () {
          const target = yield* captureProviderLogin(driver.id, 0, personal, answers)
          yield* authorizeProvider(SessionId.make("link"), driver.id, 0, target)
          yield* resolveModel({ model: "linked-meta/model", credentialSlot: personal })
          const refreshed = yield* auth.get(driver.id, personal)
          expect(refreshed?.type === "oauth" && refreshed.refresh).toBe("fake-refresh-1")
          expect(refreshed?.type === "oauth" && refreshed.metadata).toEqual(answers)
          yield* renameSignIn(driver.id, personal, home)
          yield* resolveModel({ model: "linked-meta/model", credentialSlot: home })
          const renamed = yield* auth.get(driver.id, home)
          expect(renamed?.type === "oauth" && renamed.refresh).toBe("fake-refresh-2")
          expect(renamed?.type === "oauth" && renamed.metadata).toEqual(answers)
          // The listing names the label and its kind, never what it stored.
          const rows = yield* listAuthProviders([])
          const row = rows.find((entry) => entry.provider === driver.id)
          expect(row?.credentials?.map((entry) => entry.slot)).toContain(home)
          const shown = rows.flatMap((entry) => [entry, ...(entry.credentials ?? [])])
          expect(shown.some((entry) => Predicate.hasProperty(entry, "metadata"))).toBe(false)
          expect(shown.some((entry) => Object.values(entry).includes(answers.directory))).toBe(
            false,
          )
        }).pipe(Effect.provide(layer))
        expect(received).toEqual([Option.some(answers), Option.some(answers)])
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

// ── credential placement ────────────────────────────────────────────────────

describe("credential placement", () => {
  const a = CredentialSlot.make("a")
  const b = CredentialSlot.make("b")
  const c = CredentialSlot.make("c")
  const spreadModel = ModelId.make("spread/model")
  const row = (slot: CredentialSlot, load: number, live: number, held = false) => ({
    slot,
    load,
    live,
    held,
  })

  bunTest(
    "placement takes the least-used eligible account, counting live sessions, and keeps the preferred one within one session of it",
    () => {
      // Four sessions spent $8: a unit is $2. a scores 6/2 + 1 = 4, b 2/2 + 0 = 1.
      expect(
        rankPlacement({
          slots: [row(a, 6, 1), row(b, 2, 0)],
          spent: 8,
          sessions: 4,
          preferred: Option.none(),
        }),
      ).toEqual([b, a])
      // Preferred within one session of the lowest: it stays.
      expect(
        rankPlacement({
          slots: [row(a, 4, 0), row(b, 2, 0)],
          spent: 6,
          sessions: 2,
          preferred: Option.some(a),
        }),
      ).toEqual([a, b])
      // More than one session above: the lowest wins.
      expect(
        rankPlacement({
          slots: [row(a, 6, 1), row(b, 2, 0)],
          spent: 8,
          sessions: 4,
          preferred: Option.some(a),
        }),
      ).toEqual([b, a])
      // The unit reads the provider's whole spend, not only the rows the
      // table may choose: $40 over 4 sessions is a $10 unit, so b's $3 is
      // 0.3 of a session over a's $1, and b, preferred, stays.
      expect(
        rankPlacement({
          slots: [row(a, 1, 0), row(b, 3, 0)],
          spent: 40,
          sessions: 4,
          preferred: Option.some(b),
        }),
      ).toEqual([b, a])
      // Live sessions count before their usage lands: a burst spreads.
      expect(
        rankPlacement({
          slots: [row(a, 0, 3), row(b, 0, 1)],
          spent: 0,
          sessions: 0,
          preferred: Option.none(),
        }),
      ).toEqual([b, a])
      // A spend with no session counted has no unit (never an infinite one):
      // live sessions alone.
      expect(
        rankPlacement({
          slots: [row(a, 9, 0), row(b, 0, 1)],
          spent: 9,
          sessions: 0,
          preferred: Option.none(),
        }),
      ).toEqual([a, b])
      // Ties go by pool order; an empty history scores live sessions alone.
      expect(
        rankPlacement({
          slots: [row(c, 0, 0), row(a, 0, 0), row(b, 0, 0)],
          spent: 0,
          sessions: 0,
          preferred: Option.none(),
        }),
      ).toEqual([c, a, b])
      // A held account is never chosen, and walks last.
      expect(
        rankPlacement({
          slots: [row(a, 0, 0, true), row(b, 9, 2), row(c, 3, 0)],
          spent: 12,
          sessions: 3,
          preferred: Option.some(a),
        }),
      ).toEqual([c, b, a])
      // With none eligible, the preferred account.
      expect(
        rankPlacement({
          slots: [row(a, 0, 0, true), row(b, 0, 0, true)],
          spent: 0,
          sessions: 0,
          preferred: Option.some(b),
        }),
      ).toEqual([b, a])
    },
  )

  bunTest(
    "under-pace accounts use the earliest weekly reset before score or a missing weekly reading",
    () => {
      expect(
        rankPlacement({
          slots: [
            { ...row(a, 0, 0), sustainable: 2 },
            { ...row(b, 0, 0), sustainable: 2, weeklyResetAt: 200 },
            { ...row(c, 8, 1), sustainable: 2, weeklyResetAt: 100 },
          ],
          spent: 8,
          sessions: 4,
          preferred: Option.none(),
        }),
      ).toEqual([c, b, a])
    },
  )

  bunTest(
    "an account at its paced load spills to the next weekly reset, then uses score above pace",
    () => {
      const slots = [
        { ...row(a, 0, 2), sustainable: 2, weeklyResetAt: 100 },
        { ...row(b, 0, 0), sustainable: 2, weeklyResetAt: 300 },
        { ...row(c, 8, 1), sustainable: 2, weeklyResetAt: 200 },
      ] as const
      const table = { slots, spent: 8, sessions: 4, preferred: Option.none<CredentialSlot>() }
      expect(rankPlacement(table)).toEqual([c, b, a])
      expect(
        rankPlacement({
          ...table,
          slots: Arr.map(slots, (entry) => ({ ...entry, sustainable: 0 })),
        }),
      ).toEqual([b, a, c])
    },
  )

  bunTest("a warm preferred account keeps an under-pace run only within hysteresis", () => {
    const table = {
      slots: [
        { ...row(a, 0, 0), sustainable: 3, weeklyResetAt: 100 },
        { ...row(b, 0, 1), sustainable: 3, weeklyResetAt: 200 },
      ] as const,
      spent: 0,
      sessions: 0,
      preferred: Option.some(b),
    }
    expect(rankPlacement(table)).toEqual([b, a])
    expect(
      rankPlacement({
        ...table,
        slots: [table.slots[0], { ...table.slots[1], live: 2 }],
      }),
    ).toEqual([a, b])
  })

  bunTest(
    "a warm preferred account at pace loses to an earlier under-pace reset within hysteresis",
    () => {
      expect(
        rankPlacement({
          slots: [
            { ...row(b, 0, 1), sustainable: 1, weeklyResetAt: 200 },
            { ...row(a, 0, 0), sustainable: 2, weeklyResetAt: 100 },
          ],
          spent: 0,
          sessions: 0,
          preferred: Option.some(b),
        }),
      ).toEqual([a, b])
    },
  )

  bunTest("held accounts stay last even with the earliest reset and a warm preference", () => {
    expect(
      rankPlacement({
        slots: [
          { ...row(a, 0, 0, true), sustainable: 3, weeklyResetAt: 100 },
          { ...row(b, 0, 1), sustainable: 3, weeklyResetAt: 300 },
          { ...row(c, 4, 1), sustainable: 3, weeklyResetAt: 200 },
        ],
        spent: 4,
        sessions: 2,
        preferred: Option.some(a),
      }),
    ).toEqual([c, b, a])
  })

  bunTest("equal weekly resets keep pool order among under-pace accounts", () => {
    expect(
      rankPlacement({
        slots: [
          { ...row(c, 8, 1), sustainable: 2, weeklyResetAt: 100 },
          { ...row(b, 0, 0), sustainable: 2, weeklyResetAt: 100 },
          { ...row(a, 0, 0), sustainable: 2 },
        ],
        spent: 8,
        sessions: 4,
        preferred: Option.none(),
      }),
    ).toEqual([c, b, a])
  })

  it.effect(
    "a session counts in the hour of its latest priced step, a refusal ranks against the provider's whole spend, and a pool is open while any account is not held",
    () =>
      Effect.gen(function* () {
        const placement = yield* makeCredentialPlacement(Option.none())
        const step = (slot: CredentialSlot, session: string, costUsd: number) =>
          placement.noteStep({
            provider: "spread",
            slot,
            sessionId: SessionId.make(session),
            costUsd: Option.some(costUsd),
            ttlMs: Option.some(1),
          })
        const place = (
          session: string,
          preferred: Option.Option<CredentialSlot>,
          left: ReadonlyArray<CredentialSlot>,
        ) =>
          Effect.map(
            placement.place({
              provider: "spread",
              pool: [a, b, c],
              model: spreadModel,
              sessionId: SessionId.make(session),
              preferred,
              starter: Option.none(),
              left: new Set(left),
              ttlMs: Option.some(1),
            }),
            (walk) => walk[0],
          )
        // One long session on a, $12 a day for three days, and one on b, $4:
        // two sessions, $40, a unit of $20.
        yield* step(a, "long", 12)
        yield* TestClock.adjust("1 day")
        yield* step(a, "long", 12)
        yield* TestClock.adjust("1 day")
        yield* step(a, "long", 12)
        yield* step(b, "short", 4)
        yield* TestClock.adjust("1 second")
        // a left (refused): b and c rank against the provider's $40, so b's
        // $4 is 0.2 of a session above c, and b, preferred, stays. Against
        // the open rows alone ($4, a $2 unit) b would be 2 sessions above c.
        expect(yield* place("refused", Option.some(b), [a])).toBe(b)
        // The long session's first day leaves the window. It still counts,
        // in the hour of its latest step: $28 over two sessions, a $14 unit,
        // so a's $24 is 1.7 sessions above c, unused, and c wins over a
        // preferred. Counted only in its first hour, it would be gone: a $28
        // unit, a 0.9 above c, and a kept.
        yield* TestClock.adjust("5 days")
        yield* TestClock.adjust("1 hour")
        expect(yield* place("fresh", Option.some(a), [])).toBe(c)
        // The pool is open while any of its accounts is neither held nor left by the turn.
        const now = yield* Clock.currentTimeMillis
        const open = (left: ReadonlyArray<CredentialSlot>) =>
          placement.open({
            provider: "spread",
            pool: [a, b],
            model: spreadModel,
            left: new Set(left),
          })
        expect(yield* open([])).toBe(true)
        expect(yield* open([a, b])).toBe(false)
        yield* placement.refuse({
          provider: "spread",
          slot: a,
          signedInAt: Option.none(),
          model: Option.none(),
          retryAt: Option.some(now + 60_000),
        })
        expect(yield* open([b])).toBe(false)
        yield* placement.refuse({
          provider: "spread",
          slot: b,
          signedInAt: Option.none(),
          model: Option.none(),
          retryAt: Option.some(now + 120_000),
        })
        expect(yield* open([])).toBe(false)
        yield* TestClock.adjust("61 seconds")
        expect(yield* open([])).toBe(true)
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(BunServices.layer, GentPlatform.Test())),
      ),
  )

  it.effect(
    "a session the ledger names counts once after a restart, in the hour and on the account of its latest step",
    () =>
      Effect.gen(function* () {
        type Saved = Parameters<
          Option.Option.Value<Parameters<typeof makeCredentialPlacement>[0]>["save"]
        >[0]
        const long = SessionId.make("long")
        const file = yield* Ref.make<Saved>({ buckets: [] })
        const store = {
          load: Ref.get(file),
          save: (ledger: Saved) => Ref.set(file, ledger).pipe(Effect.as(true)),
        }
        // A server's life: it reads the ledger, takes one step of "long", and writes it back.
        const serve = (slot: CredentialSlot) =>
          Effect.gen(function* () {
            const placement = yield* makeCredentialPlacement(Option.some(store))
            yield* placement.noteStep({
              provider: "spread",
              slot,
              sessionId: long,
              costUsd: Option.some(1),
              ttlMs: Option.some(1),
            })
            yield* placement.flush
          })
        const sessionsOn = Effect.map(Ref.get(file), (ledger) =>
          ledger.buckets
            .filter((bucket) => bucket.sessions.length > 0)
            .map((bucket) => ({ slot: bucket.slot, sessions: [...bucket.sessions] })),
        )
        yield* TestClock.adjust("1 hour")
        yield* serve(a)
        // Restarted in the same hour, the session goes on on a: still one session.
        yield* serve(a)
        expect(yield* sessionsOn).toEqual([{ slot: a, sessions: [long] }])
        // Restarted in the same hour again, it goes on on b: it still counts
        // once, in that hour, where its first step there counted it.
        yield* serve(b)
        expect(yield* sessionsOn).toEqual([{ slot: a, sessions: [long] }])
        // An hour on, restarted again on a: counted in that hour alone.
        yield* TestClock.adjust("1 hour")
        yield* serve(a)
        const { buckets } = yield* Ref.get(file)
        expect(yield* sessionsOn).toEqual([{ slot: a, sessions: [long] }])
        expect(buckets.map((bucket) => bucket.costUsd).reduce((sum, cost) => sum + cost, 0)).toBe(4)
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(BunServices.layer, GentPlatform.Test())),
      ),
  )

  it.effect(
    "a cache with no lifetime never goes cold: its session stays live on its account until it moves",
    () =>
      Effect.gen(function* () {
        const placeAfter = (ttlMs: Option.Option<number>) =>
          Effect.gen(function* () {
            const placement = yield* makeCredentialPlacement(Option.none())
            const place = (session: string) =>
              Effect.map(
                placement.place({
                  provider: "spread",
                  pool: [a, b],
                  model: spreadModel,
                  sessionId: SessionId.make(session),
                  preferred: Option.none(),
                  starter: Option.none(),
                  left: new Set(),
                  ttlMs,
                }),
                (walk) => walk[0],
              )
            expect(yield* place("warm")).toBe(a)
            yield* TestClock.adjust("3 hours")
            return yield* place("next")
          })
        // No lifetime: the first session still warms a, so the next goes to b.
        expect(yield* placeAfter(Option.none())).toBe(b)
        // A lifetime of an hour: a went cold, so the next reads both as unused.
        expect(yield* placeAfter(Option.some(3_600_000))).toBe(a)
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(BunServices.layer, GentPlatform.Test())),
      ),
  )

  it.effect("an account refused until its reset is not placed on before then", () =>
    Effect.gen(function* () {
      const placement = yield* makeCredentialPlacement(Option.none())
      const request = {
        provider: "spread",
        pool: [a, b] as const,
        model: spreadModel,
        preferred: Option.none<CredentialSlot>(),
        starter: Option.none<SessionId>(),
        left: new Set<CredentialSlot>(),
        ttlMs: Option.some(1_000),
      }
      const place = (session: string) =>
        Effect.map(
          placement.place({ ...request, sessionId: SessionId.make(session) }),
          (walk) => walk[0],
        )
      // b has spent, a has not: a is the least used.
      yield* placement.noteStep({
        provider: "spread",
        slot: b,
        sessionId: SessionId.make("spent"),
        costUsd: Option.some(5),
        ttlMs: Option.some(1),
      })
      yield* TestClock.adjust("1 second")
      expect(yield* place("first")).toBe(a)
      // A refusal that names its reset holds a until then.
      const now = yield* Clock.currentTimeMillis
      yield* placement.refuse({
        provider: "spread",
        slot: a,
        signedInAt: Option.none(),
        model: Option.none(),
        retryAt: Option.some(now + 600_000),
      })
      yield* TestClock.adjust("2 seconds")
      expect(yield* place("held-reset")).toBe(b)
      yield* TestClock.adjust("597 seconds")
      expect(yield* place("held-reset-again")).toBe(b)
      yield* TestClock.adjust("1 second")
      expect(yield* place("after-reset")).toBe(a)
      // One that names none holds it 5 minutes.
      yield* placement.refuse({
        provider: "spread",
        slot: a,
        signedInAt: Option.none(),
        model: Option.none(),
        retryAt: Option.none(),
      })
      yield* TestClock.adjust("2 seconds")
      expect(yield* place("held-default")).toBe(b)
      yield* TestClock.adjust("298 seconds")
      expect(yield* place("after-default")).toBe(a)
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(BunServices.layer, GentPlatform.Test()))),
  )

  it.scopedLive(
    "a spread sign-in walks its pool before the rest of its authOrder, and conflicting authSpread entries or a pool outside the order fail that sign-in only",
    () =>
      Effect.gen(function* () {
        const owner = makeProvider("spread-owner")
        const alias = { ...makeProvider("spread-alias"), credentialFrom: owner.id }
        const other = makeProvider("spread-other")
        const resolved = resolveExtensions([makeExt("spread", [owner, alias, other])])
        const fallback = CredentialSlot.make("fallback")
        const registryOf = (config: ProviderConfig) =>
          ExtensionRegistry.of({
            getResolved: () => resolved,
            providerConfig: Effect.succeed(config),
          })
        const orderOf = (
          config: ProviderConfig,
          model: string,
          pin: Option.Option<CredentialSlot> = Option.none(),
        ) =>
          requestCredentialOrder({ modelId: ModelId.make(model) }, registryOf(config), pin).pipe(
            Effect.map(Option.map((order) => order.slots)),
          )
        const spread: ProviderConfig = {
          providers: { "spread-owner": { authOrder: [a, b, fallback], authSpread: [b, a] } },
        }
        // Unpinned: the pool first, then what the order adds.
        expect(yield* orderOf(spread, "spread-owner/model")).toEqual(Option.some([b, a, fallback]))
        // Through the alias, to the owner's pool.
        expect(yield* orderOf(spread, "spread-alias/model")).toEqual(Option.some([b, a, fallback]))
        // Pinned: the pin alone.
        expect(yield* orderOf(spread, "spread-owner/model", Option.some(fallback))).toEqual(
          Option.some([fallback]),
        )
        // No pool: the plain order.
        expect(
          yield* orderOf(
            { providers: { "spread-owner": { authOrder: [a, b] } } },
            "spread-owner/model",
          ),
        ).toEqual(Option.some([a, b]))
        // An alias and its owner that name different pools fail that sign-in alone.
        const conflicting: ProviderConfig = {
          providers: {
            "spread-owner": { authSpread: [a, b] },
            "spread-alias": { authSpread: [b, a] },
          },
        }
        const failed = yield* Effect.exit(orderOf(conflicting, "spread-owner/model"))
        expect(
          Exit.isFailure(failed) &&
            Option.exists(
              Cause.findErrorOption(failed.cause),
              (error) =>
                Schema.is(ProviderAuthError)(error) &&
                error.message.includes("Conflicting credential orders"),
            ),
        ).toBe(true)
        expect(yield* orderOf(conflicting, "spread-other/model")).toEqual(
          Option.some([DEFAULT_CREDENTIAL_SLOT]),
        )
        const auth = Context.get(yield* Layer.build(Auth.Test()), Auth)
        const rows = yield* listAuthProviders([]).pipe(
          Effect.provide(
            Layer.provideMerge(
              ModelResolver.Live,
              Layer.mergeAll(
                Layer.succeed(Auth, auth),
                Layer.succeed(ExtensionRegistry, registryOf(conflicting)),
                fixtureModelCatalogSource,
              ),
            ),
          ),
        )
        expect(rows.find((entry) => entry.provider === owner.id)?.orderConflict).toEqual([
          "spread-alias",
          "spread-owner",
        ])
        expect(rows.find((entry) => entry.provider === other.id)?.orderConflict).toBeUndefined()
        // A pool names credentials of the order. With no authOrder the order
        // is the default alone, so a pool there would walk to the default
        // once both its accounts refused: the sign-in fails instead, and its
        // row names the entries that hold the order and the pool.
        const outside = (config: ProviderConfig) =>
          Effect.gen(function* () {
            const message = yield* orderOf(config, "spread-owner/model").pipe(
              Effect.flip,
              Effect.map((error) => Option.some(error.message)),
              Effect.orElseSucceed(() => Option.none<string>()),
            )
            const listed = yield* listAuthProviders([]).pipe(
              Effect.provide(
                Layer.provideMerge(
                  ModelResolver.Live,
                  Layer.mergeAll(
                    Layer.succeed(Auth, auth),
                    Layer.succeed(ExtensionRegistry, registryOf(config)),
                    fixtureModelCatalogSource,
                  ),
                ),
              ),
            )
            return {
              message,
              conflict: listed.find((entry) => entry.provider === owner.id)?.orderConflict,
            }
          })
        expect(yield* outside({ providers: { "spread-owner": { authSpread: [a, b] } } })).toEqual({
          message: Option.some(
            `The authSpread of provider "spread-owner" names "a", "b", which its authOrder does not: a pool spreads runs over credentials of the order`,
          ),
          conflict: ["spread-owner"],
        })
        expect(
          yield* outside({
            providers: {
              "spread-owner": { authOrder: [a, fallback] },
              "spread-alias": { authSpread: [b, a] },
            },
          }),
        ).toEqual({
          message: Option.some(
            `The authSpread of provider "spread-owner" names "b", which its authOrder does not: a pool spreads runs over credentials of the order`,
          ),
          conflict: ["spread-alias", "spread-owner"],
        })
      }).pipe(Effect.timeout("5 seconds")),
  )
})

describe("account lanes", () => {
  const a = CredentialSlot.make("a")
  const b = CredentialSlot.make("b")
  const c = CredentialSlot.make("c")
  const HOUR = 3_600_000
  /** $1 of list price is 200,000 fuel: one fuel is one input token at $5 per million. */
  const usage = Option.some({ inputTokens: 1_000, outputTokens: 100 })
  const placementLayer = Layer.mergeAll(BunServices.layer, GentPlatform.Test())
  const plan = ProviderId.make("plan")
  /** An account as a test names it: a label, or a label with the sign-in under it. */
  type Account = CredentialSlot | { readonly slot: CredentialSlot; readonly signedInAt: number }
  type Scope = readonly [Account, ...Array<Account>]
  const receiptOf = (account: Account): CredentialReceipt => {
    if (Predicate.isString(account)) return { provider: plan, slot: account }
    return { provider: plan, ...account }
  }
  const scopeOf = (scope: Scope) => (_provider: string) =>
    Effect.succeedSome(Arr.map(scope, receiptOf))
  const runner = SessionId.make("runner")
  const planModel = ModelId.make("plan/model")

  /** One placement and the readings and fuel a test feeds it, on the provider `plan`. */
  const accounts = (ledger: Parameters<typeof makeCredentialPlacement>[0] = Option.none()) =>
    Effect.gen(function* () {
      const placement = yield* makeCredentialPlacement(ledger)
      const read = (
        account: Account,
        readings: ReadonlyArray<{
          readonly window: string
          readonly utilization: number
          readonly resetAt: number
          readonly rejected?: boolean
          readonly model?: ModelId
        }>,
      ) => {
        const { slot, signedInAt } = receiptOf(account)
        return placement.noteQuota({
          provider: "plan",
          slot,
          signedInAt: Option.fromUndefinedOr(signedInAt),
          readings: readings.map((reading) => ({ rejected: false, ...reading })),
        })
      }
      const spend = (
        account: Account,
        costUsd: Option.Option<number>,
        spent = usage,
        sessionId = runner,
        model = planModel,
      ) => {
        const { slot, signedInAt } = receiptOf(account)
        return placement.noteFuel({
          provider: "plan",
          slot,
          signedInAt: Option.fromUndefinedOr(signedInAt),
          sessionId,
          model,
          costUsd,
          usage: spent,
        })
      }
      const lanes = (scope: Scope) =>
        Effect.map(placement.lanes(scopeOf(scope)), (report) => {
          const found = report.providers.find((lanes) => lanes.provider === "plan")
          if (Predicate.isUndefined(found)) return Option.none()
          return Option.some(found)
        }).pipe(Effect.flatMap(Effect.fromOption), Effect.orDie)
      const windowOf = (scope: Scope, slot: CredentialSlot, window: string) =>
        Effect.flatMap(lanes(scope), (report) =>
          Effect.fromOption(
            Option.fromUndefinedOr(
              report.accounts
                .find((account) => account.slot === slot)
                ?.windows.find((found) => found.window === window),
            ),
          ).pipe(Effect.orDie),
        )
      /** Admit a start of `model` under `key` over `scope`: "admitted", else the refusal's reason. */
      const admit = (scope: Scope, key: string, model = planModel) =>
        placement
          .admitLane({
            provider: "plan",
            scope: Arr.map(scope, receiptOf),
            key,
            asker: Option.none(),
            model: Option.some(model),
          })
          .pipe(
            Effect.as("admitted" as const),
            Effect.catchTag("LaneUnavailable", (refused) => Effect.succeed(refused.reason)),
          )
      /** Where a run of `session` and `model` goes over the pool `[a, b]`, in walk order. */
      const place = (session: string, model = planModel) =>
        placement.place({
          provider: "plan",
          pool: [a, b],
          model,
          sessionId: SessionId.make(session),
          preferred: Option.none(),
          starter: Option.none(),
          left: new Set(),
          ttlMs: Option.none(),
        })
      return { placement, read, spend, lanes, windowOf, admit, place }
    })
  /** A ledger store over a ref, as the file is over a restart. */
  const ledgerRef = Effect.gen(function* () {
    type Saved = Parameters<
      Option.Option.Value<Parameters<typeof makeCredentialPlacement>[0]>["save"]
    >[0]
    const file = yield* Ref.make<Saved>({ buckets: [] })
    return {
      file,
      store: Option.some({
        load: Ref.get(file),
        save: (ledger: Saved) => Ref.set(file, ledger).pipe(Effect.as(true)),
      }),
    }
  })

  /** Fit both windows on c, outside the scopes below, through real quota/fuel receipts. */
  const pacedAccounts = (weeklyPoint = 9_300_000, shortPoint = 200_000) =>
    Effect.gen(function* () {
      const fixture = yield* accounts()
      const now = yield* Clock.currentTimeMillis
      yield* fixture.read(c, [
        { window: "7d", utilization: 0, resetAt: now + 168 * HOUR },
        { window: "5h", utilization: 0, resetAt: now + 5 * HOUR },
      ])
      yield* fixture.spend(c, Option.some((2 * weeklyPoint) / 200_000))
      yield* fixture.read(c, [
        { window: "7d", utilization: 0.02, resetAt: now + 168 * HOUR },
        {
          window: "5h",
          utilization: (2 * weeklyPoint) / (100 * shortPoint),
          resetAt: now + 5 * HOUR,
        },
      ])
      return { ...fixture, now }
    })

  it.effect("rolling weekly refills give the seven-account pool eight free lanes", () =>
    Effect.gen(function* () {
      const { read, spend, lanes, admit } = yield* accounts()
      const now = yield* Clock.currentTimeMillis
      const pool = [
        a,
        b,
        c,
        ...["d", "e", "f", "g"].map((slot) => CredentialSlot.make(slot)),
      ] as const
      const resetAt = now + 166 * HOUR
      // 18.6 M fuel / 2 points = 9.3 M fuel per weekly point.
      // The same fuel / 10 points = 1.86 M per five-hour point.
      yield* read(a, [
        { window: "7d", utilization: 0.01, resetAt },
        { window: "5h", utilization: 0, resetAt: now + 5 * HOUR },
      ])
      yield* spend(a, Option.some(93))
      yield* read(a, [
        { window: "7d", utilization: 0.03, resetAt },
        { window: "5h", utilization: 0.1, resetAt: now + 5 * HOUR },
      ])
      for (const [index, hours] of [5, 17, 33, 55, 65, 108].entries()) {
        const slot = pool[index + 1]
        if (Predicate.isUndefined(slot)) return yield* Effect.die("missing test account")
        yield* read(slot, [
          { window: "7d", utilization: 1, resetAt: now + hours * HOUR, rejected: true },
          { window: "5h", utilization: 0, resetAt: now + 5 * HOUR },
        ])
      }
      // Plain hours, 100% target: in-view fuel = 930 M × 5.2973809524.
      // Rolling = 29.324787415 M/h; floor = 902.1 M / 166 h.
      // Weekly ceiling = 6482.1 M / 166 h; 5h ceiling = 167.4 M / 5 h.
      // floor(min(29.324787415, 39.0487951807, 33.48) / 3.4) = 8.
      // Before rolling: floor((902.1 / 166) / 3.4) = 1.
      const report = yield* lanes(pool)
      expect(report.capacity).toBe(8)
      expect(yield* lanes([a])).toMatchObject({ capacity: 1 }) // a pin cannot borrow refills
      // Forecasts do not make a rejected account eligible for placement now.
      expect(
        report.accounts.filter((account) => account.held).map((account) => account.slot),
      ).toEqual(pool.slice(1))
      for (let index = 0; index < 8; index += 1)
        expect(yield* admit(pool, `rolling-${index}`)).toBe("admitted")
      expect(yield* admit(pool, "rolling-full")).toBe("Busy")
    }).pipe(Effect.scoped, Effect.provide(placementLayer)),
  )

  it.effect(
    "a spent week refills five-hour room at its reset within five hours, but not at six",
    () =>
      Effect.gen(function* () {
        const { read, lanes, now } = yield* pacedAccounts()
        yield* read(a, [
          { window: "7d", utilization: 0.5, resetAt: now + 160 * HOUR },
          { window: "5h", utilization: 0.6, resetAt: now + 4 * HOUR },
        ])
        yield* read(b, [
          { window: "7d", utilization: 1, resetAt: now + HOUR, rejected: true },
          { window: "5h", utilization: 0, resetAt: now + 5 * HOUR },
        ])
        // 8 M lasts to +1h; then 28 M lasts to +4h: ceiling 7 M/h.
        // The rolling week allows 8.5257 M/h. floor(7 / 3.4) = 2.
        expect((yield* lanes([a, b])).capacity).toBe(2)
        yield* read(b, [{ window: "7d", utilization: 1, resetAt: now + 6 * HOUR, rejected: true }])
        // Without that refill in view, 8 M must last to +4h: 2 M/h.
        expect((yield* lanes([a, b])).capacity).toBe(0)
      }).pipe(Effect.scoped, Effect.provide(placementLayer)),
  )

  it.effect("a weekly reset before the five-hour reset lifts the cap on unused short room", () =>
    Effect.gen(function* () {
      const { read, lanes, now } = yield* pacedAccounts(9_300_000, 1_000_000)
      // 930 M week with 10 M left, resetting in 1h; 100 M of unused 5h room.
      yield* read(a, [
        { window: "7d", utilization: 1 - 10 / 930, resetAt: now + HOUR },
        { window: "5h", utilization: 0, resetAt: now + 5 * HOUR },
      ])
      // 10 M lasts to +1h, then the 100 M short room to +5h: 10 M/h.
      // Capped at the weekly 10 M with no refill: 2 M/h, zero lanes.
      expect((yield* lanes([a])).capacity).toBe(2)
    }).pipe(Effect.scoped, Effect.provide(placementLayer)),
  )

  it.effect("a rolling weekly refill preserves a later rejected five-hour window", () =>
    Effect.gen(function* () {
      const { read, lanes, now } = yield* pacedAccounts()
      yield* read(a, [
        { window: "7d", utilization: 0.5, resetAt: now + 160 * HOUR },
        { window: "5h", utilization: 0.6, resetAt: now + 4 * HOUR },
      ])
      yield* read(b, [
        { window: "7d", utilization: 1, resetAt: now + HOUR, rejected: true },
        { window: "5h", utilization: 1, resetAt: now + 2 * HOUR, rejected: true },
      ])
      // The weekly reset at +1h adds no short room. 8 M lasts to +2h:
      // floor(4 M/h / 3.4 M/h) = 1, rather than two with a fresh 5h window.
      expect((yield* lanes([a, b])).capacity).toBe(1)
    }).pipe(Effect.scoped, Effect.provide(placementLayer)),
  )

  it.effect("the weekly ceiling caps rolling pace before the first refill", () =>
    Effect.gen(function* () {
      const { read, lanes, now } = yield* pacedAccounts(21_000_000, 2_000_000)
      yield* read(a, [
        { window: "7d", utilization: 0.5, resetAt: now + 160 * HOUR },
        { window: "5h", utilization: 0, resetAt: now + 5 * HOUR },
      ])
      yield* read(b, [
        { window: "7d", utilization: 1, resetAt: now + 120 * HOUR, rejected: true },
        { window: "5h", utilization: 0, resetAt: now + 5 * HOUR },
      ])
      // Rolling: (0.5 + 8/168 + 48/168) × 2100 M / 168 = 10.4167 M/h.
      // Only 1050 M is available before +120h: ceiling 8.75 M/h.
      // floor(8.75 / 3.4) = 2; uncapped rolling would allow three runs.
      expect((yield* lanes([a, b])).capacity).toBe(2)
      yield* read(a, [{ window: "7d", utilization: 1, resetAt: now + 160 * HOUR, rejected: true }])
      expect((yield* lanes([a, b])).capacity).toBe(0)
    }).pipe(Effect.scoped, Effect.provide(placementLayer)),
  )

  it.effect("the five-hour ceiling caps the rolling weekly target", () =>
    Effect.gen(function* () {
      const { read, lanes, now } = yield* pacedAccounts(9_300_000, 180_000)
      yield* read(a, [
        { window: "7d", utilization: 0.5, resetAt: now + 160 * HOUR },
        { window: "5h", utilization: 0.6, resetAt: now + 4 * HOUR },
      ])
      yield* read(b, [
        { window: "7d", utilization: 1, resetAt: now + HOUR, rejected: true },
        { window: "5h", utilization: 0, resetAt: now + 5 * HOUR },
      ])
      // 7.2 M + 18 M at +1h must last to +4h: 6.3 M/h, one lane.
      // The uncapped rolling target (8.5257 M/h) would admit two.
      expect((yield* lanes([a, b])).capacity).toBe(1)
    }).pipe(Effect.scoped, Effect.provide(placementLayer)),
  )

  it.effect("with no quota readings a held account does not disable stage-0 warm preference", () =>
    Effect.gen(function* () {
      const { placement } = yield* accounts()
      const request = {
        provider: "plan",
        pool: [a, b, c] as const,
        model: ModelId.make("plan/model"),
        preferred: Option.none<CredentialSlot>(),
        starter: Option.none<SessionId>(),
        left: new Set<CredentialSlot>(),
        ttlMs: Option.none<number>(),
      }
      // b has one live cache, c none. A warm b stays within hysteresis.
      yield* placement.noteStep({
        provider: "plan",
        slot: b,
        sessionId: runner,
        costUsd: Option.none(),
        ttlMs: Option.none(),
      })
      yield* placement.refuse({
        provider: "plan",
        slot: a,
        signedInAt: Option.none(),
        model: Option.none(),
        retryAt: Option.none(),
      })
      expect(
        yield* placement.place({
          ...request,
          sessionId: SessionId.make("next"),
          preferred: Option.some(b),
        }),
      ).toEqual([b, c, a])
    }).pipe(Effect.scoped, Effect.provide(placementLayer)),
  )

  it.effect(
    "placement reads each account's sustainable minimum and weekly reset, counting live placements",
    () =>
      Effect.gen(function* () {
        const { read, spend, lanes, place } = yield* accounts()
        const now = yield* Clock.currentTimeMillis
        const weeklyA = now + 10 * HOUR
        const weeklyB = now + 5 * HOUR
        // Both have 100,000 fuel per point in both windows. b resets first
        // weekly; a resets first in 5h. Only the weekly reset sets priority.
        const readings = (weekly: number, short: number, utilization: number) => [
          { window: "7d", utilization, resetAt: weekly },
          { window: "5h", utilization, resetAt: short },
        ]
        yield* read(a, readings(weeklyA, now + HOUR, 0.1))
        yield* spend(a, Option.some(1))
        yield* read(a, readings(weeklyA, now + HOUR, 0.12))
        yield* read(b, readings(weeklyB, now + 2 * HOUR, 0.1))
        yield* spend(b, Option.some(1))
        yield* read(b, readings(weeklyB, now + 2 * HOUR, 0.12))
        const report = yield* lanes([a, b])
        expect(report.capacity).toBe(0) // floor(0.259 + 0.518), pool first
        expect(yield* place("first")).toEqual([b, a])
        // That placement is live before it reports a step: 1 exceeds b's
        // sustainable 0.518, so the next run spills to a's later reset.
        expect(yield* place("second")).toEqual([a, b])
      }).pipe(Effect.scoped, Effect.provide(placementLayer)),
  )

  it.effect(
    "each window's fuel per percent is the fuel spent between readings over the points they moved",
    () =>
      Effect.gen(function* () {
        const { read, spend, lanes, windowOf } = yield* accounts()
        yield* TestClock.adjust("1 hour")
        const start = yield* Clock.currentTimeMillis
        // The window resets 2 hours after the last reading.
        const resetAt = start + 2 * HOUR + 2 * 60_000
        yield* read(a, [{ window: "5h", utilization: 0.1, resetAt }])
        yield* spend(a, Option.some(1))
        yield* TestClock.adjust("1 minute")
        yield* read(a, [{ window: "5h", utilization: 0.11, resetAt }])
        // A reading that moved less than 1% keeps the segment open.
        yield* spend(a, Option.some(1))
        yield* read(a, [{ window: "5h", utilization: 0.112, resetAt }])
        yield* spend(a, Option.some(1))
        yield* TestClock.adjust("1 minute")
        yield* read(a, [{ window: "5h", utilization: 0.13, resetAt }])
        const window = yield* windowOf([a], a, "5h")
        // 600,000 fuel over 3 points.
        expect(window.fuelPerPct).toBeCloseTo(200_000, 3)
        expect(window.samples).toBe(2)
        // ±half a 1% step over the 3 points moved.
        expect(window.band).toBeCloseTo(0.5 / 3, 6)
        expect(window.outsideShare).toBe(0)
        // 87 points left at 200,000 fuel each, over 2 hours at 3.4 M fuel an hour.
        expect(window.sustainable).toBeCloseTo((87 * 200_000) / (2 * 3_400_000), 6)
        const report = yield* lanes([a])
        expect(report.capacity).toBe(2)
        expect(report.scope).toEqual([a])
      }).pipe(Effect.scoped, Effect.provide(placementLayer)),
  )

  it.effect(
    "a reset, a fall, a gap over 15 minutes or an unpriced request drops the fuel since the last reading",
    () =>
      Effect.gen(function* () {
        const { read, spend, windowOf } = yield* accounts()
        yield* TestClock.adjust("1 hour")
        const start = yield* Clock.currentTimeMillis
        const resetAt = start + 5 * HOUR
        yield* read(a, [{ window: "5h", utilization: 0.1, resetAt }])
        // The reset moved: a new window.
        yield* spend(a, Option.some(1))
        yield* read(a, [{ window: "5h", utilization: 0.12, resetAt: resetAt + HOUR }])
        // The window fell.
        yield* spend(a, Option.some(1))
        yield* read(a, [{ window: "5h", utilization: 0.05, resetAt: resetAt + HOUR }])
        // 16 minutes with no reading.
        yield* spend(a, Option.some(1))
        yield* TestClock.adjust("16 minutes")
        yield* read(a, [{ window: "5h", utilization: 0.07, resetAt: resetAt + HOUR }])
        // A request with no price, and one a subscription view lists at $0.
        yield* spend(a, Option.none())
        yield* read(a, [{ window: "5h", utilization: 0.09, resetAt: resetAt + HOUR }])
        yield* spend(a, Option.some(0))
        yield* read(a, [{ window: "5h", utilization: 0.11, resetAt: resetAt + HOUR }])
        const dropped = yield* windowOf([a], a, "5h")
        expect(dropped.samples).toBe(0)
        expect(dropped.fuelPerPct).toBeUndefined()
        expect(dropped.sustainable).toBeUndefined()
        // One priced move counts.
        yield* spend(a, Option.some(2))
        yield* read(a, [{ window: "5h", utilization: 0.13, resetAt: resetAt + HOUR }])
        const counted = yield* windowOf([a], a, "5h")
        expect(counted.samples).toBe(1)
        expect(counted.fuelPerPct).toBeCloseTo(200_000, 3)
      }).pipe(Effect.scoped, Effect.provide(placementLayer)),
  )

  it.effect("a move gent's fuel does not explain is spend outside gent, left out of the rate", () =>
    Effect.gen(function* () {
      const { read, spend, windowOf } = yield* accounts()
      yield* TestClock.adjust("1 hour")
      const resetAt = (yield* Clock.currentTimeMillis) + 5 * HOUR
      const step = (on: CredentialSlot, from: number, to: number, costUsd: number) =>
        Effect.gen(function* () {
          yield* read(on, [{ window: "5h", utilization: from, resetAt }])
          yield* spend(on, Option.some(costUsd))
          yield* read(on, [{ window: "5h", utilization: to, resetAt }])
        })
      yield* step(a, 0.1, 0.11, 1)
      yield* step(a, 0.11, 0.12, 1)
      // Claude Code spent 9 points of its own while gent spent $1.
      yield* step(a, 0.12, 0.22, 1)
      const window = yield* windowOf([a], a, "5h")
      expect(window.samples).toBe(2)
      expect(window.fuelPerPct).toBeCloseTo(200_000, 3)
      expect(window.outsideShare).toBeCloseTo(10 / 12, 6)
      // On b, one clean segment sets 200,000 fuel a point; then the same
      // fuel moves 6 points, 5 of them outside gent's. Judged by a rate that
      // counts it (400,000 over 7), the move would read as gent's own.
      yield* step(b, 0.1, 0.11, 1)
      yield* step(b, 0.11, 0.17, 1)
      const small = yield* windowOf([b], b, "5h")
      expect(small.samples).toBe(1)
      expect(small.fuelPerPct).toBeCloseTo(200_000, 3)
      expect(small.outsideShare).toBeCloseTo(6 / 7, 6)
    }).pipe(Effect.scoped, Effect.provide(placementLayer)),
  )

  it.effect(
    "capacity keeps account windows paired, waits for readings and caps the pool before later resets",
    () =>
      Effect.gen(function* () {
        const { read, spend, lanes } = yield* accounts()
        yield* TestClock.adjust("1 hour")
        const now = yield* Clock.currentTimeMillis
        // Both windows learn 200,000 fuel per point on c, outside the scope.
        yield* read(c, [
          { window: "5h", utilization: 0, resetAt: now + HOUR },
          { window: "7d", utilization: 0, resetAt: now + 2 * HOUR },
        ])
        yield* spend(c, Option.some(1))
        yield* read(c, [
          { window: "5h", utilization: 0.01, resetAt: now + HOUR },
          { window: "7d", utilization: 0.01, resetAt: now + 2 * HOUR },
        ])
        // a has 5-hour room only, b weekly room only: neither carries a run.
        yield* read(a, [
          { window: "5h", utilization: 0, resetAt: now + HOUR },
          { window: "7d", utilization: 0.99, resetAt: now + 24 * HOUR },
        ])
        expect((yield* lanes([a, b])).capacity).toBeUndefined()
        yield* read(b, [
          { window: "5h", utilization: 0.99, resetAt: now + HOUR },
          { window: "7d", utilization: 0, resetAt: now + 24 * HOUR },
        ])
        const pooled = yield* lanes([a, b])
        // a: 1 point of the week over 24 hours, 0.0025; b: 1 point of 5 hours over 1, 0.059.
        expect(pooled.accounts.find((account) => account.slot === a)?.sustainable).toBeCloseTo(
          200_000 / (24 * 3_400_000),
          6,
        )
        expect(pooled.accounts.find((account) => account.slot === b)?.sustainable).toBeCloseTo(
          200_000 / 3_400_000,
          6,
        )
        expect(pooled.capacity).toBe(0)
        // c raises the floor to 9.9 M/h, but by +24h the pool only has
        // 40.2 M, including c's refill at +2h: 1.675 M/h < one lane.
        expect((yield* lanes([a, b, c])).capacity).toBe(0)
      }).pipe(Effect.scoped, Effect.provide(placementLayer)),
  )

  it.effect(
    "a rejected window holds its account until it resets, then the window is full again",
    () =>
      Effect.gen(function* () {
        const { read, lanes, windowOf } = yield* accounts()
        yield* TestClock.adjust("1 hour")
        const now = yield* Clock.currentTimeMillis
        yield* read(a, [{ window: "5h", utilization: 1, resetAt: now + HOUR, rejected: true }])
        const refused = yield* lanes([a])
        expect(refused.accounts[0]?.held).toBe(true)
        expect(refused.accounts[0]?.sustainable).toBe(0)
        expect(refused.capacity).toBe(0)
        yield* TestClock.adjust("61 minutes")
        const window = yield* windowOf([a], a, "5h")
        expect(window.rejected).toBe(false)
        expect(window.utilization).toBe(0)
        expect((yield* lanes([a])).accounts[0]?.held).toBe(false)
      }).pipe(Effect.scoped, Effect.provide(placementLayer)),
  )

  it.effect(
    "two providers' plans each report their lanes, and a spent window refuses only its provider",
    () =>
      Effect.gen(function* () {
        const placement = yield* makeCredentialPlacement(Option.none())
        yield* TestClock.adjust("1 hour")
        const now = yield* Clock.currentTimeMillis
        const windows = (utilization: number, rejected = false) => [
          { window: "5h", utilization, resetAt: now + 5 * HOUR, rejected: false },
          { window: "7d", utilization, resetAt: now + 100 * HOUR, rejected },
        ]
        // Each plan learns 20 M fuel per point from $100: a week carries lanes.
        for (const provider of ["anthropic", "openai"]) {
          const note = (utilization: number) =>
            placement.noteQuota({
              provider,
              slot: a,
              signedInAt: Option.none(),
              readings: windows(utilization),
            })
          yield* note(0)
          yield* placement.noteFuel({
            provider,
            slot: a,
            signedInAt: Option.none(),
            sessionId: runner,
            model: ModelId.make(`${provider}/model`),
            costUsd: Option.some(100),
            usage,
          })
          yield* note(0.01)
        }
        const scopes = (provider: string) =>
          Effect.succeedSome(Arr.make({ provider: ProviderId.make(provider), slot: a }))
        const free = (report: LaneReport) =>
          report.providers.map((lanes) => [lanes.provider, lanes.capacity] as const)
        const both = free(yield* placement.lanes(scopes))
        expect(both.map(([provider]) => provider)).toEqual(["anthropic", "openai"])
        for (const [, capacity] of both) expect(capacity).toBeGreaterThan(0)
        const admit = (provider: string) =>
          placement
            .admitLane({
              provider,
              scope: [{ provider: ProviderId.make(provider), slot: a }],
              key: `start-${provider}`,
              asker: Option.none(),
              model: Option.some(ModelId.make(`${provider}/model`)),
            })
            .pipe(
              Effect.as("admitted" as const),
              Effect.catchTag("LaneUnavailable", (refused) => Effect.succeed(refused.reason)),
            )
        // ChatGPT's week is spent: only its runs are refused.
        yield* placement.noteQuota({
          provider: "openai",
          slot: a,
          signedInAt: Option.none(),
          readings: windows(1, true),
        })
        expect(yield* admit("openai")).toBe("Spent")
        expect(yield* admit("anthropic")).toBe("admitted")
        const open = (provider: string) =>
          placement.open({
            provider,
            pool: [a],
            model: ModelId.make(`${provider}/model`),
            left: new Set(),
          })
        expect(yield* open("openai")).toBe(false)
        expect(yield* open("anthropic")).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(placementLayer)),
  )

  it.effect("a window named in minutes is full again for its whole length once it resets", () =>
    Effect.gen(function* () {
      const { read, spend, windowOf } = yield* accounts()
      yield* TestClock.adjust("1 hour")
      const now = yield* Clock.currentTimeMillis
      yield* read(a, [{ window: "90m", utilization: 0, resetAt: now + HOUR }])
      yield* spend(a, Option.some(1))
      yield* read(a, [{ window: "90m", utilization: 0.01, resetAt: now + HOUR }])
      yield* TestClock.adjust("61 minutes")
      // 100 points at 200,000 fuel each, over 90 minutes of 3,400,000 an hour.
      const window = yield* windowOf([a], a, "90m")
      expect(window.utilization).toBe(0)
      expect(window.sustainable).toBeCloseTo((100 * 200_000) / (1.5 * 3_400_000), 6)
    }).pipe(Effect.scoped, Effect.provide(placementLayer)),
  )

  it.effect(
    "readings, segments and the measured burn survive a restart in the ledger, which an older binary still reads",
    () =>
      Effect.gen(function* () {
        const home = yield* makeTempDirectoryScoped("gent-lanes-ledger-")
        const fs = yield* FileSystem.FileSystem
        const file = `${home}/.gent/credential-usage.json`
        const server = CredentialPlacement.Live.pipe(
          Layer.provide(
            Layer.mergeAll(
              RuntimeEnvironment.Live({ cwd: home, home }),
              BunServices.layer,
              GentPlatform.Test(),
            ),
          ),
        )
        // A ledger an older gent wrote: buckets alone.
        yield* fs.makeDirectory(`${home}/.gent`, { recursive: true })
        yield* fs.writeFileString(file, '{"buckets":[]}')
        yield* TestClock.adjust("1 hour")
        const resetAt = (yield* Clock.currentTimeMillis) + 5 * HOUR
        yield* Effect.scoped(
          Effect.gen(function* () {
            const placement = Context.get(yield* Layer.build(server), CredentialPlacement)
            const quota = (utilization: number) =>
              placement.noteQuota({
                provider: "plan",
                slot: a,
                signedInAt: Option.none(),
                readings: [{ window: "5h", utilization, resetAt, rejected: false }],
              })
            const fuel = (costUsd: number) =>
              placement.noteFuel({
                provider: "plan",
                slot: a,
                signedInAt: Option.none(),
                sessionId: runner,
                model: planModel,
                costUsd: Option.some(costUsd),
                usage,
              })
            yield* quota(0.1)
            // A file with no burn reads the prior.
            const before = (yield* placement.lanes(scopeOf([a]))).providers[0]
            expect(before?.fuelPerHour).toBe(3_400_000)
            expect(before?.laneHours).toBe(0)
            // One lane runs 2 hours on $11: 2.2 M fuel, 1.1 M a lane-hour.
            yield* placement.openLane({
              sessionId: runner,
              key: "run",
              provider: "plan",
              scope: [receiptOf(a)],
            })
            yield* fuel(1)
            yield* quota(0.11)
            yield* fuel(10)
            yield* TestClock.adjust("2 hours")
            yield* placement.release(runner)
          }),
        )
        const restarted = yield* Effect.scoped(
          Effect.gen(function* () {
            const placement = Context.get(yield* Layer.build(server), CredentialPlacement)
            return yield* placement.lanes(scopeOf([a]))
          }),
        )
        const window = restarted.providers[0]?.accounts[0]?.windows[0]
        expect(window?.utilization).toBe(0.11)
        expect(window?.fuelPerPct).toBeCloseTo(200_000, 3)
        expect(restarted.providers[0]?.fuelPerHour).toBeCloseTo(1_100_000, 3)
        expect(restarted.providers[0]?.laneHours).toBeCloseTo(2, 6)
        // The schema an older binary decodes the ledger with.
        const OlderLedger = Schema.fromJsonString(
          Schema.Struct({
            buckets: Schema.Array(
              Schema.Struct({
                provider: Schema.String,
                slot: Schema.String,
                hour: Schema.Finite,
                costUsd: Schema.Finite,
                sessions: Schema.Array(Schema.String),
              }),
            ),
          }),
        )
        const text = yield* fs.readFileString(file)
        expect(text).toContain('"segments"')
        expect(text).toContain('"burn"')
        expect(text).not.toContain("sk-")
        expect(Exit.isSuccess(Schema.decodeExit(OlderLedger)(text))).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.effect(
    "the burn is the prior until a lane-hour is measured, then the fuel per lane-hour of the lanes that ended",
    () =>
      Effect.gen(function* () {
        const { placement, spend, read, lanes } = yield* accounts()
        yield* TestClock.adjust("1 hour")
        const now = yield* Clock.currentTimeMillis
        yield* read(a, [{ window: "5h", utilization: 0.1, resetAt: now + 5 * HOUR }])
        const lane = (session: string, hours: number, costUsd: Option.Option<number>) =>
          Effect.gen(function* () {
            const sessionId = SessionId.make(session)
            yield* placement.openLane({
              sessionId,
              key: session,
              provider: "plan",
              scope: [receiptOf(a)],
            })
            yield* spend(a, costUsd, usage, sessionId)
            yield* TestClock.adjust(Duration.hours(hours))
            yield* placement.release(sessionId)
          })
        // Half a lane-hour on $5, a million fuel: the prior still.
        yield* lane("short", 0.5, Option.some(5))
        expect((yield* lanes([a])).fuelPerHour).toBe(3_400_000)
        expect((yield* lanes([a])).laneHours).toBeCloseTo(0.5, 6)
        // A lane an unpriced request fell in measures nothing: its fuel is unknown.
        yield* lane("unpriced", 4, Option.none())
        expect((yield* lanes([a])).laneHours).toBeCloseTo(0.5, 6)
        // Another half hour on $5: two million fuel over one lane-hour, each
        // half weighed by how many lane-hours came after it.
        yield* lane("second", 0.5, Option.some(5))
        const decay = 0.5 ** (0.5 / 24)
        const measured = yield* lanes([a])
        expect(measured.laneHours).toBeCloseTo(1, 6)
        expect(measured.fuelPerHour).toBeCloseTo(
          (1_000_000 * decay + 1_000_000) / (0.5 * decay + 0.5),
          3,
        )
      }).pipe(Effect.scoped, Effect.provide(placementLayer)),
  )

  it.effect(
    "a rejected account replaced under its label is admitted, a late report of the old sign-in is dropped, and a renamed sign-in keeps its readings",
    () =>
      Effect.gen(function* () {
        const { placement, read, admit, lanes } = yield* accounts()
        yield* TestClock.adjust("1 hour")
        const now = yield* Clock.currentTimeMillis
        const old = { slot: a, signedInAt: 1 }
        const replaced = { slot: a, signedInAt: 2 }
        const rejected = [
          { window: "7d", utilization: 1, resetAt: now + 48 * HOUR, rejected: true },
        ]
        yield* read(old, rejected)
        expect(yield* admit([old], "before")).toBe("Spent")
        // `gent auth` signed a new account in under a: the store stamps it anew.
        expect(yield* admit([replaced], "after")).toBe("admitted")
        // The old sign-in's reading went with it: no window of the provider is read now.
        expect((yield* placement.lanes(scopeOf([replaced]))).providers).toEqual([])
        // The new sign-in reads its own window; then a response of a request the
        // old sign-in sent before the change lands late, and leaves that reading.
        yield* read(replaced, [{ window: "5h", utilization: 0.1, resetAt: now + HOUR }])
        yield* read(old, rejected)
        expect(
          (yield* lanes([replaced])).accounts[0]?.windows.map((window) => window.window),
        ).toEqual(["5h"])
        expect(yield* admit([replaced], "late")).toBe("admitted")
        // The new sign-in's own rejection holds it; renamed to c, it still does.
        yield* read(replaced, rejected)
        expect(yield* admit([replaced], "own")).toBe("Spent")
        yield* placement.renameLabel({ provider: "plan", from: a, to: c })
        const renamed = { slot: c, signedInAt: 2 }
        expect(yield* admit([renamed], "renamed")).toBe("Spent")
        const report = yield* lanes([renamed])
        expect(report.accounts.map((account) => [account.slot, account.held])).toEqual([[c, true]])
        // A late report under the old label counts on the new one.
        yield* read(replaced, [{ window: "5h", utilization: 0.2, resetAt: now + HOUR }])
        expect(
          (yield* lanes([renamed])).accounts[0]?.windows.map((window) => window.window).sort(),
        ).toEqual(["5h", "7d"])
      }).pipe(Effect.scoped, Effect.provide(placementLayer)),
  )

  it.effect(
    "a late report under the label a sign-in was renamed from holds the new label, not the old one",
    () =>
      Effect.gen(function* () {
        const { placement, read, admit, place } = yield* accounts()
        yield* TestClock.adjust("1 hour")
        const now = yield* Clock.currentTimeMillis
        expect(yield* admit([{ slot: a, signedInAt: 7 }], "before")).toBe("admitted")
        // `/auth` moves the sign-in from a to c; a request it sent as a lands late, rejected.
        yield* placement.renameLabel({ provider: "plan", from: a, to: c })
        expect(yield* admit([{ slot: c, signedInAt: 7 }], "renamed")).toBe("admitted")
        yield* read({ slot: a, signedInAt: 7 }, [
          { window: "7d", utilization: 1, resetAt: now + 48 * HOUR, rejected: true },
        ])
        // a holds no sign-in now and is placed first; c is held.
        expect(yield* place("next")).toEqual([a, b])
        expect(yield* admit([{ slot: c, signedInAt: 7 }], "after")).toBe("Spent")
      }).pipe(Effect.scoped, Effect.provide(placementLayer)),
  )

  it.effect("two labels whose sign-ins carry one stamp are two accounts", () =>
    Effect.gen(function* () {
      const { read, admit, place } = yield* accounts()
      yield* TestClock.adjust("1 hour")
      const now = yield* Clock.currentTimeMillis
      // Two sign-ins stamped in the same millisecond.
      const first = { slot: a, signedInAt: 5 }
      const second = { slot: b, signedInAt: 5 }
      expect(yield* admit([first, second], "both")).toBe("admitted")
      yield* read(first, [
        { window: "7d", utilization: 1, resetAt: now + 48 * HOUR, rejected: true },
      ])
      yield* read(second, [{ window: "7d", utilization: 0.2, resetAt: now + 48 * HOUR }])
      expect(yield* admit([second], "second")).toBe("admitted")
      expect(yield* admit([first], "first")).toBe("Spent")
      expect(yield* place("next")).toEqual([b, a])
    }).pipe(Effect.scoped, Effect.provide(placementLayer)),
  )

  it.effect(
    "a rejected account is placed last before and after a restart: the readings hold it",
    () =>
      Effect.gen(function* () {
        const { file, store } = yield* ledgerRef
        yield* TestClock.adjust("1 hour")
        const now = yield* Clock.currentTimeMillis
        const before = yield* accounts(store)
        yield* before.read(a, [
          { window: "7d", utilization: 1, resetAt: now + 48 * HOUR, rejected: true },
        ])
        yield* before.read(b, [{ window: "7d", utilization: 0.2, resetAt: now + 48 * HOUR }])
        expect(yield* before.place("first")).toEqual([b, a])
        yield* before.placement.flush
        expect((yield* Ref.get(file)).readings?.length).toBe(2)
        const after = yield* accounts(store)
        expect(yield* after.place("second")).toEqual([b, a])
      }).pipe(Effect.scoped, Effect.provide(placementLayer)),
  )

  /** A model of `plan` with windows of its own beside the account's, as a plan that meters one model reports. */
  const glm = ModelId.make("plan/glm")
  /** The fuel per point of the 5h window of `model` on `a`, or of the account's own with none. */
  const fiveHourRate = (report: ProviderLanes, model?: ModelId) =>
    report.accounts
      .find((account) => account.slot === a)
      ?.windows.find((window) => window.window === "5h" && window.model === model)?.fuelPerPct
  /**
   * Fuel both 5h windows of `a`: $1 of glm and $3 of the plan's model. The
   * account's moves 4 points, glm's 2.
   */
  const fuelBothWindows = (fixture: Effect.Success<ReturnType<typeof accounts>>, now: number) =>
    Effect.gen(function* () {
      const resetAt = now + 5 * HOUR
      yield* fixture.read(a, [
        { window: "5h", utilization: 0.1, resetAt },
        { window: "5h", model: glm, utilization: 0.1, resetAt },
      ])
      yield* fixture.spend(a, Option.some(1), usage, runner, glm)
      yield* fixture.spend(a, Option.some(3))
      yield* TestClock.adjust("1 minute")
      yield* fixture.read(a, [
        { window: "5h", utilization: 0.14, resetAt },
        { window: "5h", model: glm, utilization: 0.12, resetAt },
      ])
    })

  it.effect("a model's rejected window holds its account for that model's runs alone", () =>
    Effect.gen(function* () {
      const { read, admit, place, lanes } = yield* accounts()
      yield* TestClock.adjust("1 hour")
      const now = yield* Clock.currentTimeMillis
      yield* read(a, [
        { window: "5h", utilization: 0.1, resetAt: now + 5 * HOUR },
        { window: "5h", model: glm, utilization: 1, resetAt: now + 2 * HOUR, rejected: true },
      ])
      yield* read(b, [{ window: "5h", utilization: 0.1, resetAt: now + 5 * HOUR }])
      expect(yield* admit([a], "glm-start", glm)).toBe("Spent")
      expect(yield* admit([a], "plan-start")).toBe("admitted")
      expect(yield* place("glm-run", glm)).toEqual([b, a])
      expect(yield* place("plan-run")).toEqual([a, b])
      // The report lists the model's window beside the account's; it holds no account.
      const account = (yield* lanes([a])).accounts.find((found) => found.slot === a)
      expect(account?.held).toBe(false)
      expect(
        account?.windows.map((window) => [Option.fromUndefinedOr(window.model), window.rejected]),
      ).toEqual([
        [Option.none(), false],
        [Option.some(glm), true],
      ])
    }).pipe(Effect.scoped, Effect.provide(placementLayer)),
  )

  it.effect("a model's window fits that model's fuel alone; the account's fits every model's", () =>
    Effect.gen(function* () {
      const fixture = yield* accounts()
      yield* TestClock.adjust("1 hour")
      yield* fuelBothWindows(fixture, yield* Clock.currentTimeMillis)
      const report = yield* fixture.lanes([a])
      // 800,000 fuel over 4 points; glm's 200,000 over 2.
      expect(fiveHourRate(report)).toBeCloseTo(200_000, 3)
      expect(fiveHourRate(report, glm)).toBeCloseTo(100_000, 3)
    }).pipe(Effect.scoped, Effect.provide(placementLayer)),
  )

  it.effect(
    "a restart keeps a model's window apart from the account's of the same name, its hold and its fit",
    () =>
      Effect.gen(function* () {
        const { file, store } = yield* ledgerRef
        yield* TestClock.adjust("1 hour")
        const now = yield* Clock.currentTimeMillis
        const before = yield* accounts(store)
        yield* fuelBothWindows(before, now)
        yield* before.read(a, [
          { window: "5h", model: glm, utilization: 1, resetAt: now + 2 * HOUR, rejected: true },
        ])
        yield* before.placement.flush
        expect((yield* Ref.get(file)).readings?.length).toBe(2)
        const after = yield* accounts(store)
        expect(yield* after.admit([a], "glm-start", glm)).toBe("Spent")
        expect(yield* after.admit([a], "plan-start")).toBe("admitted")
        const report = yield* after.lanes([a])
        expect(fiveHourRate(report)).toBeCloseTo(200_000, 3)
        expect(fiveHourRate(report, glm)).toBeCloseTo(100_000, 3)
      }).pipe(Effect.scoped, Effect.provide(placementLayer)),
  )

  it.effect("values the window no longer holds leave the ledger file on the next write", () =>
    Effect.gen(function* () {
      const { file, store } = yield* ledgerRef
      yield* TestClock.adjust("1 hour")
      const now = yield* Clock.currentTimeMillis
      const { read, spend, placement } = yield* accounts(store)
      yield* read(a, [{ window: "5h", utilization: 0.1, resetAt: now + 5 * HOUR }])
      yield* spend(a, Option.some(1))
      yield* read(a, [{ window: "5h", utilization: 0.11, resetAt: now + 5 * HOUR }])
      yield* placement.flush
      expect((yield* Ref.get(file)).readings?.length).toBe(1)
      expect((yield* Ref.get(file)).segments?.length).toBe(1)
      // Eight days on, nothing new was recorded; a read of the lanes trims.
      yield* TestClock.adjust("8 days")
      expect((yield* placement.lanes(scopeOf([a]))).providers).toEqual([])
      yield* placement.flush
      const saved = yield* Ref.get(file)
      expect(saved.readings).toBeUndefined()
      expect(saved.segments).toBeUndefined()
    }).pipe(Effect.scoped, Effect.provide(placementLayer)),
  )

  it.effect("a reservation its caller frees stops counting at once", () =>
    Effect.gen(function* () {
      const { placement, read, admit, lanes } = yield* accounts()
      yield* TestClock.adjust("1 hour")
      const now = yield* Clock.currentTimeMillis
      yield* read(a, [{ window: "5h", utilization: 0.1, resetAt: now + 5 * HOUR }])
      expect(yield* admit([a], "start")).toBe("admitted")
      expect((yield* lanes([a])).load).toBe(1)
      yield* placement.freeReservation("start")
      expect((yield* lanes([a])).load).toBe(0)
    }).pipe(Effect.scoped, Effect.provide(placementLayer)),
  )

  it.effect(
    "a reservation held through its start's preparation outlasts 2 minutes, then lapses 2 minutes after the hold ends",
    () =>
      Effect.gen(function* () {
        const { placement, read, admit, lanes } = yield* accounts()
        yield* TestClock.adjust("1 hour")
        const now = yield* Clock.currentTimeMillis
        yield* read(a, [{ window: "5h", utilization: 0.1, resetAt: now + 5 * HOUR }])
        expect(yield* admit([a], "start")).toBe("admitted")
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* placement.holdReservation("start")
            yield* TestClock.adjust("10 minutes")
            expect((yield* lanes([a])).load).toBe(1)
            // A second admission under the key keeps the lane it holds.
            expect(yield* admit([a], "start")).toBe("admitted")
          }),
        )
        yield* TestClock.adjust("1 minute")
        expect((yield* lanes([a])).load).toBe(1)
        yield* TestClock.adjust("1 minute")
        expect((yield* lanes([a])).load).toBe(0)
        // A hold on a key with no lane held holds nothing.
        yield* Effect.scoped(placement.holdReservation("none"))
        expect((yield* lanes([a])).load).toBe(0)
      }).pipe(Effect.scoped, Effect.provide(placementLayer)),
  )

  it.effect(
    "a reservation two holders hold lasts until the last one ends, and a hold ends only the admission it held",
    () =>
      Effect.gen(function* () {
        const { placement, read, admit, lanes } = yield* accounts()
        yield* TestClock.adjust("1 hour")
        const now = yield* Clock.currentTimeMillis
        yield* read(a, [{ window: "5h", utilization: 0.1, resetAt: now + 5 * HOUR }])
        expect(yield* admit([a], "start")).toBe("admitted")
        const first = yield* Scope.make()
        const second = yield* Scope.make()
        yield* Scope.provide(placement.holdReservation("start"), first)
        yield* Scope.provide(placement.holdReservation("start"), second)
        yield* Scope.close(first, Exit.void)
        yield* TestClock.adjust("3 minutes")
        expect((yield* lanes([a])).load).toBe(1)
        // The start opens its turn and a new one is admitted under the key.
        yield* placement.freeReservation("start")
        expect(yield* admit([a], "start")).toBe("admitted")
        const third = yield* Scope.make()
        yield* Scope.provide(placement.holdReservation("start"), third)
        // The earlier admission's last hold ends; the new admission's hold stays.
        yield* Scope.close(second, Exit.void)
        yield* TestClock.adjust("3 minutes")
        expect((yield* lanes([a])).load).toBe(1)
        yield* Scope.close(third, Exit.void)
        yield* TestClock.adjust("3 minutes")
        expect((yield* lanes([a])).load).toBe(0)
      }).pipe(Effect.scoped, Effect.provide(placementLayer)),
  )

  it.effect("a lane's account carries the sign-in the store holds under its label now", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(makeRegistryLayerWithDrivers([noopProvider]))
      const auth = Context.get(context, Auth)
      const work = CredentialSlot.make("work")
      const stampsOf = credentialLane(
        "anthropic",
        Option.some(work),
        Context.get(context, ExtensionRegistry),
      ).pipe(
        Effect.provideService(ModelRegistry, Context.get(context, ModelRegistry)),
        Effect.map(Option.map((lane) => lane.scope.map((account) => account.signedInAt))),
      )
      yield* auth.set("anthropic", AuthApi.make({ type: "api", key: "first", signedInAt: 1 }), work)
      expect(yield* stampsOf).toEqual(Option.some([1]))
      // `gent auth` signs another account in under the label.
      yield* auth.set(
        "anthropic",
        AuthApi.make({ type: "api", key: "second", signedInAt: 2 }),
        work,
      )
      expect(yield* stampsOf).toEqual(Option.some([2]))
    }).pipe(Effect.scoped),
  )
})
