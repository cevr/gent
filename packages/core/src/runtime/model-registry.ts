import { Config, ServiceMap, Effect, Layer, Option, Ref, Schema, FileSystem, Path } from "effect"
import { Model } from "../domain/model.js"
import type { ModelId, ModelPricing } from "../domain/model.js"
import { ExtensionRegistry } from "./extensions/registry.js"
import { RuntimePlatform } from "./runtime-platform.js"

const MODELS_URL = "https://models.dev"
const CACHE_RELATIVE = ".gent/models.json"
const JsonSchema = Schema.fromJsonString(Schema.Unknown)
const decodeJson = Schema.decodeUnknownEffect(JsonSchema)

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const parsePricing = (value: unknown): ModelPricing | undefined => {
  if (!isRecord(value)) return undefined
  const input = value["input"]
  const output = value["output"]
  if (typeof input !== "number" || typeof output !== "number") return undefined
  return { input, output }
}

const parseContextLength = (value: unknown): number | undefined => {
  if (!isRecord(value)) return undefined
  const context = value["context"]
  return typeof context === "number" ? context : undefined
}

const parseModelsDev = (data: unknown): readonly Model[] => {
  if (!isRecord(data)) return []

  const models: Model[] = []
  for (const [providerId, providerValue] of Object.entries(data)) {
    if (!isRecord(providerValue)) continue
    const modelsValue = providerValue["models"]
    if (!isRecord(modelsValue)) continue

    for (const [modelKey, modelValue] of Object.entries(modelsValue)) {
      if (!isRecord(modelValue)) continue
      const name = typeof modelValue["name"] === "string" ? modelValue["name"] : modelKey
      const pricing = parsePricing(modelValue["cost"])
      const contextLength = parseContextLength(modelValue["limit"])
      const id = `${providerId}/${modelKey}` as ModelId

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

export interface ModelRegistryService {
  readonly list: () => Effect.Effect<readonly Model[]>
  readonly get: (modelId: ModelId) => Effect.Effect<Model | undefined>
  readonly refresh: () => Effect.Effect<void>
}

export class ModelRegistry extends ServiceMap.Service<ModelRegistry, ModelRegistryService>()(
  "@gent/core/src/runtime/model-registry/ModelRegistry",
) {
  static Live: Layer.Layer<
    ModelRegistry,
    never,
    FileSystem.FileSystem | Path.Path | RuntimePlatform | ExtensionRegistry
  > = Layer.effect(
    ModelRegistry,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const runtimePlatform = yield* RuntimePlatform
      const extensionRegistry = yield* ExtensionRegistry
      const homeOption = yield* Effect.gen(function* () {
        return yield* Config.option(Config.string("HOME"))
      }).pipe(Effect.catchEager(() => Effect.succeed(Option.none())))
      const home = Option.getOrElse(homeOption, () => runtimePlatform.home)
      const cachePath = path.join(home, CACHE_RELATIVE)
      const cacheRef = yield* Ref.make<readonly Model[] | null>(null)

      const loadFromDisk = Effect.gen(function* () {
        const exists = yield* fs.exists(cachePath)
        if (!exists) return [] as readonly Model[]
        const content = yield* fs
          .readFileString(cachePath)
          .pipe(Effect.catchEager(() => Effect.succeed("")))
        if (content.trim().length === 0) return [] as readonly Model[]
        const decoded = yield* decodeJson(content).pipe(
          Effect.catchEager(() => Effect.succeed(null)),
        )
        return parseModelsDev(decoded)
      }).pipe(
        Effect.catchEager(() => Effect.succeed([] as readonly Model[])),
        Effect.withSpan("ModelRegistry.loadFromDisk"),
      )

      const fetchRemote = Effect.gen(function* () {
        const res = yield* Effect.tryPromise({
          try: () =>
            fetch(`${MODELS_URL}/api.json`, {
              headers: { "User-Agent": "gent" },
              signal: AbortSignal.timeout(10_000),
            }),
          catch: () => undefined,
        })
        if (res === undefined || !res.ok) return [] as readonly Model[]
        const text = yield* Effect.tryPromise({
          try: () => res.text(),
          catch: () => "",
        })
        if (text.length === 0) return [] as readonly Model[]
        const decoded = yield* decodeJson(text).pipe(Effect.catchEager(() => Effect.succeed(null)))
        const parsed = parseModelsDev(decoded)
        if (parsed.length > 0) {
          const dir = path.dirname(cachePath)
          yield* fs.makeDirectory(dir, { recursive: true })
          yield* fs
            .writeFileString(cachePath, text)
            .pipe(Effect.catchEager((e) => Effect.logWarning("failed to write model cache", e)))
        }
        return parsed
      }).pipe(
        Effect.catchEager(() => Effect.succeed([] as readonly Model[])),
        Effect.withSpan("ModelRegistry.fetchRemote"),
      )

      const load = Effect.gen(function* () {
        const cached = yield* Ref.get(cacheRef)
        if (cached !== null) return cached
        const disk = yield* loadFromDisk
        if (disk.length > 0) {
          const result = yield* applyFilters(disk)
          yield* Ref.set(cacheRef, result)
          return result
        }
        const remote = yield* fetchRemote
        const result = yield* applyFilters(remote)
        yield* Ref.set(cacheRef, result)
        return result
      }).pipe(Effect.withSpan("ModelRegistry.load"))

      const applyFilters = (models: readonly Model[]) =>
        extensionRegistry.filterProviderModels(models).pipe(
          Effect.map((filtered) => filtered as readonly Model[]),
          Effect.catchEager(() => Effect.succeed(models)),
        )

      const refresh = Effect.gen(function* () {
        const remote = yield* fetchRemote
        if (remote.length > 0) {
          const filtered = yield* applyFilters(remote)
          yield* Ref.set(cacheRef, filtered)
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
