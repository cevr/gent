import {
  Cause,
  Context,
  Duration,
  Effect,
  type FileSystem,
  Layer,
  Option,
  type Path,
  Predicate,
  Random,
  Schedule,
  Schema,
  type Scope,
} from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import {
  AgentName,
  byReleaseDateDesc,
  DriverRef,
  Model,
  ModelId,
  parseModelId,
  parseModelProvider,
  ProviderId,
  resolveAgentDriver,
  resolveAgentModel,
  resolveDefaultAgentModel,
} from "../domain/agent.js"
import { SessionId } from "../domain/ids.js"
import { ExtensionRegistry, listModelCatalog } from "./extension-host.js"
import { causeMessage } from "../domain/guards.js"
import {
  DEFAULT_RETRY_POLICY,
  type DriverError,
  type PersistAuth,
  ProviderAuthError,
  type ProviderAuthInfo,
  type ProviderHints,
  type RetryPolicy,
} from "../domain/driver.js"
import { GentPlatform } from "./gent-platform.js"
import { LanguageModel } from "effect/unstable/ai"
import { ProviderError } from "../domain/errors.js"
import * as AiError from "effect/unstable/ai/AiError"

// ── auth ────────────────────────────────────────────────────────────────────

/**
 * `domain/auth` — single module owning every auth concept gent uses.
 *
 * The auth method, the store, its persistence, and the guard all live here.
 * Persistence is delegated to `KeyValueStore.layerFileSystem(...)` +
 * `toSchemaStore`: the directory inherits whatever protection the user's home
 * directory already has, which matches how every other gent state file
 * (`~/.gent/data.db`, journals, etc.) is stored.
 *
 * Each provider's auth blob is one URL-encoded file under the configured
 * directory (default `~/.gent/auth/`). The schema is `Auth.Info`, a
 * tagged enum with `Api | Oauth` variants.
 */

// ── Driver-facing wire types ────────────────────────────────────────────

const AuthMethodType = Schema.Literals(["oauth", "api"])
type AuthMethodType = typeof AuthMethodType.Type

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
 * There is no "ambient auth owned by the driver" variant. Drivers that own
 * auth out-of-band (e.g. Claude Code SDK reading the OS keychain) bypass the
 * auth store entirely; add the variant when a caller needs a persisted
 * presence marker for one.
 */
export const AuthInfo = Schema.TaggedUnion({
  Api: {
    type: Schema.Literal("api"),
    key: Schema.String,
  },
  Oauth: {
    type: Schema.Literal("oauth"),
    access: Schema.String,
    refresh: Schema.String,
    expires: Schema.Finite,
    accountId: Schema.optional(Schema.String),
  },
})
export type AuthInfo = Schema.Schema.Type<typeof AuthInfo>

export const AuthApi = AuthInfo.cases.Api
export type AuthApi = typeof AuthInfo.cases.Api.Type
export const AuthOauth = AuthInfo.cases.Oauth
export type AuthOauth = typeof AuthInfo.cases.Oauth.Type

const AuthType = Schema.Literals(["api", "oauth"])
type AuthType = typeof AuthType.Type

// ── Auth-guard wire types ───────────────────────────────────────────────

const AuthSource = Schema.Literals(["none", "stored"])
type AuthSource = typeof AuthSource.Type

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
// Public RPC payload — the server re-derives `driverOverrides` from session-cwd
// config, so callers cannot smuggle in an override that bypasses model auth.
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
const AuthProviderQuery = Schema.Struct({
  agentName: Schema.optional(AgentName),
  driverOverrides: Schema.optional(Schema.Record(AgentName, DriverRef)),
})
type AuthProviderQuery = typeof AuthProviderQuery.Type

// ── Auth service ────────────────────────────────────────────────────────

export class AuthError extends Schema.TaggedError<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface AuthService {
  // oxlint-disable-next-line effect/noNullish -- Auth lookup uses undefined when a provider has no stored credentials.
  readonly get: (provider: string) => Effect.Effect<AuthInfo | undefined, AuthError>
  readonly set: (provider: string, info: AuthInfo) => Effect.Effect<void, AuthError>
  readonly remove: (provider: string) => Effect.Effect<void, AuthError>
}

export class Auth extends Context.Service<Auth, AuthService>()(
  "@gent/core/src/runtime/provider/Auth",
) {
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
          // oxlint-disable-next-line effect/noNullish -- Invalid stored credentials are discarded as an absent auth record.
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
            // oxlint-disable-next-line effect/noNullish -- Invalid stored credentials are discarded as an absent auth record.
            Effect.as(undefined),
          )

        return Auth.of({
          get: (provider) =>
            store.get(provider).pipe(
              Effect.map(Option.getOrUndefined),
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

interface AuthGuardService {
  readonly listProviders: (
    query?: AuthProviderQuery,
  ) => Effect.Effect<readonly AuthProviderInfo[], AuthError>
}

export class AuthGuard extends Context.Service<AuthGuard, AuthGuardService>()(
  "@gent/core/src/runtime/provider/AuthGuard",
) {
  // ↑ co-located with `Auth`; the deterministic-keys rule allows the
  //   secondary tag to keep `<file>/<ClassName>`.

  /**
   * Live `AuthGuard`. The guard's logic is inseparable from the auth model,
   * so it lives beside it.
   *
   * Composes auth info (`Auth.get`) with registry-derived metadata
   * (the resolved model drivers) and per-session routing
   * (`resolveDefaultAgentModel` + resolved extension agents) to compute
   * which providers are required *and* present. External-routed
   * agents (driver._tag === "External") own their own auth, so model
   * auth is short-circuited for them.
   */
  static Live: Layer.Layer<AuthGuard, never, Auth | ExtensionRegistry> = Layer.effect(
    AuthGuard,
    Effect.gen(function* () {
      const auth = yield* Auth
      const extensionRegistry = yield* ExtensionRegistry
      const registeredProviders = [...extensionRegistry.getResolved().modelDrivers.values()]
      const registeredIds = new Set(registeredProviders.map((p) => p.id))

      const requiredProviders = (query: AuthProviderQuery = {}): ProviderId[] => {
        const agents = [...extensionRegistry.getResolved().agents.values()]
        const providers: ProviderId[] = []
        const seen = new Set<string>()
        const modelIds: ModelId[] = Option.toArray(resolveDefaultAgentModel(agents))

        if (!Predicate.isUndefined(query.agentName)) {
          const selectedAgent = agents.find((agent) => agent.name === query.agentName)
          if (!Predicate.isUndefined(selectedAgent)) {
            const resolved = resolveAgentDriver(selectedAgent, query.driverOverrides)
            if (resolved.driver?._tag === "External") {
              return providers
            }
            if (!Predicate.isUndefined(selectedAgent.model)) {
              modelIds.push(resolveAgentModel(selectedAgent))
            }
          }
        }

        for (const modelId of modelIds) {
          const provider = parseModelProvider(modelId)
          if (
            Option.isSome(provider) &&
            registeredIds.has(provider.value) &&
            !seen.has(provider.value)
          ) {
            providers.push(provider.value)
            seen.add(provider.value)
          }
        }

        return providers
      }

      const listProviders = Effect.fn("AuthGuard.listProviders")(function* (
        query: AuthProviderQuery = {},
      ) {
        const requiredSet = new Set(requiredProviders(query))
        const providers: AuthProviderInfo[] = []

        for (const provider of registeredProviders) {
          const storedInfo = yield* auth.get(provider.id)
          const required = requiredSet.has(ProviderId.make(provider.id))

          if (!Predicate.isUndefined(storedInfo)) {
            providers.push({
              provider: ProviderId.make(provider.id),
              hasKey: true,
              source: "stored",
              authType: storedInfo.type,
              required,
            })
            continue
          }
          providers.push({ provider: ProviderId.make(provider.id), hasKey: false, required })
        }

        return providers
      })

      return AuthGuard.of({ listProviders })
    }),
  )
}

// ── provider-auth ───────────────────────────────────────────────────────────

const authValue = (auth: Parameters<PersistAuth>[0]): AuthApi | AuthOauth => {
  if (auth.type === "api") return AuthApi.make({ type: "api", key: auth.key })
  return AuthOauth.make({
    type: "oauth",
    access: auth.access,
    refresh: auth.refresh,
    expires: auth.expires,
    accountId: auth.accountId,
  })
}

/** Build a PersistAuth callback for a provider — writes credentials to Auth. */
const persistAuthTo =
  (authStore: AuthService, providerId: string): PersistAuth =>
  (auth) =>
    authStore.set(providerId, authValue(auth)).pipe(
      Effect.mapError(
        (e) =>
          new ProviderAuthError({
            message: `Failed to persist auth for provider "${providerId}"`,
            cause: e,
          }),
      ),
    )

interface ProviderAuthService {
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
  Auth | ExtensionRegistry | GentPlatform
> = Effect.gen(function* () {
  const { modelDrivers } = (yield* ExtensionRegistry).getResolved()
  const authStore = yield* Auth
  const platform = yield* GentPlatform

  const makePersist = (providerId: string) => persistAuthTo(authStore, providerId)

  const listMethods = Effect.sync(() => {
    const result: Record<string, ReadonlyArray<AuthMethod>> = {}
    for (const provider of modelDrivers.values()) {
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
    const extProvider = modelDrivers.get(provider)
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
              message: `Provider auth failed: ${causeMessage(e)}`,
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
    const extProvider = modelDrivers.get(provider)
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
              message: `Provider auth callback failed: ${causeMessage(e)}`,
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
  "@gent/core/src/runtime/provider/ProviderAuth",
) {
  static Live: Layer.Layer<ProviderAuth, never, Auth | ExtensionRegistry | GentPlatform> =
    Layer.effect(ProviderAuth, makeProviderAuth)
}

// ── model-resolver ──────────────────────────────────────────────────────────

export interface ResolveModelRequest {
  readonly modelId: ModelId | string
  readonly agentName?: AgentName
  readonly hints?: ProviderHints
  /** Per-agent model driver override from `agent.driver`. */
  readonly driverId?: string
}

export const CurrentResolveModelAssertion = Context.Reference<
  // oxlint-disable-next-line effect/noNullish -- The optional assertion is test-only instrumentation at this service boundary.
  ((request: ResolveModelRequest) => Effect.Effect<void, ProviderError>) | undefined
>("@gent/core/src/runtime/provider/CurrentResolveModelAssertion", {
  // oxlint-disable-next-line effect/noNullish -- The optional assertion is test-only instrumentation.
  defaultValue: () => undefined,
})

interface ModelResolverService {
  readonly resolve: (
    request: ResolveModelRequest,
  ) => Effect.Effect<
    LanguageModel.Service,
    ProviderError | ProviderAuthError,
    Scope.Scope | ExtensionRegistry
  >
}

const resolveModelDefect = (
  // oxlint-disable-next-line effect/noUnknownParameters -- Provider factories can defect with any thrown value.
  defect: unknown,
  providerName: string,
  modelId: ModelId | string,
): ProviderError | ProviderAuthError => {
  if (Schema.is(ProviderAuthError)(defect)) return defect
  const detail = causeMessage(defect)
  return new ProviderError({
    message: `Extension provider "${providerName}" failed: ${detail}`,
    model: modelId,
    cause: defect,
  })
}

const resolveProviderModel = Effect.fn("ModelResolver.resolveProviderModel")(function* (
  request: ResolveModelRequest,
) {
  const parsed = parseModelId(request.modelId)
  if (Option.isNone(parsed)) {
    return yield* new ProviderError({
      message: "Invalid model id (expected provider/model)",
      model: request.modelId,
    })
  }
  const [parsedProviderName, modelName] = parsed.value
  // The loop passes the effective driver id; a bare request routes by the provider segment.
  const providerName: string = Option.getOrElse(
    Option.fromUndefinedOr(request.driverId),
    () => parsedProviderName,
  )
  const authStore = yield* Auth
  // The registry of the running turn's profile: its cwd-scoped drivers resolve here.
  const extensionRegistry = yield* ExtensionRegistry
  const extensionProvider = extensionRegistry.getResolved().modelDrivers.get(providerName)
  if (Predicate.isUndefined(extensionProvider)) {
    return yield* new ProviderError({
      message: `Unknown provider: ${providerName}`,
      model: request.modelId,
    })
  }

  const authInfo = yield* authStore.get(providerName).pipe(
    Effect.mapError(
      (e) =>
        new ProviderError({
          message: `Failed to read auth for provider "${providerName}"`,
          model: request.modelId,
          cause: e,
        }),
    ),
    Effect.map(Option.fromUndefinedOr),
  )
  let authParam: Option.Option<ProviderAuthInfo> = Option.none()
  if (Option.isSome(authInfo) && authInfo.value.type === "api") {
    authParam = Option.some({ type: "api", key: authInfo.value.key })
  } else if (Option.isSome(authInfo) && authInfo.value.type === "oauth") {
    authParam = Option.some<ProviderAuthInfo>({
      type: "oauth",
      access: authInfo.value.access,
      refresh: authInfo.value.refresh,
      expires: authInfo.value.expires,
      accountId: authInfo.value.accountId,
      persist: (updated) => persistAuthTo(authStore, providerName)({ type: "oauth", ...updated }),
    })
  }

  return yield* Effect.suspend(() =>
    extensionProvider.resolveModel(modelName, Option.getOrUndefined(authParam), request.hints),
  ).pipe(
    Effect.catchDefect((defect) =>
      Effect.fail(resolveModelDefect(defect, providerName, request.modelId)),
    ),
  )
})

export class ModelResolver extends Context.Service<ModelResolver, ModelResolverService>()(
  "@gent/core/src/runtime/provider/ModelResolver",
) {
  static fromLanguageModel = (
    layer: Layer.Layer<LanguageModel.LanguageModel>,
  ): Layer.Layer<ModelResolver> =>
    Layer.effect(
      ModelResolver,
      Effect.gen(function* () {
        const model = yield* LanguageModel.LanguageModel
        const assertRequest = yield* CurrentResolveModelAssertion
        return ModelResolver.of({
          resolve: (request) =>
            Effect.gen(function* () {
              if (!Predicate.isUndefined(assertRequest)) yield* assertRequest(request)
              return model
            }),
        })
      }),
    ).pipe(Layer.provide(layer))

  static Live: Layer.Layer<ModelResolver, never, Auth> = Layer.effect(
    ModelResolver,
    Effect.gen(function* () {
      const auth = yield* Auth
      return ModelResolver.of({
        resolve: (request) =>
          Effect.gen(function* () {
            const resolved = yield* resolveProviderModel(request)
            const scope = yield* Effect.scope
            const built = yield* Layer.buildWithScope(resolved, scope)
            return Context.get(built, LanguageModel.LanguageModel)
          }).pipe(Effect.provideService(Auth, auth)),
      })
    }),
  )
}

// ── model-registry ──────────────────────────────────────────────────────────

/**
 * Explicit capability used by the deterministic registry test layer. It is
 * not a production model fallback and is never used by `ModelRegistry.Live`.
 */
export const TEST_MODEL_CONTEXT_LIMIT_TOKENS = 128_000

interface ModelRegistryService {
  readonly list: Effect.Effect<readonly Model[], DriverError | ProviderAuthError>
  readonly get: (
    modelId: string,
  ) => Effect.Effect<Option.Option<Model>, DriverError | ProviderAuthError>
}

export class ModelRegistry extends Context.Service<ModelRegistry, ModelRegistryService>()(
  "@gent/core/src/runtime/provider/ModelRegistry",
) {
  static Live: Layer.Layer<ModelRegistry, never, ExtensionRegistry | Auth> = Layer.effect(
    ModelRegistry,
    Effect.gen(function* () {
      const { modelDrivers } = (yield* ExtensionRegistry).getResolved()
      const authStore = yield* Auth

      const resolveAuthOption = (
        providerId: string,
      ): Effect.Effect<Option.Option<ProviderAuthInfo>, ProviderAuthError> =>
        authStore.get(providerId).pipe(
          Effect.map(Option.fromUndefinedOr),
          Effect.map(
            Option.map((info): ProviderAuthInfo => {
              if (info.type === "api") return { type: "api", key: info.key }
              return {
                type: "oauth",
                access: info.access,
                refresh: info.refresh,
                expires: info.expires,
                accountId: info.accountId,
              }
            }),
          ),
          Effect.mapError(
            (e) =>
              new ProviderAuthError({
                message: `Failed to read auth for provider "${providerId}"`,
                cause: e,
              }),
          ),
        )

      /** Every driver's own catalog, newest release first. Core fetches nothing. */
      const load = Effect.fn("ModelRegistry.load")(function* () {
        const catalog = yield* listModelCatalog(modelDrivers, (providerId) =>
          resolveAuthOption(providerId).pipe(Effect.map(Option.getOrUndefined)),
        )
        return byReleaseDateDesc(catalog)
      })

      return ModelRegistry.of({
        list: load(),
        get: (modelId) =>
          load().pipe(
            Effect.map((models) =>
              Option.fromUndefinedOr(models.find((model) => model.id === modelId)),
            ),
          ),
      })
    }),
  )

  static Test = (models: readonly Model[] = []): Layer.Layer<ModelRegistry> =>
    Layer.succeed(
      ModelRegistry,
      ModelRegistry.of({
        list: Effect.succeed(models),
        get: (modelId) => {
          const existing = Option.fromUndefinedOr(models.find((model) => model.id === modelId))
          if (Option.isSome(existing)) return Effect.succeedSome(existing.value)
          if (models.length > 0) return Effect.succeedNone
          const provider = Option.getOrElse(parseModelProvider(modelId), () =>
            ProviderId.make("test"),
          )
          return Effect.succeedSome(
            Model.make({
              id: ModelId.make(modelId),
              name: modelId,
              provider,
              contextLength: TEST_MODEL_CONTEXT_LIMIT_TOKENS,
            }),
          )
        },
      }),
    )
}

// ── retry ───────────────────────────────────────────────────────────────────

/**
 * The policy of the driver a turn will call, by its effective driver id
 * (`effectiveModelDriver` in `domain/agent.ts`). A driver without a policy,
 * or no driver at all, retries under `DEFAULT_RETRY_POLICY`.
 */
export const driverRetryPolicy = Effect.fn("Retry.driverRetryPolicy")(function* (
  driverId: Option.Option<string>,
) {
  if (Option.isNone(driverId)) return DEFAULT_RETRY_POLICY
  const driver = (yield* ExtensionRegistry).getResolved().modelDrivers.get(driverId.value)
  if (Predicate.isUndefined(driver) || Predicate.isUndefined(driver.retry)) {
    return DEFAULT_RETRY_POLICY
  }
  return driver.retry
})

type ProviderOrAuthError = ProviderError | ProviderAuthError

/**
 * Only a transient `ProviderError` is retried; a credential failure escapes.
 * A request the provider accepted can still end with an error event inside
 * the stream; the driver's policy names the wire shapes that count.
 */
const isRetryable =
  (policy: RetryPolicy) =>
  (error: ProviderOrAuthError): error is ProviderError => {
    if (!Schema.is(ProviderError)(error)) return false
    if (AiError.isAiError(error.cause)) return error.cause.isRetryable
    return Schema.is(policy.transientStreamEvent)(error.cause)
  }

const retryAfterMs = (error: ProviderError): Option.Option<number> => {
  if (!AiError.isAiError(error.cause)) return Option.none()
  return Option.map(Option.fromUndefinedOr(error.cause.retryAfter), Duration.toMillis)
}

/** Upper bound of the random spread added to a backoff delay, as a fraction of it. */
const JITTER_FRACTION = 0.25

/** `attempt` counts completed failures; `jitter` is a uniform sample in [0, 1). */
const retryDelay = (
  attempt: number,
  error: ProviderError,
  config: RetryPolicy,
  jitter: number,
): number =>
  Option.match(retryAfterMs(error), {
    onSome: (ms) => Math.min(ms, config.maxDelay),
    onNone: () => {
      const base = config.initialDelay * config.backoffFactor ** attempt
      return Math.min(Math.round(base * (1 + JITTER_FRACTION * jitter)), config.maxDelay)
    },
  })

interface RetryAttemptInfo {
  readonly attempt: number
  readonly maxAttempts: number
  readonly delayMs: number
  readonly error: ProviderError
}

/**
 * Retry a provider call on transient failure under the driver's policy. The
 * provider's own retry-after wins over the backoff; both are capped at
 * `maxDelay`. `onRetry` runs before each wait with the delay the schedule
 * will take.
 */
export const retryProviderCall =
  <R2 = never>(
    config: RetryPolicy,
    options?: {
      readonly onRetry?: (info: RetryAttemptInfo) => Effect.Effect<void, never, R2>
    },
  ): (<A, R>(
    effect: Effect.Effect<A, ProviderOrAuthError, R>,
  ) => Effect.Effect<A, ProviderOrAuthError, R | R2>) =>
  <A, R>(effect: Effect.Effect<A, ProviderOrAuthError, R>) => {
    const retryable = isRetryable(config)
    // meta.attempt is 1-indexed: 1 after the first failure, 2 after the second.
    const schedule = Schedule.fromStepWithMetadata<
      ProviderOrAuthError,
      number,
      R2,
      never,
      never,
      never
    >(
      Effect.succeed((meta: Schedule.InputMetadata<ProviderOrAuthError>) => {
        if (meta.attempt >= config.maxAttempts || !retryable(meta.input)) {
          return Cause.done(meta.attempt)
        }
        const error = meta.input
        return Effect.gen(function* () {
          const jitter = yield* Random.next
          const delayMs = retryDelay(meta.attempt - 1, error, config, jitter)
          if (!Predicate.isUndefined(options?.onRetry)) {
            yield* options.onRetry({
              attempt: meta.attempt,
              maxAttempts: config.maxAttempts,
              delayMs,
              error,
            })
          }
          return [meta.attempt, Duration.millis(delayMs)] satisfies [number, Duration.Duration]
        })
      }),
    )

    return Effect.retry(effect, { schedule, while: retryable }).pipe(
      Effect.withSpan("provider.retry"),
    )
  }
