import {
  Clock,
  Config,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Redacted,
  Schema,
  SynchronizedRef,
} from "effect"
import {
  AuthMethod,
  DEFAULT_RETRY_POLICY,
  defineExtension,
  ExtensionHost,
  type ModelDriverContribution,
  ProviderAuthError,
  type ProviderAuthInfo,
  type ProviderHints,
  type ProviderResolution,
} from "@gent/core/extensions/api"
import {
  FetchHttpClient,
  type Headers,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { HttpClientError, TransportError } from "effect/unstable/http/HttpClientError"
import { Model as AiModel } from "effect/unstable/ai"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat"
import { type CatalogSource, catalogSource, driverListModels } from "./models-dev.js"

// ── credentials ─────────────────────────────────────────────────────────────

/**
 * Cached provider credential with single-flight refresh.
 *
 * One `SynchronizedRef` cell holds the credential. `getFresh` serves the
 * cell while it is warm (TTL 30s) and usable (expires more than 60s from
 * now), consults the provider's source of truth once the TTL lapses,
 * and refreshes when nothing usable remains. `SynchronizedRef.modifyEffect`
 * makes concurrent stale calls share one refresh.
 *
 * A refreshed credential is written back through `authInfo.persist`.
 * When that write fails the credential is kept as `PendingPersist`: the
 * caller sees the failure, the rotated refresh token survives, and the
 * next `getFresh` retries the write before serving anything.
 *
 * `invalidate` marks the cell so the next `getFresh` skips the cache
 * but keeps the held credential — its refresh token is the only copy a
 * provider without a keychain has.
 *
 * Providers own their Tag, credential schema, IO, and the three hooks
 * (`read`, `refresh`, `toPersisted`); this module owns the cache.
 */

const CREDENTIAL_CACHE_TTL_MS = 30_000

/**
 * A credential is "fresh enough to use" if it expires more than 60s
 * from now. Below that, callers should refresh before sending it on
 * the wire — provider auth gates reject a token in its last minute and
 * a refresh round-trip can take that long.
 */
const FRESH_ENOUGH_MS = 60_000

export const freshEnoughAt = (expiresAt: number, now: number): boolean =>
  expiresAt > now + FRESH_ENOUGH_MS

// ── Cache cell ──

export const CredentialCacheCell = <C>(credentials: Schema.Schema<C>) =>
  Schema.TaggedUnion({
    Empty: {},
    Durable: { creds: credentials, at: Schema.Finite, invalidated: Schema.Boolean },
    PendingPersist: { creds: credentials, at: Schema.Finite, invalidated: Schema.Boolean },
  })
export type CredentialCacheCell<C> = ReturnType<typeof CredentialCacheCell<C>>["Type"]
export type CredentialCacheCellRef<C> = SynchronizedRef.SynchronizedRef<CredentialCacheCell<C>>

export const EMPTY_CREDENTIAL_CELL = Schema.TaggedStruct("Empty", {}).make({})

// ── Cache ──

export interface CredentialCache<C> {
  /** Resolve cached/refreshed credentials. Fails with `ProviderAuthError` when no usable credential can be obtained. */
  readonly getFresh: Effect.Effect<C, ProviderAuthError>
  /** Skip the cache on the next `getFresh` without dropping the held credential. */
  readonly invalidate: Effect.Effect<void>
}

type PersistedCredentials = Parameters<NonNullable<ProviderAuthInfo["persist"]>>[0]

interface CredentialCacheConfig<C> {
  /** Provider name used in persist failure messages. */
  readonly label: string
  readonly credentials: Schema.Schema<C>
  readonly cellRef: CredentialCacheCellRef<C>
  readonly authInfo: Option.Option<ProviderAuthInfo>
  /** Credentials placed in the cell at build time when it is still empty. */
  readonly seed: Option.Option<C>
  readonly expiresAt: (creds: C) => number
  /**
   * Source of truth consulted once the cache is older than the TTL.
   * Receives the cached credential while it is still trusted; a provider
   * without an external store returns it as-is.
   */
  readonly read: (cached: Option.Option<C>) => Effect.Effect<Option.Option<C>>
  /** Obtain new credentials. Receives the held credential (its refresh token is the most recently rotated one). */
  readonly refresh: (held: Option.Option<C>) => Effect.Effect<C, ProviderAuthError>
  readonly toPersisted: (creds: C) => PersistedCredentials
}

export const makeCredentialCache = <C>(
  config: CredentialCacheConfig<C>,
): Effect.Effect<CredentialCache<C>> =>
  Effect.gen(function* () {
    const Cell = CredentialCacheCell(config.credentials)
    const durable = (creds: C, at: number, invalidated: boolean): CredentialCacheCell<C> =>
      Cell.cases.Durable.make({ creds, at, invalidated })
    const pending = (creds: C, at: number): CredentialCacheCell<C> =>
      Cell.cases.PendingPersist.make({ creds, at, invalidated: false })

    // First-touch seed: externally-owned cells may already hold fresher
    // creds from a prior layer build within the same extension instance.
    yield* SynchronizedRef.update(config.cellRef, (cell) => {
      if (cell._tag !== "Empty" || Option.isNone(config.seed)) return cell
      return durable(config.seed.value, 0, false)
    })

    const persist = (creds: C): Effect.Effect<void, ProviderAuthError> => {
      const write = config.authInfo.pipe(
        Option.flatMap((info) => Option.fromNullishOr(info.persist)),
      )
      if (Option.isNone(write)) return Effect.void
      return write.value(config.toPersisted(creds)).pipe(
        Effect.catchDefect((cause) => {
          let message = String(cause)
          if (cause instanceof Error) message = cause.message
          return Effect.fail(
            new ProviderAuthError({
              message: `Failed to persist refreshed ${config.label} credentials: ${message}`,
              cause,
            }),
          )
        }),
      )
    }

    // A write-back that failed earlier is retried before anything is served.
    const settlePending = (
      cell: CredentialCacheCell<C>,
      now: number,
    ): Effect.Effect<CredentialCacheCell<C>, ProviderAuthError> => {
      if (cell._tag !== "PendingPersist") return Effect.succeed(cell)
      return persist(cell.creds).pipe(Effect.map(() => durable(cell.creds, now, cell.invalidated)))
    }

    const trusted = (cell: CredentialCacheCell<C>): Option.Option<C> => {
      if (cell._tag === "Durable" && !cell.invalidated) return Option.some(cell.creds)
      return Option.none()
    }

    const getFresh: Effect.Effect<C, ProviderAuthError> = SynchronizedRef.modifyEffect(
      config.cellRef,
      (
        cell,
      ): Effect.Effect<
        readonly [Exit.Exit<C, ProviderAuthError>, CredentialCacheCell<C>],
        ProviderAuthError
      > =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const current = yield* settlePending(cell, now)
          const cached = trusted(current)

          if (
            current._tag === "Durable" &&
            Option.isSome(cached) &&
            now - current.at < CREDENTIAL_CACHE_TTL_MS &&
            freshEnoughAt(config.expiresAt(cached.value), now)
          ) {
            return [Exit.succeed(cached.value), current]
          }

          const fromSource = yield* config.read(cached)
          if (Option.isSome(fromSource) && freshEnoughAt(config.expiresAt(fromSource.value), now)) {
            return [Exit.succeed(fromSource.value), durable(fromSource.value, now, false)]
          }

          // Refresh failure leaves the cell untouched: the held refresh
          // token survives so a retry can re-attempt with it.
          let held = Option.none<C>()
          if (current._tag !== "Empty") held = Option.some(current.creds)
          const refreshed = yield* config.refresh(held)
          const persisted = Exit.map(yield* Effect.exit(persist(refreshed)), () => refreshed)
          if (Exit.isFailure(persisted)) return [persisted, pending(refreshed, now)]
          return [persisted, durable(refreshed, now, false)]
        }),
    ).pipe(Effect.flatten)

    const invalidate: Effect.Effect<void> = SynchronizedRef.update(config.cellRef, (cell) => {
      if (cell._tag === "Empty") return cell
      return { ...cell, invalidated: true }
    })

    return { getFresh, invalidate }
  })

// ── http ────────────────────────────────────────────────────────────────────

/**
 * Shared HTTP middleware for provider `transformClient` callbacks.
 *
 * Both OAuth providers build their client the same way: reconstruct the
 * request with a fresh header map, surface a credential failure through the
 * transport channel, and recover once from a 401 by invalidating the cache.
 * Only the header set itself is provider-specific, so it stays with the
 * provider; everything around it lives here.
 */

/**
 * Reconstruct an `HttpClientRequest` with the same method/url/body but a
 * fresh headers map. The public `setHeaders` combinator only merges; it
 * cannot remove, so overriding a baseline header needs a full
 * reconstruction via the public `make(method)(url, options)` constructor.
 */
export const withHeaders = (
  req: HttpClientRequest.HttpClientRequest,
  headers: Headers.Headers,
): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.make(req.method)(req.url, {
    headers,
    body: req.body,
    urlParams: req.urlParams,
    hash: Option.getOrUndefined(req.hash),
  })

/**
 * Convert a `ProviderAuthError` into the `HttpClientError` the SDK's
 * `transformClient` signature requires, so credential unavailability
 * reaches the caller through the standard transport channel.
 */
const asTransportError = (
  req: HttpClientRequest.HttpClientRequest,
  cause: ProviderAuthError,
): HttpClientError =>
  new HttpClientError({
    reason: new TransportError({ request: req, cause, description: cause.message }),
  })

/** Fetch credentials for a request, surfacing auth failure as a transport error. */
export const freshCredentials = <C>(
  creds: CredentialCache<C>,
  req: HttpClientRequest.HttpClientRequest,
): Effect.Effect<C, HttpClientError> =>
  creds.getFresh.pipe(Effect.mapError((cause) => asTransportError(req, cause)))

/**
 * Internal error driving 401 recovery. The credential cache TTL can outlive
 * a token's last minute, and tokens can be revoked server-side between cache
 * fill and wire send. Typed so the recovery fires only on this signal, not on
 * other 4xx that callers should see verbatim.
 */
class Unauthorized401Error extends Schema.TaggedError<Unauthorized401Error>(
  "@gent/extensions/src/providers/Unauthorized401Error",
)("Unauthorized401Error", {
  response: Schema.declare<HttpClientResponse.HttpClientResponse>(
    (input): input is HttpClientResponse.HttpClientResponse =>
      Predicate.hasProperty(input, HttpClientResponse.TypeId),
  ),
}) {}

/**
 * 401 recovery: invalidate the credential cache and retry ONCE. On the
 * retry the request preprocess re-enters and `creds.getFresh` re-reads or
 * forces a refresh. A second 401 means a real auth failure — surface the
 * response so user-facing recovery can kick in.
 *
 * `tapError` runs the invalidate AFTER the failure but BEFORE `Effect.retry`
 * re-attempts, so the invalidate commits before the next preprocess reads
 * the cache.
 */
export const recoverUnauthorized =
  <C>(creds: CredentialCache<C>) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    client.pipe(
      HttpClient.transformResponse((effect) =>
        effect.pipe(
          Effect.flatMap(
            (
              response,
            ): Effect.Effect<HttpClientResponse.HttpClientResponse, Unauthorized401Error> => {
              switch (response.status) {
                case 401:
                  return Effect.fail(new Unauthorized401Error({ response }))
                default:
                  return Effect.succeed(response)
              }
            },
          ),
          Effect.tapError((e) => {
            if (e._tag === "Unauthorized401Error") return creds.invalidate
            return Effect.void
          }),
          Effect.retry({
            while: (e) => e._tag === "Unauthorized401Error",
            times: 1,
          }),
          Effect.catchTag("Unauthorized401Error", (e) => Effect.succeed(e.response)),
        ),
      ),
    )

// ── openai-compatible driver ────────────────────────────────────────────────

const GOOGLE_COMPAT_URL = "https://generativelanguage.googleapis.com/v1beta/openai"
const MISTRAL_COMPAT_URL = "https://api.mistral.ai/v1"

type OpenAiCompatConfig = Required<Parameters<typeof OpenAiLanguageModel.layer>[0]>["config"]

export const readOptionalEnv = (name: string): Effect.Effect<Option.Option<string>> =>
  Config.option(Config.string(name)).pipe(Effect.orElseSucceed(() => Option.none()))

export const buildOpenAiCompatConfig = (
  hints: Option.Option<ProviderHints>,
  includeReasoning: boolean,
): OpenAiCompatConfig => {
  let config: OpenAiCompatConfig = {}
  if (Option.isSome(hints)) {
    const maxTokens = Option.fromNullishOr(hints.value.maxTokens)
    if (Option.isSome(maxTokens)) config = { ...config, max_tokens: maxTokens.value }
    const temperature = Option.fromNullishOr(hints.value.temperature)
    if (Option.isSome(temperature)) config = { ...config, temperature: temperature.value }
    const reasoning = Option.fromNullishOr(hints.value.reasoning)
    if (includeReasoning && Option.isSome(reasoning) && reasoning.value !== "none") {
      config = { ...config, reasoning_effort: reasoning.value }
    }
  }
  return config
}

export const makeOpenAiCompatResolution = (params: {
  readonly provider: string
  readonly modelName: string
  readonly apiKey: string
  readonly config: OpenAiCompatConfig
  readonly apiUrl: Option.Option<string>
}): ProviderResolution => {
  let clientLayer = OpenAiClient.layer({ apiKey: Redacted.make(params.apiKey) })
  if (Option.isSome(params.apiUrl)) {
    clientLayer = OpenAiClient.layer({
      apiKey: Redacted.make(params.apiKey),
      apiUrl: params.apiUrl.value,
    })
  }
  const providedClientLayer = clientLayer.pipe(Layer.provide(FetchHttpClient.layer))
  const modelLayer = OpenAiLanguageModel.layer({
    model: params.modelName,
    config: params.config,
  }).pipe(Layer.provide(providedClientLayer))
  return AiModel.make(params.provider, params.modelName, modelLayer)
}

const makeApiKeyCompatDriver = (params: {
  readonly id: string
  readonly name: string
  readonly envApiKey: Option.Option<string>
  readonly envVarName: string
  readonly apiUrl: Option.Option<string>
  readonly catalog: CatalogSource
}): ModelDriverContribution => ({
  id: params.id,
  name: params.name,
  // The driver id is the models.dev provider id, so no mapping is needed.
  listModels: driverListModels(params.catalog, params.id),
  retry: {
    ...DEFAULT_RETRY_POLICY,
    // An accepted request can still end with an error event inside the stream; the compatible APIs name a code.
    transientStreamEvent: Schema.Struct({
      code: Schema.Literals(["server_error", "rate_limit_exceeded"]),
    }),
  },
  resolveModel: (modelName, authInfo, hints) =>
    Effect.gen(function* () {
      let apiKey = params.envApiKey
      if (authInfo?.type === "api") apiKey = Option.fromNullishOr(authInfo.key)
      if (Option.isNone(apiKey)) {
        return yield* new ProviderAuthError({
          message: `${params.name} credentials unavailable: no stored API key or ${params.envVarName} env var`,
        })
      }
      return makeOpenAiCompatResolution({
        provider: params.id,
        modelName,
        apiKey: apiKey.value,
        apiUrl: params.apiUrl,
        config: buildOpenAiCompatConfig(Option.fromNullishOr(hints), false),
      })
    }),
  auth: {
    methods: [AuthMethod.make({ type: "api", label: "Manually enter API key" })],
  },
})

const makeApiKeyCompatExtension = (params: {
  readonly extensionId: string
  readonly driverId: string
  readonly name: string
  readonly envVarName: string
  readonly apiUrl: string
}) =>
  defineExtension({
    id: params.extensionId,
    setup: Effect.gen(function* () {
      const host = yield* ExtensionHost
      const envApiKey = yield* readOptionalEnv(params.envVarName)
      const catalog = yield* catalogSource(host.home)
      yield* host.register(
        "modelDriver",
        makeApiKeyCompatDriver({
          id: params.driverId,
          name: params.name,
          envApiKey,
          envVarName: params.envVarName,
          apiUrl: Option.some(params.apiUrl),
          catalog,
        }),
      )
    }),
  })

export const GoogleExtension = makeApiKeyCompatExtension({
  extensionId: "@gent/provider-google",
  driverId: "google",
  name: "Google",
  envVarName: "GOOGLE_GENERATIVE_AI_API_KEY",
  apiUrl: GOOGLE_COMPAT_URL,
})

export const MistralExtension = makeApiKeyCompatExtension({
  extensionId: "@gent/provider-mistral",
  driverId: "mistral",
  name: "Mistral",
  envVarName: "MISTRAL_API_KEY",
  apiUrl: MISTRAL_COMPAT_URL,
})
