/**
 * AuthStore tests
 */

import { describe, it, expect } from "effect-bun-test"
import { AuthApi, AuthOauth, AuthStore } from "@gent/core/domain/auth-store"
import { AuthStorage } from "@gent/core/domain/auth-storage"
import { Effect, Layer } from "effect"

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

  it.live("remove deletes keys", () =>
    Effect.gen(function* () {
      const auth = yield* AuthStore
      yield* auth.set("openai", new AuthApi({ type: "api", key: "key" }))
      yield* auth.remove("openai")
      const result = yield* auth.get("openai")
      expect(result).toBeUndefined()
    }).pipe(Effect.provide(storeLayer())),
  )

  it.live("list returns stored provider ids", () =>
    Effect.gen(function* () {
      const auth = yield* AuthStore
      yield* auth.set("anthropic", new AuthApi({ type: "api", key: "k1" }))
      yield* auth.set("openai", new AuthApi({ type: "api", key: "k2" }))
      const result = yield* auth.list()
      expect(result).toContain("anthropic")
      expect(result).toContain("openai")
    }).pipe(Effect.provide(storeLayer())),
  )
})
