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
  Stream,
} from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import {
  AgentName,
  byReleaseDateDesc,
  Model,
  ModelId,
  parseModelId,
  parseModelProvider,
  ProviderId,
  resolveAgentModel,
  resolveDefaultAgentModel,
} from "../domain/agent.js"
import { SessionId, ToolCallId } from "../domain/ids.js"
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
import type { ProviderOptions } from "effect/unstable/ai/LanguageModel"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as Response from "effect/unstable/ai/Response"
import type * as AiTool from "effect/unstable/ai/Tool"
import type * as AiToolkit from "effect/unstable/ai/Toolkit"

// ── auth ────────────────────────────────────────────────────────────────────

/**
 * Every auth concept gent uses: the auth method, the store, its persistence,
 * and the guard.
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
 * Public RPC payload for `auth.listProviders`. `agentName` adds that agent's
 * model to the providers that need auth; an unknown `sessionId` fails.
 */
export const ListAuthProvidersPayload = Schema.Struct({
  agentName: Schema.optional(AgentName),
  sessionId: Schema.optional(SessionId),
})
export type ListAuthProvidersPayload = typeof ListAuthProvidersPayload.Type

/** Internal query passed from the RPC handler into `AuthGuard`. */
const AuthProviderQuery = Schema.Struct({
  agentName: Schema.optional(AgentName),
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
   * which providers are required *and* present.
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

/**
 * A stored credential as a driver sees it. An OAuth credential carries a
 * `persist` that writes a refreshed token back to the store.
 */
const toProviderAuthInfo = (
  authStore: AuthService,
  providerId: string,
  info: AuthInfo,
): ProviderAuthInfo => {
  if (info.type === "api") return { type: "api", key: info.key }
  return {
    type: "oauth",
    access: info.access,
    refresh: info.refresh,
    expires: info.expires,
    accountId: info.accountId,
    persist: (updated) => persistAuthTo(authStore, providerId)({ type: "oauth", ...updated }),
  }
}

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
  const authParam = Option.map(authInfo, (info) =>
    toProviderAuthInfo(authStore, providerName, info),
  )

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

/**
 * Every model the caller's profile can run, newest release first: each model
 * driver's own catalog, read with the auth stored for that driver. Core
 * fetches nothing. The drivers come from the `ExtensionRegistry` in scope, so
 * a turn reads its own profile's and a server read the requesting session's;
 * a catalog captured once at launch missed every project-scoped driver and
 * ignored `disabledExtensions`.
 */
export const modelCatalog = Effect.fn("ModelRegistry.modelCatalog")(function* () {
  const authStore = yield* Auth
  const { modelDrivers } = (yield* ExtensionRegistry).getResolved()
  const catalog = yield* listModelCatalog(modelDrivers, (providerId) =>
    authStore.get(providerId).pipe(
      Effect.map((info) =>
        Option.getOrUndefined(
          Option.map(Option.fromUndefinedOr(info), (found) =>
            toProviderAuthInfo(authStore, providerId, found),
          ),
        ),
      ),
      Effect.mapError(
        (e) =>
          new ProviderAuthError({
            message: `Failed to read auth for provider "${providerId}"`,
            cause: e,
          }),
      ),
    ),
  )
  return byReleaseDateDesc(catalog)
})

/** One model of the caller's profile catalog: the turn's context limit and pricing. */
interface ModelRegistryService {
  readonly get: (
    modelId: string,
  ) => Effect.Effect<Option.Option<Model>, DriverError | ProviderAuthError, ExtensionRegistry>
}

export class ModelRegistry extends Context.Service<ModelRegistry, ModelRegistryService>()(
  "@gent/core/src/runtime/provider/ModelRegistry",
) {
  static Live: Layer.Layer<ModelRegistry, never, Auth> = Layer.effect(
    ModelRegistry,
    Effect.gen(function* () {
      const authStore = yield* Auth
      return ModelRegistry.of({
        get: (modelId) =>
          modelCatalog().pipe(
            Effect.provideService(Auth, authStore),
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

// ── scripted-model ──────────────────────────────────────────────────────────

/**
 * Language models that answer from a script instead of a provider.
 *
 * `ScriptedLanguageModel.debug` drives the real agent loop with canned
 * replies (and a deterministic 429 retry budget), and `empty` finishes every
 * step with nothing. `Gent.provider.mock()` ships both; the test harness
 * builds its gated and sequenced models from the same stream-part helpers.
 */

type LanguageModelToolMap = Record<string, AiTool.Any>
export type LanguageModelStreamPart<Tools extends LanguageModelToolMap = LanguageModelToolMap> =
  Response.StreamPart<Tools>

let _streamPartIdCounter = 0
const makeStreamPartId = (prefix: string) => `${prefix}-${++_streamPartIdCounter}`

export const textDeltaPart = (
  text: string,
  id = makeStreamPartId("text"),
): LanguageModelStreamPart => Response.makePart("text-delta", { id, delta: text })

export const toolCallPart = (
  toolName: string,
  // oxlint-disable-next-line effect/noUnknownParameters -- Tool arguments enter the Effect AI codec as unknown JSON data.
  input: unknown,
  options?: { toolCallId?: ToolCallId },
): LanguageModelStreamPart =>
  Response.makePart("tool-call", {
    id: options?.toolCallId ?? ToolCallId.make(makeStreamPartId("tool")),
    name: toolName,
    params: input,
    providerExecuted: false,
  })

export const reasoningDeltaPart = (
  text: string,
  id = makeStreamPartId("reasoning"),
): LanguageModelStreamPart => Response.makePart("reasoning-delta", { id, delta: text })

export const finishPart = (params: {
  finishReason: Response.FinishReason
  usage?: { inputTokens: number; outputTokens: number }
}): LanguageModelStreamPart =>
  Response.makePart("finish", {
    reason: params.finishReason,
    usage: new Response.Usage({
      inputTokens: {
        // oxlint-disable-next-line effect/noNullish -- Effect AI requires the absent token count in this wire fixture.
        uncached: undefined,
        total: params.usage?.inputTokens,
        // oxlint-disable-next-line effect/noNullish -- Effect AI requires the absent token count in this wire fixture.
        cacheRead: undefined,
        // oxlint-disable-next-line effect/noNullish -- Effect AI requires the absent token count in this wire fixture.
        cacheWrite: undefined,
      },
      outputTokens: {
        total: params.usage?.outputTokens,
        // oxlint-disable-next-line effect/noNullish -- Effect AI requires the absent token count in this wire fixture.
        text: undefined,
        // oxlint-disable-next-line effect/noNullish -- Effect AI requires the absent token count in this wire fixture.
        reasoning: undefined,
      },
    }),
    // oxlint-disable-next-line effect/noNullish -- Effect AI requires the absent response in this wire fixture.
    response: undefined,
  })

const makeEncodingToolkit = <Tools extends Record<string, AiTool.Any>>(
  tools: Tools,
): AiToolkit.WithHandler<Tools> => ({
  tools,
  handle: (name) =>
    Effect.fail(
      AiError.make({
        module: "LanguageModelLayers",
        method: "makeEncodingToolkit.handle",
        reason: new AiError.ToolConfigurationError({
          toolName: String(name),
          description: "language model response encoding does not execute tool handlers",
        }),
      }),
    ),
})

const toolkitFromProviderOptions = (
  options: ProviderOptions,
): AiToolkit.WithHandler<LanguageModelToolMap> => {
  const toolsRecord: LanguageModelToolMap = {}
  for (const tool of options.tools) {
    toolsRecord[tool.name] = tool
  }
  return makeEncodingToolkit(toolsRecord)
}

const encodePart = (
  options: ProviderOptions,
  part: Response.Part<LanguageModelToolMap>,
): Response.PartEncoded =>
  Schema.encodeUnknownSync(Response.Part(toolkitFromProviderOptions(options)))(part)

const encodeStreamPart = (
  options: ProviderOptions,
  part: LanguageModelStreamPart,
): Response.StreamPartEncoded =>
  Schema.encodeUnknownSync(Response.StreamPart(toolkitFromProviderOptions(options)))(part)

export const aiError = (method: string, message: string) =>
  AiError.make({
    module: "LanguageModelLayers",
    method,
    reason: new AiError.UnknownError({ description: message }),
  })

const extractLatestUserText = (promptInput: Prompt.RawInput): string => {
  const latest = [...Prompt.make(promptInput).content]
    .reverse()
    .find((message) => message.role === "user")
  if (Predicate.isUndefined(latest)) return ""
  return latest.content
    .filter((part): part is Prompt.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

const retryBudgetFor = (text: string): number => {
  if (text.trim().length === 0) return 0
  const hash = [...text].reduce((total, ch) => total + ch.charCodeAt(0), 0)
  if (hash % 3 === 0) return 2
  if (hash % 2 === 0) return 1
  return 0
}

const buildReply = (latestUserText: string): string => {
  const lineCount = latestUserText.split("\n").filter((line) => line.trim().length > 0).length
  if (lineCount > 1) {
    return [
      "cowork processed a merged queued turn.",
      `Received ${lineCount} lines in one message block.`,
      `Tail: ${latestUserText.split("\n").at(-1) ?? latestUserText}`,
    ].join(" ")
  }

  return [
    "cowork debug response.",
    `Latest user message: ${latestUserText || "(empty)"}.`,
    "This turn is flowing through the real agent loop with a scripted language model.",
  ].join(" ")
}

const makeReplyStream = (latestUserText: string, reply: string, delayMs = 0) => {
  const parts = reply.split(/(?<=[.!?])\s+/).filter((chunk) => chunk.length > 0)
  const stream = Stream.fromIterable([
    ...parts.map((text) => textDeltaPart(`${text} `)),
    finishPart({
      finishReason: "stop",
      usage: {
        inputTokens: Math.max(1, Math.ceil(latestUserText.length / 4)),
        outputTokens: Math.max(1, Math.ceil(reply.length / 4)),
      },
    }),
  ])

  if (delayMs <= 0) return stream

  return stream.pipe(
    Stream.flatMap((chunk) =>
      Stream.fromEffect(Effect.sleep(Duration.millis(delayMs)).pipe(Effect.as(chunk))),
    ),
  )
}

export const makeLanguageModelLayer = (params: {
  readonly streamText: (
    options: ProviderOptions,
  ) => Stream.Stream<LanguageModelStreamPart, AiError.AiError>
  readonly generateText: (options: ProviderOptions) => Effect.Effect<string, AiError.AiError>
}): Layer.Layer<LanguageModel.LanguageModel> =>
  Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: (options) =>
        params
          .generateText(options)
          .pipe(Effect.map((text) => [encodePart(options, Response.makePart("text", { text }))])),
      streamText: (options) =>
        params.streamText(options).pipe(Stream.map((part) => encodeStreamPart(options, part))),
    }),
  )

const debug = (options?: { delayMs?: number; retries?: boolean }) => {
  const delayMs = options?.delayMs ?? 0
  const retries = options?.retries ?? delayMs === 0
  const attempts = new Map<string, number>()

  return makeLanguageModelLayer({
    streamText: (modelOptions) =>
      Effect.suspend(() => {
        const latestUserText = extractLatestUserText(modelOptions.prompt)
        const seen = attempts.get(latestUserText) ?? 0
        let retryBudget = 0
        if (retries) retryBudget = retryBudgetFor(latestUserText)

        if (seen < retryBudget) {
          attempts.set(latestUserText, seen + 1)
          return Effect.fail(aiError("Debug.streamText", "Rate limit exceeded (429)"))
        }

        attempts.delete(latestUserText)
        return Effect.succeed(makeReplyStream(latestUserText, buildReply(latestUserText), delayMs))
      }).pipe(Stream.unwrap),
    generateText: () => Effect.succeed("debug scenario"),
  })
}

/**
 * A model that finishes every step having produced nothing — no text, no
 * tool calls. Real providers are trained not to do this on request, so a
 * live prompt cannot reproduce the unanswered turn; this layer can, in a
 * real process, through `Gent.provider.mock({ empty: true })`.
 */
let emptyCache = Option.none<Layer.Layer<LanguageModel.LanguageModel>>()
const empty = () => {
  if (Option.isNone(emptyCache)) {
    const layer = makeLanguageModelLayer({
      streamText: () =>
        Stream.make(
          finishPart({ finishReason: "stop", usage: { inputTokens: 1, outputTokens: 0 } }),
        ),
      generateText: () => Effect.succeed(""),
    })
    emptyCache = Option.some(layer)
    return layer
  }
  return emptyCache.value
}

export const ScriptedLanguageModel = {
  debug,
  get empty() {
    return empty()
  },
}
