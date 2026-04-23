import { describe, it, expect } from "effect-bun-test"
import { BunFileSystem } from "@effect/platform-bun"
import { Context, Deferred, Effect, FileSystem, Layer, Path, Schema, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AuthStore } from "../../src/domain/auth-store.js"
import type { ModelDriverContribution, ProviderResolution } from "../../src/domain/driver.js"
import { Model, ModelId } from "../../src/domain/model.js"
import { DriverRegistry } from "../../src/runtime/extensions/driver-registry.js"
import { ModelRegistry } from "../../src/runtime/model-registry.js"
import { RuntimePlatform } from "../../src/runtime/runtime-platform.js"
import { waitFor } from "../../src/test-utils/fixtures.js"
import { LanguageModel } from "effect/unstable/ai"
import * as AiError from "effect/unstable/ai/AiError"

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

const legacyCatalog = {
  openai: {
    models: {
      "gpt-4.1": {
        name: "GPT-4.1",
        cost: { input: 2, output: 8 },
        limit: { context: 256_000 },
      },
    },
  },
}

const mixedRemoteCatalog = {
  openai: {
    models: {
      "gpt-5.4": {
        name: "GPT-5.4",
        cost: { input: 1.25, output: 10 },
        limit: { context: 400_000 },
      },
      broken: {
        name: 42,
      },
    },
  },
  brokenProvider: {
    models: null,
  },
}

const passThroughDrivers = DriverRegistry.fromResolved({
  modelDrivers: new Map(),
  externalDrivers: new Map(),
})

const unusedLanguageModel: LanguageModel.Service = {
  generateText: () =>
    Effect.fail(
      AiError.make({
        module: "Test",
        method: "generateText",
        reason: new AiError.UnknownError({ description: "unused" }),
      }),
    ),
  generateObject: () =>
    Effect.fail(
      AiError.make({
        module: "Test",
        method: "generateObject",
        reason: new AiError.UnknownError({ description: "unused" }),
      }),
    ),
  streamText: () =>
    Stream.fail(
      AiError.make({
        module: "Test",
        method: "streamText",
        reason: new AiError.UnknownError({ description: "unused" }),
      }),
    ),
}

const unusedResolution = (): ProviderResolution => ({
  layer: Layer.succeed(LanguageModel.LanguageModel, unusedLanguageModel),
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

const makeDeferredHttpLayer = (
  started: Deferred.Deferred<void>,
  response: Deferred.Deferred<string>,
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined).pipe(Effect.ignore)
        const body = yield* Deferred.await(response)
        return HttpClientResponse.fromWeb(request, new Response(body, { status: 200 }))
      }),
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

const makeRegistryLayerWithDrivers = (
  home: string,
  responseText: string,
  modelDrivers: ReadonlyArray<ModelDriverContribution>,
) =>
  ModelRegistry.Live.pipe(
    Layer.provide(
      Layer.mergeAll(
        BunFileSystem.layer,
        Path.layer,
        RuntimePlatform.Test({ cwd: home, home, platform: "test" }),
        DriverRegistry.fromResolved({
          modelDrivers: new Map(modelDrivers.map((driver) => [driver.id, driver])),
          externalDrivers: new Map(),
        }),
        authLayer,
        makeHttpLayer(responseText),
      ),
    ),
  )

const makeDeferredRegistryLayer = (
  home: string,
  started: Deferred.Deferred<void>,
  response: Deferred.Deferred<string>,
) =>
  ModelRegistry.Live.pipe(
    Layer.provide(
      Layer.mergeAll(
        BunFileSystem.layer,
        Path.layer,
        RuntimePlatform.Test({ cwd: home, home, platform: "test" }),
        passThroughDrivers,
        authLayer,
        makeDeferredHttpLayer(started, response),
      ),
    ),
  )

const loadRegistry = (home: string, responseText: string) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(makeRegistryLayer(home, responseText))
    return Context.get(context, ModelRegistry)
  })

const loadDeferredRegistry = (
  home: string,
  started: Deferred.Deferred<void>,
  response: Deferred.Deferred<string>,
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(makeDeferredRegistryLayer(home, started, response))
    return Context.get(context, ModelRegistry)
  })

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

  it.live("loads legacy raw catalog cache and rewrites it to canonical models", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const tmpDir = yield* fs.makeTempDirectoryScoped()
        const cachePath = path.join(tmpDir, ".gent/models.json")
        yield* fs.makeDirectory(path.dirname(cachePath), { recursive: true })
        yield* fs.writeFileString(cachePath, JSON.stringify(legacyCatalog))

        const registry = yield* loadRegistry(tmpDir, JSON.stringify({}))
        const models = yield* registry.list()
        const rewritten = yield* fs.readFileString(cachePath)
        const decoded = Schema.decodeUnknownSync(CachedModelsJson)(rewritten)

        expect(models).toHaveLength(1)
        expect(models[0]?.id).toBe("openai/gpt-4.1")
        expect(Array.isArray(decoded)).toBe(true)
        expect(decoded).toHaveLength(1)
        expect(decoded[0]?.id).toBe("openai/gpt-4.1")
        expect(rewritten.includes('"openai":{"models"')).toBe(false)
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

  it.live("refresh preserves valid remote models when sibling entries are malformed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tmpDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()

        const registry = yield* loadRegistry(tmpDir, JSON.stringify(mixedRemoteCatalog))
        yield* registry.refresh()
        const models = yield* registry.list()

        expect(models).toHaveLength(1)
        expect(models[0]?.id).toBe("openai/gpt-5.4")
      }),
    ).pipe(Effect.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
  )

  it.live("applies typed model-driver catalog filters", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tmpDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
        const registry = yield* Effect.gen(function* () {
          const context = yield* Layer.build(
            makeRegistryLayerWithDrivers(tmpDir, JSON.stringify(remoteCatalog), [
              {
                id: "typed-filter",
                name: "Typed filter",
                resolveModel: unusedResolution,
                listModels: (models) =>
                  models.map((model) =>
                    model.provider === "openai"
                      ? new Model({ ...model, name: `${model.name} filtered` })
                      : model,
                  ),
              },
            ]),
          )
          return Context.get(context, ModelRegistry)
        })

        yield* registry.refresh()
        const models = yield* registry.list()

        expect(models[0]?.id).toBe("openai/gpt-5.4")
        expect(models[0]?.name).toBe("GPT-5.4 filtered")
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

  it.live("startup refresh keeps legacy cache available until remote canonical cache lands", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const started = yield* Deferred.make<void>()
        const response = yield* Deferred.make<string>()
        const tmpDir = yield* fs.makeTempDirectoryScoped()
        const cachePath = path.join(tmpDir, ".gent/models.json")
        yield* fs.makeDirectory(path.dirname(cachePath), { recursive: true })
        yield* fs.writeFileString(cachePath, JSON.stringify(legacyCatalog))

        const registry = yield* loadDeferredRegistry(tmpDir, started, response)
        yield* Deferred.await(started)

        const cachedModels = yield* registry.list()
        expect(cachedModels).toHaveLength(1)
        expect(cachedModels[0]?.id).toBe("openai/gpt-4.1")

        yield* Deferred.succeed(response, JSON.stringify(remoteCatalog))
        const refreshedModels = yield* waitFor(
          registry.list(),
          (models) => models.some((model) => model.id === "openai/gpt-5.4"),
          5_000,
          "background model refresh",
        )

        expect(refreshedModels).toHaveLength(1)
        expect(refreshedModels[0]?.id).toBe("openai/gpt-5.4")
      }),
    ).pipe(Effect.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
  )
})
