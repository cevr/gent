import { Context, Effect, Exit, Layer, Schema } from "effect"
import { AuthStore, AuthType } from "./auth-store"
import { ProviderId, parseModelProvider } from "./model"
import { AgentName, DriverRef, resolveAgentDriver, resolveAgentModel } from "./agent.js"
import { ExtensionRegistry } from "../runtime/extensions/registry.js"
import { DriverRegistry } from "../runtime/extensions/driver-registry.js"
import { SessionId } from "./ids.js"

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

/**
 * Public RPC payload for `auth.listProviders` — what callers send.
 *
 * Carries `sessionId` (so the server can resolve project config from
 * the session's cwd) and `agentName` (so external-routed agents skip
 * model auth). Notably does NOT include `driverOverrides`: those are
 * server-derived from config and never trusted from the wire.
 */
export const ListAuthProvidersPayload = Schema.Struct({
  agentName: Schema.optional(AgentName),
  /**
   * Session whose cwd should resolve project-level driverOverrides.
   * The RPC handler looks up the session via SessionStorage and threads
   * the resulting `driverOverrides` from `configService.get(cwd)`.
   *
   * Without this, a multi-cwd server's auth gate always reads launch-cwd
   * config — so a session whose project config routes `cowork` to an
   * external driver would still be UX-blocked by model auth from launch
   * cwd.
   */
  sessionId: Schema.optional(SessionId),
})
export type ListAuthProvidersPayload = typeof ListAuthProvidersPayload.Type

/**
 * Internal query passed from the RPC handler into AuthGuard. Adds
 * `driverOverrides` resolved server-side by the handler from
 * `configService.get(sessionCwd)`. Kept separate from the wire payload
 * so callers can't smuggle in an override that bypasses model auth.
 */
export const AuthProviderQuery = Schema.Struct({
  agentName: Schema.optional(AgentName),
  /**
   * Per-agent driver routing overrides (from `UserConfig.driverOverrides`).
   * When the resolved driver for `agentName` is external, model auth is
   * skipped — the external driver owns its own auth (e.g. Claude Code SDK
   * via OAuth keychain).
   *
   * Passed as a parameter (not yielded as a service) so AuthGuard.Live
   * does not gain a ConfigService dependency.
   */
  driverOverrides: Schema.optional(Schema.Record(Schema.String, DriverRef)),
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
  static Live: Layer.Layer<AuthGuard, never, AuthStore | ExtensionRegistry | DriverRegistry> =
    Layer.effect(
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
            const storedInfo = yield* authStore
              .get(provider.id)
              .pipe(Effect.catchEager(() => Effect.void))
            const hasStored = storedInfo !== undefined
            const required = requiredSet.has(ProviderId.of(provider.id))

            if (hasStored) {
              providers.push({
                provider: ProviderId.of(provider.id),
                hasKey: true,
                source: "stored" as const,
                authType: storedInfo?.type as AuthType | undefined,
                required,
              })
              continue
            }
            providers.push({ provider: ProviderId.of(provider.id), hasKey: false, required })
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
