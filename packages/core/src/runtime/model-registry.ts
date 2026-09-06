import { Context, Effect, Layer, Option, Schema, SynchronizedRef, FileSystem, Path } from "effect"
import { HttpClient, type HttpClient as HttpClientService } from "effect/unstable/http"
import { Auth } from "../domain/auth.js"
import { ProviderAuthError, type DriverError } from "../domain/driver.js"
import type { ProviderAuthInfo } from "../domain/extension.js"
import { Model, ModelId, ProviderId, parseModelProvider } from "../domain/model.js"
import type { ModelPricing } from "../domain/model.js"
import { DriverRegistry } from "./extensions/driver-registry.js"
import { RuntimeEnvironment } from "./runtime-environment.js"

const MODELS_URL = "https://models.dev"
const CACHE_RELATIVE = ".gent/models.json"
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
})
type ModelsDevModel = typeof ModelsDevModel.Type
const decodeModelsDevModel = Schema.decodeUnknownOption(ModelsDevModel)

const CacheLoad = Schema.TaggedUnion({
  Missing: {},
  Canonical: { models: Schema.Array(Model) },
})
type CacheLoad = Schema.Schema.Type<typeof CacheLoad>

const isRecord = Schema.is(Schema.JsonObject)

const parsePricing = (value: ModelsDevModel["cost"]): Option.Option<ModelPricing> =>
  Option.fromUndefinedOr(value).pipe(Option.map(({ input, output }) => ({ input, output })))

const parseContextLength = (value: ModelsDevModel["limit"]): Option.Option<number> =>
  Option.fromUndefinedOr(value).pipe(Option.map(({ context }) => context))

const parseModelsDev = (data: Schema.Json): readonly Model[] => {
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
      const id = ModelId.make(`${providerId}/${modelKey}`)

      models.push(
        Model.make(
          Object.assign(
            {
              id,
              name,
              provider: ProviderId.make(providerId),
            },
            Option.match(contextLength, {
              onNone: () => ({}),
              onSome: (value) => ({ contextLength: value }),
            }),
            Option.match(pricing, {
              onNone: () => ({}),
              onSome: (value) => ({ pricing: value }),
            }),
          ),
        ),
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

const EMPTY_MODELS = [] satisfies readonly Model[]

/**
 * Explicit capability used by the deterministic registry test layer. It is
 * not a production model fallback and is never used by `ModelRegistry.Live`.
 */
export const TEST_MODEL_CONTEXT_LIMIT_TOKENS = 128_000

export interface ModelRegistryService {
  readonly list: Effect.Effect<readonly Model[], DriverError | ProviderAuthError>
  readonly get: (
    modelId: string,
  ) => Effect.Effect<Option.Option<Model>, DriverError | ProviderAuthError>
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

      const loadFromDisk = Effect.fn("ModelRegistry.loadFromDisk")(function* () {
        const cache = yield* readCachedModels(cachePath)
        if (cache._tag === "Canonical") {
          return cache.models
        }
        return EMPTY_MODELS
      })

      const fetchRemote = Effect.fn("ModelRegistry.fetchRemote")(function* () {
        const res = yield* http
          .get(`${MODELS_URL}/api.json`, { headers: { "User-Agent": "gent" } })
          .pipe(Effect.option)
        if (res._tag === "None") return EMPTY_MODELS
        if (res.value.status >= 400) return EMPTY_MODELS
        const text = yield* res.value.text.pipe(Effect.catchEager(() => Effect.succeed("")))
        if (text.length === 0) return EMPTY_MODELS
        const decoded = decodeJson(text)
        if (decoded._tag === "None") return EMPTY_MODELS
        const parsed = parseModelsDev(decoded.value)
        if (parsed.length > 0) {
          yield* writeCachedModels(cachePath, parsed)
        }
        return parsed
      })

      // SynchronizedRef serializes loadRaw and refresh writes so refresh's
      // fresh remote payload cannot be overwritten by an in-flight load.
      // Reads still need the permit (modifyEffect), but the work inside is
      // short-circuited once the current value is Some.
      const cacheRef = yield* SynchronizedRef.make<Option.Option<readonly Model[]>>(Option.none())

      /** Load raw models (disk → remote fallback), cache unfiltered */
      const loadRaw = SynchronizedRef.modifyEffect(cacheRef, (cur) =>
        Effect.gen(function* () {
          if (Option.isSome(cur)) return [cur, cur]
          const disk = yield* loadFromDisk()
          if (disk.length > 0) return [Option.some(disk), Option.some(disk)]
          const remote = yield* fetchRemote().pipe(
            Effect.timeout(10_000),
            Effect.catchEager(() => Effect.succeed(EMPTY_MODELS)),
          )
          return [Option.some(remote), Option.some(remote)]
        }),
      )

      /** Load + apply auth-sensitive provider filters (not cached — re-evaluated per call) */
      const load = Effect.fn("ModelRegistry.load")(function* () {
        const raw = yield* loadRaw
        return yield* applyFilters(Option.getOrElse(raw, () => EMPTY_MODELS))
      })

      const resolveAuthOption = (
        providerId: string,
      ): Effect.Effect<Option.Option<ProviderAuthInfo>, ProviderAuthError> =>
        authStore.get(providerId).pipe(
          Effect.map(Option.fromUndefinedOr),
          Effect.map(
            Option.map((info): ProviderAuthInfo => {
              if (info.type === "api") return { type: "api", key: info.key }
              return {
                type: "oauth",
                access: info.access,
                refresh: info.refresh,
                expires: info.expires,
                accountId: info.accountId,
              }
            }),
          ),
          Effect.mapError(
            (e) =>
              new ProviderAuthError({
                message: `Failed to read auth for provider "${providerId}"`,
                cause: e,
              }),
          ),
        )

      const applyFilters = (models: readonly Model[]) =>
        driverRegistry.filterModelCatalog(models, (providerId) =>
          resolveAuthOption(providerId).pipe(Effect.map(Option.getOrUndefined)),
        )

      const refresh = Effect.suspend(
        Effect.fn("ModelRegistry.refresh")(function* () {
          const remote = yield* fetchRemote().pipe(
            Effect.timeout(10_000),
            Effect.catchEager(() => Effect.succeed(EMPTY_MODELS)),
          )
          if (remote.length > 0) {
            // SynchronizedRef.set takes the permit so it cannot race with an
            // in-flight loadRaw's write — last writer is whoever holds the
            // permit, and modifyEffect/set serialize through the same semaphore.
            yield* SynchronizedRef.set(cacheRef, Option.some(remote))
          }
        }),
      )

      yield* Effect.forkScoped(refresh)

      return ModelRegistry.of({
        list: load().pipe(Effect.provideContext(fsAndPathContext)),
        get: (modelId) =>
          load().pipe(
            Effect.map((models) =>
              Option.fromUndefinedOr(models.find((model) => model.id === modelId)),
            ),
            Effect.provideContext(fsAndPathContext),
          ),
      })
    }),
  )

  static Test = (models: readonly Model[] = []): Layer.Layer<ModelRegistry> =>
    Layer.succeed(
      ModelRegistry,
      ModelRegistry.of({
        list: Effect.succeed(models),
        get: (modelId) => {
          const existing = Option.fromUndefinedOr(models.find((model) => model.id === modelId))
          if (Option.isSome(existing)) return Effect.succeedSome(existing.value)
          if (models.length > 0) return Effect.succeedNone
          const provider = Option.getOrElse(parseModelProvider(modelId), () =>
            ProviderId.make("test"),
          )
          return Effect.succeedSome(
            Model.make({
              id: ModelId.make(modelId),
              name: modelId,
              provider,
              contextLength: TEST_MODEL_CONTEXT_LIMIT_TOKENS,
            }),
          )
        },
      }),
    )
}
