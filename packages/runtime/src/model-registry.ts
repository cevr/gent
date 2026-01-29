import { Context, Effect, Layer, Option, Ref, Schedule, Schema } from "effect"
import { FileSystem, Path } from "@effect/platform"
import type { ModelId, Provider, ProviderId } from "@gent/core"
import { Model, SUPPORTED_PROVIDERS, DEFAULT_MODELS } from "@gent/core"

// Cache file schema

const CacheFile = Schema.Struct({
  models: Schema.Array(Model),
  updatedAt: Schema.Number,
})

// models.dev API response schema (subset of fields we need)

const ModelsDevModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  provider: Schema.String,
  context_length: Schema.optional(Schema.Number),
})

const ModelsDevResponse = Schema.Array(ModelsDevModel)

// Provider ID mapping from models.dev to our ProviderId

const PROVIDER_MAP: Record<string, ProviderId | undefined> = {
  anthropic: "anthropic",
  "amazon-bedrock": "bedrock",
  openai: "openai",
  google: "google",
  mistral: "mistral",
}

// ModelRegistry Error

export class ModelRegistryError extends Schema.TaggedError<ModelRegistryError>()(
  "ModelRegistryError",
  { message: Schema.String },
) {}

// ModelRegistry Service

export interface ModelRegistryService {
  readonly getProviders: () => Effect.Effect<readonly Provider[]>
  readonly getModels: (providerId: ProviderId) => Effect.Effect<readonly Model[]>
  readonly getModel: (modelId: ModelId) => Effect.Effect<Option.Option<Model>>
  readonly getAllModels: () => Effect.Effect<readonly Model[]>
  readonly refresh: () => Effect.Effect<void>
}

export class ModelRegistry extends Context.Tag("@gent/runtime/src/model-registry/ModelRegistry")<
  ModelRegistry,
  ModelRegistryService
>() {
  static CACHE_PATH = ".cache/gent/models.json"
  static REFRESH_INTERVAL = 60 * 60 * 1000 // 60 minutes

  static Live: Layer.Layer<ModelRegistry, never, FileSystem.FileSystem | Path.Path> = Layer.scoped(
    ModelRegistry,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const home = process.env["HOME"] ?? "~"
      const cachePath = path.join(home, ModelRegistry.CACHE_PATH)

      const CacheFileJson = Schema.parseJson(CacheFile)

      // State: cached models
      const modelsRef = yield* Ref.make<readonly Model[]>(DEFAULT_MODELS)

      // Load cache from disk
      const loadCache = Effect.gen(function* () {
        const exists = yield* fs.exists(cachePath)
        if (exists === false) return undefined

        const content = yield* fs.readFileString(cachePath)
        const cache = yield* Schema.decodeUnknown(CacheFileJson)(content)

        const age = Date.now() - cache.updatedAt
        if (age < ModelRegistry.REFRESH_INTERVAL) {
          return cache.models
        }
        return undefined
      }).pipe(
        Effect.flatMap((models) =>
          models !== undefined ? Ref.set(modelsRef, models) : Effect.void,
        ),
        Effect.catchAll(() => Effect.void),
      )

      // Save cache to disk
      const saveCache = (models: readonly Model[]) =>
        Effect.gen(function* () {
          const cacheDir = path.dirname(cachePath)
          yield* fs.makeDirectory(cacheDir, { recursive: true })
          const json = yield* Schema.encode(CacheFileJson)({
            models: [...models],
            updatedAt: Date.now(),
          })
          yield* fs.writeFileString(cachePath, json)
        }).pipe(Effect.catchAll(() => Effect.void))

      // Fetch from models.dev API
      const fetchModels = Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: () => fetch("https://models.dev/api/models"),
          catch: () => new ModelRegistryError({ message: "Fetch failed" }),
        })

        if (!response.ok) {
          return yield* new ModelRegistryError({ message: `API error: ${response.status}` })
        }

        const json = yield* Effect.tryPromise({
          try: () => response.json() as Promise<unknown>,
          catch: () => new ModelRegistryError({ message: "JSON parse failed" }),
        })

        const apiModels = yield* Schema.decodeUnknown(ModelsDevResponse)(json).pipe(
          Effect.mapError(() => new ModelRegistryError({ message: "Invalid API response" })),
        )

        const models: Model[] = []
        for (const m of apiModels) {
          const providerId = PROVIDER_MAP[m.provider]
          if (providerId === undefined) continue

          models.push(
            new Model({
              id: `${providerId}/${m.id}` as ModelId,
              name: m.name,
              provider: providerId,
              contextLength: m.context_length,
            }),
          )
        }

        return models
      })

      // Refresh models from API
      const refresh = Effect.gen(function* () {
        const models = yield* fetchModels.pipe(
          Effect.catchAll(() => Effect.succeed(DEFAULT_MODELS as readonly Model[])),
        )
        yield* Ref.set(modelsRef, models)
        yield* saveCache(models)
      })

      // Initial load: try cache, then background refresh
      yield* loadCache
      yield* Effect.forkDaemon(
        refresh.pipe(Effect.repeat(Schedule.spaced(ModelRegistry.REFRESH_INTERVAL))),
      )

      const service: ModelRegistryService = {
        getProviders: () => Effect.succeed(SUPPORTED_PROVIDERS),

        getModels: (providerId) =>
          Ref.get(modelsRef).pipe(
            Effect.map((models) => models.filter((m) => m.provider === providerId)),
          ),

        getModel: (modelId) =>
          Ref.get(modelsRef).pipe(
            Effect.map((models) => Option.fromNullable(models.find((m) => m.id === modelId))),
          ),

        getAllModels: () => Ref.get(modelsRef),

        refresh: () => refresh,
      }

      return service
    }),
  )

  static Test = (models: readonly Model[] = DEFAULT_MODELS): Layer.Layer<ModelRegistry> =>
    Layer.succeed(ModelRegistry, {
      getProviders: () => Effect.succeed(SUPPORTED_PROVIDERS),
      getModels: (providerId) => Effect.succeed(models.filter((m) => m.provider === providerId)),
      getModel: (modelId) =>
        Effect.succeed(Option.fromNullable(models.find((m) => m.id === modelId))),
      getAllModels: () => Effect.succeed(models),
      refresh: () => Effect.void,
    })
}
