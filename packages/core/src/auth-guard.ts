import { Context, Effect, Layer, Schema } from "effect"
import { AuthStore, AuthType } from "./auth-store"
import { AgentModels } from "./agent"
import { ProviderId, SUPPORTED_PROVIDERS, parseModelProvider } from "./model"

export const AuthSource = Schema.Literal("stored")
export type AuthSource = typeof AuthSource.Type

export const AuthProviderInfo = Schema.Struct({
  provider: ProviderId,
  hasKey: Schema.Boolean,
  source: Schema.optional(AuthSource),
  authType: Schema.optional(AuthType),
  required: Schema.Boolean,
})
export type AuthProviderInfo = typeof AuthProviderInfo.Type

export interface AuthGuardService {
  readonly requiredProviders: () => Effect.Effect<readonly ProviderId[]>
  readonly listProviders: () => Effect.Effect<readonly AuthProviderInfo[]>
  readonly missingRequiredProviders: () => Effect.Effect<readonly ProviderId[]>
}

const REQUIRED_PROVIDERS: readonly ProviderId[] = (() => {
  const providers = new Set<ProviderId>()
  for (const modelId of Object.values(AgentModels)) {
    const provider = parseModelProvider(modelId)
    if (provider !== undefined) providers.add(provider)
  }
  return [...providers]
})()

export class AuthGuard extends Context.Tag("@gent/core/src/auth-guard/AuthGuard")<
  AuthGuard,
  AuthGuardService
>() {
  static Live: Layer.Layer<AuthGuard, never, AuthStore> = Layer.effect(
    AuthGuard,
    Effect.gen(function* () {
      const authStore = yield* AuthStore
      const requiredSet = new Set(REQUIRED_PROVIDERS)

      const listProviders = Effect.fn("AuthGuard.listProviders")(function* () {
        const providers: AuthProviderInfo[] = []
        for (const provider of SUPPORTED_PROVIDERS) {
          const storedInfo = yield* authStore
            .get(provider.id)
            .pipe(Effect.catchAll(() => Effect.succeed(undefined)))
          const hasStored = storedInfo !== undefined
          const required = requiredSet.has(provider.id)

          if (hasStored) {
            providers.push({
              provider: provider.id,
              hasKey: true,
              source: "stored" as const,
              authType: storedInfo?.type as AuthType | undefined,
              required,
            })
            continue
          }
          providers.push({ provider: provider.id, hasKey: false, required })
        }

        return providers
      })

      const missingRequiredProviders = Effect.fn("AuthGuard.missingRequiredProviders")(
        function* () {
          const providers = yield* listProviders()
          return providers.filter((p) => p.required && !p.hasKey).map((p) => p.provider)
        },
      )

      return AuthGuard.of({
        requiredProviders: () => Effect.succeed(REQUIRED_PROVIDERS),
        listProviders,
        missingRequiredProviders,
      })
    }),
  )
}
