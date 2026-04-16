/**
 * AuthGuard tests
 */

import { describe, it, expect } from "effect-bun-test"
import { AuthGuard } from "@gent/core/domain/auth-guard"
import { AuthApi, AuthStore } from "@gent/core/domain/auth-store"
import { AuthStorage } from "@gent/core/domain/auth-storage"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { DriverRegistry } from "@gent/core/runtime/extensions/driver-registry"
import type { LoadedExtension } from "@gent/core/domain/extension"
import type { ModelDriverContribution } from "@gent/core/domain/driver"
import { AgentDefinition } from "@gent/core/domain/agent"
import { Effect, Layer } from "effect"

const testProviders: ModelDriverContribution[] = [
  { id: "anthropic", name: "Anthropic", resolveModel: () => ({}) },
  { id: "openai", name: "OpenAI", resolveModel: () => ({}) },
  { id: "bedrock", name: "AWS Bedrock", resolveModel: () => ({}) },
  { id: "google", name: "Google", resolveModel: () => ({}) },
  { id: "mistral", name: "Mistral", resolveModel: () => ({}) },
]

const testAgents = [
  new AgentDefinition({
    name: "cowork" as never,
    model: "anthropic/claude-opus-4-6" as never,
  }),
  new AgentDefinition({
    name: "deepwork" as never,
    model: "openai/gpt-5.4" as never,
  }),
]

const testResolved = resolveExtensions([
  {
    manifest: { id: "test-providers" },
    kind: "builtin",
    sourcePath: "test",
    setup: { modelDrivers: testProviders, agents: testAgents },
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
    manifest: { id: "test-providers" },
    kind: "builtin",
    sourcePath: "test",
    setup: {
      modelDrivers: testProviders,
      agents: [
        ...testAgents,
        new AgentDefinition({
          name: "helper:google" as never,
          model: "google/gemini-2.5-flash" as never,
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
  it.live("requiredProviders include cowork + deepwork providers", () => {
    const layer = AuthGuard.Live.pipe(
      Layer.provide(AuthStore.Live),
      Layer.provide(AuthStorage.Test()),
      Layer.provide(testRegistryLayer),
    )
    return Effect.gen(function* () {
      const guard = yield* AuthGuard
      const result = yield* guard.requiredProviders()
      expect(result).toContain("anthropic")
      expect(result).toContain("openai")
    }).pipe(Effect.provide(layer))
  })

  it.live("missingRequiredProviders returns missing when no keys", () => {
    const layer = AuthGuard.Live.pipe(
      Layer.provide(AuthStore.Live),
      Layer.provide(AuthStorage.Test()),
      Layer.provide(testRegistryLayer),
    )
    return Effect.gen(function* () {
      const guard = yield* AuthGuard
      const result = yield* guard.missingRequiredProviders()
      expect(result).toContain("anthropic")
      expect(result).toContain("openai")
    }).pipe(Effect.provide(layer))
  })

  it.live("missingRequiredProviders clears when keys are present", () => {
    const layer = AuthGuard.Live.pipe(
      Layer.provide(AuthStore.Live),
      Layer.provide(AuthStorage.Test({ openai: "sk-openai", anthropic: "sk-anthropic" })),
      Layer.provide(testRegistryLayer),
    )
    return Effect.gen(function* () {
      const guard = yield* AuthGuard
      const result = yield* guard.missingRequiredProviders()
      expect(result).toEqual([])
    }).pipe(Effect.provide(layer))
  })

  it.live("listProviders uses get even when listInfo fails", () => {
    const layer = AuthGuard.Live.pipe(
      Layer.provide(
        Layer.succeed(AuthStore, {
          get: (provider: string) =>
            provider === "anthropic"
              ? Effect.succeed(new AuthApi({ type: "api", key: "sk-test" }))
              : Effect.succeed(undefined),
          set: () => Effect.void,
          remove: () => Effect.void,
          list: () => Effect.fail(new Error("list failed")),
          listInfo: () => Effect.fail(new Error("listInfo failed")),
        }),
      ),
      Layer.provide(testRegistryLayer),
    )
    return Effect.gen(function* () {
      const guard = yield* AuthGuard
      const result = yield* guard.listProviders()

      const anthropic = result.find((p) => p.provider === "anthropic")
      const openai = result.find((p) => p.provider === "openai")
      expect(anthropic?.hasKey).toBe(true)
      expect(openai?.hasKey).toBe(false)
    }).pipe(Effect.provide(layer))
  })

  it.live(
    "helper-only modeled agents do not widen required providers beyond the runtime pair",
    () => {
      const layer = AuthGuard.Live.pipe(
        Layer.provide(AuthStore.Live),
        Layer.provide(AuthStorage.Test()),
        Layer.provide(helperAgentRegistryLayer),
      )
      return Effect.gen(function* () {
        const guard = yield* AuthGuard
        const result = yield* guard.requiredProviders()
        expect(result).toContain("anthropic")
        expect(result).toContain("openai")
        expect(result).not.toContain("google")
      }).pipe(Effect.provide(layer))
    },
  )

  it.live("selected agent widens required providers to match the actual runtime agent", () => {
    const layer = AuthGuard.Live.pipe(
      Layer.provide(AuthStore.Live),
      Layer.provide(AuthStorage.Test()),
      Layer.provide(helperAgentRegistryLayer),
    )
    return Effect.gen(function* () {
      const guard = yield* AuthGuard
      const result = yield* guard.requiredProviders({ agentName: "helper:google" })
      expect(result).toContain("anthropic")
      expect(result).toContain("openai")
      expect(result).toContain("google")
    }).pipe(Effect.provide(layer))
  })
})
