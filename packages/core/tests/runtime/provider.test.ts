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
  Schema,
  Stream,
} from "effect"
import { TestClock } from "effect/testing"
import * as AiError from "effect/ai/AiError"
import {
  AuthMethod,
  DEFAULT_RETRY_POLICY,
  isContextOverflow,
  type ModelDriverContribution,
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
  AuthInfo,
  type AuthService,
  serializeAuthStore,
  ModelResolver,
  authorizeProvider,
  completeProviderAuth,
  DecisionModelResolver,
  removeSignIn,
  listAuthMethods,
  retryProviderCall,
  ModelCatalogRecord,
  ModelRegistry,
  modelCatalog,
  finishPart,
  toolCallPart,
} from "../../src/runtime/provider"
import { BunServices } from "@effect/platform-bun"
import { Model as AiModel, LanguageModel } from "effect/ai"
import { test as bunTest } from "bun:test"
import { ExtensionRegistry, resolveExtensions } from "../../src/runtime/extension-host"
import type { LoadedExtension } from "../../src/domain/extension.js"
import { ModelId, ProviderId, Model, type ReasoningEffort } from "../../src/domain/agent"
import { BranchId, ExtensionId, MessageId, SessionId, ToolCallId } from "../../src/domain/ids"
import { GentPlatform } from "../../src/runtime/gent-platform"
import { tool, type ToolCapability } from "@gent/core/extensions/api"
import { LanguageModelLayers } from "../../src/test-utils/language-model"
import { convertTools } from "../../src/runtime/tools"
import { toPrompt } from "../../src/runtime/model-context"
import { dateFromMillis, Message } from "../../src/domain/message"
import { toCodecAnthropic } from "effect/ai/AnthropicStructuredOutput"
import * as AiTool from "effect/ai/Tool"
import type * as AiToolkit from "effect/ai/Toolkit"
import type { ToolkitInput } from "effect/ai/LanguageModel"
import * as Prompt from "effect/ai/Prompt"
import type * as Response from "effect/ai/Response"

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

const authLayer = Layer.succeed(
  Auth,
  Auth.of(
    serializeAuthStore({
      get: () => Effect.succeed(noStoredAuth),
      set: () => Effect.void,
      remove: () => Effect.void,
    }),
  ),
)

const failingReadAuthLayer = Layer.succeed(
  Auth,
  Auth.of(
    serializeAuthStore({
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
    const catalog = modelCatalog().pipe(
      Effect.provideService(ExtensionRegistry, drivers),
      Effect.provideService(Auth, auth),
      Effect.provideService(ModelCatalogRecord, catalogRecord),
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
      const oauthLayer = Layer.succeed(
        Auth,
        Auth.of(
          serializeAuthStore({
            get: (providerId) => {
              if (providerId !== "openai") {
                return Effect.succeed(noStoredAuth)
              }
              return Effect.succeed(AuthInfo.cases.Api.make({ type: "api", key: "sk-openai" }))
            },
            set: () => Effect.void,
            remove: () => Effect.void,
          }),
        ),
      )
      const seen: Array<string> = []
      const registry = yield* loadRegistryWithDrivers(
        [
          {
            id: "openai",
            name: "OpenAI",
            resolveModel: unusedResolution,
            listModels: (auth) =>
              Effect.sync(() => {
                if (auth?._tag === "Api") seen.push(`openai:${auth.key}`)
                return [catalogModel("openai/gpt-5.4")]
              }),
          },
          {
            id: "anthropic",
            name: "Anthropic",
            resolveModel: unusedResolution,
            listModels: (auth) =>
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
      Effect.provide(Layer.merge(Auth.Test(seed), testRegistryLayer)),
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
            Layer.merge(
              Auth.Test({ prompted: AuthApi.make({ type: "api", key: "k", metadata }) }),
              registry,
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
      const layer = Layer.mergeAll(authLayer, testRegistry, GentPlatform.Test())
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
}

const buildProviderLayer = (
  extensions: LoadedExtension[],
  authStore: AuthService = testAuthStorage,
) => {
  const resolved = resolveExtensions(extensions)
  const registryLayer = ExtensionRegistry.fromResolved(resolved)
  const authLayer = Layer.succeed(Auth, authStore)
  return Layer.provideMerge(ModelResolver.Live, Layer.mergeAll(authLayer, registryLayer))
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
    listModels: (auth?: ProviderAuthInfo) =>
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
  ExtensionRegistry.fromResolved(
    resolveExtensions([makeExt("shared-sign-in", [...sharedSignInDrivers(seen)])]),
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
    ).pipe(Layer.provideMerge(Layer.merge(Auth.Test(seed), sharedSignInRegistry(seen))))
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
      const methods = yield* listAuthMethods().pipe(Effect.provide(sharedSignInRegistry([])))
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
        effect.pipe(Effect.provide(Layer.merge(Auth.Test({}), registry)))
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
    listModels: (authInfo) =>
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
          DecisionModelResolver.Live.pipe(Layer.provideMerge(Layer.merge(Auth.Test({}), registry))),
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

// ── scripted debug model ────────────────────────────────────────────────────

describe("Scripted debug model tool scenario", () => {
  /** A toolkit advertising `names`, as a turn's request does; the test resolves no call. */
  const advertisedTool = (name: string) => AiTool.dynamic(name, { parameters: Schema.Unknown })
  type Advertised = Record<string, ReturnType<typeof advertisedTool>>
  type Part = Response.StreamPart<Advertised>
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
  const promptAfter = (done: number): Prompt.RawInput => [
    { role: "user", content: "run the debug tools scenario" },
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
  const step = (done: number, tools: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const model = yield* LanguageModel.LanguageModel
      const parts = yield* model
        .streamText({
          prompt: promptAfter(done),
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
