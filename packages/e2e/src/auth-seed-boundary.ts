import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { AuthApi, AuthStore } from "@gent/core/domain/auth-store"
import { AuthStorage } from "@gent/core/domain/auth-storage"
import { Effect, Layer, ManagedRuntime } from "effect"

export const seedAuthBoundary = (authFilePath: string, authKeyPath: string): Promise<void> => {
  const storageLayer = AuthStorage.LiveEncryptedFile(authFilePath, authKeyPath).pipe(
    Layer.provide(Layer.merge(BunServices.layer, BunFileSystem.layer)),
  )
  const runtime = ManagedRuntime.make(AuthStore.Live.pipe(Layer.provide(storageLayer)))
  return runtime
    .runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthStore
        yield* auth.set("anthropic", AuthApi.make({ type: "api", key: "test-key" }))
        yield* auth.set("openai", AuthApi.make({ type: "api", key: "test-key" }))
      }),
    )
    .finally(() => {
      void runtime.dispose()
    })
}
