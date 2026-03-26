import { ServiceMap, Effect, Layer, Schema } from "effect"
import { AuthStore, AuthType } from "./auth-store"
import { resolveAgentModel } from "./agent"
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

export class AuthGuard extends ServiceMap.Service<AuthGuard, AuthGuardService>()(
  "@gent/core/src/domain/auth-guard/AuthGuard",
) {
  static Live: Layer.Layer<AuthGuard, never, AuthStore | ExtensionRegistry> = Layer.effect(
    AuthGuard,
    Effect.gen(function* () {
      const authStore = yield* AuthStore
      const extensionRegistry = yield* ExtensionRegistry

      // Derive required providers from all primary agents' model prefixes,
      // intersected with registered provider IDs (supports extension-contributed agents)
      const agents = yield* extensionRegistry.listPrimaryAgents()
      const registeredProviders = yield* extensionRegistry.listProviders()
      const registeredIds = new Set(registeredProviders.map((p) => p.id))
      const requiredProviders: ProviderId[] = []
      const seen = new Set<string>()
      for (const agent of agents) {
        const modelId = resolveAgentModel(agent)
        const provider = parseModelProvider(modelId)
        if (provider !== undefined && registeredIds.has(provider) && !seen.has(provider)) {
          requiredProviders.push(provider)
          seen.add(provider)
        }
      }
      const requiredSet = new Set(requiredProviders)

      const listProviders = Effect.fn("AuthGuard.listProviders")(function* () {
        const providers: AuthProviderInfo[] = []

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
        requiredProviders: () => Effect.succeed(requiredProviders),
        listProviders,
        missingRequiredProviders,
      })
    }),
  )

  static Test = (providers: readonly AuthProviderInfo[] = []): Layer.Layer<AuthGuard> =>
    Layer.succeed(AuthGuard, {
      requiredProviders: () => Effect.succeed([]),
      listProviders: () => Effect.succeed(providers),
      missingRequiredProviders: () =>
        Effect.succeed(providers.filter((p) => p.required && !p.hasKey).map((p) => p.provider)),
    })
}
