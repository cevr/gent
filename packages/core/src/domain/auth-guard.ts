import { Context, Effect, Exit, Layer, Schema } from "effect"
import { AuthStore, AuthType } from "./auth-store"
import { ProviderId, parseModelProvider } from "./model"
import { AgentName, resolveAgentModel } from "./agent.js"
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

export const AuthProviderQuery = Schema.Struct({
  agentName: Schema.optional(AgentName),
})
export type AuthProviderQuery = typeof AuthProviderQuery.Type

export interface AuthGuardService {
  readonly requiredProviders: (query?: AuthProviderQuery) => Effect.Effect<readonly ProviderId[]>
  readonly listProviders: (query?: AuthProviderQuery) => Effect.Effect<readonly AuthProviderInfo[]>
  readonly missingRequiredProviders: (
    query?: AuthProviderQuery,
  ) => Effect.Effect<readonly ProviderId[]>
}

export class AuthGuard extends Context.Service<AuthGuard, AuthGuardService>()(
  "@gent/core/src/domain/auth-guard/AuthGuard",
) {
  static Live: Layer.Layer<AuthGuard, never, AuthStore | ExtensionRegistry> = Layer.effect(
    AuthGuard,
    Effect.gen(function* () {
      const authStore = yield* AuthStore
      const extensionRegistry = yield* ExtensionRegistry

      const registeredProviders = yield* extensionRegistry.listProviders()
      const registeredIds = new Set(registeredProviders.map((p) => p.id))

      const requiredProviders = Effect.fn("AuthGuard.requiredProviders")(function* (
        query: AuthProviderQuery = {},
      ) {
        const modelPairExit = yield* Effect.exit(extensionRegistry.resolveDualModelPair())
        const providers: ProviderId[] = []
        const seen = new Set<string>()
        const modelIds = Exit.isSuccess(modelPairExit) ? [...modelPairExit.value] : []

        if (query.agentName !== undefined) {
          const selectedAgent = yield* extensionRegistry.getAgent(query.agentName)
          if (selectedAgent?.model !== undefined) {
            modelIds.push(resolveAgentModel(selectedAgent))
          }
        }

        for (const modelId of modelIds) {
          const provider = parseModelProvider(modelId)
          if (provider !== undefined && registeredIds.has(provider) && !seen.has(provider)) {
            providers.push(provider)
            seen.add(provider)
          }
        }

        return providers
      })

      const listProvidersWithQuery = Effect.fn("AuthGuard.listProviders")(function* (
        query: AuthProviderQuery = {},
      ) {
        const requiredSet = new Set(yield* requiredProviders(query))
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

      const missingRequiredProviders = Effect.fn("AuthGuard.missingRequiredProviders")(function* (
        query: AuthProviderQuery = {},
      ) {
        const providers = yield* listProvidersWithQuery(query)
        return providers.filter((p) => p.required && !p.hasKey).map((p) => p.provider)
      })

      return AuthGuard.of({
        requiredProviders,
        listProviders: listProvidersWithQuery,
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
