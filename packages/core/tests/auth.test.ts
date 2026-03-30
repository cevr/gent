/**
 * Auth storage tests
 */

import { describe, it, expect } from "effect-bun-test"
import { AuthGuard } from "@gent/core/domain/auth-guard"
import { AuthApi, AuthOauth, AuthStore } from "@gent/core/domain/auth-store"
import { AuthStorage } from "@gent/core/domain/auth-storage"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"
import type { LoadedExtension, ProviderContribution } from "@gent/core/domain/extension"
import { AgentDefinition } from "@gent/core/domain/agent"
import { Effect, Layer } from "effect"

const testProviders: ProviderContribution[] = [
  { id: "anthropic", name: "Anthropic", resolveModel: () => ({}) },
  { id: "openai", name: "OpenAI", resolveModel: () => ({}) },
  { id: "bedrock", name: "AWS Bedrock", resolveModel: () => ({}) },
  { id: "google", name: "Google", resolveModel: () => ({}) },
  { id: "mistral", name: "Mistral", resolveModel: () => ({}) },
]

const testAgents = [
  new AgentDefinition({
    name: "cowork" as never,
    kind: "primary",
    model: "anthropic/claude-opus-4-6" as never,
  }),
  new AgentDefinition({
    name: "deepwork" as never,
    kind: "primary",
    model: "openai/gpt-5.4" as never,
  }),
]

const testRegistryLayer = ExtensionRegistry.fromResolved(
  resolveExtensions([
    {
      manifest: { id: "test-providers" },
      kind: "builtin",
      sourcePath: "test",
      setup: { providers: testProviders, agents: testAgents },
    } satisfies LoadedExtension,
  ]),
)

describe("AuthStore", () => {
  const storeLayer = (initial: Record<string, string> = {}) =>
    Layer.provide(AuthStore.Live, AuthStorage.Test(initial))

  it.live("get returns undefined for missing key", () =>
    AuthStore.use((auth) => auth.get("anthropic")).pipe(
      Effect.tap((result) => Effect.sync(() => expect(result).toBeUndefined())),
      Effect.provide(storeLayer()),
    ),
  )

  it.live("get returns stored api auth", () =>
    AuthStore.use((auth) => auth.get("anthropic")).pipe(
      Effect.tap((result) => Effect.sync(() => expect(result?.type).toBe("api"))),
      Effect.provide(storeLayer({ anthropic: "sk-test-key" })),
    ),
  )

  it.live("set stores api auth for retrieval", () =>
    Effect.gen(function* () {
      const auth = yield* AuthStore
      yield* auth.set("openai", new AuthApi({ type: "api", key: "sk-openai-key" }))
      const result = yield* auth.get("openai")
      expect(result?.type).toBe("api")
    }).pipe(Effect.provide(storeLayer())),
  )

  it.live("set stores oauth auth for retrieval", () =>
    Effect.gen(function* () {
      const auth = yield* AuthStore
      yield* auth.set(
        "anthropic",
        new AuthOauth({
          type: "oauth",
          access: "token",
          refresh: "refresh",
          expires: Date.now() + 1000,
        }),
      )
      const result = yield* auth.get("anthropic")
      expect(result?.type).toBe("oauth")
    }).pipe(Effect.provide(storeLayer())),
  )

  it.live("listInfo returns auth info for all providers", () =>
    AuthStore.use((auth) => auth.listInfo()).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Object.keys(result)).toContain("anthropic")
          expect(Object.keys(result)).toContain("openai")
        }),
      ),
      Effect.provide(storeLayer({ anthropic: "key1", openai: "key2" })),
    ),
  )
})

describe("AuthGuard", () => {
  it.live("requiredProviders include cowork + reviewer (deepwork) providers", () => {
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
})
