import { describe, test, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import type { LoadedExtension } from "@gent/core/domain/extension"
import type { ModelDriverContribution } from "@gent/core/domain/driver"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { modelDriver as modelDriverContribution } from "@gent/core/domain/contribution"
import { DriverRegistry } from "@gent/core/runtime/extensions/driver-registry"
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

const makeProvider = (id: string, name?: string): ModelDriverContribution => ({
  id,
  name: name ?? id,
  resolveModel: () => fakeResolution(),
})

const makeExt = (extId: string, modelDrivers: ModelDriverContribution[]): LoadedExtension => ({
  manifest: { id: extId },
  kind: "builtin",
  sourcePath: "test",
  contributions: modelDrivers.map(modelDriverContribution),
})

const buildProviderLayer = (extensions: LoadedExtension[]) => {
  const resolved = resolveExtensions(extensions)
  const registryLayer = ExtensionRegistry.fromResolved(resolved)
  const driverRegistryLayer = DriverRegistry.fromResolved({
    modelDrivers: resolved.modelDrivers,
    externalDrivers: resolved.externalDrivers,
  })
  const authLayer = Layer.succeed(AuthStore, testAuthStorage)
  return Layer.provide(Provider.Live, Layer.mergeAll(authLayer, registryLayer, driverRegistryLayer))
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
    const throwingProvider: ModelDriverContribution = {
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

  // ── Per-turn driver registry override (per-cwd profile shadowing) ──

  test("per-request driverRegistry overrides the captured one for model resolution", async () => {
    // Captured registry has only "captured-only" — would fail to find "shadowed"
    const capturedLayer = buildProviderLayer([
      makeExt("captured", [makeProvider("captured-only", "Captured")]),
    ])
    // Per-turn registry has "shadowed" — should win
    const shadowedResolved = resolveExtensions([
      makeExt("shadowed", [makeProvider("shadowed", "Shadowed")]),
    ])
    const overrideRegistry = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* DriverRegistry
      }).pipe(
        Effect.provide(
          DriverRegistry.fromResolved({
            modelDrivers: shadowedResolved.modelDrivers,
            externalDrivers: shadowedResolved.externalDrivers,
          }),
        ),
      ),
    )

    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const provider = yield* Provider
        const stream = yield* provider.stream({
          model: "shadowed/some-model",
          messages: [],
          systemPrompt: "",
          driverRegistry: overrideRegistry,
        })
        yield* Stream.runHead(stream)
      }).pipe(Effect.provide(capturedLayer)),
    )

    // Resolution should NOT fail with "Unknown provider" — overrideRegistry has "shadowed".
    if (result._tag === "Failure") {
      const pretty = result.cause.toString()
      expect(pretty).not.toContain("Unknown provider")
    }
  })

  // ── ModelDriverRef.id override ──

  test("driverId override picks a driver other than the one parsed from modelId", async () => {
    // Both drivers registered. Default parse from "primary/foo" → "primary".
    // We force "alt" via driverId override and check `alt` was chosen by giving it
    // a recognizable resolveModel side effect.
    let chosenDriver: string | undefined
    const layer = buildProviderLayer([
      makeExt("primary-ext", [
        {
          id: "primary",
          name: "Primary",
          resolveModel: () => {
            chosenDriver = "primary"
            return fakeResolution()
          },
        },
      ]),
      makeExt("alt-ext", [
        {
          id: "alt",
          name: "Alt",
          resolveModel: () => {
            chosenDriver = "alt"
            return fakeResolution()
          },
        },
      ]),
    ])

    await Effect.runPromiseExit(
      Effect.gen(function* () {
        const provider = yield* Provider
        const stream = yield* provider.stream({
          model: "primary/foo",
          messages: [],
          systemPrompt: "",
          driverId: "alt",
        })
        yield* Stream.runHead(stream)
      }).pipe(Effect.provide(layer)),
    )

    expect(chosenDriver).toBe("alt")
  })
})
