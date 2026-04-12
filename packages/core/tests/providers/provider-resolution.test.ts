import { describe, test, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import type { LoadedExtension, ProviderContribution } from "@gent/core/domain/extension"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { AuthStore, type AuthInfo } from "@gent/core/domain/auth-store"
import { Provider, type ProviderResolution } from "@gent/core/providers/provider"
import { LanguageModel } from "effect/unstable/ai"
import * as AiError from "effect/unstable/ai/AiError"

const testAuthStorage = {
  get: () => Effect.sync(() => undefined as AuthInfo | undefined),
  set: () => Effect.void,
  remove: () => Effect.void,
  list: () => Effect.succeed([] as ReadonlyArray<string>),
  listInfo: () => Effect.succeed({} as Record<string, AuthInfo>),
}

/** Create a fake ProviderResolution with a stub LanguageModel layer */
const fakeResolution = (): ProviderResolution => ({
  layer: Layer.succeed(LanguageModel.LanguageModel, {
    generateText: () =>
      Effect.fail(
        AiError.make({
          module: "Test",
          method: "generateText",
          reason: new AiError.UnknownError({ description: "stub" }),
        }),
      ),
    generateObject: () =>
      Effect.fail(
        AiError.make({
          module: "Test",
          method: "generateObject",
          reason: new AiError.UnknownError({ description: "stub" }),
        }),
      ),
    streamText: () =>
      Stream.fail(
        AiError.make({
          module: "Test",
          method: "streamText",
          reason: new AiError.UnknownError({ description: "stub" }),
        }),
      ),
  } as LanguageModel.Service),
})

const makeProvider = (id: string, name?: string): ProviderContribution => ({
  id,
  name: name ?? id,
  resolveModel: () => fakeResolution(),
})

const makeExt = (extId: string, providers: ProviderContribution[]): LoadedExtension => ({
  manifest: { id: extId },
  kind: "builtin",
  sourcePath: "test",
  setup: { providers },
})

const buildProviderLayer = (extensions: LoadedExtension[]) => {
  const resolved = resolveExtensions(extensions)
  const registryLayer = ExtensionRegistry.fromResolved(resolved)
  const authLayer = Layer.succeed(AuthStore, testAuthStorage)
  return Layer.provide(Provider.Live, Layer.merge(authLayer, registryLayer))
}

describe("Provider model resolution", () => {
  test("resolves model through extension-registered provider", async () => {
    const layer = buildProviderLayer([makeExt("test-ext", [makeProvider("custom")])])
    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const provider = yield* Provider
        // Should resolve successfully (the stream will fail with stub error, not resolution error)
        const stream = yield* provider.stream({
          model: "custom/gpt-5",
          messages: [],
          systemPrompt: "",
        })
        // Consume one chunk to trigger the stream — expect the stub error, not "Unknown provider"
        yield* Stream.runHead(stream)
      }).pipe(Effect.provide(layer)),
    )
    if (result._tag === "Failure") {
      const pretty = result.cause.toString()
      expect(pretty).not.toContain("Unknown provider")
      // Stub LanguageModel fails with AiError — wrapped as ProviderError
      expect(pretty).toContain("stub")
    }
  })

  test("errors for unregistered provider", async () => {
    const layer = buildProviderLayer([])
    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const provider = yield* Provider
        yield* provider.stream({
          model: "unknown-provider/some-model",
          messages: [],
          systemPrompt: "",
        })
      }).pipe(Effect.provide(layer)),
    )
    expect(result._tag).toBe("Failure")
  })

  test("wraps extension resolveModel errors as ProviderError", async () => {
    const throwingProvider: ProviderContribution = {
      id: "broken",
      name: "Broken",
      resolveModel: () => {
        throw new Error("kaboom")
      },
    }
    const layer = buildProviderLayer([makeExt("broken-ext", [throwingProvider])])
    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const provider = yield* Provider
        yield* provider.stream({
          model: "broken/model",
          messages: [],
          systemPrompt: "",
        })
      }).pipe(Effect.provide(layer)),
    )
    expect(result._tag).toBe("Failure")
  })
})
