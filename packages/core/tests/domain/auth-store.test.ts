/**
 * AuthStore tests
 */

import { describe, it, expect } from "effect-bun-test"
import { AuthApi, AuthOauth, AuthStore } from "@gent/core/domain/auth-store"
import { AuthStorage, AuthStorageError } from "@gent/core/domain/auth-storage"
import { Effect, Layer } from "effect"

describe("AuthStore", () => {
  const storeLayer = (initial: Record<string, string> = {}) =>
    Layer.provide(AuthStore.Live, AuthStorage.Test(initial))

  it.live("missing auth key returns undefined", () =>
    AuthStore.use((auth) => auth.get("anthropic")).pipe(
      Effect.tap((result) => Effect.sync(() => expect(result).toBeUndefined())),
      Effect.provide(storeLayer()),
    ),
  )

  it.live("stored API key is retrievable", () =>
    AuthStore.use((auth) => auth.get("anthropic")).pipe(
      Effect.tap((result) => Effect.sync(() => expect(result?.type).toBe("api"))),
      Effect.provide(storeLayer({ anthropic: "sk-test-key" })),
    ),
  )

  it.live("legacy OAuth JSON decodes as OAuth, not an API key", () =>
    Effect.gen(function* () {
      const auth = yield* AuthStore
      const result = yield* auth.get("openai")
      expect(result?.type).toBe("oauth")
      if (result?.type === "oauth") {
        expect(result.access).toBe("access-token")
        expect(result.refresh).toBe("refresh-token")
        expect(result.accountId).toBe("account-1")
      }
    }).pipe(
      Effect.provide(
        storeLayer({
          openai:
            '{"type":"oauth","access":"access-token","refresh":"refresh-token","expires":4102444800000,"accountId":"account-1"}',
        }),
      ),
    ),
  )

  it.live("raw string fallback is reserved for raw API keys", () =>
    Effect.gen(function* () {
      const auth = yield* AuthStore
      const rawKey = yield* auth.get("openai")
      expect(rawKey?.type).toBe("api")
      if (rawKey?.type === "api") expect(rawKey.key).toBe("sk-raw")

      const invalidJson = yield* Effect.exit(auth.get("broken"))
      expect(invalidJson._tag).toBe("Failure")
    }).pipe(
      Effect.provide(
        storeLayer({
          openai: "sk-raw",
          broken: '{"type":"oauth","access":"missing-required-fields"}',
        }),
      ),
    ),
  )

  it.live("API key persists across reads", () =>
    Effect.gen(function* () {
      const auth = yield* AuthStore
      yield* auth.set("openai", new AuthApi({ type: "api", key: "sk-openai-key" }))
      const result = yield* auth.get("openai")
      expect(result?.type).toBe("api")
    }).pipe(Effect.provide(storeLayer())),
  )

  it.live("OAuth token persists across reads", () =>
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

  it.live("lists auth info for all configured providers", () =>
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

  it.live("removed key is no longer retrievable", () =>
    Effect.gen(function* () {
      const auth = yield* AuthStore
      yield* auth.set("openai", new AuthApi({ type: "api", key: "key" }))
      yield* auth.remove("openai")
      const result = yield* auth.get("openai")
      expect(result).toBeUndefined()
    }).pipe(Effect.provide(storeLayer())),
  )

  it.live("remove surfaces storage failures", () => {
    const failingStorage = Layer.succeed(AuthStorage, {
      get: () => Effect.succeed(undefined),
      set: () => Effect.void,
      delete: () => Effect.fail(new AuthStorageError({ message: "delete failed" })),
      list: () => Effect.succeed([]),
    })

    return Effect.gen(function* () {
      const auth = yield* AuthStore
      const exit = yield* Effect.exit(auth.remove("openai"))
      expect(exit._tag).toBe("Failure")
    }).pipe(Effect.provide(Layer.provide(AuthStore.Live, failingStorage)))
  })

  it.live("lists all stored provider IDs", () =>
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
