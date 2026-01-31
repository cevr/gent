import { Config, Context, Effect, Layer, Option, Schema } from "effect"
import { AuthStorage } from "./auth-storage"
import { AgentModels } from "./agent"
import { ProviderId, PROVIDER_ENV_VARS, SUPPORTED_PROVIDERS, parseModelProvider } from "./model"

export const AuthSource = Schema.Literal("env", "stored")
export type AuthSource = typeof AuthSource.Type

export const AuthProviderInfo = Schema.Struct({
  provider: ProviderId,
  hasKey: Schema.Boolean,
  source: Schema.optional(AuthSource),
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

const getEnvKey = (provider: ProviderId): Effect.Effect<string | undefined> => {
  const envVar = PROVIDER_ENV_VARS[provider]
  if (envVar === undefined || envVar === "") return Effect.succeed(undefined)
  return Config.option(Config.string(envVar)).pipe(
    Effect.catchAll(() => Effect.succeed(Option.none())),
    Effect.map(Option.getOrUndefined),
  )
}

export class AuthGuard extends Context.Tag("@gent/core/src/auth-guard/AuthGuard")<
  AuthGuard,
  AuthGuardService
>() {
  static Live: Layer.Layer<AuthGuard, never, AuthStorage> = Layer.effect(
    AuthGuard,
    Effect.gen(function* () {
      const authStorage = yield* AuthStorage
      const requiredSet = new Set(REQUIRED_PROVIDERS)

      const listProviders = Effect.fn("AuthGuard.listProviders")(function* () {
        const storedKeys = yield* authStorage
          .list()
          .pipe(Effect.catchAll(() => Effect.succeed([] as readonly string[])))
        const storedSet = new Set(storedKeys)

        const providers: AuthProviderInfo[] = []
        for (const provider of SUPPORTED_PROVIDERS) {
          const envKey = yield* getEnvKey(provider.id)
          const hasEnv = envKey !== undefined && envKey !== ""
          const hasStored = storedSet.has(provider.id)
          const required = requiredSet.has(provider.id)

          if (hasEnv) {
            providers.push({
              provider: provider.id,
              hasKey: true,
              source: "env" as const,
              required,
            })
            continue
          }
          if (hasStored) {
            providers.push({
              provider: provider.id,
              hasKey: true,
              source: "stored" as const,
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
