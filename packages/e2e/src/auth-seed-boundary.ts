import { BunServices } from "@effect/platform-bun"
import { Auth, AuthApi } from "@gent/core-internal/domain/auth"
import { Effect, Layer, ManagedRuntime } from "effect"

/**
 * Seeds the on-disk auth store with API keys for the test providers.
 * Used by e2e fixtures so child gent processes find usable credentials
 * without prompting.
 *
 * `directory` is the same path the SUT will read on launch
 * (`GENT_AUTH_DIRECTORY` / `dependencies.authDirectory`). Each provider
 * becomes one URL-encoded file under that directory.
 */
export const seedAuthBoundary = (directory: string): Promise<void> => {
  const runtime = ManagedRuntime.make(Auth.Live(directory).pipe(Layer.provide(BunServices.layer)))
  return runtime
    .runPromise(
      Effect.gen(function* () {
        const auth = yield* Auth
        yield* auth.set("anthropic", AuthApi.make({ type: "api", key: "test-key" }))
        yield* auth.set("openai", AuthApi.make({ type: "api", key: "test-key" }))
      }),
    )
    .finally(() => {
      void runtime.dispose()
    })
}
