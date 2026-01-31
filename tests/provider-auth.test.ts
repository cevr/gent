import { describe, it, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AuthMethod, AuthStore, AuthStorage, type AuthApi } from "@gent/core"
import { ProviderAuth, type ProviderAuthProvider } from "@gent/providers"

const oauthProvider: ProviderAuthProvider = {
  methods: [new AuthMethod({ type: "oauth", label: "OAuth" })],
  authorize: () =>
    Effect.succeed({
      authorization: {
        url: "http://example.com/auth",
        method: "code",
        instructions: "Paste code",
      },
      callback: (code?: string) => Effect.succeed({ type: "api", key: code ?? "" } as const),
    }),
}

const noopProvider: ProviderAuthProvider = {
  methods: [new AuthMethod({ type: "api", label: "API" })],
  authorize: () => Effect.succeed(undefined),
}

const providers = {
  anthropic: noopProvider,
  openai: oauthProvider,
  bedrock: noopProvider,
  google: noopProvider,
  mistral: noopProvider,
}

describe("ProviderAuth", () => {
  it("scopes pending OAuth by session + auth id", async () => {
    const layer = Layer.mergeAll(AuthStorage.Test(), AuthStore.Live, ProviderAuth.Test(providers))

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* ProviderAuth
        const store = yield* AuthStore

        const first = yield* auth.authorize("s1", "openai", 0)
        const second = yield* auth.authorize("s2", "openai", 0)

        if (!first || !second) return { ok: false as const }

        yield* auth.callback("s1", "openai", 0, first.authorizationId, "sk-1")
        const stored = yield* store.get("openai")

        const mismatch = yield* Effect.either(
          auth.callback("s2", "openai", 0, first.authorizationId, "sk-2"),
        )

        return {
          ok: true as const,
          firstId: first.authorizationId,
          secondId: second.authorizationId,
          stored,
          mismatch,
        }
      }).pipe(Effect.provide(layer)),
    )

    if (!result.ok) throw new Error("auth setup failed")

    expect(result.firstId).not.toBe(result.secondId)
    expect(result.stored?.type).toBe("api")
    expect((result.stored as AuthApi | undefined)?.key).toBe("sk-1")
    expect(result.mismatch._tag).toBe("Left")
  })
})
