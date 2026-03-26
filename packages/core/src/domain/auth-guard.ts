import { ServiceMap, Effect, Layer, Schema } from "effect"
import { AuthStore, AuthType } from "./auth-store"
import { Agents, resolveAgentModel } from "./agent"
import { ProviderId, parseModelProvider } from "./model"
import { ExtensionRegistry } from "../runtime/extensions/registry.js"

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
  for (const agent of Object.values(Agents)) {
    const modelId = resolveAgentModel(agent)
    const provider = parseModelProvider(modelId)
    if (provider !== undefined) providers.add(provider)
  }
  return [...providers]
})()

export class AuthGuard extends ServiceMap.Service<AuthGuard, AuthGuardService>()(
  "@gent/core/src/domain/auth-guard/AuthGuard",
) {
  static Live: Layer.Layer<AuthGuard, never, AuthStore | ExtensionRegistry> = Layer.effect(
    AuthGuard,
    Effect.gen(function* () {
      const authStore = yield* AuthStore
      const extensionRegistry = yield* ExtensionRegistry
      const requiredSet = new Set(REQUIRED_PROVIDERS)

      const listProviders = Effect.fn("AuthGuard.listProviders")(function* () {
        const providers: AuthProviderInfo[] = []
        const registeredProviders = yield* extensionRegistry.listProviders()

        for (const provider of registeredProviders) {
          const storedInfo = yield* authStore
            .get(provider.id)
            .pipe(Effect.catchEager(() => Effect.void))
          const hasStored = storedInfo !== undefined
          const required = requiredSet.has(provider.id as ProviderId)

          if (hasStored) {
            providers.push({
              provider: provider.id as ProviderId,
              hasKey: true,
              source: "stored" as const,
              authType: storedInfo?.type as AuthType | undefined,
              required,
            })
            continue
          }
          providers.push({ provider: provider.id as ProviderId, hasKey: false, required })
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

  static Test = (providers: readonly AuthProviderInfo[] = []): Layer.Layer<AuthGuard> =>
    Layer.succeed(AuthGuard, {
      requiredProviders: () => Effect.succeed(REQUIRED_PROVIDERS),
      listProviders: () => Effect.succeed(providers),
      missingRequiredProviders: () =>
        Effect.succeed(providers.filter((p) => p.required && !p.hasKey).map((p) => p.provider)),
    })
}
