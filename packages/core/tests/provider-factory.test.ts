import { describe, test, expect } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import type { LanguageModel } from "ai"
import type { LoadedExtension, ProviderContribution } from "@gent/core/domain/extension"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { AuthStore, type AuthInfo } from "@gent/core/domain/auth-store"
import { ProviderFactory } from "@gent/core/providers/provider-factory"

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

const buildFactory = async (extensions: LoadedExtension[]) => {
  const resolved = resolveExtensions(extensions)
  const registryLayer = ExtensionRegistry.fromResolved(resolved)
  const authLayer = Layer.succeed(AuthStore, testAuthStorage)
  const factoryLayer = Layer.provide(ProviderFactory.Live, Layer.merge(authLayer, registryLayer))
  return ManagedRuntime.make(factoryLayer).runPromise(
    Effect.gen(function* () {
      return yield* ProviderFactory
    }),
  )
}

describe("ProviderFactory extension dispatch", () => {
  test("resolves model through extension-registered provider", async () => {
    const factory = await buildFactory([makeExt("test-ext", [makeProvider("custom")])])
    const model = await Effect.runPromise(factory.getModel("custom/gpt-5"))
    expect(model.modelId).toBe("custom/gpt-5")
  })

  test("falls back to builtin for unregistered provider", async () => {
    const factory = await buildFactory([])
    // anthropic is a builtin — without API key it will still create a client
    // We just verify it doesn't error with "Unknown provider"
    const result = await Effect.runPromiseExit(
      factory.getModel("anthropic/claude-sonnet-4-20250514"),
    )
    // Should succeed (builtin dispatch creates an Anthropic client)
    expect(result._tag).toBe("Success")
  })

  test("wraps extension resolveModel errors as ProviderError", async () => {
    const throwingProvider: ProviderContribution = {
      id: "broken",
      name: "Broken",
      resolveModel: () => {
        throw new Error("kaboom")
      },
    }
    const factory = await buildFactory([makeExt("broken-ext", [throwingProvider])])
    const result = await Effect.runPromiseExit(factory.getModel("broken/model"))
    expect(result._tag).toBe("Failure")
  })

  test("extension provider takes priority over builtin", async () => {
    const overrideProvider: ProviderContribution = {
      id: "anthropic",
      name: "Custom Anthropic",
      resolveModel: (name) => fakeModel(`custom-anthropic/${name}`),
    }
    const factory = await buildFactory([makeExt("override-ext", [overrideProvider])])
    const model = await Effect.runPromise(factory.getModel("anthropic/claude-sonnet-4-20250514"))
    expect(model.modelId).toBe("custom-anthropic/claude-sonnet-4-20250514")
  })

  test("listProviders shows extension-registered providers with correct isCustom", async () => {
    const factory = await buildFactory([
      makeExt("ext", [makeProvider("anthropic", "Anthropic"), makeProvider("custom", "My Custom")]),
    ])
    const providers = await Effect.runPromise(factory.listProviders())
    const ids = providers.map((p) => p.id)
    expect(ids).toContain("anthropic")
    expect(ids).toContain("custom")
    // Custom should be marked as custom
    const custom = providers.find((p) => p.id === "custom")
    expect(custom?.isCustom).toBe(true)
    // Builtin ID should not be custom
    const anthropic = providers.find((p) => p.id === "anthropic")
    expect(anthropic?.isCustom).toBe(false)
  })

  test("builtin migrated to extension keeps isCustom false", async () => {
    const factory = await buildFactory([
      makeExt("ext", [makeProvider("anthropic", "Anthropic Extension")]),
    ])
    const providers = await Effect.runPromise(factory.listProviders())
    const anthropic = providers.find((p) => p.id === "anthropic")
    expect(anthropic?.isCustom).toBe(false)
    expect(anthropic?.name).toBe("Anthropic Extension")
    // Should not have duplicate
    expect(providers.filter((p) => p.id === "anthropic").length).toBe(1)
  })
})
