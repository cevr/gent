import { describe, expect, it, test } from "effect-bun-test"
import {
  Clock,
  Context,
  type Crypto,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
  SynchronizedRef,
} from "effect"
import { Model, ModelId, ProviderId } from "@gent/core/extensions/api"
import { makeTempDirectoryScoped } from "@gent/core/test-utils"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { TestClock } from "effect/testing"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import type { ChildProcessSpawner } from "effect/unstable/process"
import {
  type CredentialCacheCell,
  driverCatalog,
  EMPTY_CREDENTIAL_CELL,
  freshEnoughAt,
  modelsDevCatalog,
} from "../src/providers.js"
import {
  AnthropicPlatform,
  buildAnthropicModelDriver,
  type ClaudeCredentials,
} from "../src/anthropic.js"

/** The models.dev catalog reads its cache path, so it needs the platform. */
const platformLayer = Layer.merge(BunFileSystem.layer, Path.layer)

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
/** A cache file from a build before the format stamp: a bare `Model[]`. */
const UnstampedCacheJson = Schema.fromJsonString(Schema.Array(Model))
const encodeUnstampedCache = Schema.encodeSync(UnstampedCacheJson)
const StampedCacheJson = Schema.fromJsonString(
  Schema.Struct({ format: Schema.String, models: Schema.Array(Model) }),
)
const AnyJson = Schema.fromJsonString(Schema.Unknown)
const encodeAnyJson = Schema.encodeSync(AnyJson)

const remotePayload = {
  openai: {
    models: {
      "gpt-5.4": {
        name: "GPT-5.4",
        cost: { input: 1.25, output: 10 },
        limit: { context: 400_000, input: 272_000, output: 128_000 },
        release_date: "2026-07-24",
        tool_call: true,
        reasoning: true,
      },
      "gpt-4o": {
        name: "GPT-4o",
        limit: { context: 128_000 },
        tool_call: true,
        reasoning: false,
      },
      "text-embedding-3-small": {
        name: "text-embedding-3-small",
        cost: { input: 0.02, output: 0 },
        tool_call: false,
      },
      broken: { name: 42 },
    },
  },
  anthropic: {
    models: {
      "claude-opus-5": {
        name: "Claude Opus 5",
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
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

/**
 * The format this build stamps on its cache, read back from a file the
 * catalog wrote itself, so the test never restates how the stamp is derived.
 */
const currentCacheFormat = Effect.fn("test.currentCacheFormat")(function* () {
  const fs = yield* FileSystem.FileSystem
  const home = yield* freshHome("format")
  const calls = yield* Ref.make(0)
  yield* modelsDevCatalog(home).pipe(
    Effect.provide(countingHttpLayer(calls, encodeAnyJson(remotePayload))),
  )
  const written = yield* fs.readFileString(yield* cachePathIn(home))
  return (yield* Schema.decodeEffect(StampedCacheJson)(written)).format
})

/** A cache file in this build's format. */
const stampedCache = Effect.fn("test.stampedCache")(function* (models: ReadonlyArray<Model>) {
  const format = yield* currentCacheFormat()
  return yield* Schema.encodeEffect(StampedCacheJson)({ format, models })
})

describe("models.dev catalog", () => {
  it.scopedLive("serves a fresh cache from disk without fetching", () =>
    Effect.gen(function* () {
      const home = yield* freshHome("disk")
      yield* writeCache(
        home,
        yield* stampedCache([
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
        Effect.provide(countingHttpLayer(calls, encodeAnyJson(remotePayload))),
      )

      expect(models).toHaveLength(1)
      expect(models[0]?.id).toBe(ModelId.make("openai/gpt-5.4"))
      expect(models[0]?.name).toBe("GPT-5.4")
      expect(yield* Ref.get(calls)).toBe(0)
    }).pipe(Effect.provide(platformLayer)),
  )

  it.scopedLive(
    "the Anthropic driver lists a documented 200k model, and a model outside the 1M families, at 200k, whatever the catalog says",
    () =>
      Effect.gen(function* () {
        const home = yield* freshHome("anthropic-window")
        const claude = (key: string, contextLength: number) =>
          Model.make({
            id: ModelId.make(`anthropic/${key}`),
            name: key,
            provider: ProviderId.make("anthropic"),
            contextLength,
          })
        // models.dev lists Sonnet 4.5 at 1M; platform.claude.com/docs/en/build-with-claude/context-windows says 200k.
        yield* writeCache(
          home,
          yield* stampedCache([
            claude("claude-sonnet-4-5", 1_000_000),
            claude("claude-sonnet-4-6", 1_000_000),
            claude("claude-opus-5", 1_000_000),
            claude("claude-haiku-4-5", 200_000),
            // A model the family table does not name yet stays at 200k until a row
            // records its window: an understated window compacts early, an overstated one fails.
            claude("claude-sonnet-6", 1_000_000),
          ]),
        )
        const platform = yield* Effect.context<
          | FileSystem.FileSystem
          | Path.Path
          | ChildProcessSpawner.ChildProcessSpawner
          | Crypto.Crypto
        >()
        const driver = buildAnthropicModelDriver(
          yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(
            EMPTY_CREDENTIAL_CELL,
          ),
          Option.none(),
          Context.add(
            platform,
            AnthropicPlatform,
            AnthropicPlatform.of({ platform: "darwin", home, env: {} }),
          ),
          { home, platform },
        )
        const listModels = Option.getOrThrow(Option.fromUndefinedOr(driver.listModels))
        const windows = (yield* listModels()).map(
          (model) => `${model.id} ${String(model.contextLength)}`,
        )
        expect(windows).toEqual([
          "anthropic/claude-sonnet-4-5 200000",
          "anthropic/claude-sonnet-4-6 1000000",
          "anthropic/claude-opus-5 1000000",
          "anthropic/claude-haiku-4-5 200000",
          "anthropic/claude-sonnet-6 200000",
        ])
      }).pipe(Effect.provide(BunServices.layer)),
  )

  it.scopedLive("a cache older than a day refetches and rewrites the canonical models", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* freshHome("stale")
      const cachePath = yield* writeCache(
        home,
        yield* stampedCache([
          Model.make({
            id: ModelId.make("openai/gpt-4.1"),
            name: "GPT-4.1",
            provider: ProviderId.make("openai"),
            contextLength: 256_000,
          }),
        ]),
      )
      yield* ageCacheTwoDays(cachePath)
      const oldInode = (yield* fs.stat(cachePath)).ino
      const calls = yield* Ref.make(0)

      const models = yield* modelsDevCatalog(home).pipe(
        Effect.provide(countingHttpLayer(calls, encodeAnyJson(remotePayload))),
      )

      expect(yield* Ref.get(calls)).toBe(1)
      expect(models.map((model) => model.id)).toContain(ModelId.make("openai/gpt-5.4"))
      expect(models.map((model) => model.id)).not.toContain(ModelId.make("openai/gpt-4.1"))
      // The new cache replaces the old file by a rename, never a rewrite in
      // place: another process reads the old catalog or the new one, whole.
      expect(Option.isSome(oldInode)).toBe(true)
      expect((yield* fs.stat(cachePath)).ino).not.toEqual(oldInode)

      // The cache holds gent's canonical `Model[]`, never the raw payload.
      const written = yield* fs.readFileString(cachePath)
      const decoded = yield* Schema.decodeEffect(StampedCacheJson)(written)
      expect(decoded.models.map((model) => model.id)).toContain(ModelId.make("openai/gpt-5.4"))
      expect(written.includes('"openai":{"models"')).toBe(false)
    }).pipe(Effect.provide(platformLayer)),
  )

  // The driver sends a reasoning effort only to a model that reasons; the
  // catalog, not a name pattern, says which ones do.
  it.scopedLive("each model carries the reasoning flag models.dev gives it", () =>
    Effect.gen(function* () {
      const home = yield* freshHome("reasoning")
      const calls = yield* Ref.make(0)

      const models = yield* modelsDevCatalog(home).pipe(
        Effect.provide(countingHttpLayer(calls, encodeAnyJson(remotePayload))),
      )
      const reasoningOf = (id: string) =>
        models.find((model) => model.id === ModelId.make(id))?.reasoning

      expect(reasoningOf("openai/gpt-5.4")).toBe(true)
      expect(reasoningOf("openai/gpt-4o")).toBe(false)
      // models.dev names no flag: the catalog does not guess one.
      expect(reasoningOf("anthropic/claude-opus-5")).toBeUndefined()
    }).pipe(Effect.provide(platformLayer)),
  )

  it.scopedLive("a malformed cache is ignored and the remote payload replaces it", () =>
    Effect.gen(function* () {
      const home = yield* freshHome("malformed")
      yield* writeCache(home, '{"openai":{"models":{}}}')
      const calls = yield* Ref.make(0)

      const models = yield* modelsDevCatalog(home).pipe(
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
        yield* stampedCache([
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

      const models = yield* modelsDevCatalog(home).pipe(Effect.provide(failingHttpLayer(calls)))

      expect(yield* Ref.get(calls)).toBe(1)
      expect(models.map((model) => model.id)).toEqual([ModelId.make("openai/gpt-4.1")])
    }).pipe(Effect.provide(platformLayer)),
  )

  it.scopedLive("a stale catalog served after a failed fetch is fetched again later", () =>
    Effect.gen(function* () {
      const home = yield* freshHome("offline-retry")
      const cachePath = yield* writeCache(
        home,
        yield* stampedCache([
          Model.make({
            id: ModelId.make("openai/gpt-4.1"),
            name: "GPT-4.1",
            provider: ProviderId.make("openai"),
            contextLength: 256_000,
          }),
        ]),
      )
      yield* ageCacheTwoDays(cachePath)
      const offline = yield* Ref.make(0)
      const online = yield* Ref.make(0)
      const now = yield* Clock.currentTimeMillis
      yield* Effect.gen(function* () {
        // The virtual clock starts where the cache file's age was measured from.
        yield* TestClock.setTime(now)
        const first = yield* modelsDevCatalog(home).pipe(Effect.provide(failingHttpLayer(offline)))
        expect(first.map((model) => model.id)).toEqual([ModelId.make("openai/gpt-4.1")])
        // Within the memo's life the process asks nobody.
        yield* modelsDevCatalog(home).pipe(
          Effect.provide(countingHttpLayer(online, encodeAnyJson(remotePayload))),
        )
        expect(yield* Ref.get(online)).toBe(0)
        // Later the network is back, and the stale catalog is fetched again.
        yield* TestClock.adjust("1 hour")
        const later = yield* modelsDevCatalog(home).pipe(
          Effect.provide(countingHttpLayer(online, encodeAnyJson(remotePayload))),
        )
        expect(yield* Ref.get(online)).toBe(1)
        expect(later.map((model) => model.id)).toContain(ModelId.make("openai/gpt-5.4"))
      }).pipe(Effect.provide(TestClock.layer()))
    }).pipe(Effect.provide(platformLayer)),
  )

  it.scopedLive("no cache and a failed fetch give an empty catalog", () =>
    Effect.gen(function* () {
      const home = yield* freshHome("empty")
      const calls = yield* Ref.make(0)

      const models = yield* modelsDevCatalog(home).pipe(Effect.provide(failingHttpLayer(calls)))

      expect(models).toEqual([])
    }).pipe(Effect.provide(platformLayer)),
  )

  it.scopedLive("carries the release date onto the parsed model", () =>
    Effect.gen(function* () {
      const home = yield* freshHome("release-date")
      const calls = yield* Ref.make(0)

      const models = yield* modelsDevCatalog(home).pipe(
        Effect.provide(countingHttpLayer(calls, encodeAnyJson(remotePayload))),
      )

      const opus = models.find((model) => model.id === "anthropic/claude-opus-5")
      expect(opus?.releaseDate).toBe("2026-07-24")
    }).pipe(Effect.provide(platformLayer)),
  )

  it.scopedLive("carries the prompt-cache prices onto the parsed model", () =>
    Effect.gen(function* () {
      const home = yield* freshHome("cache-price")
      const calls = yield* Ref.make(0)

      const models = yield* modelsDevCatalog(home).pipe(
        Effect.provide(countingHttpLayer(calls, encodeAnyJson(remotePayload))),
      )

      const opus = models.find((model) => model.id === "anthropic/claude-opus-5")
      expect(opus?.pricing).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 })
      const gpt = models.find((model) => model.id === "openai/gpt-5.4")
      expect(gpt?.pricing).toEqual({ input: 1.25, output: 10 })
    }).pipe(Effect.provide(platformLayer)),
  )

  it.scopedLive("carries an input cap below the window onto the parsed model", () =>
    Effect.gen(function* () {
      const home = yield* freshHome("input-cap")
      const calls = yield* Ref.make(0)

      const models = yield* modelsDevCatalog(home).pipe(
        Effect.provide(countingHttpLayer(calls, encodeAnyJson(remotePayload))),
      )

      const gpt = models.find((model) => model.id === "openai/gpt-5.4")
      expect(gpt?.contextLength).toBe(400_000)
      expect(gpt?.inputLimit).toBe(272_000)
      // A model the catalog names no cap for has none.
      const opus = models.find((model) => model.id === "anthropic/claude-opus-5")
      expect(opus?.inputLimit).toBeUndefined()
    }).pipe(Effect.provide(platformLayer)),
  )

  it.scopedLive("carries the output cap onto the parsed model", () =>
    Effect.gen(function* () {
      const home = yield* freshHome("output-cap")
      const calls = yield* Ref.make(0)

      const models = yield* modelsDevCatalog(home).pipe(
        Effect.provide(countingHttpLayer(calls, encodeAnyJson(remotePayload))),
      )

      const gpt = models.find((model) => model.id === "openai/gpt-5.4")
      expect(gpt?.outputLimit).toBe(128_000)
      const opus = models.find((model) => model.id === "anthropic/claude-opus-5")
      expect(opus?.outputLimit).toBeUndefined()
    }).pipe(Effect.provide(platformLayer)),
  )

  it.scopedLive("a model without tool calling stays out of the catalog", () =>
    Effect.gen(function* () {
      const home = yield* freshHome("tool-call")
      const calls = yield* Ref.make(0)

      const models = yield* modelsDevCatalog(home).pipe(
        Effect.provide(countingHttpLayer(calls, encodeAnyJson(remotePayload))),
      )

      const ids = models.map((model) => model.id)
      expect(ids).not.toContain(ModelId.make("openai/text-embedding-3-small"))
      // No flag means unknown, and the model stays.
      expect(ids).toContain(ModelId.make("anthropic/claude-opus-5"))
    }).pipe(Effect.provide(platformLayer)),
  )

  // A build before the stamp wrote a bare array without cache prices. Served
  // for a day, it priced every cache read as uncached input.
  const olderBuildCache = encodeUnstampedCache([
    Model.make({
      id: ModelId.make("anthropic/claude-opus-5"),
      name: "Claude Opus 5",
      provider: ProviderId.make("anthropic"),
      pricing: { input: 5, output: 25 },
    }),
  ])

  it.scopedLive("a fresh cache an older build wrote refetches and gains the new fields", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* freshHome("unstamped")
      const cachePath = yield* writeCache(home, olderBuildCache)
      const calls = yield* Ref.make(0)

      const models = yield* modelsDevCatalog(home).pipe(
        Effect.provide(countingHttpLayer(calls, encodeAnyJson(remotePayload))),
      )

      expect(yield* Ref.get(calls)).toBe(1)
      const opus = models.find((model) => model.id === "anthropic/claude-opus-5")
      expect(opus?.pricing).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 })
      // The rewrite carries this build's stamp, so the next load serves it.
      const rewritten = yield* fs.readFileString(cachePath)
      expect((yield* Schema.decodeEffect(StampedCacheJson)(rewritten)).format).toBe(
        yield* currentCacheFormat(),
      )
    }).pipe(Effect.provide(platformLayer)),
  )

  it.scopedLive("a fresh cache stamped with another format refetches", () =>
    Effect.gen(function* () {
      const home = yield* freshHome("other-format")
      yield* writeCache(
        home,
        yield* Schema.encodeEffect(StampedCacheJson)({
          format: "0",
          models: [
            Model.make({
              id: ModelId.make("openai/gpt-4.1"),
              name: "GPT-4.1",
              provider: ProviderId.make("openai"),
            }),
          ],
        }),
      )
      const calls = yield* Ref.make(0)

      const models = yield* modelsDevCatalog(home).pipe(
        Effect.provide(countingHttpLayer(calls, encodeAnyJson(remotePayload))),
      )

      expect(yield* Ref.get(calls)).toBe(1)
      expect(models.map((model) => model.id)).not.toContain(ModelId.make("openai/gpt-4.1"))
    }).pipe(Effect.provide(platformLayer)),
  )

  it.scopedLive("a cache an older build wrote still serves when the fetch fails", () =>
    Effect.gen(function* () {
      const home = yield* freshHome("unstamped-offline")
      yield* writeCache(home, olderBuildCache)
      const calls = yield* Ref.make(0)

      const models = yield* modelsDevCatalog(home).pipe(Effect.provide(failingHttpLayer(calls)))

      expect(yield* Ref.get(calls)).toBe(1)
      expect(models.map((model) => model.id)).toEqual([ModelId.make("anthropic/claude-opus-5")])
    }).pipe(Effect.provide(platformLayer)),
  )

  it.scopedLive("driverCatalog serves only the driver's own provider", () =>
    Effect.gen(function* () {
      const home = yield* freshHome("per-provider")
      const calls = yield* Ref.make(0)

      const anthropic = yield* driverCatalog(home, "anthropic").pipe(
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
      yield* Deferred.succeed(gate, void 0)
      const [openai, anthropic] = yield* Fiber.join(both).pipe(Effect.timeout(5_000))

      expect(yield* Ref.get(calls)).toBe(1)
      expect(openai.map((model) => model.id)).toEqual([
        ModelId.make("openai/gpt-5.4"),
        ModelId.make("openai/gpt-4o"),
      ])
      expect(anthropic.map((model) => model.id)).toEqual([ModelId.make("anthropic/claude-opus-5")])
    }).pipe(Effect.provide(platformLayer)),
  )

  it.scopedLive("an offline load is not memoized; the next load reaches the host", () =>
    Effect.gen(function* () {
      const home = yield* freshHome("recovers")
      const offlineCalls = yield* Ref.make(0)

      const offline = yield* modelsDevCatalog(home).pipe(
        Effect.provide(failingHttpLayer(offlineCalls)),
      )

      expect(offline).toEqual([])
      expect(yield* Ref.get(offlineCalls)).toBe(1)

      // The host is reachable again. An empty first load must not have pinned
      // an empty catalog for the life of the process.
      const onlineCalls = yield* Ref.make(0)
      const online = yield* modelsDevCatalog(home).pipe(
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
