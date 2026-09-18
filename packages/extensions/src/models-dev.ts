import { type Context, Effect, FileSystem, Option, Path, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import {
  isRecord,
  Model,
  ModelId,
  type ModelPricing,
  omitUndefined,
  ProviderId,
} from "@gent/core/extensions/api"

// ── models-dev ──────────────────────────────────────────────────────────────

/**
 * The models.dev catalog, owned by the drivers that list its models.
 *
 * Core resolves a model through the driver seam and concatenates every
 * driver's `listModels`. Where a driver's list comes from is the driver's
 * concern, so the fetch, the parse, and the disk cache live here — shared by
 * the anthropic, openai, and api-key-compat drivers.
 *
 * One load per home directory per process. `Effect.cached` memoizes it, so
 * several drivers listing at once share one read and at most one fetch. There
 * is no background refresh: a cache older than a day refetches on the next
 * load, and a failed fetch serves whatever the disk still holds.
 *
 * @module
 */

const MODELS_URL = "https://models.dev"
const CACHE_RELATIVE = ".gent/models.json"
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000
const EMPTY_MODELS = [] satisfies ReadonlyArray<Model>

const JsonSchema = Schema.fromJsonString(Schema.Json)
const CachedModelsJson = Schema.fromJsonString(Schema.Array(Model))
const decodeJson = Schema.decodeUnknownOption(JsonSchema)
const decodeCachedModels = Schema.decodeUnknownOption(CachedModelsJson)
const encodeCachedModels = Schema.encodeSync(CachedModelsJson)

const ModelsDevCost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
})
const ModelsDevLimit = Schema.Struct({
  context: Schema.Finite,
})
const ModelsDevModel = Schema.Struct({
  name: Schema.optional(Schema.String),
  cost: Schema.optional(ModelsDevCost),
  limit: Schema.optional(ModelsDevLimit),
  release_date: Schema.optional(Schema.String),
})
type ModelsDevModel = typeof ModelsDevModel.Type
const decodeModelsDevModel = Schema.decodeUnknownOption(ModelsDevModel)

const parsePricing = (value: ModelsDevModel["cost"]): Option.Option<ModelPricing> =>
  Option.fromUndefinedOr(value).pipe(Option.map(({ input, output }) => ({ input, output })))

const parseContextLength = (value: ModelsDevModel["limit"]): Option.Option<number> =>
  Option.fromUndefinedOr(value).pipe(Option.map(({ context }) => context))

/** The models.dev payload as gent's canonical `Model[]`; a malformed entry is dropped. */
const parseModelsDev = (data: Schema.Json): ReadonlyArray<Model> => {
  if (!isRecord(data)) return []

  const models: Model[] = []
  for (const [providerId, providerValue] of Object.entries(data)) {
    if (!isRecord(providerValue)) continue
    const modelsValue = providerValue["models"]
    if (!isRecord(modelsValue)) continue

    for (const [modelKey, rawModelValue] of Object.entries(modelsValue)) {
      const decoded = decodeModelsDevModel(rawModelValue)
      if (decoded._tag === "None") continue
      const modelValue = decoded.value
      const name = Option.getOrElse(Option.fromUndefinedOr(modelValue.name), () => modelKey)
      const pricing = parsePricing(modelValue.cost)
      const contextLength = parseContextLength(modelValue.limit)
      const releaseDate = Option.fromUndefinedOr(modelValue.release_date)
      const id = ModelId.make(`${providerId}/${modelKey}`)

      models.push(
        Model.make({
          id,
          name,
          provider: ProviderId.make(providerId),
          ...omitUndefined({
            contextLength: Option.getOrUndefined(contextLength),
            pricing: Option.getOrUndefined(pricing),
            releaseDate: Option.getOrUndefined(releaseDate),
          }),
        }),
      )
    }
  }

  return models
}

/** The catalog on disk, or nothing when the file is absent, empty, or malformed. */
const readCachedModels = Effect.fn("ModelsDev.readCache")(
  function* (cachePath: string) {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(cachePath)
    if (!exists) return EMPTY_MODELS
    const content = yield* fs
      .readFileString(cachePath)
      .pipe(Effect.catchEager(() => Effect.succeed("")))
    if (content.trim().length === 0) return EMPTY_MODELS
    return Option.getOrElse(decodeCachedModels(content), () => EMPTY_MODELS)
  },
  Effect.catchEager(() => Effect.succeed(EMPTY_MODELS)),
)

const writeCachedModels = Effect.fn("ModelsDev.writeCache")(
  function* (cachePath: string, models: ReadonlyArray<Model>) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const text = yield* Effect.try({
      try: () => encodeCachedModels(models),
      catch: () => "",
    })
    if (text.length === 0) return

    yield* fs.makeDirectory(path.dirname(cachePath), { recursive: true })
    yield* fs.writeFileString(cachePath, text)
  },
  Effect.catchEager((e) =>
    Effect.logWarning("failed to write model cache").pipe(
      Effect.annotateLogs({ error: String(e) }),
    ),
  ),
)

/** True when no cache file exists or its mtime is older than a day. */
const isCacheStale = Effect.fn("ModelsDev.isCacheStale")(
  function* (cachePath: string) {
    const fs = yield* FileSystem.FileSystem
    const info = yield* fs.stat(cachePath)
    const mtime = info.mtime
    if (Option.isNone(mtime)) return true
    const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
    return now - mtime.value.getTime() > CACHE_MAX_AGE_MS
  },
  Effect.catchEager(() => Effect.succeed(true)),
)

/** The remote catalog, or nothing when the request fails, times out, or is unparsable. */
const fetchRemoteModels = Effect.fn("ModelsDev.fetchRemote")(
  function* () {
    const http = yield* HttpClient.HttpClient
    const response = yield* http.get(`${MODELS_URL}/api.json`, {
      headers: { "User-Agent": "gent" },
    })
    if (response.status >= 400) return EMPTY_MODELS
    const text = yield* response.text
    if (text.length === 0) return EMPTY_MODELS
    const decoded = decodeJson(text)
    if (decoded._tag === "None") return EMPTY_MODELS
    return parseModelsDev(decoded.value)
  },
  Effect.timeout(FETCH_TIMEOUT_MS),
  Effect.catchEager(() => Effect.succeed(EMPTY_MODELS)),
)

const loadCatalog = Effect.fn("ModelsDev.load")(function* (home: string) {
  const path = yield* Path.Path
  const cachePath = path.join(home, CACHE_RELATIVE)
  const disk = yield* readCachedModels(cachePath)
  const stale = yield* isCacheStale(cachePath)
  if (disk.length > 0 && !stale) return disk

  const remote = yield* fetchRemoteModels()
  // A failed or empty fetch keeps whatever the disk still holds; stale is fine.
  if (remote.length === 0) return disk
  yield* writeCachedModels(cachePath, remote)
  return remote
})

type CatalogEffect = Effect.Effect<
  ReadonlyArray<Model>,
  never,
  FileSystem.FileSystem | Path.Path | HttpClient.HttpClient
>

/**
 * One memoized load per home directory, for the life of the process. The
 * drivers each call `driverCatalog` during their own `listModels`, and the
 * memo is what makes that one read and at most one fetch rather than one per
 * driver.
 */
const catalogsByHome = new Map<string, CatalogEffect>()

/**
 * The models.dev catalog for `home`, loaded at most once per process.
 *
 * The memo is built the first time a home is asked for and stored before the
 * effect is handed back, so every driver that lists models for the same home
 * shares one read and at most one fetch. `Effect.cached` is a constructor: it
 * allocates the latch and performs no IO, so building the memo here decides
 * nothing about when the catalog loads.
 */
export const modelsDevCatalog = (home: string): CatalogEffect => {
  const existing = Option.fromUndefinedOr(catalogsByHome.get(home))
  if (Option.isSome(existing)) return existing.value
  // `Effect.cached` only allocates the memo's latch — no IO, no failure — so
  // running it here is allocation, not work. The catalog loads when a driver
  // runs the effect this returns.
  const memo = Effect.runSync(Effect.cached(loadCatalog(home)))
  catalogsByHome.set(home, memo)
  return memo
}

/** The models.dev catalog narrowed to one provider — a driver's own list. */
export const driverCatalog = (home: string, providerId: string): CatalogEffect =>
  modelsDevCatalog(home).pipe(
    Effect.map((models) => models.filter((model) => model.provider === providerId)),
  )

/**
 * What a driver needs to serve its own catalog: the home directory that holds
 * the cache, and the platform services its setup captured. Both are plain
 * values a driver factory takes; neither is yielded inside a driver leaf.
 */
export interface CatalogSource {
  readonly home: string
  readonly platform: Context.Context<FileSystem.FileSystem | Path.Path>
}

/** Capture the home and platform services a driver's catalog needs. */
export const catalogSource = Effect.fn("ModelsDev.catalogSource")(function* (home: string) {
  const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
  return { home, platform } satisfies CatalogSource
})

/**
 * A driver's `listModels`: its own models.dev entries, with the platform
 * services and the HTTP client provided from what setup captured.
 */
export const driverListModels =
  (source: CatalogSource, providerId: string) => (): Effect.Effect<ReadonlyArray<Model>> =>
    driverCatalog(source.home, providerId).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off The catalog owns its own HTTP client at the driver boundary; it outlives no scope.
      Effect.provide(FetchHttpClient.layer),
      Effect.provideContext(source.platform),
    )
