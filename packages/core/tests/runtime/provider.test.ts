import { describe, expect, it } from "effect-bun-test"
import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Ref,
  Schedule,
  Schema,
  Stream,
} from "effect"
import { TestClock } from "effect/testing"
import * as AiError from "effect/unstable/ai/AiError"
import {
  DEFAULT_RETRY_POLICY,
  type ModelDriverContribution,
  ProviderAuthError,
  type ProviderResolution,
} from "../../src/domain/driver"
import { ProviderError } from "../../src/domain/errors"
import {
  Auth,
  AuthApi,
  AuthError,
  AuthGuard,
  AuthInfo,
  AuthMethod,
  type AuthService,
  ListAuthProvidersPayload,
  ModelResolver,
  ProviderAuth,
  retryProviderCall,
  ModelRegistry,
} from "../../src/runtime/provider"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { RuntimeEnvironment } from "../../src/runtime/config.js"
import { Model as AiModel, LanguageModel } from "effect/unstable/ai"
import { test as bunTest } from "bun:test"
import {
  DriverRegistry,
  type DriverRegistryService,
  ExtensionRegistry,
  resolveExtensions,
} from "../../src/runtime/extension-host"
import type { LoadedExtension } from "../../src/domain/extension.js"
import {
  AgentDefinition,
  AgentName,
  DEFAULT_AGENT_NAME,
  ExternalDriverRef,
  ModelId,
  ProviderId,
  Model,
} from "../../src/domain/agent"
import { BranchId, ExtensionId, MessageId, SessionId, ToolCallId } from "../../src/domain/ids"
import { failingLanguageModel, makeLanguageModel } from "../helpers/failing-language-model"
import { GentPlatform } from "../../src/runtime/gent-platform"
import { tool, type ToolCapability } from "@gent/core/extensions/api"
import {
  finishPart,
  LanguageModelLayers,
  toolCallPart,
  waitFor,
} from "../../src/test-utils/language-model"
import { convertTools } from "../../src/runtime/tools"
import { toPrompt } from "../../src/runtime/model-context"
import { dateFromMillis, Message } from "../../src/domain/message"
import { toCodecAnthropic } from "effect/unstable/ai/AnthropicStructuredOutput"
import * as AiTool from "effect/unstable/ai/Tool"
import type * as AiToolkit from "effect/unstable/ai/Toolkit"
import type { ToolkitInput } from "effect/unstable/ai/LanguageModel"
import * as Prompt from "effect/unstable/ai/Prompt"

// ── retry.test ──────────────────────────────────────────────────────────────

/**
 * Provider retry: which failures are retried, how long the schedule waits,
 * and what it reports. The only interface is `retryProviderCall` under a
 * driver `RetryPolicy`.
 */

/** The wire shapes the shipped Anthropic and OpenAI drivers name as transient. */
const transientStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["overloaded_error", "api_error", "rate_limit_error"]),
  }),
  Schema.Struct({ code: Schema.Literals(["server_error", "rate_limit_exceeded"]) }),
])
const policy = { ...DEFAULT_RETRY_POLICY, transientStreamEvent }
const fast = { ...policy, initialDelay: 1, maxDelay: 1, maxAttempts: 3 }

const rateLimited = (retryAfter: Duration.Duration) =>
  new ProviderError({
    message: "Rate limit",
    model: "test",
    cause: AiError.make({
      module: "Test",
      method: "streamText",
      reason: new AiError.RateLimitError({ retryAfter }),
    }),
  })

const invalidKey = new ProviderError({
  message: "Invalid API key",
  model: "test",
  cause: AiError.make({
    module: "Test",
    method: "streamText",
    reason: new AiError.AuthenticationError({ kind: "InvalidKey" }),
  }),
})

const streamEvent = (cause: { type: string } | { code: string }) =>
  new ProviderError({ message: "stream ended with an error event", model: "test", cause })

/** Fails `failures` times with `error`, then succeeds; records every retry delay. */
const failThenSucceed = (error: ProviderOrAuth, failures: number, config = fast) => {
  const delays: Array<number> = []
  let calls = 0
  const run = Effect.gen(function* () {
    calls += 1
    if (calls <= failures) return yield* error
    return "ok"
  }).pipe(
    retryProviderCall(config, {
      onRetry: ({ delayMs }) => Effect.sync(() => void delays.push(delayMs)),
    }),
  )
  return { run, delays, calls: () => calls }
}
type ProviderOrAuth = ProviderError | ProviderAuthError

describe("provider retry", () => {
  it.effect("waits the provider's retry-after before retrying a typed rate limit", () =>
    Effect.gen(function* () {
      const { run, delays } = failThenSucceed(rateLimited(Duration.seconds(30)), 1, {
        ...fast,
        maxDelay: 60_000,
      })
      const fiber = yield* Effect.forkChild(run)
      yield* TestClock.adjust("30 seconds")
      expect(yield* Fiber.join(fiber)).toBe("ok")
      expect(delays).toEqual([30_000])
    }),
  )

  it.effect("caps the provider's retry-after at the configured maximum", () =>
    Effect.gen(function* () {
      const { run, delays } = failThenSucceed(rateLimited(Duration.minutes(10)), 1, {
        ...fast,
        maxDelay: 5_000,
      })
      const fiber = yield* Effect.forkChild(run)
      yield* TestClock.adjust("5 seconds")
      expect(yield* Fiber.join(fiber)).toBe("ok")
      expect(delays).toEqual([5_000])
    }),
  )

  it.effect("backs off exponentially with bounded jitter for a mid-stream overload", () =>
    Effect.gen(function* () {
      const { run, delays } = failThenSucceed(streamEvent({ type: "overloaded_error" }), 2, {
        ...policy,
        initialDelay: 1000,
        maxDelay: 60_000,
        backoffFactor: 2,
        maxAttempts: 3,
      })
      const fiber = yield* Effect.forkChild(run)
      yield* TestClock.adjust("1250 millis")
      yield* TestClock.adjust("2500 millis")
      expect(yield* Fiber.join(fiber)).toBe("ok")
      expect(delays).toHaveLength(2)
      expect(delays[0]).toBeGreaterThanOrEqual(1000)
      expect(delays[0]).toBeLessThanOrEqual(1250)
      expect(delays[1]).toBeGreaterThanOrEqual(2000)
      expect(delays[1]).toBeLessThanOrEqual(2500)
    }),
  )

  it.live("retries an OpenAI stream error code and reports each attempt", () =>
    Effect.gen(function* () {
      const attempts: Array<{ attempt: number; maxAttempts: number; error: string }> = []
      let calls = 0
      const result = yield* Effect.gen(function* () {
        calls += 1
        if (calls < 3) return yield* streamEvent({ code: "server_error" })
        return "ok"
      }).pipe(
        retryProviderCall(fast, {
          onRetry: ({ attempt, maxAttempts, error }) =>
            Effect.sync(() => void attempts.push({ attempt, maxAttempts, error: error.message })),
        }),
      )
      expect(result).toBe("ok")
      expect(attempts).toEqual([
        { attempt: 1, maxAttempts: 3, error: "stream ended with an error event" },
        { attempt: 2, maxAttempts: 3, error: "stream ended with an error event" },
      ])
    }),
  )

  it.live("gives up after the last attempt and fails with the provider error", () =>
    Effect.gen(function* () {
      const { run, delays, calls } = failThenSucceed(streamEvent({ type: "api_error" }), 5)
      const exit = yield* Effect.exit(run)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls()).toBe(3)
      expect(delays).toHaveLength(2)
    }),
  )

  it.live("a credential failure escapes without a retry", () =>
    Effect.gen(function* () {
      const typed = failThenSucceed(invalidKey, 1)
      expect(Exit.isFailure(yield* Effect.exit(typed.run))).toBe(true)
      expect(typed.calls()).toBe(1)

      const auth = failThenSucceed(new ProviderAuthError({ message: "no credentials" }), 1)
      expect(Exit.isFailure(yield* Effect.exit(auth.run))).toBe(true)
      expect(auth.calls()).toBe(1)

      const untyped = failThenSucceed(
        new ProviderError({ message: "Rate limit exceeded (429)", model: "test" }),
        1,
      )
      expect(Exit.isFailure(yield* Effect.exit(untyped.run))).toBe(true)
      expect(untyped.calls()).toBe(1)
    }),
  )
})

// ── model-registry.test ─────────────────────────────────────────────────────

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
    // oxlint-disable-next-line effect/noNullish -- Keep the null value required by this external data contract.
    models: null,
  },
}

const releaseOrderCatalog = {
  anthropic: {
    models: {
      "claude-sonnet-4-6": {
        name: "Claude Sonnet 4.6",
        release_date: "2026-02-17",
        limit: { context: 1_000_000 },
      },
      "claude-opus-5": {
        name: "Claude Opus 5",
        release_date: "2026-07-24",
        limit: { context: 1_000_000 },
      },
      undated: {
        name: "Undated",
        limit: { context: 1_000 },
      },
      "claude-opus-4-6": {
        name: "Claude Opus 4.6",
        release_date: "2026-02",
        limit: { context: 200_000 },
      },
    },
  },
}

const passThroughDrivers = DriverRegistry.fromResolved({
  modelDrivers: new Map(),
  externalDrivers: new Map(),
})

const unusedResolution = (): Effect.Effect<ProviderResolution> =>
  Effect.succeed(
    AiModel.make("test", "model", Layer.succeed(LanguageModel.LanguageModel, failingLanguageModel)),
  )

const authLayer = Layer.succeed(
  Auth,
  Auth.of({
    get: () => Effect.succeed(Option.getOrUndefined(Option.none<AuthInfo>())),
    set: () => Effect.void,
    remove: () => Effect.void,
  }),
)

const failingReadAuthLayer = Layer.succeed(
  Auth,
  Auth.of({
    get: () => Effect.fail(new AuthError({ message: "read failed" })),
    set: () => Effect.void,
    remove: () => Effect.void,
  }),
)

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
        // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
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
        RuntimeEnvironment.Live({ cwd: home, home, platform: "test" }),
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
        RuntimeEnvironment.Live({ cwd: home, home, platform: "test" }),
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
        RuntimeEnvironment.Live({ cwd: home, home, platform: "test" }),
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

describe("model catalog resolution", () => {
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
        const models = yield* registry.list

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
          registry.list,
          (models) => models.some((model) => model.id === "openai/gpt-5.4"),
          5_000,
          "background refresh to land",
        )

        const cached = yield* fs.readFileString(cachePath)
        const decoded = yield* Schema.decodeEffect(CachedModelsJson)(cached)

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
            registry.list,
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
                models.map((model) => {
                  if (model.provider === "openai") {
                    return Model.make({ ...model, name: `${model.name} filtered` })
                  }
                  return model
                }),
            },
          ]),
        )
        const registry = Context.get(context, ModelRegistry)

        const models = yield* waitFor(
          registry.list,
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

        const error = yield* Effect.flip(registry.list)

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

        const error = yield* Effect.flip(registry.list)

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
        const models = yield* registry.list

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

        const cachedModels = yield* registry.list
        expect(cachedModels).toHaveLength(1)
        expect(cachedModels[0]?.id).toBe(ModelId.make("openai/gpt-4.1"))

        yield* Deferred.succeed(response, encodeAnyJson(remoteCatalog))
        const refreshedModels = yield* waitFor(
          registry.list,
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
              let response = staleResponse
              if (n === 1) response = freshResponse
              const body = yield* Deferred.await(response)
              return HttpClientResponse.fromWeb(request, new Response(body, { status: 200 }))
            }),
          ),
        )

        const layer = ModelRegistry.Live.pipe(
          Layer.provide(
            Layer.mergeAll(
              BunFileSystem.layer,
              Path.layer,
              RuntimeEnvironment.Live({ cwd: tmpDir, home: tmpDir, platform: "test" }),
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
        const listFiber = yield* Effect.forkChild(registry.list)
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
          registry.list,
          (models) => models.some((m) => m.id === "openai/gpt-5.4"),
          5_000,
          "refresh write after in-flight load completes",
        )
        expect(freshList).toHaveLength(1)
        expect(freshList[0]?.id).toBe(ModelId.make("openai/gpt-5.4"))
      }),
    ).pipe(Effect.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
  )

  it.live("carries the models.dev release date onto the parsed model", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tmpDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()

        const registry = yield* loadRegistry(tmpDir, encodeAnyJson(releaseOrderCatalog))
        const models = yield* waitFor(
          registry.list,
          (models) => models.some((model) => model.id === "anthropic/claude-opus-5"),
          5_000,
          "background refresh to land",
        )

        const opus = models.find((model) => model.id === "anthropic/claude-opus-5")
        expect(opus?.releaseDate).toBe("2026-07-24")
      }),
    ).pipe(Effect.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
  )

  it.live("lists models newest release first, undated last", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tmpDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()

        const registry = yield* loadRegistry(tmpDir, encodeAnyJson(releaseOrderCatalog))
        const models = yield* waitFor(
          registry.list,
          (models) => models.length === 4,
          5_000,
          "background refresh to land",
        )

        expect(models.map((model) => model.id)).toEqual([
          ModelId.make("anthropic/claude-opus-5"),
          ModelId.make("anthropic/claude-sonnet-4-6"),
          ModelId.make("anthropic/claude-opus-4-6"),
          ModelId.make("anthropic/undated"),
        ])
      }),
    ).pipe(Effect.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
  )

  it.live("orders a cache written before release dates existed, without refetching", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const tmpDir = yield* fs.makeTempDirectoryScoped()
        const cachePath = path.join(tmpDir, ".gent/models.json")
        yield* fs.makeDirectory(path.dirname(cachePath), { recursive: true })
        // Exactly the shape every shipped cache already on disk has: no
        // releaseDate key at all. It must still decode.
        yield* fs.writeFileString(
          cachePath,
          '[{"id":"openai/gpt-5.4","name":"GPT-5.4","provider":"openai","contextLength":400000}]',
        )

        const registry = yield* loadRegistry(tmpDir, encodeAnyJson({}))
        const models = yield* registry.list

        expect(models).toHaveLength(1)
        expect(models[0]?.id).toBe(ModelId.make("openai/gpt-5.4"))
        expect(models[0]?.releaseDate).toBeUndefined()
      }),
    ).pipe(Effect.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
  )
})

// ── ../domain/auth.test ─────────────────────────────────────────────────────

/**
 * Locks the consolidated `domain/auth` module — the `Auth` service and
 * the `Auth.Info` schema.
 *
 * Exercises:
 *   - `Auth.Test` round-trip (set / get / remove).
 *   - `Auth.Live` against a real on-disk directory, including
 *     "corrupt file is discarded and reported".
 */

describe("Auth", () => {
  describe("Auth.Test", () => {
    it.live("round-trips api / oauth variants", () =>
      Effect.gen(function* () {
        const auth = yield* Auth

        yield* auth.set("openai", AuthInfo.cases.Api.make({ type: "api", key: "sk-test" }))
        const openai = yield* auth.get("openai")
        expect(openai?.type).toBe("api")
        if (openai?.type === "api") expect(openai.key).toBe("sk-test")

        yield* auth.set(
          "anthropic",
          AuthInfo.cases.Oauth.make({
            type: "oauth",
            access: "a",
            refresh: "r",
            expires: 0,
          }),
        )
        const anthropic = yield* auth.get("anthropic")
        expect(anthropic?.type).toBe("oauth")
        if (anthropic?.type === "oauth") {
          expect(anthropic.access).toBe("a")
          expect(anthropic.refresh).toBe("r")
        }

        yield* auth.remove("openai")
        expect(yield* auth.get("openai")).toBeUndefined()
      }).pipe(Effect.provide(Auth.Test())),
    )

    it.live("returns undefined for missing providers", () =>
      Effect.gen(function* () {
        const auth = yield* Auth
        expect(yield* auth.get("does-not-exist")).toBeUndefined()
      }).pipe(Effect.provide(Auth.Test())),
    )
  })

  describe("Auth.Live", () => {
    it.scopedLive("persists round-trip to disk", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()

        const writer = Effect.gen(function* () {
          const auth = yield* Auth
          yield* auth.set("openai", AuthInfo.cases.Api.make({ type: "api", key: "sk-on-disk" }))
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(Auth.Live(dir)))
        yield* writer

        const reader = Effect.gen(function* () {
          const auth = yield* Auth
          return yield* auth.get("openai")
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(Auth.Live(dir)))
        const fetched = yield* reader

        expect(fetched?.type).toBe("api")
        if (fetched?.type === "api") expect(fetched.key).toBe("sk-on-disk")
      }).pipe(Effect.provide(BunServices.layer)),
    )

    it.scopedLive("discards a corrupt entry and returns undefined", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        // Write a malformed entry directly. `KeyValueStore.layerFileSystem`
        // URL-encodes the key into the file basename — `openai` is safe
        // and round-trips as `openai` with no escaping.
        yield* fs.writeFileString(`${dir}/openai`, "not-json-at-all")

        const result = yield* Effect.gen(function* () {
          const auth = yield* Auth
          return yield* auth.get("openai")
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(Auth.Live(dir)))
        expect(result).toBeUndefined()

        // Recovery is not just "swallow" — the broken file should be
        // removed so the next launch isn't held back by it.
        const stillThere = yield* fs.exists(`${dir}/openai`)
        expect(stillThere).toBe(false)
      }).pipe(Effect.provide(BunServices.layer)),
    )
  })
})

// ── ../domain/auth-guard.test ───────────────────────────────────────────────

/**
 * AuthGuard tests
 */

const stubModel = AiModel.make(
  "test",
  "model",
  Layer.succeed(LanguageModel.LanguageModel, failingLanguageModel),
)

const testProviders: ModelDriverContribution[] = [
  { id: "anthropic", name: "Anthropic", resolveModel: () => Effect.succeed(stubModel) },
  { id: "openai", name: "OpenAI", resolveModel: () => Effect.succeed(stubModel) },
  { id: "google", name: "Google", resolveModel: () => Effect.succeed(stubModel) },
  { id: "mistral", name: "Mistral", resolveModel: () => Effect.succeed(stubModel) },
]

const testAgents = [
  AgentDefinition.make({
    name: DEFAULT_AGENT_NAME,
    model: ModelId.make("anthropic/claude-opus-4-6"),
  }),
]

const testResolved = resolveExtensions([
  {
    manifest: { id: ExtensionId.make("test-providers") },
    scope: "builtin",
    sourcePath: "test",
    contributions: {
      modelDrivers: testProviders,
      agents: testAgents,
    },
  } satisfies LoadedExtension,
])
const testRegistryLayer = Layer.merge(
  ExtensionRegistry.fromResolved(testResolved),
  DriverRegistry.fromResolved({
    modelDrivers: testResolved.modelDrivers,
    externalDrivers: testResolved.externalDrivers,
  }),
)

const helperResolved = resolveExtensions([
  {
    manifest: { id: ExtensionId.make("test-providers") },
    scope: "builtin",
    sourcePath: "test",
    contributions: {
      modelDrivers: testProviders,
      agents: [
        ...testAgents,
        AgentDefinition.make({
          name: AgentName.make("helper:google"),
          model: ModelId.make("google/gemini-2.5-flash"),
        }),
      ],
    },
  } satisfies LoadedExtension,
])
const helperAgentRegistryLayer = Layer.merge(
  ExtensionRegistry.fromResolved(helperResolved),
  DriverRegistry.fromResolved({
    modelDrivers: helperResolved.modelDrivers,
    externalDrivers: helperResolved.externalDrivers,
  }),
)

describe("AuthGuard", () => {
  const apiInfo = (key: string): AuthInfo => AuthApi.make({ type: "api", key })

  const guardLayerWithSeed = (
    seed: Record<string, AuthInfo>,
    registryLayer: Layer.Layer<ExtensionRegistry | DriverRegistry>,
  ) => AuthGuard.Live.pipe(Layer.provide(Auth.Test(seed)), Layer.provide(registryLayer))

  it.live("only the main agent's model provider is marked required", () => {
    const layer = guardLayerWithSeed({}, testRegistryLayer)
    return Effect.gen(function* () {
      const guard = yield* AuthGuard
      const result = yield* guard.listProviders()
      expect(result.filter((p) => p.required).map((p) => p.provider)).toEqual([
        ProviderId.make("anthropic"),
      ])
    }).pipe(Effect.provide(layer))
  })

  it.live("a required provider without a stored key reports hasKey false", () => {
    const layer = guardLayerWithSeed({}, testRegistryLayer)
    return Effect.gen(function* () {
      const guard = yield* AuthGuard
      const result = yield* guard.listProviders()
      expect(result.filter((p) => p.required && !p.hasKey).map((p) => p.provider)).toEqual([
        ProviderId.make("anthropic"),
      ])
    }).pipe(Effect.provide(layer))
  })

  it.live("a required provider with a stored key reports hasKey true", () => {
    const layer = guardLayerWithSeed({ anthropic: apiInfo("sk-anthropic") }, testRegistryLayer)
    return Effect.gen(function* () {
      const guard = yield* AuthGuard
      const result = yield* guard.listProviders()
      expect(result.filter((p) => p.required && !p.hasKey)).toEqual([])
    }).pipe(Effect.provide(layer))
  })

  it.live("listProviders reports per-provider hasKey via Auth.get", () => {
    const layer = guardLayerWithSeed({ anthropic: apiInfo("sk-test") }, testRegistryLayer)
    return Effect.gen(function* () {
      const guard = yield* AuthGuard
      const result = yield* guard.listProviders()
      const anthropic = result.find((p) => p.provider === "anthropic")
      const openai = result.find((p) => p.provider === "openai")
      expect(anthropic?.hasKey).toBe(true)
      expect(openai?.hasKey).toBe(false)
    }).pipe(Effect.provide(layer))
  })

  it.live("unselected helper agents do not widen required providers beyond main", () => {
    const layer = guardLayerWithSeed({}, helperAgentRegistryLayer)
    return Effect.gen(function* () {
      const guard = yield* AuthGuard
      const result = yield* guard.listProviders()
      expect(result.filter((p) => p.required).map((p) => p.provider)).toEqual([
        ProviderId.make("anthropic"),
      ])
    }).pipe(Effect.provide(layer))
  })

  it.live("selected agent with a different provider widens required providers", () => {
    const layer = guardLayerWithSeed({}, helperAgentRegistryLayer)
    return Effect.gen(function* () {
      const guard = yield* AuthGuard
      const result = yield* guard.listProviders({ agentName: AgentName.make("helper:google") })
      const required = result.filter((p) => p.required).map((p) => p.provider)
      expect(required).toContain(ProviderId.make("anthropic"))
      expect(required).toContain(ProviderId.make("google"))
      expect(required).not.toContain(ProviderId.make("openai"))
    }).pipe(Effect.provide(layer))
  })

  it.live("agent routed externally via driverOverrides skips model auth requirements", () => {
    const layer = guardLayerWithSeed({}, testRegistryLayer)
    return Effect.gen(function* () {
      const guard = yield* AuthGuard
      // main is an anthropic-modeled agent, but config-routes through
      // an external driver (e.g. Claude Code SDK). The external driver
      // owns its own auth, so model providers should not be required.
      const result = yield* guard.listProviders({
        agentName: DEFAULT_AGENT_NAME,
        driverOverrides: {
          [DEFAULT_AGENT_NAME]: ExternalDriverRef.make({ id: "acp-claude-code" }),
        },
      })
      expect(result.filter((p) => p.required)).toEqual([])
    }).pipe(Effect.provide(layer))
  })
})

describe("ListAuthProvidersPayload schema", () => {
  // The RPC handler resolves project config from the session's cwd,
  // not the launch cwd. The wire payload must carry sessionId so the
  // TUI can opt into per-session resolution. Notably it does NOT
  // carry `driverOverrides` — the server re-derives those from
  // session-cwd config so a wire caller can't smuggle in an override
  // that bypasses model auth.
  //
  // Plain `bunTest` here: these are pure schema decode checks with
  // no Effect context, so the `effect-bun-test` `it.live`/`it.effect`
  // ceremony isn't needed (and the bare `it` from that lib is an
  // object, not a function).
  const decode = Schema.decodeUnknownSync(ListAuthProvidersPayload)

  bunTest("accepts a sessionId field", () => {
    const query = decode({ sessionId: SessionId.make("019d-test-session-id") })
    expect(query.sessionId).toBe(SessionId.make("019d-test-session-id"))
  })

  bunTest("accepts agentName + sessionId together", () => {
    const query = decode({
      agentName: DEFAULT_AGENT_NAME,
      sessionId: SessionId.make("019d-test-session-id"),
    })
    expect(query.agentName).toBe(DEFAULT_AGENT_NAME)
    expect(query.sessionId).toBe(SessionId.make("019d-test-session-id"))
  })

  bunTest("accepts omitted filters for launch-cwd defaults", () => {
    const query = decode({})
    expect(query.agentName).toBeUndefined()
    expect(query.sessionId).toBeUndefined()
  })

  bunTest("rejects driverOverrides — those are server-derived, not wire-supplied", () => {
    // Schema is closed-by-default? No — Schema.Struct is open by default.
    // The point of the split is that consumers see a type without
    // driverOverrides; runtime decode of an unknown field is a no-op.
    // This test documents intent: callers shouldn't include driverOverrides.
    const query = decode({
      sessionId: SessionId.make("019d-test-session-id"),
      driverOverrides: { [DEFAULT_AGENT_NAME]: { _tag: "External", id: "evil" } },
    })
    expect(query.sessionId).toBe(SessionId.make("019d-test-session-id"))
    // The decoded type intentionally has no `driverOverrides` field.
    expect("driverOverrides" in query).toBe(false)
  })
})

// ── ../providers/provider-auth.test ─────────────────────────────────────────

const pendingCallbacks = new Map<string, (code?: string) => string>()
const oauthProvider: ModelDriverContribution = {
  id: "openai",
  name: "OpenAI",
  resolveModel: () => Effect.succeed(stubModel),
  auth: {
    methods: [AuthMethod.make({ type: "oauth", label: "OAuth" })],
    authorize: (ctx) =>
      Effect.sync(() => {
        pendingCallbacks.set(ctx.authorizationId, (code) => code ?? "")
        return Option.some({
          url: "http://example.com/auth",
          method: "code",
          instructions: "Paste code",
        })
      }),
    callback: (ctx) =>
      Effect.gen(function* () {
        const cb = pendingCallbacks.get(ctx.authorizationId)
        pendingCallbacks.delete(ctx.authorizationId)
        let apiKey = ""
        if (!Predicate.isUndefined(cb)) apiKey = cb(ctx.code)
        yield* ctx.persist({ type: "api", key: apiKey })
      }),
  },
}
const noopProvider: ModelDriverContribution = {
  id: "anthropic",
  name: "Anthropic",
  resolveModel: () => Effect.succeed(stubModel),
  auth: {
    methods: [AuthMethod.make({ type: "api", label: "API" })],
  },
}
const persistDuringAuthorizeProvider: ModelDriverContribution = {
  id: "persisting",
  name: "Persisting",
  resolveModel: () => Effect.succeed(stubModel),
  auth: {
    methods: [AuthMethod.make({ type: "oauth", label: "Done" })],
    authorize: (ctx) =>
      Effect.gen(function* () {
        yield* ctx.persist({ type: "api", key: "sk-authorize" })
        return Option.some({
          url: "",
          method: "done",
        })
      }),
  },
}
const testResolvedProviderAuth = resolveExtensions([
  {
    manifest: { id: ExtensionId.make("test") },
    scope: "builtin",
    sourcePath: "test",
    contributions: { modelDrivers: [oauthProvider, noopProvider, persistDuringAuthorizeProvider] },
  } satisfies LoadedExtension,
])
const testRegistry = ExtensionRegistry.fromResolved(testResolvedProviderAuth)
const testDriverRegistry = DriverRegistry.fromResolved({
  modelDrivers: testResolvedProviderAuth.modelDrivers,
  externalDrivers: testResolvedProviderAuth.externalDrivers,
})
const failingAuthStoreLayer = Layer.succeed(
  Auth,
  Auth.of({
    get: () => Effect.succeed(Option.getOrUndefined(Option.none<AuthInfo>())),
    set: () => Effect.fail(new AuthError({ message: "write failed" })),
    remove: () => Effect.void,
  } satisfies AuthService),
)
describe("ProviderAuth", () => {
  it.live("extension authorize + callback stores credentials", () =>
    Effect.gen(function* () {
      pendingCallbacks.clear()
      const authLayer = Auth.Test()
      const layer = Layer.provideMerge(
        ProviderAuth.Live,
        Layer.mergeAll(authLayer, testRegistry, testDriverRegistry, GentPlatform.Test()),
      )
      const result = yield* Effect.gen(function* () {
        const auth = yield* ProviderAuth
        const store = yield* Auth
        const authResult = yield* auth.authorize(SessionId.make("s1"), "openai", 0)
        if (Option.isNone(authResult)) return { ok: false }
        yield* auth.callback(
          SessionId.make("s1"),
          "openai",
          0,
          authResult.value.authorizationId,
          "sk-test-key",
        )
        const stored = yield* store.get("openai")
        return { ok: true, stored }
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer))
      if (!result.ok) return yield* Effect.die(new Error("auth setup failed"))
      const stored = Option.fromUndefinedOr(result.stored)
      expect(Option.isSome(stored)).toBe(true)
      if (Option.isNone(stored)) return
      expect(stored.value.type).toBe("api")
      if (stored.value.type !== "api") return
      expect(stored.value.key).toBe("sk-test-key")
    }),
  )
  it.live("listMethods returns methods from extension providers", () =>
    Effect.gen(function* () {
      const authLayer = Auth.Test()
      const layer = Layer.provideMerge(
        ProviderAuth.Live,
        Layer.mergeAll(authLayer, testRegistry, testDriverRegistry, GentPlatform.Test()),
      )
      const methods = yield* Effect.gen(function* () {
        const auth = yield* ProviderAuth
        return yield* auth.listMethods
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer))
      expect(Object.keys(methods)).toContain("openai")
      expect(Object.keys(methods)).toContain("anthropic")
      expect(Object.keys(methods)).toContain("persisting")
      expect(methods["openai"]?.length).toBe(1)
    }),
  )
  it.live("authorize surfaces credential persistence failures", () =>
    Effect.gen(function* () {
      const layer = Layer.provideMerge(
        ProviderAuth.Live,
        Layer.mergeAll(
          failingAuthStoreLayer,
          testRegistry,
          testDriverRegistry,
          GentPlatform.Test(),
        ),
      )
      const exit = yield* Effect.gen(function* () {
        const auth = yield* ProviderAuth
        return yield* Effect.exit(auth.authorize(SessionId.make("s1"), "persisting", 0))
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        expect(exit.cause.toString()).toContain("Failed to persist auth")
      }
    }),
  )
  it.live("callback surfaces credential persistence failures", () =>
    Effect.gen(function* () {
      pendingCallbacks.clear()
      const layer = Layer.provideMerge(
        ProviderAuth.Live,
        Layer.mergeAll(
          failingAuthStoreLayer,
          testRegistry,
          testDriverRegistry,
          GentPlatform.Test(),
        ),
      )
      const exit = yield* Effect.gen(function* () {
        const auth = yield* ProviderAuth
        const authResult = yield* auth.authorize(SessionId.make("s1"), "openai", 0)
        if (Option.isNone(authResult)) return yield* Effect.die("auth setup failed")
        return yield* Effect.exit(
          auth.callback(
            SessionId.make("s1"),
            "openai",
            0,
            authResult.value.authorizationId,
            "sk-test-key",
          ),
        )
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        expect(exit.cause.toString()).toContain("Failed to persist auth")
      }
    }),
  )
})

// ── ../providers/provider-resolution.test ───────────────────────────────────

// oxlint-disable-next-line effect/noNullish -- AuthService uses undefined to represent missing credentials.
const missingAuthInfo: AuthInfo | undefined = undefined
const testAuthStorage: AuthService = {
  get: () => Effect.succeed(missingAuthInfo),
  set: () => Effect.void,
  remove: () => Effect.void,
}
/** Create a fake upstream model with a stub LanguageModel layer */
const fakeResolution = (): ProviderResolution =>
  AiModel.make("test", "model", Layer.succeed(LanguageModel.LanguageModel, failingLanguageModel))
const modelFromService = (provider: string, service: LanguageModel.Service): ProviderResolution =>
  AiModel.make(provider, "model", Layer.succeed(LanguageModel.LanguageModel, service))
const assertProviderResolutionRejectsBareLayer = () => {
  const bareLayer = Layer.succeed(LanguageModel.LanguageModel, failingLanguageModel)
  // @ts-expect-error ProviderResolution must come from Effect AI Model.make metadata.
  const resolution: ProviderResolution = bareLayer
  return resolution
}
// If ProviderResolution ever stops requiring Model.make metadata, this
// assignment compiles and @ts-expect-error flips the guard red.
void assertProviderResolutionRejectsBareLayer
const makeProvider = (id: string, name?: string): ModelDriverContribution => ({
  id,
  name: name ?? id,
  resolveModel: () => Effect.succeed(fakeResolution()),
})
const EchoParams = Schema.Struct({ text: Schema.String })
const echoCapability: ToolCapability = tool({
  id: "echo",
  description: "Echo input",
  params: EchoParams,
  output: Schema.String,
  execute: () => Effect.succeed("echoed"),
})
const makeExt = (extId: string, modelDrivers: ModelDriverContribution[]): LoadedExtension => ({
  manifest: { id: ExtensionId.make(extId) },
  scope: "builtin",
  sourcePath: "test",
  contributions: { modelDrivers },
})
interface ModelRequest {
  readonly model: string
  readonly reasoning?: string
  readonly maxTokens?: number
  readonly temperature?: number
  readonly driverRegistry?: DriverRegistryService
  readonly driverId?: string
}

const buildProviderLayer = (
  extensions: LoadedExtension[],
  authStore: AuthService = testAuthStorage,
) => {
  const resolved = resolveExtensions(extensions)
  const registryLayer = ExtensionRegistry.fromResolved(resolved)
  const driverRegistryLayer = DriverRegistry.fromResolved({
    modelDrivers: resolved.modelDrivers,
    externalDrivers: resolved.externalDrivers,
  })
  const authLayer = Layer.succeed(Auth, authStore)
  return Layer.provide(
    ModelResolver.Live,
    Layer.mergeAll(authLayer, registryLayer, driverRegistryLayer),
  )
}
const resolveModel = (request: ModelRequest) =>
  Effect.gen(function* () {
    const resolver = yield* ModelResolver
    return yield* resolver.resolve({
      modelId: request.model,
      hints: {
        reasoning: request.reasoning,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
      },
      driverRegistry: request.driverRegistry,
      driverId: request.driverId,
    })
  })
const streamResolvedModel = <Tools extends Record<string, AiTool.Any> = Record<string, AiTool.Any>>(
  request: ModelRequest & {
    readonly prompt: Prompt.RawInput
    readonly tools?: ReadonlyArray<ToolCapability>
    readonly toolkit?: ToolkitInput<Tools>
  },
) =>
  Effect.gen(function* () {
    const model = yield* resolveModel(request)
    if (!Predicate.isUndefined(request.toolkit)) {
      return yield* model
        .streamText({
          prompt: request.prompt,
          toolkit: request.toolkit,
          disableToolCallResolution: true,
        })
        .pipe(Stream.runCollect)
    }
    if (!Predicate.isUndefined(request.tools)) {
      return yield* model
        .streamText({
          prompt: request.prompt,
          toolkit: convertTools(request.tools),
          disableToolCallResolution: true,
        })
        .pipe(Stream.runCollect)
    }
    return yield* model.streamText({ prompt: request.prompt }).pipe(Stream.runCollect)
  })
describe("Provider model resolution", () => {
  it.scoped("resolves model through extension-registered provider", () =>
    Effect.gen(function* () {
      const layer = buildProviderLayer([makeExt("test-ext", [makeProvider("custom")])])
      const result = yield* Effect.exit(
        resolveModel({
          model: "custom/gpt-5",
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
      expect(result._tag).toBe("Success")
    }),
  )
  it.scoped("ModelResolver resolves the LanguageModel service directly", () =>
    Effect.gen(function* () {
      const languageModel = makeLanguageModel({
        streamText: () => Stream.fromIterable([finishPart({ finishReason: "stop" })]),
      })
      const layer = buildProviderLayer([
        makeExt("direct-ext", [
          {
            id: "direct",
            name: "Direct",
            resolveModel: () => Effect.succeed(modelFromService("direct", languageModel)),
          },
        ]),
      ])
      // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      const model = yield* resolveModel({ model: "direct/gpt-5" }).pipe(Effect.provide(layer))
      const result = yield* model.streamText({ prompt: [] }).pipe(Stream.runCollect)
      expect(Array.from(result)).toEqual([expect.objectContaining({ type: "finish" })])
    }),
  )
  it.scoped("errors for unregistered provider", () =>
    Effect.gen(function* () {
      const layer = buildProviderLayer([])
      const result = yield* Effect.exit(
        resolveModel({
          model: "unknown-provider/some-model",
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
      expect(result._tag).toBe("Failure")
    }),
  )
  it.scoped("failing test provider resolves before failing at stream boundary", () =>
    Effect.gen(function* () {
      const resolver = yield* ModelResolver
      const model = yield* resolver.resolve({ modelId: "test/failing" })
      const result = yield* Effect.exit(model.streamText({ prompt: [] }).pipe(Stream.runCollect))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(Cause.pretty(result.cause)).toContain("provider exploded")
      }
    }).pipe(Effect.provide(ModelResolver.fromLanguageModel(LanguageModelLayers.failing))),
  )
  it.scoped("wraps extension resolveModel errors as ProviderError preserving cause", () =>
    Effect.gen(function* () {
      // oxlint-disable-next-line effect/noNewError -- The defect identity is part of this cause-preservation assertion.
      const original = new Error("kaboom")
      const throwingProvider: ModelDriverContribution = {
        id: "broken",
        name: "Broken",
        resolveModel: () => Effect.die(original),
      }
      const layer = buildProviderLayer([makeExt("broken-ext", [throwingProvider])])
      const result = yield* Effect.exit(
        resolveModel({
          model: "broken/model",
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const errOpt = Cause.findErrorOption(result.cause)
        expect(errOpt._tag).toBe("Some")
        if (errOpt._tag === "Some") {
          const err = errOpt.value
          // The original `Error` thrown from the driver must be
          // preserved as `cause` so the upstream chain is debuggable.
          expect(err._tag).toBe("ProviderError")
          expect(err.cause).toBe(original)
        }
      }
    }),
  )
  it.scoped("driver ProviderAuthError surfaces typed at the provider boundary", () =>
    Effect.gen(function* () {
      // Drivers that fail closed at credential resolution return a typed
      // ProviderAuthError from `resolveModel`. The boundary must keep it
      // typed so `GentRpcError` (which has
      // `ProviderAuthError` as a first-class union arm) receives the typed
      // tag — not a generic `ProviderError` with the auth error demoted to
      // a defect-encoded cause.
      const failingAuthProvider: ModelDriverContribution = {
        id: "auth-missing",
        name: "AuthMissing",
        resolveModel: () =>
          Effect.fail(
            new ProviderAuthError({
              message: "credentials unavailable: no OAuth, API key, or env var",
            }),
          ),
      }
      const layer = buildProviderLayer([makeExt("auth-missing-ext", [failingAuthProvider])])
      const result = yield* Effect.exit(
        resolveModel({
          model: "auth-missing/model",
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const errOpt = Cause.findErrorOption(result.cause)
        expect(errOpt._tag).toBe("Some")
        if (errOpt._tag === "Some") {
          const err = errOpt.value
          expect(Schema.is(ProviderAuthError)(err)).toBe(true)
          if (Schema.is(ProviderAuthError)(err)) {
            expect(err.message).toContain("credentials unavailable")
          }
        }
      }
    }),
  )
  it.scoped("auth store read failures fail closed before resolving the model", () =>
    Effect.gen(function* () {
      let resolved = false
      const provider: ModelDriverContribution = {
        id: "auth-fails",
        name: "AuthFails",
        resolveModel: () =>
          Effect.sync(() => {
            resolved = true
            return fakeResolution()
          }),
      }
      const authStore: AuthService = {
        ...testAuthStorage,
        get: () => Effect.fail(new AuthError({ message: "read failed" })),
      }
      const layer = buildProviderLayer([makeExt("auth-fails-ext", [provider])], authStore)
      const result = yield* Effect.exit(
        resolveModel({
          model: "auth-fails/model",
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
      expect(result._tag).toBe("Failure")
      expect(resolved).toBe(false)
      expect(result.toString()).toContain('Failed to read auth for provider "auth-fails"')
    }),
  )
  // ── Per-turn driver registry override (per-cwd profile shadowing) ──
  it.scoped("per-request driverRegistry overrides the captured one for model resolution", () =>
    Effect.gen(function* () {
      // Captured registry has only "captured-only" — would fail to find "shadowed"
      const capturedLayer = buildProviderLayer([
        makeExt("captured", [makeProvider("captured-only", "Captured")]),
      ])
      // Per-turn registry has "shadowed" — should win
      const shadowedResolved = resolveExtensions([
        makeExt("shadowed", [makeProvider("shadowed", "Shadowed")]),
      ])
      const overrideRegistry = yield* Effect.service(DriverRegistry).pipe(
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        Effect.provide(
          DriverRegistry.fromResolved({
            modelDrivers: shadowedResolved.modelDrivers,
            externalDrivers: shadowedResolved.externalDrivers,
          }),
        ),
      )
      const result = yield* Effect.exit(
        resolveModel({
          model: "shadowed/some-model",
          driverRegistry: overrideRegistry,
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(capturedLayer)),
      )
      // Resolution should NOT fail with "Unknown provider" — overrideRegistry has "shadowed".
      if (result._tag === "Failure") {
        const pretty = result.cause.toString()
        expect(pretty).not.toContain("Unknown provider")
      }
    }),
  )
  // ── ModelDriverRef.id override ──
  it.scoped("driverId override picks a driver other than the one parsed from modelId", () =>
    Effect.gen(function* () {
      // Both drivers registered. Default parse from "primary/foo" → "primary".
      // We force "alt" via driverId override and check `alt` was chosen by giving it
      // a recognizable resolveModel side effect.
      let chosenDriver = "unset"
      const layer = buildProviderLayer([
        makeExt("primary-ext", [
          {
            id: "primary",
            name: "Primary",
            resolveModel: () =>
              Effect.sync(() => {
                chosenDriver = "primary"
                return fakeResolution()
              }),
          },
        ]),
        makeExt("alt-ext", [
          {
            id: "alt",
            name: "Alt",
            resolveModel: () =>
              Effect.sync(() => {
                chosenDriver = "alt"
                return fakeResolution()
              }),
          },
        ]),
      ])
      yield* Effect.exit(
        resolveModel({
          model: "primary/foo",
          driverId: "alt",
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
      expect(chosenDriver).toBe("alt")
    }),
  )
  it.scoped("runtime tools advertise capabilities through the live stream path", () =>
    Effect.gen(function* () {
      type CapturedTools = {
        readonly disableToolCallResolution: Option.Option<boolean>
        readonly toolkit: Option.Option<
          | AiToolkit.Toolkit<Record<string, AiTool.Any>>
          | AiToolkit.WithHandler<Record<string, AiTool.Any>>
        >
      }
      const captured: CapturedTools[] = []
      const streamingProvider: ModelDriverContribution = {
        id: "tools-live",
        name: "ToolsLive",
        resolveModel: () =>
          Effect.succeed(
            modelFromService(
              "tools-live",
              makeLanguageModel<{
                readonly disableToolCallResolution?: boolean
                readonly toolkit?:
                  | AiToolkit.Toolkit<Record<string, AiTool.Any>>
                  | AiToolkit.WithHandler<Record<string, AiTool.Any>>
              }>({
                streamText: (options) => {
                  captured.push({
                    disableToolCallResolution: Option.fromUndefinedOr(
                      options.disableToolCallResolution,
                    ),
                    toolkit: Option.fromUndefinedOr(options.toolkit),
                  })
                  return Stream.fromIterable([
                    toolCallPart("echo", { text: "hi" }, { toolCallId: ToolCallId.make("tc-1") }),
                    finishPart({
                      finishReason: "tool-calls",
                      usage: { inputTokens: 10, outputTokens: 20 },
                    }),
                  ])
                },
              }),
            ),
          ),
      }
      const layer = buildProviderLayer([makeExt("tools-live-ext", [streamingProvider])])
      const parts = yield* streamResolvedModel({
        model: "tools-live/gpt-5",
        prompt: [],
        tools: [echoCapability],
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer))
      expect(captured).toHaveLength(1)
      const capturedTools = captured[0]
      if (Predicate.isUndefined(capturedTools)) return
      expect(Option.isSome(capturedTools.disableToolCallResolution)).toBe(true)
      if (Option.isSome(capturedTools.disableToolCallResolution)) {
        expect(capturedTools.disableToolCallResolution.value).toBe(true)
      }
      expect(Option.isSome(capturedTools.toolkit)).toBe(true)
      if (Option.isNone(capturedTools.toolkit)) return
      const toolkit = capturedTools.toolkit.value
      expect(Object.keys(toolkit.tools)).toEqual(["echo"])
      expect(toolkit.tools["echo"]?.name).toBe("echo")
      const advertisedTool = toolkit.tools["echo"]
      expect(advertisedTool).toBeDefined()
      if (!Predicate.isUndefined(advertisedTool)) {
        expect(() => toCodecAnthropic(advertisedTool.parametersSchema)).not.toThrow()
      }
      const collected = Array.from(parts)
      expect(collected).toHaveLength(2)
      expect(collected[0]).toEqual(
        expect.objectContaining({
          type: "tool-call",
          name: "echo",
          params: { text: "hi" },
        }),
      )
      expect(collected[1]).toEqual(
        expect.objectContaining({
          type: "finish",
          reason: "tool-calls",
        }),
      )
    }),
  )
  it.scoped("runtime toolkit preserves typed Effect tool maps through the live stream path", () =>
    Effect.gen(function* () {
      const typedEchoTool = AiTool.dynamic("typedEcho", {
        description: "Typed echo input",
        parameters: Schema.Struct({ text: Schema.String }),
      })
      type TypedTools = {
        readonly typedEcho: typeof typedEchoTool
      }
      const typedToolkit = {
        tools: { typedEcho: typedEchoTool },
        handle: (name) =>
          Effect.fail(
            AiError.make({
              module: "Test",
              method: "typedToolkit.handle",
              reason: new AiError.ToolConfigurationError({
                toolName: String(name),
                description: "unused in provider advertising test",
              }),
            }),
          ),
      } satisfies AiToolkit.WithHandler<TypedTools>
      let capturedToolkit: Option.Option<AiToolkit.WithHandler<TypedTools>> = Option.none()
      const streamingProvider: ModelDriverContribution = {
        id: "typed-toolkit-live",
        name: "TypedToolkitLive",
        resolveModel: () =>
          Effect.succeed(
            modelFromService(
              "typed-toolkit-live",
              makeLanguageModel<{
                readonly toolkit?: AiToolkit.WithHandler<TypedTools>
              }>({
                streamText: (options) => {
                  capturedToolkit = Option.fromUndefinedOr(options.toolkit)
                  return Stream.fromIterable([
                    toolCallPart(
                      "typedEcho",
                      { text: "hi" },
                      { toolCallId: ToolCallId.make("typed-tc-1") },
                    ),
                    finishPart({
                      finishReason: "tool-calls",
                      usage: { inputTokens: 1, outputTokens: 1 },
                    }),
                  ])
                },
              }),
            ),
          ),
      }
      const layer = buildProviderLayer([makeExt("typed-toolkit-live-ext", [streamingProvider])])
      const parts = yield* streamResolvedModel<TypedTools>({
        model: "typed-toolkit-live/gpt-5",
        prompt: [],
        toolkit: typedToolkit,
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer))
      expect(Option.isSome(capturedToolkit)).toBe(true)
      if (Option.isSome(capturedToolkit)) expect(capturedToolkit.value).toBe(typedToolkit)
      const collected = Array.from(parts)
      expect(collected[0]).toEqual(
        expect.objectContaining({
          type: "tool-call",
          name: "typedEcho",
          params: { text: "hi" },
        }),
      )
    }),
  )
  it.scoped("live stream path builds Effect Prompt with multimodal and reasoning parts", () =>
    Effect.gen(function* () {
      let capturedPrompt: Option.Option<Prompt.Prompt> = Option.none()
      const streamingProvider: ModelDriverContribution = {
        id: "prompt-live",
        name: "PromptLive",
        resolveModel: () =>
          Effect.succeed(
            modelFromService(
              "prompt-live",
              makeLanguageModel<{
                readonly prompt?: Prompt.RawInput
              }>({
                streamText: (options) => {
                  capturedPrompt = Option.some(Prompt.make(options.prompt ?? []))
                  return Stream.fromIterable([
                    finishPart({
                      finishReason: "stop",
                      usage: { inputTokens: 3, outputTokens: 1 },
                    }),
                  ])
                },
              }),
            ),
          ),
      }
      const layer = buildProviderLayer([makeExt("prompt-live-ext", [streamingProvider])])
      yield* Effect.gen(function* () {
        const parts = yield* streamResolvedModel({
          model: "prompt-live/gpt-5",
          prompt: toPrompt(
            [
              Message.cases.regular.make({
                id: MessageId.make("user-image"),
                sessionId: SessionId.make("prompt-session"),
                branchId: BranchId.make("prompt-branch"),
                role: "user",
                parts: [
                  Prompt.textPart({ text: "inspect" }),
                  Prompt.filePart({
                    data: "data:image/jpeg;base64,abc",
                    mediaType: "image/jpeg",
                  }),
                ],
                createdAt: dateFromMillis(0),
              }),
              Message.cases.regular.make({
                id: MessageId.make("assistant-reasoning"),
                sessionId: SessionId.make("prompt-session"),
                branchId: BranchId.make("prompt-branch"),
                role: "assistant",
                parts: [Prompt.reasoningPart({ text: "look at image metadata" })],
                createdAt: dateFromMillis(0),
              }),
              Message.cases.regular.make({
                id: MessageId.make("hidden"),
                sessionId: SessionId.make("prompt-session"),
                branchId: BranchId.make("prompt-branch"),
                role: "user",
                parts: [Prompt.textPart({ text: "should not reach model" })],
                createdAt: dateFromMillis(0),
                metadata: { hidden: true },
              }),
            ],
            { systemPrompt: "System policy." },
          ),
        })
        expect(parts.length).toBe(1)
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer))
      expect(Option.isSome(capturedPrompt)).toBe(true)
      if (Option.isNone(capturedPrompt)) return
      expect(capturedPrompt.value.content.map((message) => message.role)).toEqual([
        "system",
        "user",
        "assistant",
      ])
      const userMessage = capturedPrompt.value.content[1]
      expect(userMessage?.role).toBe("user")
      if (userMessage?.role === "user") {
        expect(userMessage.content[1]).toEqual(
          expect.objectContaining({
            type: "file",
            mediaType: "image/jpeg",
            data: "data:image/jpeg;base64,abc",
          }),
        )
      }
      const assistantMessage = capturedPrompt.value.content[2]
      expect(assistantMessage?.role).toBe("assistant")
      if (assistantMessage?.role === "assistant") {
        expect(assistantMessage.content[0]).toEqual(
          expect.objectContaining({
            type: "reasoning",
            text: "look at image metadata",
          }),
        )
      }
      expect(
        capturedPrompt.value.content.some((message) => {
          if (message.role === "user") {
            return message.content.some(
              (part) => part.type === "text" && part.text === "should not reach model",
            )
          }
          return false
        }),
      ).toBe(false)
    }),
  )
})
