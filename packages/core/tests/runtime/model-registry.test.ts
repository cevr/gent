import { describe, it, expect } from "effect-bun-test"
import { BunFileSystem } from "@effect/platform-bun"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AuthStore } from "../../src/domain/auth-store.js"
import { Model, ModelId } from "../../src/domain/model.js"
import { DriverRegistry } from "../../src/runtime/extensions/driver-registry.js"
import { ModelRegistry } from "../../src/runtime/model-registry.js"
import { RuntimePlatform } from "../../src/runtime/runtime-platform.js"

const CachedModelsJson = Schema.fromJsonString(Schema.Array(Model))
const encodeCachedModels = Schema.encodeSync(CachedModelsJson)

const remoteCatalog = {
  openai: {
    models: {
      "gpt-5.4": {
        name: "GPT-5.4",
        cost: { input: 1.25, output: 10 },
        limit: { context: 400_000 },
      },
    },
  },
}

const passThroughDrivers = DriverRegistry.fromResolved({
  modelDrivers: new Map(),
  externalDrivers: new Map(),
})

const authLayer = Layer.succeed(AuthStore, {
  get: () => Effect.succeed(undefined),
  set: () => Effect.void,
  remove: () => Effect.void,
  list: () => Effect.succeed([]),
  listInfo: () => Effect.succeed({}),
})

const makeHttpLayer = (responseText: string) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(responseText, { status: 200 })),
      ),
    ),
  )

const makeRegistryLayer = (home: string, responseText: string) =>
  ModelRegistry.Live.pipe(
    Layer.provide(
      Layer.mergeAll(
        BunFileSystem.layer,
        Path.layer,
        RuntimePlatform.Test({ cwd: home, home, platform: "test" }),
        passThroughDrivers,
        authLayer,
        makeHttpLayer(responseText),
      ),
    ),
  )

const loadRegistry = (home: string, responseText: string) =>
  Effect.gen(function* () {
    return yield* ModelRegistry
  }).pipe(Effect.provide(makeRegistryLayer(home, responseText)))

describe("ModelRegistry", () => {
  it.live("loads cached canonical models from disk", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const tmpDir = yield* fs.makeTempDirectoryScoped()
        const cachePath = path.join(tmpDir, ".gent/models.json")
        yield* fs.makeDirectory(path.dirname(cachePath), { recursive: true })
        yield* fs.writeFileString(
          cachePath,
          encodeCachedModels([
            new Model({
              id: ModelId.of("openai/gpt-5.4"),
              name: "GPT-5.4",
              provider: "openai",
              contextLength: 400_000,
            }),
          ]),
        )

        const registry = yield* loadRegistry(tmpDir, JSON.stringify({}))
        const models = yield* registry.list()

        expect(models).toHaveLength(1)
        expect(models[0]?.id).toBe("openai/gpt-5.4")
        expect(models[0]?.name).toBe("GPT-5.4")
      }),
    ).pipe(Effect.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
  )

  it.live("refresh writes canonical model cache instead of raw remote payload", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const tmpDir = yield* fs.makeTempDirectoryScoped()
        const cachePath = path.join(tmpDir, ".gent/models.json")

        const registry = yield* loadRegistry(tmpDir, JSON.stringify(remoteCatalog))
        yield* registry.refresh()

        const cached = yield* fs.readFileString(cachePath)
        const decoded = Schema.decodeUnknownSync(CachedModelsJson)(cached)

        expect(Array.isArray(decoded)).toBe(true)
        expect(decoded).toHaveLength(1)
        expect(decoded[0]?.id).toBe("openai/gpt-5.4")
        expect(decoded[0]?.provider).toBe("openai")
        expect(cached.includes('"openai":{"models"')).toBe(false)
      }),
    ).pipe(Effect.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
  )

  it.live("ignores malformed cache payloads instead of leaking raw shapes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const tmpDir = yield* fs.makeTempDirectoryScoped()
        const cachePath = path.join(tmpDir, ".gent/models.json")
        yield* fs.makeDirectory(path.dirname(cachePath), { recursive: true })
        yield* fs.writeFileString(cachePath, '{"openai":{"models":{}}}')

        const registry = yield* loadRegistry(tmpDir, JSON.stringify({}))
        const models = yield* registry.list()

        expect(models).toEqual([])
      }),
    ).pipe(Effect.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
  )
})
