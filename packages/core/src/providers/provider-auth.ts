import { Context, Effect, Layer } from "effect"
import { AuthApi, AuthOauth, AuthStore } from "../domain/auth-store.js"
import { AuthAuthorization } from "../domain/auth-method.js"
import type { AuthMethod } from "../domain/auth-method.js"
import { ProviderAuthError, type PersistAuth } from "../domain/driver.js"
import type { SessionId } from "../domain/ids.js"
import {
  DriverRegistry,
  type DriverRegistryService,
} from "../runtime/extensions/driver-registry.js"

export { ProviderAuthError } from "../domain/driver.js"

export interface ProviderAuthService {
  readonly listMethods: () => Effect.Effect<Record<string, ReadonlyArray<typeof AuthMethod.Type>>>
  readonly authorize: (
    sessionId: SessionId,
    provider: string,
    method: number,
  ) => Effect.Effect<typeof AuthAuthorization.Type | undefined, ProviderAuthError>
  readonly callback: (
    sessionId: SessionId,
    provider: string,
    method: number,
    authorizationId: string,
    code?: string,
  ) => Effect.Effect<void, ProviderAuthError>
}

export class ProviderAuth extends Context.Service<ProviderAuth, ProviderAuthService>()(
  "@gent/core/src/providers/provider-auth/ProviderAuth",
) {
  static Live: Layer.Layer<ProviderAuth, never, AuthStore | DriverRegistry> = Layer.effect(
    ProviderAuth,
    Effect.gen(function* () {
      const driverRegistry = yield* DriverRegistry
      return yield* makeProviderAuth(driverRegistry)
    }),
  )
}

const makeProviderAuth = (
  driverRegistry: DriverRegistryService,
): Effect.Effect<ProviderAuthService, never, AuthStore> =>
  Effect.gen(function* () {
    const authStore = yield* AuthStore

    /** Build a PersistAuth callback for a provider — writes credentials to AuthStore */
    const makePersist =
      (providerId: string): PersistAuth =>
      (auth) => {
        if (auth.type === "api") {
          return authStore.set(providerId, new AuthApi({ type: "api", key: auth.key })).pipe(
            Effect.mapError(
              (e) =>
                new ProviderAuthError({
                  message: `Failed to persist auth for provider "${providerId}"`,
                  cause: e,
                }),
            ),
          )
        }
        return authStore
          .set(
            providerId,
            new AuthOauth({
              type: "oauth",
              access: auth.access,
              refresh: auth.refresh,
              expires: auth.expires,
              ...(auth.accountId !== undefined ? { accountId: auth.accountId } : {}),
            }),
          )
          .pipe(
            Effect.mapError(
              (e) =>
                new ProviderAuthError({
                  message: `Failed to persist auth for provider "${providerId}"`,
                  cause: e,
                }),
            ),
          )
      }

    const listMethods = Effect.fn("ProviderAuth.listMethods")(function* () {
      const result: Record<string, ReadonlyArray<typeof AuthMethod.Type>> = {}
      const registeredProviders = yield* driverRegistry.listModels()
      for (const provider of registeredProviders) {
        if (provider.auth !== undefined && provider.auth.methods.length > 0) {
          result[provider.id] = provider.auth.methods
        }
      }
      return result
    })

    const authorize = Effect.fn("ProviderAuth.authorize")(function* (
      sessionId: SessionId,
      provider: string,
      method: number,
    ) {
      const extProvider = yield* driverRegistry.getModel(provider)
      if (extProvider?.auth?.authorize === undefined) {
        return yield* new ProviderAuthError({
          message: `Provider "${provider}" does not support authorize`,
        })
      }
      const authorizationId = Bun.randomUUIDv7()
      const extResult = yield* extProvider.auth
        .authorize({
          sessionId,
          methodIndex: method,
          authorizationId,
          persist: makePersist(provider),
        })
        .pipe(
          Effect.catchDefect((e) =>
            Effect.fail(
              new ProviderAuthError({
                message: `Provider auth failed: ${e instanceof Error ? e.message : String(e)}`,
                cause: e,
              }),
            ),
          ),
        )
      if (extResult === undefined) return undefined
      return new AuthAuthorization({
        authorizationId,
        url: extResult.url,
        method: extResult.method,
        ...(extResult.instructions !== undefined ? { instructions: extResult.instructions } : {}),
      })
    })

    const callback = Effect.fn("ProviderAuth.callback")(function* (
      sessionId: SessionId,
      provider: string,
      method: number,
      authorizationId: string,
      code?: string,
    ) {
      const extProvider = yield* driverRegistry.getModel(provider)
      if (extProvider?.auth?.callback === undefined) {
        // No callback handler — auth completed during authorize (e.g. "done" method)
        return
      }
      yield* extProvider.auth
        .callback({
          sessionId,
          methodIndex: method,
          authorizationId,
          persist: makePersist(provider),
          code,
        })
        .pipe(
          Effect.catchDefect((e) =>
            Effect.fail(
              new ProviderAuthError({
                message: `Provider auth callback failed: ${e instanceof Error ? e.message : String(e)}`,
                cause: e,
              }),
            ),
          ),
        )
    })

    return ProviderAuth.of({
      listMethods,
      authorize,
      callback,
    })
  })
