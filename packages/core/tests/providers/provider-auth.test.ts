import { describe, it, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AuthMethod } from "@gent/core/domain/auth-method"
import { AuthStore, AuthStoreError } from "@gent/core/domain/auth-store"
import type { AuthApi } from "@gent/core/domain/auth-store"
import { AuthStorage } from "@gent/core/domain/auth-storage"
import type { LoadedExtension } from "../../src/domain/extension.js"
import type { ModelDriverContribution } from "@gent/core/domain/driver"
import { ProviderAuth } from "@gent/core/providers/provider-auth"
import { ExtensionRegistry, resolveExtensions } from "../../src/runtime/extensions/registry"
import { DriverRegistry } from "../../src/runtime/extensions/driver-registry"

const pendingCallbacks = new Map<string, (code?: string) => string>()

const oauthProvider: ModelDriverContribution = {
  id: "openai",
  name: "OpenAI",
  resolveModel: () => ({}),
  auth: {
    methods: [AuthMethod.make({ type: "oauth", label: "OAuth" })],
    authorize: (ctx) =>
      Effect.tryPromise({
        try: async () => {
          pendingCallbacks.set(ctx.authorizationId, (code) => code ?? "")
          return {
            url: "http://example.com/auth",
            method: "code" as const,
            instructions: "Paste code",
          }
        },
        catch: (e) => ({ _tag: "AuthError" as const, cause: e }),
      }).pipe(Effect.catchEager(() => Effect.void.pipe(Effect.as(undefined)))),
    callback: (ctx) =>
      Effect.gen(function* () {
        const cb = pendingCallbacks.get(ctx.authorizationId)
        pendingCallbacks.delete(ctx.authorizationId)
        const apiKey = cb !== undefined ? cb(ctx.code) : ""
        yield* ctx.persist({ type: "api", key: apiKey })
      }),
  },
}

const noopProvider: ModelDriverContribution = {
  id: "anthropic",
  name: "Anthropic",
  resolveModel: () => ({}),
  auth: {
    methods: [AuthMethod.make({ type: "api", label: "API" })],
  },
}

const persistDuringAuthorizeProvider: ModelDriverContribution = {
  id: "persisting",
  name: "Persisting",
  resolveModel: () => ({}),
  auth: {
    methods: [AuthMethod.make({ type: "oauth", label: "Done" })],
    authorize: (ctx) =>
      Effect.gen(function* () {
        yield* ctx.persist({ type: "api", key: "sk-authorize" })
        return {
          url: "",
          method: "done" as const,
        }
      }),
  },
}

const testResolved = resolveExtensions([
  {
    manifest: { id: "test" },
    scope: "builtin",
    sourcePath: "test",
    contributions: { modelDrivers: [oauthProvider, noopProvider, persistDuringAuthorizeProvider] },
  } satisfies LoadedExtension,
])
const testRegistry = ExtensionRegistry.fromResolved(testResolved)
const testDriverRegistry = DriverRegistry.fromResolved({
  modelDrivers: testResolved.modelDrivers,
  externalDrivers: testResolved.externalDrivers,
})

const failingAuthStoreLayer = Layer.succeed(
  AuthStore,
  AuthStore.of({
    get: () => Effect.succeed(undefined),
    set: () => Effect.fail(new AuthStoreError({ message: "write failed" })),
    remove: () => Effect.void,
    list: () => Effect.succeed([]),
    listInfo: () => Effect.succeed({}),
  }),
)

describe("ProviderAuth", () => {
  it("extension authorize + callback stores credentials", async () => {
    pendingCallbacks.clear()
    const authStoreLayer = Layer.provide(AuthStore.Live, AuthStorage.Test())
    const layer = Layer.provideMerge(
      ProviderAuth.Test(),
      Layer.mergeAll(authStoreLayer, testRegistry, testDriverRegistry),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* ProviderAuth
        const store = yield* AuthStore

        const authResult = yield* auth.authorize("s1", "openai", 0)
        if (authResult === undefined) return { ok: false as const }

        yield* auth.callback("s1", "openai", 0, authResult.authorizationId, "sk-test-key")
        const stored = yield* store.get("openai")

        return { ok: true as const, stored }
      }).pipe(Effect.provide(layer)),
    )

    if (!result.ok) throw new Error("auth setup failed")
    expect(result.stored?.type).toBe("api")
    expect((result.stored as AuthApi | undefined)?.key).toBe("sk-test-key")
  })

  it("listMethods returns methods from extension providers", async () => {
    const authStoreLayer = Layer.provide(AuthStore.Live, AuthStorage.Test())
    const layer = Layer.provideMerge(
      ProviderAuth.Test(),
      Layer.mergeAll(authStoreLayer, testRegistry, testDriverRegistry),
    )

    const methods = await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* ProviderAuth
        return yield* auth.listMethods()
      }).pipe(Effect.provide(layer)),
    )

    expect(Object.keys(methods)).toContain("openai")
    expect(Object.keys(methods)).toContain("anthropic")
    expect(Object.keys(methods)).toContain("persisting")
    expect(methods["openai"]?.length).toBe(1)
  })

  it("authorize surfaces credential persistence failures", async () => {
    const layer = Layer.provideMerge(
      ProviderAuth.Test(),
      Layer.mergeAll(failingAuthStoreLayer, testRegistry, testDriverRegistry),
    )

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* ProviderAuth
        return yield* Effect.exit(auth.authorize("s1", "persisting", 0))
      }).pipe(Effect.provide(layer)),
    )

    expect(exit._tag).toBe("Failure")
    expect(exit.cause.toString()).toContain("Failed to persist auth")
  })

  it("callback surfaces credential persistence failures", async () => {
    pendingCallbacks.clear()
    const layer = Layer.provideMerge(
      ProviderAuth.Test(),
      Layer.mergeAll(failingAuthStoreLayer, testRegistry, testDriverRegistry),
    )

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* ProviderAuth
        const authResult = yield* auth.authorize("s1", "openai", 0)
        if (authResult === undefined) return yield* Effect.dieMessage("auth setup failed")
        return yield* Effect.exit(
          auth.callback("s1", "openai", 0, authResult.authorizationId, "sk-test-key"),
        )
      }).pipe(Effect.provide(layer)),
    )

    expect(exit._tag).toBe("Failure")
    expect(exit.cause.toString()).toContain("Failed to persist auth")
  })
})
