import { describe, expect, it, test } from "effect-bun-test"
import { Deferred, Effect, Fiber, FileSystem, Layer, Path, Ref, Schema } from "effect"
import {
  Model,
  type ModelDriverContribution,
  ModelId,
  type ProviderAuthInfo,
  ProviderId,
} from "@gent/core/extensions/api"
import {
  collectTestContributions,
  type FakeFetchState,
  makeFakeFetchState,
  makeTempDirectoryScoped,
  oneGenerate,
} from "@gent/core/test-utils"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { BunFileSystem } from "@effect/platform-bun"
import {
  driverCatalog,
  freshEnoughAt,
  GoogleExtension,
  MistralExtension,
  modelsDevCatalog,
} from "../src/providers.js"
import { encodeExternalJson } from "./helpers/external-wire.js"

// ── openai-compatible-providers.test ────────────────────────────────────────

const makeApiAuthInfo = (key: string): ProviderAuthInfo => ({
  type: "api",
  key,
})

const chatHappyResponse = (model: string) => ({
  status: 200,
  body: encodeExternalJson({
    id: "chatcmpl-test-1",
    object: "chat.completion",
    created: 1_700_000_000,
    model,
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

const onlyDriver = (drivers: ReadonlyArray<ModelDriverContribution>): ModelDriverContribution => {
  expect(drivers).toHaveLength(1)
  return drivers[0]!
}

const runOne = (model: Parameters<typeof oneGenerate>[0], state: FakeFetchState) =>
  oneGenerate(model, state, () => chatHappyResponse("compat-model")).pipe(Effect.orDie)

/** Extension setup reads its models.dev cache path, so it needs the platform. */
const platformLayer = Layer.merge(BunFileSystem.layer, Path.layer)

describe("OpenAI-compatible provider drivers", () => {
  it.live("Google uses the Gemini OpenAI-compatible endpoint", () =>
    Effect.gen(function* () {
      const contributions = yield* collectTestContributions(GoogleExtension.setup)
      const driver = onlyDriver(contributions.modelDrivers ?? [])
      const model = yield* driver.resolveModel("gemini-2.5-pro", makeApiAuthInfo("google-key"), {
        cacheKey: "session-cache-key",
      })
      const fetchState = makeFakeFetchState()
      yield* runOne(model, fetchState)
      const request = fetchState.captured.at(-1)!
      expect(request.url).toBe(
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      )
      expect(request.headers["authorization"]).toBe("Bearer google-key")
      expect(request.body).not.toContain("prompt_cache_key")
    }).pipe(Effect.provide(platformLayer)),
  )

  it.live("Mistral uses the Mistral OpenAI-compatible endpoint", () =>
    Effect.gen(function* () {
      const contributions = yield* collectTestContributions(MistralExtension.setup)
      const driver = onlyDriver(contributions.modelDrivers ?? [])
      const model = yield* driver.resolveModel(
        "mistral-large-latest",
        makeApiAuthInfo("mistral-key"),
        { cacheKey: "session-cache-key" },
      )
      const fetchState = makeFakeFetchState()
      yield* runOne(model, fetchState)
      const request = fetchState.captured.at(-1)!
      expect(request.url).toBe("https://api.mistral.ai/v1/chat/completions")
      expect(request.headers["authorization"]).toBe("Bearer mistral-key")
      expect(request.body).not.toContain("prompt_cache_key")
    }).pipe(Effect.provide(platformLayer)),
  )
})

// ── models.dev catalog ──────────────────────────────────────────────────────

/**
 * The models.dev catalog a driver serves from `listModels`.
 *
 * Covers the disk cache, the 24 h staleness rule, the shape written back, and
 * the per-home memo two drivers share. These behaviors used to live in
 * `packages/core/tests/runtime/provider.test.ts`; they moved here with the
 * code, because the catalog belongs to the driver, not to the kernel.
 */

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000
const CachedModelsJson = Schema.fromJsonString(Schema.Array(Model))
const encodeCachedModels = Schema.encodeSync(CachedModelsJson)
const AnyJson = Schema.fromJsonString(Schema.Unknown)
const encodeAnyJson = Schema.encodeSync(AnyJson)

const remotePayload = {
  openai: {
    models: {
      "gpt-5.4": {
        name: "GPT-5.4",
        cost: { input: 1.25, output: 10 },
        limit: { context: 400_000 },
        release_date: "2026-07-24",
      },
      broken: { name: 42 },
    },
  },
  anthropic: {
    models: {
      "claude-opus-5": {
        name: "Claude Opus 5",
        limit: { context: 1_000_000 },
        release_date: "2026-07-24",
      },
    },
  },
  // oxlint-disable-next-line effect/noNullish -- Keep the null value required by this external data contract.
  brokenProvider: { models: null },
}

/** An HTTP client that answers every call with `body` and counts the calls. */
const countingHttpLayer = (calls: Ref.Ref<number>, body: string) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        yield* Ref.update(calls, (n) => n + 1)
        return HttpClientResponse.fromWeb(request, new Response(body, { status: 200 }))
      }),
    ),
  )

/**
 * An HTTP client that counts the call, then waits for `gate` before it
 * answers. Every caller that reaches it is still in flight until the gate
 * opens, so the count reflects how many callers got past the memo.
 */
const gatedHttpLayer = (calls: Ref.Ref<number>, gate: Deferred.Deferred<void>, body: string) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        yield* Ref.update(calls, (n) => n + 1)
        yield* Deferred.await(gate)
        return HttpClientResponse.fromWeb(request, new Response(body, { status: 200 }))
      }),
    ),
  )

/** An HTTP client that always fails the request. */
const failingHttpLayer = (calls: Ref.Ref<number>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        yield* Ref.update(calls, (n) => n + 1)
        return HttpClientResponse.fromWeb(request, new Response("", { status: 500 }))
      }),
    ),
  )

const cachePathIn = (home: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    return path.join(home, ".gent/models.json")
  })

const writeCache = Effect.fn("test.writeCache")(function* (home: string, text: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const cachePath = yield* cachePathIn(home)
  yield* fs.makeDirectory(path.dirname(cachePath), { recursive: true })
  yield* fs.writeFileString(cachePath, text)
  return cachePath
})

/** Push a cache file's mtime two days back, so the next load treats it as stale. */
const ageCacheTwoDays = Effect.fn("test.ageCache")(function* (cachePath: string) {
  const fs = yield* FileSystem.FileSystem
  const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
  // `utimes` takes seconds, not milliseconds.
  const stale = (now - TWO_DAYS_MS) / 1000
  yield* fs.utimes(cachePath, stale, stale)
})

/** A fresh home directory. Each test gets its own so the per-home memo is new. */
const freshHome = (label: string) => makeTempDirectoryScoped(`models-dev-${label}-`)

describe("models.dev catalog", () => {
  it.scopedLive("serves a fresh cache from disk without fetching", () =>
    Effect.gen(function* () {
      const home = yield* freshHome("disk")
      yield* writeCache(
        home,
        encodeCachedModels([
          Model.make({
            id: ModelId.make("openai/gpt-5.4"),
            name: "GPT-5.4",
            provider: ProviderId.make("openai"),
            contextLength: 400_000,
          }),
        ]),
      )
      const calls = yield* Ref.make(0)

      const models = yield* modelsDevCatalog(home).pipe(
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the HTTP stub for this operation.
        Effect.provide(countingHttpLayer(calls, encodeAnyJson(remotePayload))),
      )

      expect(models).toHaveLength(1)
      expect(models[0]?.id).toBe(ModelId.make("openai/gpt-5.4"))
      expect(models[0]?.name).toBe("GPT-5.4")
      expect(yield* Ref.get(calls)).toBe(0)
    }).pipe(Effect.provide(platformLayer)),
  )

  it.scopedLive("a cache older than a day refetches and rewrites the canonical models", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* freshHome("stale")
      const cachePath = yield* writeCache(
        home,
        encodeCachedModels([
          Model.make({
            id: ModelId.make("openai/gpt-4.1"),
            name: "GPT-4.1",
            provider: ProviderId.make("openai"),
            contextLength: 256_000,
          }),
        ]),
      )
      yield* ageCacheTwoDays(cachePath)
      const calls = yield* Ref.make(0)

      const models = yield* modelsDevCatalog(home).pipe(
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the HTTP stub for this operation.
        Effect.provide(countingHttpLayer(calls, encodeAnyJson(remotePayload))),
      )

      expect(yield* Ref.get(calls)).toBe(1)
      expect(models.map((model) => model.id)).toContain(ModelId.make("openai/gpt-5.4"))
      expect(models.map((model) => model.id)).not.toContain(ModelId.make("openai/gpt-4.1"))

      // The cache holds gent's canonical `Model[]`, never the raw payload.
      const written = yield* fs.readFileString(cachePath)
      const decoded = yield* Schema.decodeEffect(CachedModelsJson)(written)
      expect(decoded.map((model) => model.id)).toContain(ModelId.make("openai/gpt-5.4"))
      expect(written.includes('"openai":{"models"')).toBe(false)
    }).pipe(Effect.provide(platformLayer)),
  )

  it.scopedLive("a malformed cache is ignored and the remote payload replaces it", () =>
    Effect.gen(function* () {
      const home = yield* freshHome("malformed")
      yield* writeCache(home, '{"openai":{"models":{}}}')
      const calls = yield* Ref.make(0)

      const models = yield* modelsDevCatalog(home).pipe(
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the HTTP stub for this operation.
        Effect.provide(countingHttpLayer(calls, encodeAnyJson(remotePayload))),
      )

      expect(yield* Ref.get(calls)).toBe(1)
      expect(models.map((model) => model.id)).toContain(ModelId.make("openai/gpt-5.4"))
    }).pipe(Effect.provide(platformLayer)),
  )

  it.scopedLive("a failed fetch serves the stale catalog still on disk", () =>
    Effect.gen(function* () {
      const home = yield* freshHome("offline")
      const cachePath = yield* writeCache(
        home,
        encodeCachedModels([
          Model.make({
            id: ModelId.make("openai/gpt-4.1"),
            name: "GPT-4.1",
            provider: ProviderId.make("openai"),
            contextLength: 256_000,
          }),
        ]),
      )
      yield* ageCacheTwoDays(cachePath)
      const calls = yield* Ref.make(0)

      const models = yield* modelsDevCatalog(home).pipe(
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the HTTP stub for this operation.
        Effect.provide(failingHttpLayer(calls)),
      )

      expect(yield* Ref.get(calls)).toBe(1)
      expect(models.map((model) => model.id)).toEqual([ModelId.make("openai/gpt-4.1")])
    }).pipe(Effect.provide(platformLayer)),
  )

  it.scopedLive("no cache and a failed fetch give an empty catalog", () =>
    Effect.gen(function* () {
      const home = yield* freshHome("empty")
      const calls = yield* Ref.make(0)

      const models = yield* modelsDevCatalog(home).pipe(
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the HTTP stub for this operation.
        Effect.provide(failingHttpLayer(calls)),
      )

      expect(models).toEqual([])
    }).pipe(Effect.provide(platformLayer)),
  )

  it.scopedLive("carries the release date onto the parsed model", () =>
    Effect.gen(function* () {
      const home = yield* freshHome("release-date")
      const calls = yield* Ref.make(0)

      const models = yield* modelsDevCatalog(home).pipe(
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the HTTP stub for this operation.
        Effect.provide(countingHttpLayer(calls, encodeAnyJson(remotePayload))),
      )

      const opus = models.find((model) => model.id === "anthropic/claude-opus-5")
      expect(opus?.releaseDate).toBe("2026-07-24")
    }).pipe(Effect.provide(platformLayer)),
  )

  it.scopedLive("a cache written before release dates existed still loads", () =>
    Effect.gen(function* () {
      const home = yield* freshHome("no-release-date")
      // Exactly the shape every shipped cache already on disk has: no
      // releaseDate key at all. It must still decode.
      yield* writeCache(
        home,
        '[{"id":"openai/gpt-5.4","name":"GPT-5.4","provider":"openai","contextLength":400000}]',
      )
      const calls = yield* Ref.make(0)

      const models = yield* modelsDevCatalog(home).pipe(
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the HTTP stub for this operation.
        Effect.provide(countingHttpLayer(calls, encodeAnyJson(remotePayload))),
      )

      expect(models).toHaveLength(1)
      expect(models[0]?.id).toBe(ModelId.make("openai/gpt-5.4"))
      expect(models[0]?.releaseDate).toBeUndefined()
      expect(yield* Ref.get(calls)).toBe(0)
    }).pipe(Effect.provide(platformLayer)),
  )

  it.scopedLive("driverCatalog serves only the driver's own provider", () =>
    Effect.gen(function* () {
      const home = yield* freshHome("per-provider")
      const calls = yield* Ref.make(0)

      const anthropic = yield* driverCatalog(home, "anthropic").pipe(
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the HTTP stub for this operation.
        Effect.provide(countingHttpLayer(calls, encodeAnyJson(remotePayload))),
      )

      expect(anthropic.map((model) => model.id)).toEqual([ModelId.make("anthropic/claude-opus-5")])
    }).pipe(Effect.provide(platformLayer)),
  )

  it.scopedLive("two drivers on one home share a single fetch", () =>
    Effect.gen(function* () {
      const home = yield* freshHome("memo")
      const calls = yield* Ref.make(0)
      // The gate holds every request open until the test releases it. Both
      // drivers are therefore still in flight when the count is taken, so the
      // first load's disk write cannot serve the second caller and stand in
      // for the memo. Without the memo store this test sees 2 calls.
      const gate = yield* Deferred.make<void>()
      const gated = gatedHttpLayer(calls, gate, encodeAnyJson(remotePayload))
      // oxlint-disable-next-line effect/noInlineProvide -- This test composes the HTTP stub for this operation.
      const http = Effect.provide(gated)

      const both = yield* Effect.forkChild(
        Effect.all(
          [driverCatalog(home, "openai").pipe(http), driverCatalog(home, "anthropic").pipe(http)],
          {
            concurrency: "unbounded",
          },
        ),
      )
      // Let both callers reach the catalog before anything can answer.
      yield* Effect.yieldNow
      // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
      yield* Deferred.succeed(gate, undefined)
      const [openai, anthropic] = yield* Fiber.join(both).pipe(Effect.timeout(5_000))

      expect(yield* Ref.get(calls)).toBe(1)
      expect(openai.map((model) => model.id)).toEqual([ModelId.make("openai/gpt-5.4")])
      expect(anthropic.map((model) => model.id)).toEqual([ModelId.make("anthropic/claude-opus-5")])
    }).pipe(Effect.provide(platformLayer)),
  )

  it.scopedLive("an offline load is not memoized; the next load reaches the host", () =>
    Effect.gen(function* () {
      const home = yield* freshHome("recovers")
      const offlineCalls = yield* Ref.make(0)

      const offline = yield* modelsDevCatalog(home).pipe(
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the HTTP stub for this operation.
        Effect.provide(failingHttpLayer(offlineCalls)),
      )

      expect(offline).toEqual([])
      expect(yield* Ref.get(offlineCalls)).toBe(1)

      // The host is reachable again. An empty first load must not have pinned
      // an empty catalog for the life of the process.
      const onlineCalls = yield* Ref.make(0)
      const online = yield* modelsDevCatalog(home).pipe(
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the HTTP stub for this operation.
        Effect.provide(countingHttpLayer(onlineCalls, encodeAnyJson(remotePayload))),
      )

      expect(yield* Ref.get(onlineCalls)).toBe(1)
      expect(online.map((model) => model.id)).toContain(ModelId.make("openai/gpt-5.4"))
    }).pipe(Effect.provide(platformLayer)),
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
