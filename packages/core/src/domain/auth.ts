/**
 * `domain/auth` — single module owning every auth concept gent uses.
 *
 * Collapses the prior four-file split (`auth-method`, `auth-store`,
 * `auth-storage`, `auth-guard`) plus the runtime `auth-guard-live` into
 * one place. Persistence is delegated to
 * `KeyValueStore.layerFileSystem(...)` + `toSchemaStore`; the previous
 * hand-rolled "encrypted file vs. macOS keychain" split is gone — the
 * directory inherits whatever protection the user's home directory
 * already has, which matches how every other gent state file
 * (`~/.gent/data.db`, journals, etc.) is stored.
 *
 * Each provider's auth blob is one URL-encoded file under the configured
 * directory (default `~/.gent/auth/`). The schema is `Auth.Info`, a
 * tagged enum with `Api | Oauth` variants.
 *
 * Breaking change at C2: any existing `~/.gent/auth.json[.enc]` content
 * is unreadable by this module. Users re-authenticate on next launch.
 */

import { Context, Effect, Exit, Layer, Option, Schema } from "effect"
import type { FileSystem, Path } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import { TaggedEnumClass } from "./schema-tagged-enum-class.js"
import { ProviderId, parseModelProvider } from "./model.js"
import { AgentName, DriverRef, resolveAgentDriver, resolveAgentModel } from "./agent.js"
import { resolveDualModelPair } from "./agent-pair.js"
import { SessionId } from "./ids.js"
import { ExtensionRegistry } from "../runtime/extensions/registry.js"
import { DriverRegistry } from "../runtime/extensions/driver-registry.js"

// ── Driver-facing wire types ────────────────────────────────────────────

export const AuthMethodType = Schema.Literals(["oauth", "api"])
export type AuthMethodType = typeof AuthMethodType.Type

export class AuthMethod extends Schema.Class<AuthMethod>("AuthMethod")({
  type: AuthMethodType,
  label: Schema.String,
}) {}

export const AuthAuthorizationMethod = Schema.Literals(["auto", "code", "done"])
export type AuthAuthorizationMethod = typeof AuthAuthorizationMethod.Type

export class AuthAuthorization extends Schema.Class<AuthAuthorization>("AuthAuthorization")({
  authorizationId: Schema.String,
  url: Schema.String,
  method: AuthAuthorizationMethod,
  instructions: Schema.optional(Schema.String),
}) {}

// ── Stored auth payload ─────────────────────────────────────────────────

/**
 * `Auth.Info` — variants persisted in the store.
 *
 * - `Api`   — bearer/API key; presented to the model driver as `key`.
 * - `Oauth` — refreshable bearer token + expiry; driver may rotate.
 *
 * A third "ambient auth owned by the driver" variant was specced
 * during the C2 collapse but has no caller wiring yet, so it isn't
 * carried as a parallel API. Drivers that own auth out-of-band (e.g.
 * Claude Code SDK reading the OS keychain) currently bypass the auth
 * store entirely; if a future caller needs a persisted presence
 * marker, add it back to this enum at that point.
 */
export const AuthInfo = TaggedEnumClass("AuthInfo", {
  Api: {
    type: Schema.Literal("api"),
    key: Schema.String,
  },
  Oauth: {
    type: Schema.Literal("oauth"),
    access: Schema.String,
    refresh: Schema.String,
    expires: Schema.Number,
    accountId: Schema.optional(Schema.String),
  },
})
export type AuthInfo = Schema.Schema.Type<typeof AuthInfo>

export const AuthApi = AuthInfo.Api
export type AuthApi = typeof AuthInfo.Api.Type
export const AuthOauth = AuthInfo.Oauth
export type AuthOauth = typeof AuthInfo.Oauth.Type

export const AuthType = Schema.Literals(["api", "oauth"])
export type AuthType = typeof AuthType.Type

// ── Auth-guard wire types ───────────────────────────────────────────────

export const AuthSource = Schema.Literals(["none", "stored"])
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
 * Public RPC payload for `auth.listProviders`. Carries `sessionId` (for
 * cwd-scoped config resolution) and `agentName` (so external-routed
 * agents skip model auth). Excludes `driverOverrides`: those are
 * server-derived from config and never trusted from the wire.
 */
export const ListAuthProvidersPayload = Schema.Struct({
  agentName: Schema.optional(AgentName),
  sessionId: Schema.optional(SessionId),
})
export type ListAuthProvidersPayload = typeof ListAuthProvidersPayload.Type

/**
 * Internal query passed from the RPC handler into `AuthGuard`. Adds
 * server-side resolved `driverOverrides`. Kept separate from the wire
 * payload so callers can't smuggle in an override that bypasses model
 * auth.
 */
export const AuthProviderQuery = Schema.Struct({
  agentName: Schema.optional(AgentName),
  driverOverrides: Schema.optional(Schema.Record(AgentName, DriverRef)),
})
export type AuthProviderQuery = typeof AuthProviderQuery.Type

// ── Auth service ────────────────────────────────────────────────────────

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface AuthService {
  readonly get: (provider: string) => Effect.Effect<AuthInfo | undefined, AuthError>
  readonly set: (provider: string, info: AuthInfo) => Effect.Effect<void, AuthError>
  readonly remove: (provider: string) => Effect.Effect<void, AuthError>
}

export class Auth extends Context.Service<Auth, AuthService>()("@gent/core/src/domain/auth") {
  /**
   * File-system-backed live layer. One file per provider (URL-encoded
   * key) under `directory`. Stale or corrupt entries are discarded and
   * logged so a single broken file can't brick startup.
   */
  static Live = (directory: string): Layer.Layer<Auth, never, FileSystem.FileSystem | Path.Path> =>
    Layer.effect(
      Auth,
      Effect.gen(function* () {
        const kv = yield* KeyValueStore.KeyValueStore
        const store = KeyValueStore.toSchemaStore(kv, AuthInfo)

        const wrap = (message: string) => (cause: unknown) => new AuthError({ message, cause })

        const discardInvalid = (
          provider: string,
          cause: unknown,
        ): Effect.Effect<AuthInfo | undefined> =>
          Effect.logWarning("discarded invalid auth info").pipe(
            Effect.annotateLogs({ provider, cause: String(cause) }),
            Effect.andThen(
              kv
                .remove(provider)
                .pipe(
                  Effect.catch((deleteCause: KeyValueStore.KeyValueStoreError) =>
                    Effect.logWarning("failed to discard invalid auth info").pipe(
                      Effect.annotateLogs({ provider, deleteCause: String(deleteCause) }),
                    ),
                  ),
                ),
            ),
            Effect.as(undefined as AuthInfo | undefined),
          )

        return Auth.of({
          get: (provider) =>
            store.get(provider).pipe(
              Effect.map((opt) => (Option.isSome(opt) ? opt.value : undefined)),
              Effect.catchTag("SchemaError", (e) => discardInvalid(provider, e)),
              Effect.mapError(wrap("Failed to read auth info")),
            ),
          set: (provider, info) =>
            store.set(provider, info).pipe(Effect.mapError(wrap("Failed to persist auth info"))),
          remove: (provider) =>
            kv.remove(provider).pipe(Effect.mapError(wrap("Failed to remove auth info"))),
        })
      }),
    ).pipe(Layer.provide(Layer.orDie(KeyValueStore.layerFileSystem(directory))))

  /**
   * In-memory test layer. Optionally seeded with a starting record.
   */
  static Test = (initial: Record<string, AuthInfo> = {}): Layer.Layer<Auth> =>
    Layer.sync(Auth)(() => {
      const map = new Map(Object.entries(initial))
      return Auth.of({
        get: (provider) => Effect.succeed(map.get(provider)),
        set: (provider, info) =>
          Effect.sync(() => {
            map.set(provider, info)
          }),
        remove: (provider) =>
          Effect.sync(() => {
            map.delete(provider)
          }),
      })
    })
}

// ── Auth guard ──────────────────────────────────────────────────────────

export interface AuthGuardService {
  readonly requiredProviders: (query?: AuthProviderQuery) => Effect.Effect<readonly ProviderId[]>
  readonly listProviders: (
    query?: AuthProviderQuery,
  ) => Effect.Effect<readonly AuthProviderInfo[], AuthError>
  readonly missingRequiredProviders: (
    query?: AuthProviderQuery,
  ) => Effect.Effect<readonly ProviderId[], AuthError>
}

export class AuthGuard extends Context.Service<AuthGuard, AuthGuardService>()(
  "@gent/core/src/domain/auth/AuthGuard",
) {
  // ↑ co-located with `Auth`; the deterministic-keys rule allows the
  //   secondary tag to keep `<file>/<ClassName>`.
  static Test = (providers: readonly AuthProviderInfo[] = []): Layer.Layer<AuthGuard> =>
    Layer.succeed(AuthGuard, {
      requiredProviders: () => Effect.succeed([]),
      listProviders: () => Effect.succeed(providers),
      missingRequiredProviders: () =>
        Effect.succeed(providers.filter((p) => p.required && !p.hasKey).map((p) => p.provider)),
    })

  /**
   * Live `AuthGuard`. The guard's logic is inseparable from the auth
   * model — a separate `auth-guard-live.ts` was redundant.
   *
   * Composes auth info (`Auth.get`) with registry-derived metadata
   * (`DriverRegistry.listModels`) and per-session routing
   * (`ExtensionRegistry.resolveDualModelPair` + `listAgents`) to compute
   * which providers are required *and* present. External-routed
   * agents (driver._tag === "external") own their own auth, so model
   * auth is short-circuited for them.
   */
  static Live: Layer.Layer<AuthGuard, never, Auth | ExtensionRegistry | DriverRegistry> =
    Layer.effect(
      AuthGuard,
      Effect.gen(function* () {
        const auth = yield* Auth
        const extensionRegistry = yield* ExtensionRegistry
        const driverRegistry = yield* DriverRegistry

        const registeredProviders = yield* driverRegistry.listModels()
        const registeredIds = new Set(registeredProviders.map((p) => p.id))

        const requiredProviders = Effect.fn("AuthGuard.requiredProviders")(function* (
          query: AuthProviderQuery = {},
        ) {
          const agents = yield* extensionRegistry.listAgents()
          const modelPairExit = yield* Effect.exit(resolveDualModelPair(agents))
          const providers: ProviderId[] = []
          const seen = new Set<string>()
          const modelIds = Exit.isSuccess(modelPairExit) ? [...modelPairExit.value] : []

          if (query.agentName !== undefined) {
            const selectedAgent = agents.find((agent) => agent.name === query.agentName)
            if (selectedAgent !== undefined) {
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

        const listProviders = Effect.fn("AuthGuard.listProviders")(function* (
          query: AuthProviderQuery = {},
        ) {
          const requiredSet = new Set(yield* requiredProviders(query))
          const providers: AuthProviderInfo[] = []

          for (const provider of registeredProviders) {
            const storedInfo = yield* auth.get(provider.id)
            const required = requiredSet.has(ProviderId.make(provider.id))

            if (storedInfo !== undefined) {
              providers.push({
                provider: ProviderId.make(provider.id),
                hasKey: true,
                source: "stored" as const,
                authType: storedInfo.type as AuthType,
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
          const providers = yield* listProviders(query)
          return providers.filter((p) => p.required && !p.hasKey).map((p) => p.provider)
        })

        return AuthGuard.of({
          requiredProviders,
          listProviders,
          missingRequiredProviders,
        })
      }),
    )
}
