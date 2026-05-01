/**
 * AuthStore tests
 */

import { describe, it, expect } from "effect-bun-test"
import { AuthApi, AuthInfo, AuthOauth, AuthStore } from "@gent/core/domain/auth-store"
import { AuthStorage, AuthStorageError } from "@gent/core/domain/auth-storage"
import { Effect, Layer, Logger, Schema } from "effect"

describe("AuthStore", () => {
  const AuthInfoJson = Schema.fromJsonString(AuthInfo)
  const encodeAuthInfo = Schema.encodeSync(AuthInfoJson)
  const apiJson = (key: string) => encodeAuthInfo(new AuthApi({ type: "api", key }))

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
      Effect.provide(storeLayer({ anthropic: apiJson("sk-test-key") })),
    ),
  )

  it.live("old OAuth JSON is discarded", () =>
    Effect.gen(function* () {
      const auth = yield* AuthStore
      const result = yield* auth.get("openai")
      expect(result).toBeUndefined()
      const providers = yield* auth.list()
      expect(providers).not.toContain("openai")
    }).pipe(
      Effect.provide(
        storeLayer({
          openai:
            '{"type":"oauth","access":"access-token","refresh":"refresh-token","expires":4102444800000,"accountId":"account-1"}',
        }),
      ),
    ),
  )

  it.live("invalid auth payloads are discarded", () =>
    Effect.gen(function* () {
      const auth = yield* AuthStore
      const rawKey = yield* auth.get("openai")
      expect(rawKey).toBeUndefined()

      const invalidJson = yield* auth.get("broken")
      expect(invalidJson).toBeUndefined()
      const providers = yield* auth.list()
      expect(providers).toEqual([])
    }).pipe(
      Effect.provide(
        storeLayer({
          openai: "sk-raw",
          broken: '{"type":"oauth","access":"missing-required-fields"}',
        }),
      ),
    ),
  )

  it.live("listInfo omits and discards invalid auth payloads", () =>
    Effect.gen(function* () {
      const auth = yield* AuthStore
      const result = yield* auth.listInfo()
      expect(Object.keys(result)).toEqual(["anthropic"])
      expect(result["anthropic"]?.type).toBe("api")
      const providers = yield* auth.list()
      expect(providers).toEqual(["anthropic"])
    }).pipe(
      Effect.provide(
        storeLayer({
          anthropic: apiJson("key1"),
          openai:
            '{"type":"oauth","access":"access-token","refresh":"refresh-token","expires":4102444800000}',
        }),
      ),
    ),
  )

  it.live("delete failure while discarding invalid auth stays non-fatal", () => {
    const logEntries: Array<{
      readonly message: unknown
      readonly annotations: Record<string, unknown>
    }> = []
    const captureLogger = Logger.map(Logger.formatStructured, (entry) => {
      logEntries.push(entry)
    })
    const messageText = (message: unknown) =>
      Array.isArray(message) ? message.map((entry) => String(entry)).join(" ") : String(message)
    const failingStorage = Layer.succeed(AuthStorage, {
      get: (provider: string) => Effect.succeed(provider === "openai" ? "sk-raw" : undefined),
      set: () => Effect.void,
      delete: () => Effect.fail(new AuthStorageError({ message: "delete failed" })),
      list: () => Effect.succeed(["openai"]),
    })

    return Effect.gen(function* () {
      const auth = yield* AuthStore
      const result = yield* auth.get("openai").pipe(Effect.provide(Logger.layer([captureLogger])))
      expect(result).toBeUndefined()
      const logMessages = logEntries.map((entry) => messageText(entry.message))
      expect(logMessages).toContain("failed to discard invalid auth info")
      expect(logMessages).not.toContain("discarded invalid auth info")
      const failureLog = logEntries.find(
        (entry) => messageText(entry.message) === "failed to discard invalid auth info",
      )
      expect(String(failureLog?.annotations["cause"])).toContain(
        "AuthStoreError: Failed to decode auth info",
      )
      expect(String(failureLog?.annotations["deleteCause"])).toContain(
        "AuthStorageError: delete failed",
      )
      const providers = yield* auth.list()
      expect(providers).toEqual(["openai"])
    }).pipe(Effect.provide(Layer.provide(AuthStore.Live, failingStorage)))
  })

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
      Effect.provide(storeLayer({ anthropic: apiJson("key1"), openai: apiJson("key2") })),
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

  it.live("get surfaces storage read failures", () => {
    const failingStorage = Layer.succeed(AuthStorage, {
      get: () => Effect.fail(new AuthStorageError({ message: "read failed" })),
      set: () => Effect.void,
      delete: () => Effect.void,
      list: () => Effect.succeed([]),
    })

    return Effect.gen(function* () {
      const auth = yield* AuthStore
      const exit = yield* Effect.exit(auth.get("openai"))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        expect(exit.cause.toString()).toContain("read failed")
      }
    }).pipe(Effect.provide(Layer.provide(AuthStore.Live, failingStorage)))
  })

  it.live("list and listInfo surface storage list failures", () => {
    const failingStorage = Layer.succeed(AuthStorage, {
      get: () => Effect.succeed(undefined),
      set: () => Effect.void,
      delete: () => Effect.void,
      list: () => Effect.fail(new AuthStorageError({ message: "list failed" })),
    })

    return Effect.gen(function* () {
      const auth = yield* AuthStore
      const listExit = yield* Effect.exit(auth.list())
      expect(listExit._tag).toBe("Failure")
      if (listExit._tag === "Failure") {
        expect(listExit.cause.toString()).toContain("list failed")
      }

      const listInfoExit = yield* Effect.exit(auth.listInfo())
      expect(listInfoExit._tag).toBe("Failure")
      if (listInfoExit._tag === "Failure") {
        expect(listInfoExit.cause.toString()).toContain("list failed")
      }
    }).pipe(Effect.provide(Layer.provide(AuthStore.Live, failingStorage)))
  })

  it.live("keychain-style delete failures reach AuthStore", () => {
    const keychainLikeStorage = Layer.succeed(AuthStorage, {
      get: () => Effect.succeed("sk-existing"),
      set: () => Effect.void,
      delete: () =>
        Effect.fail(new AuthStorageError({ message: "Keychain command failed: denied" })),
      list: () => Effect.succeed(["openai"]),
    })

    return Effect.gen(function* () {
      const auth = yield* AuthStore
      const exit = yield* Effect.exit(auth.remove("openai"))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        expect(exit.cause.toString()).toContain("Keychain command failed")
      }
    }).pipe(Effect.provide(Layer.provide(AuthStore.Live, keychainLikeStorage)))
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
