import { describe, expect, it } from "effect-bun-test"
import { Effect, FileSystem, Layer, Path, Ref, Schema } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Model, ModelId, ProviderId } from "@gent/core/extensions/api"
import { makeTempDirectoryScoped } from "@gent/core-internal/test-utils/language-model"
import { driverCatalog, modelsDevCatalog } from "../src/models-dev.js"

// ── models-dev.test ─────────────────────────────────────────────────────────

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

const platformLayer = Layer.merge(BunFileSystem.layer, Path.layer)

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
      // oxlint-disable-next-line effect/noInlineProvide -- This test composes the platform layer for this operation.
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
      // oxlint-disable-next-line effect/noInlineProvide -- This test composes the platform layer for this operation.
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
      // oxlint-disable-next-line effect/noInlineProvide -- This test composes the platform layer for this operation.
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
      // oxlint-disable-next-line effect/noInlineProvide -- This test composes the platform layer for this operation.
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
      // oxlint-disable-next-line effect/noInlineProvide -- This test composes the platform layer for this operation.
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
      // oxlint-disable-next-line effect/noInlineProvide -- This test composes the platform layer for this operation.
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
      // oxlint-disable-next-line effect/noInlineProvide -- This test composes the platform layer for this operation.
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
      // oxlint-disable-next-line effect/noInlineProvide -- This test composes the platform layer for this operation.
    }).pipe(Effect.provide(platformLayer)),
  )

  it.scopedLive("two drivers on one home share a single fetch", () =>
    Effect.gen(function* () {
      const home = yield* freshHome("memo")
      const calls = yield* Ref.make(0)
      // oxlint-disable-next-line effect/noInlineProvide -- This test composes the HTTP stub for this operation.
      const http = Effect.provide(countingHttpLayer(calls, encodeAnyJson(remotePayload)))

      const openai = yield* driverCatalog(home, "openai").pipe(http)
      const anthropic = yield* driverCatalog(home, "anthropic").pipe(http)

      expect(yield* Ref.get(calls)).toBe(1)
      expect(openai.map((model) => model.id)).toEqual([ModelId.make("openai/gpt-5.4")])
      expect(anthropic.map((model) => model.id)).toEqual([ModelId.make("anthropic/claude-opus-5")])
      // oxlint-disable-next-line effect/noInlineProvide -- This test composes the platform layer for this operation.
    }).pipe(Effect.provide(platformLayer)),
  )
})
