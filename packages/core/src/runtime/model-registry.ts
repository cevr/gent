import { Context, Effect, Layer, Ref, Schema, FileSystem, Path } from "effect"
import { HttpClient, type HttpClient as HttpClientService } from "effect/unstable/http"
import { AuthStore } from "../domain/auth-store.js"
import type { ProviderAuthInfo } from "../domain/extension.js"
import { Model, ModelId } from "../domain/model.js"
import type { ModelPricing } from "../domain/model.js"
import { DriverRegistry } from "./extensions/driver-registry.js"
import { RuntimePlatform } from "./runtime-platform.js"

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
type CacheLoad =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Canonical"; readonly models: readonly Model[] }
  | { readonly _tag: "Legacy"; readonly models: readonly Model[] }

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
      const id = ModelId.of(`${providerId}/${modelKey}`)

      models.push(
        new Model({
          id,
          name,
          provider: providerId,
          ...(contextLength !== undefined ? { contextLength } : {}),
          ...(pricing !== undefined ? { pricing } : {}),
        }),
      )
    }
  }

  return models
}

const readCachedModels = Effect.fn("ModelRegistry.loadFromDisk")(
  function* (fs: FileSystem.FileSystem, cachePath: string) {
    const exists = yield* fs.exists(cachePath)
    if (!exists) return { _tag: "Missing" } as CacheLoad
    const content = yield* fs
      .readFileString(cachePath)
      .pipe(Effect.catchEager(() => Effect.succeed("")))
    if (content.trim().length === 0) return { _tag: "Missing" } as CacheLoad

    const canonical = decodeCachedModels(content)
    if (canonical._tag === "Some") {
      return { _tag: "Canonical", models: canonical.value } as CacheLoad
    }

    const json = decodeJson(content)
    if (json._tag === "None") return { _tag: "Missing" } as CacheLoad
    const legacyModels = parseModelsDev(json.value)
    if (legacyModels.length === 0) return { _tag: "Missing" } as CacheLoad
    return { _tag: "Legacy", models: legacyModels } as CacheLoad
  },
  Effect.catchEager(() => Effect.succeed({ _tag: "Missing" } as CacheLoad)),
)

const writeCachedModels = Effect.fn("ModelRegistry.writeCache")(
  function* (
    fs: FileSystem.FileSystem,
    path: Path.Path,
    cachePath: string,
    models: readonly Model[],
  ) {
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
  readonly list: () => Effect.Effect<readonly Model[]>
  readonly get: (modelId: ModelId) => Effect.Effect<Model | undefined>
  readonly refresh: () => Effect.Effect<void>
}

export class ModelRegistry extends Context.Service<ModelRegistry, ModelRegistryService>()(
  "@gent/core/src/runtime/model-registry/ModelRegistry",
) {
  static Live: Layer.Layer<
    ModelRegistry,
    never,
    | FileSystem.FileSystem
    | Path.Path
    | RuntimePlatform
    | DriverRegistry
    | AuthStore
    | HttpClientService.HttpClient
  > = Layer.effect(
    ModelRegistry,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const http = yield* HttpClient.HttpClient
      const runtimePlatform = yield* RuntimePlatform
      const driverRegistry = yield* DriverRegistry
      const authStore = yield* AuthStore
      const cachePath = path.join(runtimePlatform.home, CACHE_RELATIVE)
      const cacheRef = yield* Ref.make<readonly Model[] | null>(null)

      const loadFromDisk = Effect.gen(function* () {
        const cache = yield* readCachedModels(fs, cachePath)
        if (cache._tag === "Legacy") {
          yield* writeCachedModels(fs, path, cachePath, cache.models)
        }
        if (cache._tag === "Canonical" || cache._tag === "Legacy") {
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
          yield* writeCachedModels(fs, path, cachePath, parsed)
        }
        return parsed
      }).pipe(
        Effect.timeout(10_000),
        Effect.catchEager(() => Effect.succeed([] as readonly Model[])),
        Effect.withSpan("ModelRegistry.fetchRemote"),
      )

      /** Load raw models (disk → remote fallback), cache unfiltered */
      const loadRaw = Effect.gen(function* () {
        const cached = yield* Ref.get(cacheRef)
        if (cached !== null) return cached
        const disk = yield* loadFromDisk
        if (disk.length > 0) {
          yield* Ref.set(cacheRef, disk)
          return disk
        }
        const remote = yield* fetchRemote
        yield* Ref.set(cacheRef, remote)
        return remote
      })

      /** Load + apply auth-sensitive provider filters (not cached — re-evaluated per call) */
      const load = Effect.gen(function* () {
        const raw = yield* loadRaw
        return yield* applyFilters(raw)
      }).pipe(Effect.withSpan("ModelRegistry.load"))

      const resolveAuth = (providerId: string): Effect.Effect<ProviderAuthInfo | undefined> =>
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
          Effect.catchEager(() => Effect.void.pipe(Effect.as(undefined))),
        )

      const applyFilters = (models: readonly Model[]) =>
        driverRegistry.filterModelCatalog(models, resolveAuth).pipe(
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          Effect.map((filtered) => filtered as readonly Model[]),
          Effect.catchEager(() => Effect.succeed(models)),
        )

      const refresh = Effect.gen(function* () {
        const remote = yield* fetchRemote
        if (remote.length > 0) {
          yield* Ref.set(cacheRef, remote)
        }
      }).pipe(Effect.withSpan("ModelRegistry.refresh"))

      yield* Effect.forkScoped(refresh)

      return ModelRegistry.of({
        list: () => load,
        get: (modelId) => load.pipe(Effect.map((models) => models.find((m) => m.id === modelId))),
        refresh: () => refresh,
      })
    }),
  )

  static Test = (models: readonly Model[] = []): Layer.Layer<ModelRegistry> =>
    Layer.succeed(ModelRegistry, {
      list: () => Effect.succeed(models),
      get: (modelId) => Effect.succeed(models.find((m) => m.id === modelId)),
      refresh: () => Effect.void,
    })
}
