/**
 * Auth storage tests
 */

import { describe, it, expect } from "bun:test"
import { AuthGuard, AuthStorage } from "@gent/core"
import { ConfigProvider, Effect, Layer } from "effect"

describe("AuthStorage", () => {
  describe("Test implementation", () => {
    it("get returns undefined for missing key", async () => {
      const layer = AuthStorage.Test()
      const result = await Effect.runPromise(
        AuthStorage.pipe(
          Effect.flatMap((auth) => auth.get("anthropic")),
          Effect.provide(layer),
        ),
      )
      expect(result).toBeUndefined()
    })

    it("get returns stored key", async () => {
      const layer = AuthStorage.Test({ anthropic: "sk-test-key" })
      const result = await Effect.runPromise(
        AuthStorage.pipe(
          Effect.flatMap((auth) => auth.get("anthropic")),
          Effect.provide(layer),
        ),
      )
      expect(result).toBe("sk-test-key")
    })

    it("set stores key for retrieval", async () => {
      const layer = AuthStorage.Test()
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const auth = yield* AuthStorage
          yield* auth.set("openai", "sk-openai-key")
          return yield* auth.get("openai")
        }).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("sk-openai-key")
    })

    it("set overwrites existing key", async () => {
      const layer = AuthStorage.Test({ anthropic: "old-key" })
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const auth = yield* AuthStorage
          yield* auth.set("anthropic", "new-key")
          return yield* auth.get("anthropic")
        }).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("new-key")
    })

    it("delete removes stored key", async () => {
      const layer = AuthStorage.Test({ anthropic: "sk-test-key" })
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const auth = yield* AuthStorage

          // Key exists
          const before = yield* auth.get("anthropic")
          expect(before).toBe("sk-test-key")

          // Delete
          yield* auth.delete("anthropic")

          // Key gone
          return yield* auth.get("anthropic")
        }).pipe(Effect.provide(layer)),
      )
      expect(result).toBeUndefined()
    })

    it("delete is idempotent for missing key", async () => {
      const layer = AuthStorage.Test()
      // Should not throw
      await Effect.runPromise(
        AuthStorage.pipe(
          Effect.flatMap((auth) => auth.delete("nonexistent")),
          Effect.provide(layer),
        ),
      )
    })

    it("list returns all provider names", async () => {
      const layer = AuthStorage.Test({
        anthropic: "key1",
        openai: "key2",
        google: "key3",
      })
      const result = await Effect.runPromise(
        AuthStorage.pipe(
          Effect.flatMap((auth) => auth.list()),
          Effect.provide(layer),
        ),
      )
      expect(result.length).toBe(3)
      expect(result).toContain("anthropic")
      expect(result).toContain("openai")
      expect(result).toContain("google")
    })

    it("list returns empty array when no keys", async () => {
      const layer = AuthStorage.Test()
      const result = await Effect.runPromise(
        AuthStorage.pipe(
          Effect.flatMap((auth) => auth.list()),
          Effect.provide(layer),
        ),
      )
      expect(result).toEqual([])
    })

    it("list updates after set and delete", async () => {
      const layer = AuthStorage.Test()
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const auth = yield* AuthStorage

          // Initially empty
          const initial = yield* auth.list()
          expect(initial).toEqual([])

          // Add keys
          yield* auth.set("anthropic", "key1")
          yield* auth.set("openai", "key2")
          const afterSet = yield* auth.list()
          expect(afterSet.length).toBe(2)

          // Delete one
          yield* auth.delete("anthropic")
          return yield* auth.list()
        }).pipe(Effect.provide(layer)),
      )
      expect(result.length).toBe(1)
      expect(result).toContain("openai")
    })
  })
})

describe("AuthGuard", () => {
  it("requiredProviders include cowork + deepwork providers", async () => {
    const configLayer = Layer.setConfigProvider(ConfigProvider.fromMap(new Map()))
    const layer = Layer.mergeAll(AuthStorage.Test(), AuthGuard.Live, configLayer)
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const guard = yield* AuthGuard
        return yield* guard.requiredProviders()
      }).pipe(Effect.provide(layer)),
    )
    expect(result).toContain("anthropic")
    expect(result).toContain("openai")
  })

  it("missingRequiredProviders returns missing when no keys", async () => {
    const configLayer = Layer.setConfigProvider(ConfigProvider.fromMap(new Map()))
    const layer = Layer.mergeAll(AuthStorage.Test(), AuthGuard.Live, configLayer)
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const guard = yield* AuthGuard
        return yield* guard.missingRequiredProviders()
      }).pipe(Effect.provide(layer)),
    )
    expect(result).toContain("anthropic")
    expect(result).toContain("openai")
  })

  it("missingRequiredProviders clears when keys are present", async () => {
    const configLayer = Layer.setConfigProvider(
      ConfigProvider.fromMap(new Map([["ANTHROPIC_API_KEY", "sk-anthropic"]])),
    )
    const layer = Layer.mergeAll(
      AuthStorage.Test({ openai: "sk-openai" }),
      AuthGuard.Live,
      configLayer,
    )
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const guard = yield* AuthGuard
        return yield* guard.missingRequiredProviders()
      }).pipe(Effect.provide(layer)),
    )
    expect(result).toEqual([])
  })
})
