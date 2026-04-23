import { describe, it, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AuthMethod } from "@gent/core/domain/auth-method"
import { AuthStore } from "@gent/core/domain/auth-store"
import type { AuthApi } from "@gent/core/domain/auth-store"
import { AuthStorage } from "@gent/core/domain/auth-storage"
import type { LoadedExtension } from "../../src/domain/extension.js"
import type { ModelDriverContribution } from "@gent/core/domain/driver"
import { ProviderAuth } from "@gent/core/providers/provider-auth"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { DriverRegistry } from "@gent/core/runtime/extensions/driver-registry"

const pendingCallbacks = new Map<string, (code?: string) => string>()

const oauthProvider: ModelDriverContribution = {
  id: "openai",
  name: "OpenAI",
  resolveModel: () => ({}),
  auth: {
    methods: [new AuthMethod({ type: "oauth", label: "OAuth" })],
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
    methods: [new AuthMethod({ type: "api", label: "API" })],
  },
}

const testResolved = resolveExtensions([
  {
    manifest: { id: "test" },
    kind: "builtin",
    sourcePath: "test",
    contributions: { modelDrivers: [oauthProvider, noopProvider] },
  } satisfies LoadedExtension,
])
const testRegistry = ExtensionRegistry.fromResolved(testResolved)
const testDriverRegistry = DriverRegistry.fromResolved({
  modelDrivers: testResolved.modelDrivers,
  externalDrivers: testResolved.externalDrivers,
})

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
    expect(methods["openai"]?.length).toBe(1)
  })
})
