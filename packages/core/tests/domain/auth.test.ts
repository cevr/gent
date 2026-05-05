/**
 * Locks the consolidated `domain/auth` module — `Auth` service +
 * `AuthGuard` service + the `Auth.Info` schema.
 *
 * Exercises:
 *   - `Auth.Test` round-trip (set / get / remove).
 *   - `Auth.Live` against a real on-disk directory, including
 *     "corrupt file is discarded and reported".
 *   - `AuthGuard.Test` smoke.
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect, FileSystem } from "effect"
import { BunServices } from "@effect/platform-bun"
import { Auth, AuthGuard, AuthInfo } from "../../src/domain/auth.js"

describe("Auth", () => {
  describe("Auth.Test", () => {
    it.live("round-trips api / oauth variants", () =>
      Effect.gen(function* () {
        const auth = yield* Auth

        yield* auth.set("openai", AuthInfo.Api.make({ type: "api", key: "sk-test" }))
        const openai = yield* auth.get("openai")
        expect(openai?.type).toBe("api")
        if (openai?.type === "api") expect(openai.key).toBe("sk-test")

        yield* auth.set(
          "anthropic",
          AuthInfo.Oauth.make({
            type: "oauth",
            access: "a",
            refresh: "r",
            expires: 0,
          }),
        )
        const anthropic = yield* auth.get("anthropic")
        expect(anthropic?.type).toBe("oauth")
        if (anthropic?.type === "oauth") {
          expect(anthropic.access).toBe("a")
          expect(anthropic.refresh).toBe("r")
        }

        yield* auth.remove("openai")
        expect(yield* auth.get("openai")).toBeUndefined()
      }).pipe(Effect.provide(Auth.Test())),
    )

    it.live("returns undefined for missing providers", () =>
      Effect.gen(function* () {
        const auth = yield* Auth
        expect(yield* auth.get("does-not-exist")).toBeUndefined()
      }).pipe(Effect.provide(Auth.Test())),
    )
  })

  describe("Auth.Live", () => {
    it.scopedLive("persists round-trip to disk", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()

        const writer = Effect.gen(function* () {
          const auth = yield* Auth
          yield* auth.set("openai", AuthInfo.Api.make({ type: "api", key: "sk-on-disk" }))
        }).pipe(Effect.provide(Auth.Live(dir)))
        yield* writer

        const reader = Effect.gen(function* () {
          const auth = yield* Auth
          return yield* auth.get("openai")
        }).pipe(Effect.provide(Auth.Live(dir)))
        const fetched = yield* reader

        expect(fetched?.type).toBe("api")
        if (fetched?.type === "api") expect(fetched.key).toBe("sk-on-disk")
      }).pipe(Effect.provide(BunServices.layer)),
    )

    it.scopedLive("discards a corrupt entry and returns undefined", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        // Write a malformed entry directly. `KeyValueStore.layerFileSystem`
        // URL-encodes the key into the file basename — `openai` is safe
        // and round-trips as `openai` with no escaping.
        yield* fs.writeFileString(`${dir}/openai`, "not-json-at-all")

        const result = yield* Effect.gen(function* () {
          const auth = yield* Auth
          return yield* auth.get("openai")
        }).pipe(Effect.provide(Auth.Live(dir)))
        expect(result).toBeUndefined()

        // Recovery is not just "swallow" — the broken file should be
        // removed so the next launch isn't held back by it.
        const stillThere = yield* fs.exists(`${dir}/openai`)
        expect(stillThere).toBe(false)
      }).pipe(Effect.provide(BunServices.layer)),
    )
  })

  describe("AuthGuard.Test", () => {
    it.live("returns the seeded provider list and computes missing required", () =>
      Effect.gen(function* () {
        const guard = yield* AuthGuard
        const providers = yield* guard.listProviders()
        expect(providers.length).toBe(2)

        const missing = yield* guard.missingRequiredProviders()
        expect(missing.map(String)).toEqual(["needs-key"])
      }).pipe(
        Effect.provide(
          AuthGuard.Test([
            { provider: "has-key" as never, hasKey: true, required: true },
            { provider: "needs-key" as never, hasKey: false, required: true },
          ]),
        ),
      ),
    )
  })
})
