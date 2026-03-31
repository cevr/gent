import { describe, test, expect } from "bun:test"
import { Effect, Layer } from "effect"
import type { LoadedExtension, ProviderContribution } from "@gent/core/domain/extension"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { AuthStore, type AuthInfo } from "@gent/core/domain/auth-store"
import { Provider } from "@gent/core/providers/provider"
import type { LanguageModel } from "ai"

const testAuthStorage = {
  get: () => Effect.sync(() => undefined as AuthInfo | undefined),
  set: () => Effect.void,
  remove: () => Effect.void,
  list: () => Effect.succeed([] as ReadonlyArray<string>),
  listInfo: () => Effect.succeed({} as Record<string, AuthInfo>),
}

const fakeModel = (id: string): LanguageModel =>
  ({
    modelId: id,
    provider: "test",
    specificationVersion: "v1",
  }) as unknown as LanguageModel

const makeProvider = (id: string, name?: string): ProviderContribution => ({
  id,
  name: name ?? id,
  resolveModel: (modelName) => fakeModel(`${id}/${modelName}`),
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
        yield* provider.stream({
          model: "custom/gpt-5",
          messages: [],
          systemPrompt: "",
        })
      }).pipe(Effect.provide(layer)),
    )
    // The fake model triggers an AI SDK version error (not a "Unknown provider" resolution error),
    // proving that model resolution through the extension succeeded.
    if (result._tag === "Failure") {
      const pretty = result.cause.toString()
      expect(pretty).not.toContain("Unknown provider")
      expect(pretty).toContain("Unsupported model version")
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
