/**
 * Auth storage tests
 */

import { describe, it, expect } from "bun:test"
import { AuthGuard, AuthApi, AuthOauth, AuthStore, AuthStorage } from "@gent/core"
import { Effect, Layer } from "effect"

describe("AuthStore", () => {
  const storeLayer = (initial: Record<string, string> = {}) =>
    Layer.provide(AuthStore.Live, AuthStorage.Test(initial))

  it("get returns undefined for missing key", async () => {
    const result = await Effect.runPromise(
      AuthStore.pipe(
        Effect.flatMap((auth) => auth.get("anthropic")),
        Effect.provide(storeLayer()),
      ),
    )
    expect(result).toBeUndefined()
  })

  it("get returns stored api auth", async () => {
    const layer = storeLayer({ anthropic: "sk-test-key" })
    const result = await Effect.runPromise(
      AuthStore.pipe(
        Effect.flatMap((auth) => auth.get("anthropic")),
        Effect.provide(layer),
      ),
    )
    expect(result?.type).toBe("api")
  })

  it("set stores api auth for retrieval", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthStore
        yield* auth.set("openai", new AuthApi({ type: "api", key: "sk-openai-key" }))
        return yield* auth.get("openai")
      }).pipe(Effect.provide(storeLayer())),
    )
    expect(result?.type).toBe("api")
  })

  it("set stores oauth auth for retrieval", async () => {
    const result = await Effect.runPromise(
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
        return yield* auth.get("anthropic")
      }).pipe(Effect.provide(storeLayer())),
    )
    expect(result?.type).toBe("oauth")
  })

  it("listInfo returns auth info for all providers", async () => {
    const layer = storeLayer({ anthropic: "key1", openai: "key2" })
    const result = await Effect.runPromise(
      AuthStore.pipe(
        Effect.flatMap((auth) => auth.listInfo()),
        Effect.provide(layer),
      ),
    )
    expect(Object.keys(result)).toContain("anthropic")
    expect(Object.keys(result)).toContain("openai")
  })
})

describe("AuthGuard", () => {
  it("requiredProviders include cowork + deepwork providers", async () => {
    const layer = Layer.mergeAll(AuthStorage.Test(), AuthStore.Live, AuthGuard.Live)
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
    const layer = Layer.mergeAll(AuthStorage.Test(), AuthStore.Live, AuthGuard.Live)
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
    const layer = Layer.mergeAll(
      AuthStorage.Test({ openai: "sk-openai", anthropic: "sk-anthropic" }),
      AuthStore.Live,
      AuthGuard.Live,
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
