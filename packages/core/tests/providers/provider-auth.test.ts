import { describe, it, expect } from "effect-bun-test"
import { Predicate, Effect, Layer, Option } from "effect"
import { LanguageModel, Model as AiModel } from "effect/unstable/ai"
import { SessionId, ExtensionId } from "@gent/core-internal/domain/ids"
import {
  Auth,
  AuthError,
  AuthMethod,
  type AuthInfo,
  type AuthService,
} from "@gent/core-internal/domain/auth"
import type { LoadedExtension } from "../../src/domain/extension.js"
import type { ModelDriverContribution } from "@gent/core-internal/domain/driver"
import { ProviderAuth } from "@gent/core-internal/providers/provider-auth"
import { ExtensionRegistry, resolveExtensions } from "../../src/runtime/extensions/registry"
import { DriverRegistry } from "../../src/runtime/extensions/driver-registry"
import { GentPlatform } from "../../src/runtime/gent-platform"
import { failingLanguageModel } from "../helpers/failing-language-model"
const pendingCallbacks = new Map<string, (code?: string) => string>()
const stubModel = AiModel.make(
  "test",
  "model",
  Layer.succeed(LanguageModel.LanguageModel, failingLanguageModel),
)
const oauthProvider: ModelDriverContribution = {
  id: "openai",
  name: "OpenAI",
  resolveModel: () => Effect.succeed(stubModel),
  auth: {
    methods: [AuthMethod.make({ type: "oauth", label: "OAuth" })],
    authorize: (ctx) =>
      Effect.sync(() => {
        pendingCallbacks.set(ctx.authorizationId, (code) => code ?? "")
        return Option.some({
          url: "http://example.com/auth",
          method: "code",
          instructions: "Paste code",
        })
      }),
    callback: (ctx) =>
      Effect.gen(function* () {
        const cb = pendingCallbacks.get(ctx.authorizationId)
        pendingCallbacks.delete(ctx.authorizationId)
        let apiKey = ""
        if (!Predicate.isUndefined(cb)) apiKey = cb(ctx.code)
        yield* ctx.persist({ type: "api", key: apiKey })
      }),
  },
}
const noopProvider: ModelDriverContribution = {
  id: "anthropic",
  name: "Anthropic",
  resolveModel: () => Effect.succeed(stubModel),
  auth: {
    methods: [AuthMethod.make({ type: "api", label: "API" })],
  },
}
const persistDuringAuthorizeProvider: ModelDriverContribution = {
  id: "persisting",
  name: "Persisting",
  resolveModel: () => Effect.succeed(stubModel),
  auth: {
    methods: [AuthMethod.make({ type: "oauth", label: "Done" })],
    authorize: (ctx) =>
      Effect.gen(function* () {
        yield* ctx.persist({ type: "api", key: "sk-authorize" })
        return Option.some({
          url: "",
          method: "done",
        })
      }),
  },
}
const testResolved = resolveExtensions([
  {
    manifest: { id: ExtensionId.make("test") },
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
  Auth,
  Auth.of({
    get: () => Effect.succeed(Option.getOrUndefined(Option.none<AuthInfo>())),
    set: () => Effect.fail(new AuthError({ message: "write failed" })),
    remove: () => Effect.void,
  } satisfies AuthService),
)
describe("ProviderAuth", () => {
  it.live("extension authorize + callback stores credentials", () =>
    Effect.gen(function* () {
      pendingCallbacks.clear()
      const authLayer = Auth.Test()
      const layer = Layer.provideMerge(
        ProviderAuth.Live,
        Layer.mergeAll(authLayer, testRegistry, testDriverRegistry, GentPlatform.Test()),
      )
      const result = yield* Effect.gen(function* () {
        const auth = yield* ProviderAuth
        const store = yield* Auth
        const authResult = yield* auth.authorize(SessionId.make("s1"), "openai", 0)
        if (Option.isNone(authResult)) return { ok: false }
        yield* auth.callback(
          SessionId.make("s1"),
          "openai",
          0,
          authResult.value.authorizationId,
          "sk-test-key",
        )
        const stored = yield* store.get("openai")
        return { ok: true, stored }
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer))
      if (!result.ok) return yield* Effect.die(new Error("auth setup failed"))
      const stored = Option.fromUndefinedOr(result.stored)
      expect(Option.isSome(stored)).toBe(true)
      if (Option.isNone(stored)) return
      expect(stored.value.type).toBe("api")
      if (stored.value.type !== "api") return
      expect(stored.value.key).toBe("sk-test-key")
    }),
  )
  it.live("listMethods returns methods from extension providers", () =>
    Effect.gen(function* () {
      const authLayer = Auth.Test()
      const layer = Layer.provideMerge(
        ProviderAuth.Live,
        Layer.mergeAll(authLayer, testRegistry, testDriverRegistry, GentPlatform.Test()),
      )
      const methods = yield* Effect.gen(function* () {
        const auth = yield* ProviderAuth
        return yield* auth.listMethods
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer))
      expect(Object.keys(methods)).toContain("openai")
      expect(Object.keys(methods)).toContain("anthropic")
      expect(Object.keys(methods)).toContain("persisting")
      expect(methods["openai"]?.length).toBe(1)
    }),
  )
  it.live("authorize surfaces credential persistence failures", () =>
    Effect.gen(function* () {
      const layer = Layer.provideMerge(
        ProviderAuth.Live,
        Layer.mergeAll(
          failingAuthStoreLayer,
          testRegistry,
          testDriverRegistry,
          GentPlatform.Test(),
        ),
      )
      const exit = yield* Effect.gen(function* () {
        const auth = yield* ProviderAuth
        return yield* Effect.exit(auth.authorize(SessionId.make("s1"), "persisting", 0))
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        expect(exit.cause.toString()).toContain("Failed to persist auth")
      }
    }),
  )
  it.live("callback surfaces credential persistence failures", () =>
    Effect.gen(function* () {
      pendingCallbacks.clear()
      const layer = Layer.provideMerge(
        ProviderAuth.Live,
        Layer.mergeAll(
          failingAuthStoreLayer,
          testRegistry,
          testDriverRegistry,
          GentPlatform.Test(),
        ),
      )
      const exit = yield* Effect.gen(function* () {
        const auth = yield* ProviderAuth
        const authResult = yield* auth.authorize(SessionId.make("s1"), "openai", 0)
        if (Option.isNone(authResult)) return yield* Effect.die("auth setup failed")
        return yield* Effect.exit(
          auth.callback(
            SessionId.make("s1"),
            "openai",
            0,
            authResult.value.authorizationId,
            "sk-test-key",
          ),
        )
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        expect(exit.cause.toString()).toContain("Failed to persist auth")
      }
    }),
  )
})
