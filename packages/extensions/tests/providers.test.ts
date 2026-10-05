import { FetchHttpClient, type HttpClient } from "effect/http"
import { describe, expect, it, test } from "effect-bun-test"
import {
  ConfigProvider,
  Context,
  type Crypto,
  Deferred,
  Duration,
  Effect,
  Fiber,
  type FileSystem,
  Layer,
  Option,
  type Path,
  Schema,
  Semaphore,
  SynchronizedRef,
} from "effect"
import {
  type ApiClassContribution,
  type CatalogModel,
  type CatalogProvider,
  type Model,
  type ModelCatalogView,
  type ModelDriverContribution,
  ModelId,
  ProviderAuthError,
  ProviderAuthInfo,
  CredentialSlot,
  type RunEffort,
} from "@gent/core/extensions/api"
import {
  createRpcHarness,
  fixtureModelCatalog,
  LanguageModelLayers,
  listModelCatalog,
  modelCatalogFixture,
  KNOWN_IMAGE_COSTS,
  storedCredentialModel,
  textStep,
} from "@gent/core/test-utils"
import { shippedPreset } from "./helpers/test-preset.js"
import { SHIPPED_API_CLASSES } from "./helpers/api-classes.js"
import { encodeExternalJson } from "./helpers/external-wire.js"
import { makeFakeFetchState, oneGenerate } from "./helpers/fake-http-client.js"
import { BunServices } from "@effect/platform-bun"
import { TestClock } from "effect/testing"
import type { ChildProcessSpawner } from "effect/process"
import {
  catalogModels,
  apiKeyFrom,
  CHAT_COMPLETIONS_CLASS,
  type CredentialCacheCell,
  type CredentialFailure,
  type CredentialStore,
  EMPTY_CREDENTIAL_CELL,
  freshEnoughAt,
  makeCredentialCache,
  OPENAI_IMAGE_COSTS,
  openAiImageCost,
} from "../src/providers.js"
import {
  AnthropicPlatform,
  buildAnthropicModelDriver,
  type ClaudeCredentials,
  MESSAGES_CLASS,
} from "../src/anthropic.js"
import { RESPONSES_CLASS } from "../src/openai.js"

// ── driver catalog ──────────────────────────────────────────────────────────

/**
 * What a driver lists from the catalog core hands it. Core owns the
 * snapshot, its revalidation and its parse (core's `tests/runtime/provider.test.ts`,
 * "models.dev catalog source"); a driver only narrows, stamps and corrects.
 */

/** A catalog view over `providers`. */
const catalogOf = (...providers: ReadonlyArray<CatalogProvider>): ModelCatalogView => ({
  provider: (id) => Option.fromUndefinedOr(providers.find((provider) => provider.id === id)),
})

const anthropicCatalog = (...models: ReadonlyArray<CatalogModel>) =>
  catalogOf({ id: "anthropic", name: "Anthropic", env: [], models })

/** An Anthropic driver on macOS, with no credentials and an empty env. */
const anthropicDriverIn = Effect.fn("test.anthropicDriverIn")(function* (
  promptCacheTtl: "5m" | "1h",
) {
  const platform = yield* Effect.context<
    | FileSystem.FileSystem
    | Path.Path
    | ChildProcessSpawner.ChildProcessSpawner
    | Crypto.Crypto
    | HttpClient.HttpClient
  >().pipe(Effect.provide(FetchHttpClient.layer))
  return buildAnthropicModelDriver(
    yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL),
    Option.none(),
    Context.add(
      platform,
      AnthropicPlatform,
      AnthropicPlatform.of({ platform: "darwin", home: "/nonexistent/gent-test-home", env: {} }),
    ),
    promptCacheTtl,
  )
})

describe("driver catalog", () => {
  it.live(
    "the Anthropic driver's override lists Sonnet 4.5 at its documented 200k window, and every other model at the catalog's window",
    () =>
      Effect.gen(function* () {
        const claude = (key: string, context: number): CatalogModel => ({
          id: key,
          name: key,
          limit: { context },
        })
        // models.dev lists Sonnet 4.5 at 1M; platform.claude.com/docs/en/build-with-claude/context-windows says 200k.
        const catalog = anthropicCatalog(
          claude("claude-sonnet-4-5", 1_000_000),
          claude("claude-sonnet-4-6", 1_000_000),
          claude("claude-opus-5", 1_000_000),
          claude("claude-haiku-4-5", 200_000),
          claude("claude-sonnet-6", 1_000_000),
        )
        const driver = yield* anthropicDriverIn("1h")
        const listed = yield* listModelCatalog(
          { modelDrivers: new Map([[driver.id, driver]]), apiClasses: new Map() },
          { ...catalog, providerIds: ["anthropic"], failure: Option.none() },
        )
        expect(listed.models.map((model) => `${model.id} ${String(model.contextLength)}`)).toEqual([
          "anthropic/claude-sonnet-4-5 200000",
          "anthropic/claude-sonnet-4-6 1000000",
          "anthropic/claude-opus-5 1000000",
          "anthropic/claude-haiku-4-5 200000",
          "anthropic/claude-sonnet-6 1000000",
        ])
      }).pipe(Effect.provide(BunServices.layer)),
  )

  test("a driver's catalog names its provider's prompt-cache lifetime on each model", () => {
    const catalog = anthropicCatalog({
      id: "claude-opus-5",
      name: "Opus 5",
      limit: { context: 1_000_000 },
    })

    const models = catalogModels(catalog, "anthropic", Duration.minutes(5), MESSAGES_CLASS)

    expect(models.map((model) => model.promptCacheTtlMs)).toEqual([5 * 60_000])
  })

  it.live("a model takes the tool-image bound of the API class that speaks it", () =>
    Effect.gen(function* () {
      const compat: ModelDriverContribution = {
        id: "compat",
        name: "Compat",
        endpoint: () =>
          Effect.succeed({
            apiKey: Option.some("compat-key"),
            baseUrl: Option.none(),
            transformClient: Option.none(),
          }),
      }
      const catalog = catalogOf({
        id: "compat",
        name: "Compat",
        env: [],
        models: [
          { id: "chat-model", name: "Chat", npm: "@ai-sdk/openai-compatible" },
          { id: "messages-model", name: "Messages", npm: "@ai-sdk/anthropic" },
        ],
      })
      const listed = yield* listModelCatalog(
        { modelDrivers: new Map([[compat.id, compat]]), apiClasses: SHIPPED_API_CLASSES },
        { ...catalog, providerIds: ["compat"], failure: Option.none() },
      )
      // Chat Completions upstreams take fewer images; the Messages API keeps the default bound.
      expect(
        listed.models.map((model) => [String(model.id), Option.fromUndefinedOr(model.imageLimit)]),
      ).toEqual([
        ["compat/chat-model", Option.some({ images: 5, base64Chars: 4_000_000 })],
        ["compat/messages-model", Option.none()],
      ])
      const driverListed = catalogModels(
        catalogOf({ id: "compat", name: "Compat", env: [], models: [{ id: "x", name: "X" }] }),
        "compat",
        Duration.minutes(5),
        CHAT_COMPLETIONS_CLASS,
      )
      expect(driverListed.map((model) => model.imageLimit)).toEqual([
        { images: 5, base64Chars: 4_000_000 },
      ])
    }),
  )

  test("a model counts and sends each image as the API class that speaks it does", () => {
    const costOf = (id: string, apiClass: ApiClassContribution) =>
      catalogModels(
        catalogOf({ id: "p", name: "P", env: [], models: [{ id, name: id }] }),
        "p",
        Duration.minutes(5),
        apiClass,
      ).map((model) => [model.imageCost, Option.fromUndefinedOr(model.imagePartOptions)])
    const high = Option.some({ openai: { imageDetail: "high" } })
    // OpenAI tiles for gpt-4o-mini, at its own rates.
    expect(costOf("gpt-4o-mini", RESPONSES_CLASS)).toEqual([
      [{ _tag: "Tiles", baseTokens: 2_833, tileTokens: 5_667 }, high],
    ])
    expect(costOf("gpt-4o", RESPONSES_CLASS)).toEqual([
      [{ _tag: "Tiles", baseTokens: 85, tileTokens: 170 }, high],
    ])
    // Newer OpenAI models count patches, shrunk to the `high` detail's budget.
    expect(costOf("gpt-5.4", RESPONSES_CLASS)).toEqual([
      [{ _tag: "Patches", multiplier: 1.2, maxPatches: 2_500 }, high],
    ])
    expect(costOf("openai/gpt-4.1-mini", CHAT_COMPLETIONS_CLASS)).toEqual([
      [{ _tag: "Patches", multiplier: 1.62, maxPatches: 6_144 }, high],
    ])
    // Anthropic counts pixels and needs no part option.
    expect(costOf("claude-sonnet-4-5", MESSAGES_CLASS)).toEqual([
      [{ _tag: "Pixels", pixelsPerToken: 750 }, Option.none()],
    ])
  })

  test("every cost a shipped API class counts is one core bounds a class with no cost by", () => {
    // A model no table row names takes each class's default cost.
    const entry: CatalogModel = { id: "no-such-model", name: "None" }
    const shipped = [
      ...OPENAI_IMAGE_COSTS.map(([, cost]) => cost),
      openAiImageCost(entry),
      ...[...SHIPPED_API_CLASSES.values()].flatMap((apiClass) =>
        Option.toArray(Option.map(Option.fromUndefinedOr(apiClass.imageCost), (of) => of(entry))),
      ),
    ]
    for (const cost of shipped) expect(KNOWN_IMAGE_COSTS).toContainEqual(cost)
  })

  test("a model lists the effort levels its API class sends", () => {
    const efforts: CatalogModel["reasoningOptions"] = [
      { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] },
    ]
    const catalog = anthropicCatalog(
      // On by default: `none` turns thinking off.
      { id: "claude-opus-5", name: "Opus 5", reasoning: true, reasoningOptions: efforts },
      // Always on: `none` sends the lowest effort.
      { id: "claude-fable-5", name: "Fable 5", reasoning: true, reasoningOptions: efforts },
      // A budget only: a level picks the budget, so any level passes.
      {
        id: "claude-haiku-4-5",
        name: "Haiku 4.5",
        reasoning: true,
        reasoningOptions: [{ type: "budget_tokens", min: 1024 }],
      },
    )
    const openai = catalogOf({
      id: "openai",
      name: "OpenAI",
      env: [],
      models: [
        {
          id: "gpt-5.5-pro",
          name: "GPT-5.5 Pro",
          reasoning: true,
          reasoningOptions: [{ type: "effort", values: ["medium", "high", "xhigh"] }],
        },
      ],
    })
    const ttl = Duration.minutes(5)

    const models = [
      ...catalogModels(catalog, "anthropic", ttl, MESSAGES_CLASS),
      ...catalogModels(openai, "openai", ttl, RESPONSES_CLASS),
    ]
    const levels = (model: Model) => Option.fromUndefinedOr(model.efforts)
    expect(Object.fromEntries(models.map((model) => [model.id, levels(model)]))).toEqual({
      "anthropic/claude-opus-5": Option.some(["none", "low", "medium", "high", "xhigh", "max"]),
      "anthropic/claude-fable-5": Option.some(["low", "medium", "high", "xhigh", "max"]),
      "anthropic/claude-haiku-4-5": Option.none(),
      "openai/gpt-5.5-pro": Option.some(["medium", "high", "xhigh"]),
    })
  })

  it.live(
    "the Anthropic driver carries an effort change on a model that takes markers, while thinking stays planned the same",
    () =>
      Effect.gen(function* () {
        const driver = yield* anthropicDriverIn("1h")
        const carriesEffort = Option.getOrThrow(Option.fromUndefinedOr(driver.carriesEffort))
        const reasoningOptions: CatalogModel["reasoningOptions"] = [
          { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] },
        ]
        const catalog = anthropicCatalog(
          { id: "claude-opus-5", name: "Opus 5", reasoning: true, reasoningOptions },
          { id: "claude-sonnet-5", name: "Sonnet 5", reasoning: true, reasoningOptions },
          { id: "claude-sonnet-5-5", name: "Sonnet 5.5", reasoning: true, reasoningOptions },
          { id: "claude-opus-5-5", name: "Opus 5.5", reasoning: true, reasoningOptions },
        )
        const carries = (model: string, history: ReadonlyArray<RunEffort>) =>
          carriesEffort(
            model,
            {
              reasoning: "low",
              reasoningHistory: history.map(Option.some),
              cacheKey: "session",
              supportsReasoning: true,
            },
            catalog,
          )
        expect([
          carries("claude-opus-5", ["high"]),
          carries("claude-sonnet-5-5", ["high"]),
          // `none` turns thinking off on Opus 5: a move to low turns it on, at the top level.
          carries("claude-opus-5", ["none"]),
          // No markers before Sonnet 5.5.
          carries("claude-sonnet-5", ["high"]),
          // A run at the model's default was carried as a marker of the
          // level it runs at (high on Opus 5, medium on Opus 5.5): the top
          // level stays the first run's, so a later change rides on.
          carries("claude-opus-5", ["high", "default"]),
          carries("claude-opus-5-5", ["high", "default"]),
          // A first run at the default named no top level; the change keeps it unnamed.
          carries("claude-opus-5", ["default"]),
        ]).toEqual([true, true, false, false, true, true, true])
      }).pipe(Effect.provide(BunServices.layer)),
  )

  test("a driver lists only its own provider's models a turn can drive", () => {
    const catalog = catalogOf(
      {
        id: "openai",
        name: "OpenAI",
        env: ["OPENAI_API_KEY"],
        models: [
          { id: "gpt-5.4", name: "GPT-5.4", toolCall: true },
          // No flag means unknown, and the model stays.
          { id: "gpt-4o", name: "GPT-4o" },
          { id: "text-embedding-3-small", name: "text-embedding-3-small", toolCall: false },
          // A decision model answers typed decisions, never a turn.
          { id: "clef", name: "Clef", decision: true },
        ],
      },
      { id: "anthropic", name: "Anthropic", env: [], models: [{ id: "opus", name: "Opus" }] },
    )

    const ttl = Duration.minutes(5)
    expect(catalogModels(catalog, "openai", ttl, RESPONSES_CLASS).map((model) => model.id)).toEqual(
      [ModelId.make("openai/gpt-5.4"), ModelId.make("openai/gpt-4o")],
    )
    expect(catalogModels(catalog, "missing", ttl, RESPONSES_CLASS)).toEqual([])
  })

  it.live(
    "the Anthropic catalog names the lifetimes its markers ask for, 1 hour or 5 minutes with the switch, 5 minutes for a child, and prices each cache write by the lifetime it wrote",
    () =>
      Effect.gen(function* () {
        const catalog = anthropicCatalog({
          id: "claude-opus-5",
          name: "Opus 5",
          limit: { context: 1_000_000 },
          // models.dev prices a write at the 5-minute rate, 1.25x input.
          cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        })
        const lifetimes = (promptCacheTtl: "5m" | "1h") =>
          Effect.gen(function* () {
            const driver = yield* anthropicDriverIn(promptCacheTtl)
            const listModels = Option.getOrThrow(Option.fromUndefinedOr(driver.listModels))
            // The USD cost of the writes a response's usage reports, each at its lifetime's rate.
            const lifetimeWriteCostUsd = (model: Model, fiveMinutes: number, oneHour: number) => {
              const metadata = {
                anthropic: {
                  usage: {
                    cache_creation: {
                      ephemeral_5m_input_tokens: fiveMinutes,
                      ephemeral_1h_input_tokens: oneHour,
                    },
                  },
                },
              }
              const writes = driver.cacheWritesByLifetime?.(metadata) ?? []
              const rates = model.pricing?.cacheWriteByLifetime ?? []
              const cost = writes.reduce(
                (sum, write) =>
                  sum +
                  write.tokens * (rates.find((rate) => rate.ttlMs === write.ttlMs)?.price ?? 0),
                0,
              )
              return cost / 1_000_000
            }
            return (yield* listModels(catalog)).map((model) => ({
              lifetimeMs: model.promptCacheTtlMs,
              childLifetimeMs: model.childPromptCacheTtlMs,
              // 10,000 tokens written to the cache, in USD.
              writeCostUsd: (10_000 * (model.pricing?.cacheWrite ?? 0)) / 1_000_000,
              // A child writes 10,000 tokens for 5 minutes.
              childWriteCostUsd: lifetimeWriteCostUsd(model, 10_000, 0),
              // A child that also writes the shared part: 6,000 for 5 minutes, 4,000 for 1 hour.
              mixedWriteCostUsd: lifetimeWriteCostUsd(model, 6_000, 4_000),
            }))
          })
        // A 1-hour write costs 2x input, a 5-minute one 1.25x. A child asks for 5 minutes.
        const lifetimeCosts = {
          childWriteCostUsd: 0.0625,
          mixedWriteCostUsd: (6_000 * 6.25 + 4_000 * 10) / 1_000_000,
        }
        expect(yield* lifetimes("1h")).toEqual([
          {
            lifetimeMs: 60 * 60_000,
            childLifetimeMs: 5 * 60_000,
            writeCostUsd: 0.1,
            ...lifetimeCosts,
          },
        ])
        expect(yield* lifetimes("5m")).toEqual([
          {
            lifetimeMs: 5 * 60_000,
            childLifetimeMs: 5 * 60_000,
            writeCostUsd: 0.0625,
            ...lifetimeCosts,
          },
        ])
      }).pipe(Effect.timeout("5 seconds"), Effect.provide(BunServices.layer)),
  )
})

// ── generic providers ───────────────────────────────────────────────────────

/**
 * A models.dev provider with no adapter (DeepSeek in the fixture) runs on
 * the class that speaks its package, with a key and no code. Core's
 * `tests/runtime/provider.test.ts` ("generic providers") covers activation,
 * `${VAR}` prompts and the config entries; these run the shipped classes.
 */
describe("generic providers on the shipped classes", () => {
  const chatReply = () => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: encodeExternalJson({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1_700_000_000,
      model: "deepseek-v4-pro",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  })

  const deepseekRequest = (stored: Record<string, string>, env: Record<string, string>) =>
    Effect.gen(function* () {
      const state = makeFakeFetchState()
      const model = storedCredentialModel({
        modelDrivers: [],
        apiClasses: [...SHIPPED_API_CLASSES.values()],
        stored,
        modelId: "deepseek/deepseek-v4-pro",
        catalog: fixtureModelCatalog(),
      }).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))))
      yield* oneGenerate(model, state, chatReply)
      return state.captured.map((request) => [request.url, request.headers["authorization"]])
    })

  it.live("DeepSeek's request goes to its catalog URL over Chat Completions with its key", () =>
    Effect.gen(function* () {
      expect(yield* deepseekRequest({}, { DEEPSEEK_API_KEY: "sk-env" })).toEqual([
        ["https://api.deepseek.com/chat/completions", "Bearer sk-env"],
      ])
      expect(
        yield* deepseekRequest({ deepseek: "sk-stored" }, { DEEPSEEK_API_KEY: "sk-env" }),
      ).toEqual([["https://api.deepseek.com/chat/completions", "Bearer sk-stored"]])
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  it.live(
    "with DEEPSEEK_API_KEY set, the shipped extensions list DeepSeek's models and its /auth row over RPC",
    () =>
      Effect.gen(function* () {
        const listed = (env: Record<string, string>) =>
          Effect.gen(function* () {
            const fixture = yield* modelCatalogFixture
            const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
            const { client, sessionId } = yield* createRpcHarness({
              ...shippedPreset,
              modelCatalogHttpLayer: fixture.layer,
              providerLayer,
            })
            const models = (yield* client.model.list({ sessionId })).map((model) => model.id)
            const rows = (yield* client.auth.listProviders({ sessionId })).map((row) => [
              String(row.provider),
              row.source ?? "none",
            ])
            const search = (yield* client.auth.listCatalogProviders({ sessionId })).providers.map(
              (row) => String(row.provider),
            )
            return { models, rows, search }
          }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))))

        const withKey = yield* listed({ DEEPSEEK_API_KEY: "sk-env" })
        expect(withKey.models).toContain(ModelId.make("deepseek/deepseek-v4-pro"))
        expect(withKey.models).not.toContain(ModelId.make("google/gemini-3.6-flash"))
        expect(withKey.rows).toContainEqual(["deepseek", "env"])
        expect(withKey.search).not.toContain("deepseek")

        const without = yield* listed({})
        expect(without.models).not.toContain(ModelId.make("deepseek/deepseek-v4-pro"))
        expect(without.rows.map(([provider]) => provider)).not.toContain("deepseek")
        // The search offers it; no class speaks Google's package, so it is not offered.
        expect(without.search).toContain("deepseek")
        expect(without.search).not.toContain("google")
      }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
  )
})

describe("freshEnoughAt", () => {
  // A token in its last minute is refreshed before it goes on the wire.
  const now = 1_700_000_000_000

  test("true when expiry is more than 60s away", () => {
    expect(freshEnoughAt(now + 61_000, now)).toBe(true)
  })

  test("false at exactly the 60s threshold", () => {
    expect(freshEnoughAt(now + 60_000, now)).toBe(false)
  })

  test("false when expiry is in the past", () => {
    expect(freshEnoughAt(now - 1, now)).toBe(false)
  })
})

// ── credential cache ────────────────────────────────────────────────────────

/**
 * `makeCredentialCache` as both OAuth drivers build it. A cache whose cell
 * cannot serve finds the credential in one of two sources: a keychain it
 * reads (Anthropic), or the gent auth store it reads and writes under the
 * store lock (OpenAI). Each case runs over both. The driver files keep only
 * what their adapters add: the OpenAI account id and the keychain order.
 */

const TestCredentials = Schema.Struct({
  access: Schema.String,
  refresh: Schema.String,
  expires: Schema.Finite,
})
type TestCredentials = typeof TestCredentials.Type

/** The test clock starts at 0, so an expiry is an offset from the start. */
const FAR_FUTURE_MS = 10 * 60 * 1000
const EXPIRING_SOON_MS = 30_000
const credentialsNamed = (name: string, expires: number): TestCredentials => ({
  access: `${name}-access`,
  refresh: `${name}-refresh`,
  expires,
})

const SOURCES = ["keychain", "auth store"] as const
type Source = (typeof SOURCES)[number]

/** A cache over a fresh cell; `source.current` is what the keychain or store holds. */
const sourcedCache = (
  kind: Source,
  initial: TestCredentials,
  refresh: (
    held: Option.Option<TestCredentials>,
  ) => Effect.Effect<TestCredentials, CredentialFailure>,
) =>
  Effect.gen(function* () {
    const source = { current: initial }
    const cellRef =
      yield* SynchronizedRef.make<CredentialCacheCell<TestCredentials>>(EMPTY_CREDENTIAL_CELL)
    const lock = yield* Semaphore.make(1)
    let read =
      Option.none<
        (cached: Option.Option<TestCredentials>) => Effect.Effect<Option.Option<TestCredentials>>
      >()
    let store = Option.none<CredentialStore<TestCredentials>>()
    if (kind === "keychain")
      read = Option.some(() => Effect.sync(() => Option.some(source.current)))
    if (kind === "auth store")
      store = Option.some({
        update: (f) =>
          Effect.gen(function* () {
            const [answer, write] = yield* f(Option.some(source.current))
            if (Option.isSome(write)) source.current = write.value
            return answer
          }).pipe((update) => lock.withPermit(update)),
        same: (a, b) => a.refresh === b.refresh,
      })
    // A keychain refresh, as Claude Code's does, starts from the keychain's
    // token when the cell holds none, and writes the keychain.
    let refreshFrom = refresh
    if (kind === "keychain")
      refreshFrom = (held) =>
        refresh(Option.orElse(held, () => Option.some(source.current))).pipe(
          Effect.tap((fresh) =>
            Effect.sync(() => {
              source.current = fresh
            }),
          ),
        )
    const cache = yield* makeCredentialCache({
      label: "Test",
      credentials: TestCredentials,
      cellRef,
      expiresAt: (credentials) => credentials.expires,
      read,
      refresh: refreshFrom,
      store,
    })
    return { cache, source }
  })

const onTestClock = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(Effect.provide(TestClock.layer()), Effect.timeout("3 seconds"))

for (const kind of SOURCES) {
  describe(`credential cache over a ${kind}`, () => {
    it.live("a credential inside the cache lifetime is served though the source changed", () =>
      onTestClock(
        Effect.gen(function* () {
          const { cache, source } = yield* sourcedCache(
            kind,
            credentialsNamed("k1", FAR_FUTURE_MS),
            () => Effect.die(new Error("no refresh expected")),
          )
          expect((yield* cache.getFresh).access).toBe("k1-access")
          source.current = credentialsNamed("k2", FAR_FUTURE_MS)
          expect((yield* cache.getFresh).access).toBe("k1-access")
        }),
      ),
    )

    it.live("callers that find a stale credential at once share one refresh", () =>
      onTestClock(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          let refreshes = 0
          const { cache } = yield* sourcedCache(
            kind,
            credentialsNamed("seed", EXPIRING_SOON_MS),
            () =>
              Effect.gen(function* () {
                refreshes += 1
                yield* Deferred.succeed(started, void 0)
                yield* Deferred.await(release)
                return credentialsNamed("fresh", FAR_FUTURE_MS)
              }),
          )
          const both = yield* Effect.forkChild(
            Effect.all([cache.getFresh, cache.getFresh], { concurrency: 2 }),
          )
          yield* Deferred.await(started)
          yield* Deferred.succeed(release, void 0)
          const results = yield* Fiber.join(both)
          expect(results.map((credentials) => credentials.access)).toEqual([
            "fresh-access",
            "fresh-access",
          ])
          expect(refreshes).toBe(1)
        }),
      ),
    )

    it.live("a credential in its last minute is refreshed with its own refresh token", () =>
      onTestClock(
        Effect.gen(function* () {
          const used: Array<string> = []
          const { cache } = yield* sourcedCache(
            kind,
            credentialsNamed("seed", EXPIRING_SOON_MS),
            (held) =>
              Effect.sync(() => {
                used.push(Option.match(held, { onNone: () => "", onSome: (h) => h.refresh }))
                return credentialsNamed("fresh", FAR_FUTURE_MS)
              }),
          )
          expect((yield* cache.getFresh).access).toBe("fresh-access")
          expect(used).toEqual(["seed-refresh"])
        }),
      ),
    )

    it.live("a failed refresh reaches the caller and the rotated refresh token stays", () =>
      onTestClock(
        Effect.gen(function* () {
          const used: Array<string> = []
          const answers: ReadonlyArray<Effect.Effect<TestCredentials, CredentialFailure>> = [
            Effect.succeed(credentialsNamed("rotated", EXPIRING_SOON_MS)),
            Effect.fail(new ProviderAuthError({ message: "OAuth 401 from refresh" })),
            Effect.succeed(credentialsNamed("third", FAR_FUTURE_MS)),
          ]
          const { cache } = yield* sourcedCache(
            kind,
            credentialsNamed("seed", EXPIRING_SOON_MS),
            (held) =>
              Effect.suspend(() => {
                used.push(Option.match(held, { onNone: () => "", onSome: (h) => h.refresh }))
                return answers[used.length - 1] ?? Effect.die(new Error("one refresh too many"))
              }),
          )
          expect((yield* cache.getFresh).access).toBe("rotated-access")
          const failure = yield* Effect.flip(cache.getFresh)
          expect(failure.message).toContain("401")
          expect((yield* cache.getFresh).access).toBe("third-access")
          // A cleared cell would send the spent seed token the third time.
          expect(used).toEqual(["seed-refresh", "rotated-refresh", "rotated-refresh"])
        }),
      ),
    )

    it.live("a rejected credential is refreshed on the next call, though it has not expired", () =>
      onTestClock(
        Effect.gen(function* () {
          let refreshes = 0
          const seed = credentialsNamed("seed", FAR_FUTURE_MS)
          const { cache } = yield* sourcedCache(kind, seed, () =>
            Effect.sync(() => {
              refreshes += 1
              return credentialsNamed("fresh", FAR_FUTURE_MS)
            }),
          )
          expect((yield* cache.getFresh).access).toBe("seed-access")
          yield* cache.invalidate(seed)
          expect((yield* cache.getFresh).access).toBe("fresh-access")
          expect(refreshes).toBe(1)
        }),
      ),
    )

    it.live("a caller stopped after the provider rotated the token still stores the rotation", () =>
      onTestClock(
        Effect.gen(function* () {
          const used: Array<string> = []
          const rotated = yield* Deferred.make<void>()
          const answered = yield* Deferred.make<void>()
          const answers = [
            credentialsNamed("rotated", EXPIRING_SOON_MS),
            credentialsNamed("third", FAR_FUTURE_MS),
          ]
          const { cache } = yield* sourcedCache(
            kind,
            credentialsNamed("seed", EXPIRING_SOON_MS),
            (held) =>
              Effect.gen(function* () {
                used.push(Option.match(held, { onNone: () => "", onSome: (h) => h.refresh }))
                const answer = Option.fromUndefinedOr(answers[used.length - 1])
                if (Option.isNone(answer))
                  return yield* Effect.die(new Error("one refresh too many"))
                if (used.length > 1) return answer.value
                // The provider spent the token it was sent; its answer is on the way back.
                yield* Deferred.succeed(rotated, void 0)
                yield* Deferred.await(answered)
                return answer.value
              }),
          )
          const first = yield* Effect.forkChild(cache.getFresh)
          yield* Deferred.await(rotated)
          // Stop the caller (an Esc during the model build) while the answer is in flight.
          const stopping = yield* Effect.forkChild(Fiber.interrupt(first), {
            startImmediately: true,
          })
          yield* Deferred.succeed(answered, void 0)
          yield* Fiber.join(stopping)

          // The rotation was stored, so the next refresh sends the rotated token, not the spent one.
          expect((yield* cache.getFresh).access).toBe("third-access")
          expect(used).toEqual(["seed-refresh", "rotated-refresh"])
        }),
      ),
    )
  })
}

describe("API-only credential selection", () => {
  test("unsupported named OAuth cannot impersonate the ambient API key", () => {
    const update = () => Effect.die("the pure API selector must not read OAuth")
    const named = ProviderAuthInfo.cases.Oauth.make({
      slot: CredentialSlot.make("personal"),
      update,
    })
    const omitted = ProviderAuthInfo.cases.Oauth.make({ update })
    const legacy = ProviderAuthInfo.cases.Oauth.make({
      slot: CredentialSlot.make("default"),
      update,
    })
    const ambient = Option.some("fake-ambient")
    expect(Option.isNone(apiKeyFrom(Option.some(named), ambient))).toBe(true)
    for (const auth of [
      Option.none<ProviderAuthInfo>(),
      Option.some(omitted),
      Option.some(legacy),
    ]) {
      expect(Option.contains(apiKeyFrom(auth, ambient), "fake-ambient")).toBe(true)
    }
    const api = ProviderAuthInfo.cases.Api.make({
      key: "fake-named",
      slot: CredentialSlot.make("personal"),
    })
    expect(Option.contains(apiKeyFrom(Option.some(api), ambient), "fake-named")).toBe(true)
  })
})
