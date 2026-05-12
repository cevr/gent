import { Context, Effect, Layer, Schema, SynchronizedRef, FileSystem, Path } from "effect"
import { HttpClient, type HttpClient as HttpClientService } from "effect/unstable/http"
import { Auth } from "../domain/auth.js"
import { ProviderAuthError, type DriverError } from "../domain/driver.js"
import type { ProviderAuthInfo } from "../domain/extension.js"
import { Model, ModelId, ProviderId } from "../domain/model.js"
import type { ModelPricing } from "../domain/model.js"
import { DriverRegistry } from "./extensions/driver-registry.js"
import { RuntimeEnvironment } from "./runtime-environment.js"

const MODELS_URL = "https://models.dev"
const CACHE_RELATIVE = ".gent/models.json"
const JsonSchema = Schema.fromJsonString(Schema.Unknown)
const CachedModelsJson = Schema.fromJsonString(Schema.Array(Model))
const decodeJson = Schema.decodeUnknownOption(JsonSchema)
const decodeCachedModels = Schema.decodeUnknownOption(CachedModelsJson)
const encodeCachedModels = Schema.encodeSync(CachedModelsJson)
const ModelsDevCost = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
})
const ModelsDevLimit = Schema.Struct({
  context: Schema.Number,
})
const ModelsDevModel = Schema.Struct({
  name: Schema.optional(Schema.String),
  cost: Schema.optional(ModelsDevCost),
  limit: Schema.optional(ModelsDevLimit),
})
type ModelsDevModel = typeof ModelsDevModel.Type
const decodeModelsDevModel = Schema.decodeUnknownOption(ModelsDevModel)

type JsonRecord = Record<string, unknown>
const CacheLoad = Schema.TaggedUnion({
  Missing: {},
  Canonical: { models: Schema.Array(Model) },
})
type CacheLoad = Schema.Schema.Type<typeof CacheLoad>

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const parsePricing = (value: ModelsDevModel["cost"]): ModelPricing | undefined =>
  value === undefined ? undefined : { input: value.input, output: value.output }

const parseContextLength = (value: ModelsDevModel["limit"]): number | undefined => value?.context

const parseModelsDev = (data: unknown): readonly Model[] => {
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
      const name = modelValue.name ?? modelKey
      const pricing = parsePricing(modelValue.cost)
      const contextLength = parseContextLength(modelValue.limit)
      const id = ModelId.make(`${providerId}/${modelKey}`)

      models.push(
        Model.make({
          id,
          name,
          provider: ProviderId.make(providerId),
          ...(contextLength !== undefined ? { contextLength } : {}),
          ...(pricing !== undefined ? { pricing } : {}),
        }),
      )
    }
  }

  return models
}

const readCachedModels = Effect.fn("ModelRegistry.loadFromDisk")(
  function* (cachePath: string) {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(cachePath)
    if (!exists) return CacheLoad.cases.Missing.make({})
    const content = yield* fs
      .readFileString(cachePath)
      .pipe(Effect.catchEager(() => Effect.succeed("")))
    if (content.trim().length === 0) return CacheLoad.cases.Missing.make({})

    const canonical = decodeCachedModels(content)
    if (canonical._tag === "Some") {
      return CacheLoad.cases.Canonical.make({ models: canonical.value })
    }

    return CacheLoad.cases.Missing.make({})
  },
  Effect.catchEager(() => Effect.succeed(CacheLoad.cases.Missing.make({}))),
)

const writeCachedModels = Effect.fn("ModelRegistry.writeCache")(
  function* (cachePath: string, models: readonly Model[]) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const text = yield* Effect.try({
      try: () => encodeCachedModels(models),
      catch: () => "",
    })
    if (text.length === 0) return

    const dir = path.dirname(cachePath)
    yield* fs.makeDirectory(dir, { recursive: true })
    yield* fs.writeFileString(cachePath, text)
  },
  Effect.catchEager((e) =>
    Effect.logWarning("failed to write model cache").pipe(
      Effect.annotateLogs({ error: String(e) }),
    ),
  ),
)

export interface ModelRegistryService {
  readonly list: () => Effect.Effect<readonly Model[], DriverError | ProviderAuthError>
}

export class ModelRegistry extends Context.Service<ModelRegistry, ModelRegistryService>()(
  "@gent/core/src/runtime/model-registry/ModelRegistry",
) {
  static Live: Layer.Layer<
    ModelRegistry,
    never,
    | FileSystem.FileSystem
    | Path.Path
    | RuntimeEnvironment
    | DriverRegistry
    | Auth
    | HttpClientService.HttpClient
  > = Layer.effect(
    ModelRegistry,
    Effect.gen(function* () {
      const path = yield* Path.Path
      const http = yield* HttpClient.HttpClient
      const runtimeEnvironment = yield* RuntimeEnvironment
      const driverRegistry = yield* DriverRegistry
      const authStore = yield* Auth
      const fsAndPathContext = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
      const cachePath = path.join(runtimeEnvironment.home, CACHE_RELATIVE)

      const loadFromDisk = Effect.gen(function* () {
        const cache = yield* readCachedModels(cachePath)
        if (cache._tag === "Canonical") {
          return cache.models
        }
        return [] as readonly Model[]
      }).pipe(Effect.withSpan("ModelRegistry.loadFromDisk"))

      const fetchRemote = Effect.gen(function* () {
        const res = yield* http
          .get(`${MODELS_URL}/api.json`, { headers: { "User-Agent": "gent" } })
          .pipe(Effect.option)
        if (res._tag === "None" || res.value.status >= 400) return [] as readonly Model[]
        const text = yield* res.value.text.pipe(Effect.catchEager(() => Effect.succeed("")))
        if (text.length === 0) return [] as readonly Model[]
        const decoded = decodeJson(text)
        if (decoded._tag === "None") return [] as readonly Model[]
        const parsed = parseModelsDev(decoded.value)
        if (parsed.length > 0) {
          yield* writeCachedModels(cachePath, parsed)
        }
        return parsed
      }).pipe(
        Effect.timeout(10_000),
        Effect.catchEager(() => Effect.succeed([] as readonly Model[])),
        Effect.withSpan("ModelRegistry.fetchRemote"),
      )

      // SynchronizedRef serializes loadRaw and refresh writes so refresh's
      // fresh remote payload cannot be overwritten by an in-flight load.
      // Reads still need the permit (modifyEffect), but the work inside is
      // short-circuited once `cur !== null`.
      const cacheRef = yield* SynchronizedRef.make<readonly Model[] | null>(null)

      /** Load raw models (disk → remote fallback), cache unfiltered */
      const loadRaw = SynchronizedRef.modifyEffect(cacheRef, (cur) =>
        Effect.gen(function* () {
          if (cur !== null) return [cur, cur] as const
          const disk = yield* loadFromDisk
          const loaded = disk.length > 0 ? disk : yield* fetchRemote
          return [loaded, loaded] as const
        }),
      )

      /** Load + apply auth-sensitive provider filters (not cached — re-evaluated per call) */
      const load = Effect.gen(function* () {
        const raw = yield* loadRaw
        return yield* applyFilters(raw)
      }).pipe(Effect.withSpan("ModelRegistry.load"))

      const resolveAuth = (
        providerId: string,
      ): Effect.Effect<ProviderAuthInfo | undefined, ProviderAuthError> =>
        authStore.get(providerId).pipe(
          Effect.map((info): ProviderAuthInfo | undefined => {
            if (info === undefined) return undefined
            if (info.type === "api") return { type: "api", key: info.key }
            if (info.type === "oauth") {
              return {
                type: "oauth",
                access: info.access,
                refresh: info.refresh,
                expires: info.expires,
                accountId: info.accountId,
              }
            }
            return undefined
          }),
          Effect.mapError(
            (e) =>
              new ProviderAuthError({
                message: `Failed to read auth for provider "${providerId}"`,
                cause: e,
              }),
          ),
        )

      const applyFilters = (models: readonly Model[]) =>
        driverRegistry.filterModelCatalog(models, resolveAuth)

      const refresh = Effect.gen(function* () {
        const remote = yield* fetchRemote
        if (remote.length > 0) {
          // SynchronizedRef.set takes the permit so it cannot race with an
          // in-flight loadRaw's write — last writer is whoever holds the
          // permit, and modifyEffect/set serialize through the same semaphore.
          yield* SynchronizedRef.set(cacheRef, remote)
        }
      }).pipe(Effect.withSpan("ModelRegistry.refresh"))

      yield* Effect.forkScoped(refresh)

      return ModelRegistry.of({
        list: () => load.pipe(Effect.provideContext(fsAndPathContext)),
      })
    }),
  )

  static Test = (models: readonly Model[] = []): Layer.Layer<ModelRegistry> =>
    Layer.succeed(ModelRegistry, {
      list: () => Effect.succeed(models),
    })
}
