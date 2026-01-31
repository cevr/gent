import { Config, Context, Effect, Layer, Option, Ref, Schema } from "effect"
import { FileSystem, Path } from "@effect/platform"
import { Model } from "@gent/core"
import type { ModelId, ModelPricing } from "@gent/core"
import * as os from "node:os"

const MODELS_URL = "https://models.dev"
const CACHE_RELATIVE = ".gent/models.json"
const JsonSchema = Schema.parseJson(Schema.Unknown)
const decodeJson = Schema.decodeUnknown(JsonSchema)

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

export class ModelRegistry extends Context.Tag("@gent/runtime/src/model-registry/ModelRegistry")<
  ModelRegistry,
  ModelRegistryService
>() {
  static Live: Layer.Layer<ModelRegistry, never, FileSystem.FileSystem | Path.Path> = Layer.scoped(
    ModelRegistry,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* Config.option(Config.string("HOME")).pipe(
        Effect.catchAll(() => Effect.succeed(Option.none())),
        Effect.map(Option.getOrElse(() => os.homedir())),
      )
      const cachePath = path.join(home, CACHE_RELATIVE)
      const cacheRef = yield* Ref.make<readonly Model[] | null>(null)

      const loadFromDisk = Effect.gen(function* () {
        const exists = yield* fs.exists(cachePath)
        if (!exists) return [] as readonly Model[]
        const content = yield* fs
          .readFileString(cachePath)
          .pipe(Effect.catchAll(() => Effect.succeed("")))
        if (content.trim().length === 0) return [] as readonly Model[]
        const decoded = yield* decodeJson(content).pipe(Effect.catchAll(() => Effect.succeed(null)))
        return parseModelsDev(decoded)
      }).pipe(Effect.catchAll(() => Effect.succeed([] as readonly Model[])))

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
        const decoded = yield* decodeJson(text).pipe(Effect.catchAll(() => Effect.succeed(null)))
        const parsed = parseModelsDev(decoded)
        if (parsed.length > 0) {
          const dir = path.dirname(cachePath)
          yield* fs.makeDirectory(dir, { recursive: true })
          yield* fs.writeFileString(cachePath, text).pipe(Effect.catchAll(() => Effect.void))
        }
        return parsed
      }).pipe(Effect.catchAll(() => Effect.succeed([] as readonly Model[])))

      const load = Effect.gen(function* () {
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

      const refresh = Effect.gen(function* () {
        const remote = yield* fetchRemote
        if (remote.length > 0) {
          yield* Ref.set(cacheRef, remote)
        }
      })

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
