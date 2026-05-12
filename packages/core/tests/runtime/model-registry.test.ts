import { describe, it, expect } from "effect-bun-test"
import { BunFileSystem } from "@effect/platform-bun"
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Ref,
  Schedule,
  Schema,
} from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Auth, AuthError, type AuthInfo } from "../../src/domain/auth.js"
import type { ModelDriverContribution, ProviderResolution } from "../../src/domain/driver.js"
import { Model, ModelId, ProviderId } from "../../src/domain/model.js"
import { DriverRegistry } from "../../src/runtime/extensions/driver-registry.js"
import { ModelRegistry } from "../../src/runtime/model-registry.js"
import { RuntimeEnvironment } from "../../src/runtime/runtime-environment.js"
import { waitFor } from "../../src/test-utils/fixtures.js"
import { LanguageModel, Model as AiModel } from "effect/unstable/ai"
import { failingLanguageModel } from "../helpers/failing-language-model.js"

const CachedModelsJson = Schema.fromJsonString(Schema.Array(Model))
const encodeCachedModels = Schema.encodeSync(CachedModelsJson)
const AnyJson = Schema.fromJsonString(Schema.Unknown)
const encodeAnyJson = Schema.encodeSync(AnyJson)

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

const unusedResolution = (): ProviderResolution =>
  AiModel.make("test", "model", Layer.succeed(LanguageModel.LanguageModel, failingLanguageModel))

const missingAuthInfo: AuthInfo | undefined = undefined
const authLayer = Layer.succeed(Auth, {
  get: () => Effect.succeed(missingAuthInfo),
  set: () => Effect.void,
  remove: () => Effect.void,
})

const failingReadAuthLayer = Layer.succeed(Auth, {
  get: () => Effect.fail(new AuthError({ message: "read failed" })),
  set: () => Effect.void,
  remove: () => Effect.void,
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
        RuntimeEnvironment.Test({ cwd: home, home, platform: "test" }),
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
  overrideAuthLayer: Layer.Layer<Auth> = authLayer,
) =>
  ModelRegistry.Live.pipe(
    Layer.provide(
      Layer.mergeAll(
        BunFileSystem.layer,
        Path.layer,
        RuntimeEnvironment.Test({ cwd: home, home, platform: "test" }),
        DriverRegistry.fromResolved({
          modelDrivers: new Map(modelDrivers.map((driver) => [driver.id, driver])),
          externalDrivers: new Map(),
        }),
        overrideAuthLayer,
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
        RuntimeEnvironment.Test({ cwd: home, home, platform: "test" }),
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
            Model.make({
              id: ModelId.make("openai/gpt-5.4"),
              name: "GPT-5.4",
              provider: ProviderId.make("openai"),
              contextLength: 400_000,
            }),
          ]),
        )

        const registry = yield* loadRegistry(tmpDir, encodeAnyJson({}))
        const models = yield* registry.list()

        expect(models).toHaveLength(1)
        expect(models[0]?.id).toBe(ModelId.make("openai/gpt-5.4"))
        expect(models[0]?.name).toBe("GPT-5.4")
      }),
    ).pipe(Effect.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
  )

  it.live("background refresh writes canonical model cache instead of raw remote payload", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const tmpDir = yield* fs.makeTempDirectoryScoped()
        const cachePath = path.join(tmpDir, ".gent/models.json")

        const registry = yield* loadRegistry(tmpDir, encodeAnyJson(remoteCatalog))
        yield* waitFor(
          registry.list(),
          (models) => models.some((model) => model.id === "openai/gpt-5.4"),
          5_000,
          "background refresh to land",
        )

        const cached = yield* fs.readFileString(cachePath)
        const decoded = yield* Schema.decodeUnknownEffect(CachedModelsJson)(cached)

        expect(Array.isArray(decoded)).toBe(true)
        expect(decoded).toHaveLength(1)
        expect(decoded[0]?.id).toBe(ModelId.make("openai/gpt-5.4"))
        expect(decoded[0]?.provider).toBe(ProviderId.make("openai"))
        expect(cached.includes('"openai":{"models"')).toBe(false)
      }),
    ).pipe(Effect.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
  )

  it.live(
    "background refresh preserves valid remote models when sibling entries are malformed",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const tmpDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()

          const registry = yield* loadRegistry(tmpDir, encodeAnyJson(mixedRemoteCatalog))
          const models = yield* waitFor(
            registry.list(),
            (models) => models.some((model) => model.id === "openai/gpt-5.4"),
            5_000,
            "background refresh to land",
          )

          expect(models).toHaveLength(1)
          expect(models[0]?.id).toBe(ModelId.make("openai/gpt-5.4"))
        }),
      ).pipe(Effect.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
  )

  it.live("applies typed model-driver catalog filters", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tmpDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
        const context = yield* Layer.build(
          makeRegistryLayerWithDrivers(tmpDir, encodeAnyJson(remoteCatalog), [
            {
              id: "typed-filter",
              name: "Typed filter",
              resolveModel: unusedResolution,
              listModels: (models) =>
                models.map((model) =>
                  model.provider === "openai"
                    ? Model.make({ ...model, name: `${model.name} filtered` })
                    : model,
                ),
            },
          ]),
        )
        const registry = Context.get(context, ModelRegistry)

        const models = yield* waitFor(
          registry.list(),
          (models) => models.some((model) => model.name === "GPT-5.4 filtered"),
          5_000,
          "background refresh + filter to land",
        )

        expect(models[0]?.id).toBe(ModelId.make("openai/gpt-5.4"))
        expect(models[0]?.name).toBe("GPT-5.4 filtered")
      }),
    ).pipe(Effect.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
  )

  it.live("fails closed when a model-driver filter returns malformed output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tmpDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
        const malformed = Model.make({
          id: ModelId.make("openai/broken"),
          name: "Broken",
          provider: ProviderId.make("openai"),
        })
        Reflect.set(malformed, "name", 42)
        const context = yield* Layer.build(
          makeRegistryLayerWithDrivers(tmpDir, encodeAnyJson(remoteCatalog), [
            {
              id: "malformed-filter",
              name: "Malformed filter",
              resolveModel: unusedResolution,
              listModels: () => [malformed],
            },
          ]),
        )
        const registry = Context.get(context, ModelRegistry)

        const error = yield* Effect.flip(registry.list())

        expect(error._tag).toBe("DriverError")
        if (error._tag === "DriverError") {
          expect(error.reason).toContain("returned an invalid model catalog")
        }
      }),
    ).pipe(Effect.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
  )

  it.live("fails closed when auth lookup fails during model-driver catalog filtering", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tmpDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
        let filterCalled = false
        const context = yield* Layer.build(
          makeRegistryLayerWithDrivers(
            tmpDir,
            encodeAnyJson(remoteCatalog),
            [
              {
                id: "auth-filter",
                name: "Auth filter",
                resolveModel: unusedResolution,
                listModels: (models) => {
                  filterCalled = true
                  return models
                },
              },
            ],
            failingReadAuthLayer,
          ),
        )
        const registry = Context.get(context, ModelRegistry)

        const error = yield* Effect.flip(registry.list())

        expect(error._tag).toBe("ProviderAuthError")
        expect(filterCalled).toBe(false)
        if (error._tag === "ProviderAuthError") {
          expect(error.message).toContain('Failed to read auth for provider "auth-filter"')
        }
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

        const registry = yield* loadRegistry(tmpDir, encodeAnyJson({}))
        const models = yield* registry.list()

        expect(models).toEqual([])
      }),
    ).pipe(Effect.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
  )

  it.live("startup refresh keeps canonical cache available until remote cache lands", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const started = yield* Deferred.make<void>()
        const response = yield* Deferred.make<string>()
        const tmpDir = yield* fs.makeTempDirectoryScoped()
        const cachePath = path.join(tmpDir, ".gent/models.json")
        yield* fs.makeDirectory(path.dirname(cachePath), { recursive: true })
        yield* fs.writeFileString(
          cachePath,
          encodeCachedModels([
            Model.make({
              id: ModelId.make("openai/gpt-4.1"),
              name: "GPT-4.1",
              provider: ProviderId.make("openai"),
              contextLength: 256_000,
            }),
          ]),
        )

        const registry = yield* loadDeferredRegistry(tmpDir, started, response)
        yield* Deferred.await(started)

        const cachedModels = yield* registry.list()
        expect(cachedModels).toHaveLength(1)
        expect(cachedModels[0]?.id).toBe(ModelId.make("openai/gpt-4.1"))

        yield* Deferred.succeed(response, encodeAnyJson(remoteCatalog))
        const refreshedModels = yield* waitFor(
          registry.list(),
          (models) => models.some((model) => model.id === "openai/gpt-5.4"),
          5_000,
          "background model refresh",
        )

        expect(refreshedModels).toHaveLength(1)
        expect(refreshedModels[0]?.id).toBe(ModelId.make("openai/gpt-5.4"))
      }),
    ).pipe(Effect.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
  )

  it.live("refresh write is not overwritten by an in-flight load that finishes later", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tmpDir = yield* fs.makeTempDirectoryScoped()

        // Two HTTP requests: first returns a stale 4.1 catalog (the one
        // foreground list() is loading via fetchRemote because disk is
        // empty); second returns the fresh 5.4 catalog (refresh fetches it).
        // Both block on per-call deferreds so the test controls ordering.
        const staleResponse = yield* Deferred.make<string>()
        const freshResponse = yield* Deferred.make<string>()
        const callCount = yield* Ref.make(0)

        // Auto-forked refresh makes the FIRST HTTP request (assigned `fresh`);
        // the foreground `list()` makes the SECOND (assigned `stale`).
        const racingHttpLayer = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.gen(function* () {
              const n = yield* Ref.updateAndGet(callCount, (c) => c + 1)
              const body = yield* Deferred.await(n === 1 ? freshResponse : staleResponse)
              return HttpClientResponse.fromWeb(request, new Response(body, { status: 200 }))
            }),
          ),
        )

        const layer = ModelRegistry.Live.pipe(
          Layer.provide(
            Layer.mergeAll(
              BunFileSystem.layer,
              Path.layer,
              RuntimeEnvironment.Test({ cwd: tmpDir, home: tmpDir, platform: "test" }),
              passThroughDrivers,
              authLayer,
              racingHttpLayer,
            ),
          ),
        )
        const context = yield* Layer.build(layer)
        const registry = Context.get(context, ModelRegistry)

        const staleCatalog = {
          openai: {
            models: {
              "gpt-4.1": {
                name: "GPT-4.1",
                cost: { input: 1, output: 2 },
                limit: { context: 256_000 },
              },
            },
          },
        }

        // Wait until both HTTP calls have started, so list()'s in-flight load
        // and the forked startup refresh are both suspended on their
        // deferreds. (Startup refresh is auto-forked when the Live layer
        // builds; the test triggers list() separately.)
        const listFiber = yield* Effect.forkChild(registry.list())
        yield* Effect.repeat(Ref.get(callCount), {
          until: (n) => n >= 2,
          schedule: Schedule.spaced("5 millis"),
        }).pipe(Effect.timeout(2_000))

        // Release fresh first: refresh resolves 5.4 and tries to write the
        // cache, but list() still holds the SynchronizedRef permit, so the
        // write is queued. Then release stale: list() resolves 4.1, writes
        // 4.1 to the cache, releases the permit. refresh's queued write
        // then sets the cache to 5.4 (last winner).
        yield* Deferred.succeed(freshResponse, encodeAnyJson(remoteCatalog))
        yield* Deferred.succeed(staleResponse, encodeAnyJson(staleCatalog))

        const staleList = yield* Fiber.join(listFiber)
        // The in-flight load saw 4.1 — it returns 4.1 to its caller.
        expect(staleList[0]?.id).toBe(ModelId.make("openai/gpt-4.1"))

        // Auto-forked refresh's queued SynchronizedRef.set runs after listFiber
        // releases the permit. Once it lands, the cache is 5.4 — and stays 5.4.
        // Under the buggy original Ref-based code the in-flight 4.1 write
        // overwrote the 5.4 write and this assertion would never converge.
        const freshList = yield* waitFor(
          registry.list(),
          (models) => models.some((m) => m.id === "openai/gpt-5.4"),
          5_000,
          "refresh write after in-flight load completes",
        )
        expect(freshList).toHaveLength(1)
        expect(freshList[0]?.id).toBe(ModelId.make("openai/gpt-5.4"))
      }),
    ).pipe(Effect.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
  )
})
