import { Context, Effect, Layer, Schema } from "effect"
import { AuthType, type AuthStoreError } from "./auth-store"
import { ProviderId } from "./model"
import { AgentName, DriverRef } from "./agent.js"
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
   * Passed as a parameter (not yielded as a service) so AuthGuardLive
   * does not gain a ConfigService dependency.
   */
  driverOverrides: Schema.optional(Schema.Record(Schema.String, DriverRef)),
})
export type AuthProviderQuery = typeof AuthProviderQuery.Type

export interface AuthGuardService {
  readonly requiredProviders: (query?: AuthProviderQuery) => Effect.Effect<readonly ProviderId[]>
  readonly listProviders: (
    query?: AuthProviderQuery,
  ) => Effect.Effect<readonly AuthProviderInfo[], AuthStoreError>
  readonly missingRequiredProviders: (
    query?: AuthProviderQuery,
  ) => Effect.Effect<readonly ProviderId[], AuthStoreError>
}

export class AuthGuard extends Context.Service<AuthGuard, AuthGuardService>()(
  "@gent/core/src/domain/auth-guard/AuthGuard",
) {
  static Test = (providers: readonly AuthProviderInfo[] = []): Layer.Layer<AuthGuard> =>
    Layer.succeed(AuthGuard, {
      requiredProviders: () => Effect.succeed([]),
      listProviders: () => Effect.succeed(providers),
      missingRequiredProviders: () =>
        Effect.succeed(providers.filter((p) => p.required && !p.hasKey).map((p) => p.provider)),
    })
}
