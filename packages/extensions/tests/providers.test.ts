import { describe, expect, it, test } from "effect-bun-test"
import {
  Clock,
  Context,
  type Crypto,
  Deferred,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Ref,
  Schema,
  Semaphore,
  SynchronizedRef,
} from "effect"
import { Model, ModelId, ProviderAuthError, ProviderId } from "@gent/core/extensions/api"
import { makeTempDirectoryScoped } from "@gent/core/test-utils"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import type { ChildProcessSpawner } from "effect/process"
import {
  catalogSource,
  type CredentialCacheCell,
  type CredentialFailure,
  type CredentialStore,
  driverCatalog,
  driverListModels,
  EMPTY_CREDENTIAL_CELL,
  freshEnoughAt,
  makeCredentialCache,
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
 * the per-home memo two drivers share. The catalog belongs to the driver,
 * not to the kernel.
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
 * An HTTP client that counts the call, signals `reached`, then waits for
 * `gate` before it answers. Every caller that reaches it is still in flight
 * until the gate opens.
 */
const gatedHttpLayer = (
  calls: Ref.Ref<number>,
  reached: Deferred.Deferred<void>,
  gate: Deferred.Deferred<void>,
  body: string,
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        yield* Ref.update(calls, (n) => n + 1)
        yield* Deferred.succeed(reached, void 0)
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

/** An Anthropic driver on macOS in `home`, with no credentials and an empty env. */
const anthropicDriverIn = Effect.fn("test.anthropicDriverIn")(function* (
  home: string,
  promptCacheTtl: "5m" | "1h",
) {
  const platform = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
  >()
  return buildAnthropicModelDriver(
    yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL),
    Option.none(),
    Context.add(
      platform,
      AnthropicPlatform,
      AnthropicPlatform.of({ platform: "darwin", home, env: {} }),
    ),
    { home, platform },
    promptCacheTtl,
  )
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
        const driver = yield* anthropicDriverIn(home, "1h")
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

  it.scopedLive("a driver's catalog names its provider's prompt-cache lifetime on each model", () =>
    Effect.gen(function* () {
      const home = yield* freshHome("cache-lifetime")
      yield* writeCache(
        home,
        yield* stampedCache([
          Model.make({
            id: ModelId.make("anthropic/claude-opus-5"),
            name: "Opus 5",
            provider: ProviderId.make("anthropic"),
            contextLength: 1_000_000,
          }),
        ]),
      )
      const source = yield* catalogSource(home)

      const models = yield* driverListModels(
        source,
        "anthropic",
        Option.some(Duration.minutes(5)),
      )()

      expect(models.map((model) => model.promptCacheTtlMs)).toEqual([5 * 60_000])
    }).pipe(Effect.provide(platformLayer)),
  )

  it.scopedLive(
    "the Anthropic catalog names the lifetimes its markers ask for, 1 hour or 5 minutes with the switch, 5 minutes for a child, and prices each cache write by the lifetime it wrote",
    () =>
      Effect.gen(function* () {
        const home = yield* freshHome("anthropic-cache-lifetime")
        yield* writeCache(
          home,
          yield* stampedCache([
            Model.make({
              id: ModelId.make("anthropic/claude-opus-5"),
              name: "Opus 5",
              provider: ProviderId.make("anthropic"),
              contextLength: 1_000_000,
              // models.dev prices a write at the 5-minute rate, 1.25x input.
              pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
            }),
          ]),
        )
        const lifetimes = (promptCacheTtl: "5m" | "1h") =>
          Effect.gen(function* () {
            const driver = yield* anthropicDriverIn(home, promptCacheTtl)
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
            return (yield* listModels()).map((model) => ({
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

  it.scopedLive("each parsed model carries the fields models.dev gives it", () =>
    Effect.gen(function* () {
      const home = yield* freshHome("fields")
      const calls = yield* Ref.make(0)

      const models = yield* modelsDevCatalog(home).pipe(
        Effect.provide(countingHttpLayer(calls, encodeAnyJson(remotePayload))),
      )
      // The catalog fields of one model, with only the fields that are set.
      const fields = (id: string) => {
        const model = models.find((candidate) => candidate.id === ModelId.make(id))
        const all = {
          // The driver sends a reasoning effort only to a model that reasons;
          // the catalog, not a name pattern, says which ones do.
          reasoning: model?.reasoning,
          releaseDate: model?.releaseDate,
          pricing: model?.pricing,
          contextLength: model?.contextLength,
          inputLimit: model?.inputLimit,
          outputLimit: model?.outputLimit,
        }
        return Object.fromEntries(
          Object.entries(all).filter(([, value]) => Predicate.isNotUndefined(value)),
        )
      }

      expect(fields("openai/gpt-5.4")).toStrictEqual({
        reasoning: true,
        releaseDate: "2026-07-24",
        pricing: { input: 1.25, output: 10 },
        contextLength: 400_000,
        inputLimit: 272_000,
        outputLimit: 128_000,
      })
      expect(fields("openai/gpt-4o")["reasoning"]).toBe(false)
      // A field models.dev does not name stays unset: the catalog does not guess.
      expect(fields("anthropic/claude-opus-5")).toStrictEqual({
        releaseDate: "2026-07-24",
        pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        contextLength: 1_000_000,
      })
      const ids = models.map((model) => model.id)
      // A model without tool calling stays out; no flag means unknown, and the model stays.
      expect(ids).not.toContain(ModelId.make("openai/text-embedding-3-small"))
      expect(ids).toContain(ModelId.make("anthropic/claude-opus-5"))
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
      const fs = yield* FileSystem.FileSystem
      const home = yield* freshHome("memo")
      // A directory stands where the cache file goes: the disk can neither
      // write nor serve a catalog, so only the memo can spare the second
      // driver its own fetch. Without the memo this test sees 2 calls.
      yield* fs.makeDirectory(yield* cachePathIn(home), { recursive: true })
      const calls = yield* Ref.make(0)
      const reached = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      const http = Effect.provide(
        gatedHttpLayer(calls, reached, gate, encodeAnyJson(remotePayload)),
      )

      // The second driver lists while the first driver's fetch is in flight.
      const first = yield* Effect.forkChild(driverCatalog(home, "openai").pipe(http))
      yield* Deferred.await(reached)
      const second = yield* Effect.forkChild(driverCatalog(home, "anthropic").pipe(http))
      yield* Deferred.succeed(gate, void 0)
      const openai = yield* Fiber.join(first).pipe(Effect.timeout(5_000))
      const anthropic = yield* Fiber.join(second).pipe(Effect.timeout(5_000))

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

  it.scopedLive(
    "a read stopped during the first fetch stops only its wait; the next read gets that fetch's catalog",
    () =>
      Effect.gen(function* () {
        // The stop lands at every point around the scheduler's yield budget
        // (2048 steps), where a waiter can be counted before its cleanup is in place.
        for (let steps = 1990; steps < 2060; steps++) {
          const home = yield* freshHome("stopped")
          const calls = yield* Ref.make(0)
          const reached = yield* Deferred.make<void>()
          const answer = yield* Deferred.make<void>()
          // The host answers only once the test lets it: the first read is still
          // waiting in the fetch when its caller stops, as an Esc during the
          // day's first turn does.
          const host = Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.gen(function* () {
                yield* Ref.update(calls, (n) => n + 1)
                yield* Deferred.succeed(reached, void 0)
                yield* Deferred.await(answer)
                return HttpClientResponse.fromWeb(
                  request,
                  new Response(encodeAnyJson(remotePayload), { status: 200 }),
                )
              }),
            ),
          )
          const busy = Effect.forEach(Array.from({ length: steps }), () => Effect.void, {
            discard: true,
          })
          const first = yield* Effect.forkChild(
            busy.pipe(Effect.andThen(modelsDevCatalog(home)), Effect.provide(host)),
          )
          yield* Deferred.await(reached)
          yield* Fiber.interrupt(first)

          const next = yield* Effect.forkChild(modelsDevCatalog(home).pipe(Effect.provide(host)))
          yield* Deferred.succeed(answer, void 0)
          const models = yield* Fiber.join(next)

          expect(models.map((model) => model.id)).toContain(ModelId.make("openai/gpt-5.4"))
          // The stopped read's fetch went on and served the next read.
          expect(yield* Ref.get(calls)).toBe(1)
        }
      }).pipe(Effect.timeout(10_000), Effect.provide(platformLayer)),
    15_000,
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
