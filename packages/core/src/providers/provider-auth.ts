import { Predicate, Context, Effect, Layer, Option } from "effect"
import { Auth, AuthApi, AuthOauth, AuthAuthorization } from "../domain/auth.js"
import type { AuthMethod } from "../domain/auth.js"
import { ProviderAuthError, type PersistAuth } from "../domain/driver.js"
import type { SessionId } from "../domain/ids.js"
import { DriverRegistry } from "../runtime/extensions/driver-registry.js"
import { GentPlatform } from "../runtime/gent-platform.js"

export { ProviderAuthError } from "../domain/driver.js"

export interface ProviderAuthService {
  readonly listMethods: Effect.Effect<Record<string, ReadonlyArray<AuthMethod>>>
  readonly authorize: (
    sessionId: SessionId,
    provider: string,
    method: number,
  ) => Effect.Effect<Option.Option<AuthAuthorization>, ProviderAuthError>
  readonly callback: (
    sessionId: SessionId,
    provider: string,
    method: number,
    authorizationId: string,
    code?: string,
  ) => Effect.Effect<void, ProviderAuthError>
}

const makeProviderAuth: Effect.Effect<
  ProviderAuthService,
  never,
  Auth | DriverRegistry | GentPlatform
> = Effect.gen(function* () {
  const driverRegistry = yield* DriverRegistry
  const authStore = yield* Auth
  const platform = yield* GentPlatform

  const errorMessage = (cause: unknown): string => {
    if (Predicate.isError(cause)) return cause.message
    return String(cause)
  }

  /** Build a PersistAuth callback for a provider — writes credentials to Auth */
  const makePersist =
    (providerId: string): PersistAuth =>
    (auth) => {
      if (auth.type === "api") {
        return authStore.set(providerId, AuthApi.make({ type: "api", key: auth.key })).pipe(
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
          AuthOauth.make({
            type: "oauth",
            access: auth.access,
            refresh: auth.refresh,
            expires: auth.expires,
            accountId: auth.accountId,
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

  const listMethods = Effect.gen(function* () {
    const result: Record<string, ReadonlyArray<AuthMethod>> = {}
    const registeredProviders = yield* driverRegistry.listModels
    for (const provider of registeredProviders) {
      if (!Predicate.isUndefined(provider.auth) && provider.auth.methods.length > 0) {
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
    if (Predicate.isUndefined(extProvider?.auth?.authorize)) {
      return yield* new ProviderAuthError({
        message: `Provider "${provider}" does not support authorize`,
      })
    }
    const authorizationId = yield* platform.randomId
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
              message: `Provider auth failed: ${errorMessage(e)}`,
              cause: e,
            }),
          ),
        ),
      )
    if (Option.isNone(extResult)) return Option.none()
    return Option.some(
      new AuthAuthorization({
        authorizationId,
        url: extResult.value.url,
        method: extResult.value.method,
        instructions: extResult.value.instructions,
      }),
    )
  })

  const callback = Effect.fn("ProviderAuth.callback")(function* (
    sessionId: SessionId,
    provider: string,
    method: number,
    authorizationId: string,
    code?: string,
  ) {
    const extProvider = yield* driverRegistry.getModel(provider)
    if (Predicate.isUndefined(extProvider?.auth?.callback)) {
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
              message: `Provider auth callback failed: ${errorMessage(e)}`,
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

export class ProviderAuth extends Context.Service<ProviderAuth, ProviderAuthService>()(
  "@gent/core/src/providers/provider-auth/ProviderAuth",
) {
  static Live: Layer.Layer<ProviderAuth, never, Auth | DriverRegistry | GentPlatform> =
    Layer.effect(ProviderAuth, makeProviderAuth)
}
