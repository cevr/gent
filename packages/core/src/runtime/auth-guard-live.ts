import { Effect, Exit, Layer } from "effect"
import { AuthGuard, type AuthProviderInfo, type AuthProviderQuery } from "../domain/auth-guard.js"
import { AuthStore, type AuthType } from "../domain/auth-store.js"
import { ProviderId, parseModelProvider } from "../domain/model.js"
import { resolveAgentDriver, resolveAgentModel } from "../domain/agent.js"
import { ExtensionRegistry } from "./extensions/registry.js"
import { DriverRegistry } from "./extensions/driver-registry.js"

export const AuthGuardLive: Layer.Layer<
  AuthGuard,
  never,
  AuthStore | ExtensionRegistry | DriverRegistry
> = Layer.effect(
  AuthGuard,
  Effect.gen(function* () {
    const authStore = yield* AuthStore
    const extensionRegistry = yield* ExtensionRegistry
    const driverRegistry = yield* DriverRegistry

    const registeredProviders = yield* driverRegistry.listModels()
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
        if (selectedAgent !== undefined) {
          // External-routed agents (ACP, etc.) own their own auth; model
          // auth is irrelevant. Short-circuit so the missing-keys check
          // doesn't ask for, e.g., an OpenAI key when `cowork` is
          // routed through Claude Code via config.
          const resolved = resolveAgentDriver(selectedAgent, query.driverOverrides)
          if (resolved.driver?._tag === "external") {
            return providers
          }
          if (selectedAgent.model !== undefined) {
            modelIds.push(resolveAgentModel(selectedAgent))
          }
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
        const storedInfo = yield* authStore.get(provider.id)
        const hasStored = storedInfo !== undefined
        const required = requiredSet.has(ProviderId.make(provider.id))

        if (hasStored) {
          providers.push({
            provider: ProviderId.make(provider.id),
            hasKey: true,
            source: "stored" as const,
            authType: storedInfo?.type as AuthType | undefined,
            required,
          })
          continue
        }
        providers.push({ provider: ProviderId.make(provider.id), hasKey: false, required })
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
