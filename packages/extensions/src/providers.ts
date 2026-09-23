import {
  Cause,
  Clock,
  Config,
  type Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
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
  isRecord,
  Model,
  type ModelDriverContribution,
  ModelId,
  type ModelPricing,
  omitUndefined,
  credentialFailureMetadata,
  ProviderAuthError,
  type ProviderHints,
  ProviderId,
  type ProviderResolution,
} from "@gent/core/extensions/api"
import {
  FetchHttpClient,
  type Headers,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { EncodeError, HttpClientError, TransportError } from "effect/unstable/http/HttpClientError"
import { AiError, Model as AiModel } from "effect/unstable/ai"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat"

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
 * The source of truth is one of two kinds:
 *
 * - `read`: an external store the provider reads and its refresh writes
 *   itself (the Claude Code keychain).
 * - `store`: the gent auth store. Every profile of the process has its own
 *   cell, but all of them share this store, so the store is the owner of
 *   the credential. Once the TTL lapses, `getFresh` reads and refreshes
 *   inside one `store.update`, under the store lock. When the store holds a
 *   credential other than the held one (a sign-in, or a refresh in another
 *   profile), the cell adopts it and never refreshes or writes the held
 *   one. When that write fails the rotated credential is kept as
 *   `PendingPersist`: the caller sees the failure, the rotated refresh
 *   token survives, and the next `getFresh` retries the write before
 *   serving anything, but only while the store still holds the credential
 *   that the rotation replaced.
 *
 * `invalidate` marks the cell so the next `getFresh` skips the cache
 * but keeps the held credential — its refresh token is the only copy a
 * provider without a keychain has.
 *
 * Providers own their credential schema, IO, and the hooks (`read` or
 * `store`, `refresh`); this module owns the cache.
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

// ── Refresh failures ──

/**
 * A refresh that failed for a reason that passes: a transport error, a
 * timeout, or a 429/5xx from the token endpoint. The request fails as
 * retryable and the loop tries again. A `ProviderAuthError` is permanent:
 * the user must sign in again.
 */
export class CredentialRefreshUnavailable extends Schema.TaggedError<CredentialRefreshUnavailable>(
  "@gent/extensions/src/providers/CredentialRefreshUnavailable",
)("CredentialRefreshUnavailable", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export type CredentialFailure = ProviderAuthError | CredentialRefreshUnavailable

/** True when a token endpoint status means "try again later", not "sign in again". */
export const isTransientTokenStatus = (status: number): boolean => status === 429 || status >= 500

// ── Cache cell ──

export const CredentialCacheCell = <C>(credentials: Schema.Schema<C>) =>
  Schema.TaggedUnion({
    Empty: {},
    Durable: { creds: credentials, at: Schema.Finite, invalidated: Schema.Boolean },
    PendingPersist: {
      creds: credentials,
      /** The stored credential the rotation replaced; the write lands only over it. */
      replaces: credentials,
      at: Schema.Finite,
      invalidated: Schema.Boolean,
    },
  })
export type CredentialCacheCell<C> = ReturnType<typeof CredentialCacheCell<C>>["Type"]
export type CredentialCacheCellRef<C> = SynchronizedRef.SynchronizedRef<CredentialCacheCell<C>>

export const EMPTY_CREDENTIAL_CELL = Schema.TaggedStruct("Empty", {}).make({})

/**
 * Replace the held credential with a new sign-in. A cell lives as long as
 * the extension, and `makeCredentialCache` seeds it only while it is empty,
 * so a sign-in must write the cell itself: without that, the old account
 * stays in use and its next refresh writes it back over the new one.
 * `write` stores the sign-in; it runs under the cell lock, so a refresh in
 * flight in this cell cannot store the old account after it. The cells of
 * other profiles adopt the sign-in from the store (see `CredentialStore`).
 */
export const replaceHeldCredential = <C, E>(
  credentials: Schema.Schema<C>,
  cellRef: CredentialCacheCellRef<C>,
  creds: C,
  write: Effect.Effect<void, E>,
): Effect.Effect<void, E> =>
  SynchronizedRef.updateEffect(cellRef, () =>
    Effect.gen(function* () {
      yield* write
      const at = yield* Clock.currentTimeMillis
      return CredentialCacheCell(credentials).cases.Durable.make({ creds, at, invalidated: false })
    }),
  )

// ── Cache ──

export interface CredentialCache<C> {
  /**
   * Resolve cached/refreshed credentials. Fails with `ProviderAuthError` when
   * no usable credential can be obtained, and with
   * `CredentialRefreshUnavailable` when the refresh failed for a reason that
   * passes.
   */
  readonly getFresh: Effect.Effect<C, CredentialFailure>
  /** Skip the cache on the next `getFresh` without dropping the held credential. */
  readonly invalidate: Effect.Effect<void>
}

/**
 * The gent auth store as a credential cache sees it. All profiles of the
 * process share it. `update` runs `f` under the store lock for the
 * provider and writes the credential `f` returns (none leaves the store as
 * it is). `same` is true when two credentials are one sign-in at one
 * rotation (the same refresh token).
 */
export interface CredentialStore<C> {
  readonly update: <A, E>(
    f: (stored: Option.Option<C>) => Effect.Effect<readonly [A, Option.Option<C>], E>,
  ) => Effect.Effect<A, E | ProviderAuthError>
  readonly same: (a: C, b: C) => boolean
}

interface CredentialCacheConfig<C> {
  /** Provider name used in persist failure messages. */
  readonly label: string
  readonly credentials: Schema.Schema<C>
  readonly cellRef: CredentialCacheCellRef<C>
  /** Credentials placed in the cell at build time when it is still empty. */
  readonly seed: Option.Option<C>
  readonly expiresAt: (creds: C) => number
  /**
   * External source of truth consulted once the cache is older than the
   * TTL. Receives the cached credential while it is still trusted. A
   * provider whose refresh writes this source itself (the Claude Code
   * keychain) passes it; a provider on the gent auth store passes `store`.
   * With neither, the cached credential is served while it is fresh.
   */
  readonly read: Option.Option<(cached: Option.Option<C>) => Effect.Effect<Option.Option<C>>>
  /** Obtain new credentials. Receives the credential whose refresh token to use. */
  readonly refresh: (held: Option.Option<C>) => Effect.Effect<C, CredentialFailure>
  /** The gent auth store that owns the credential; none when nothing reads it back. */
  readonly store: Option.Option<CredentialStore<C>>
}

export const makeCredentialCache = <C>(
  config: CredentialCacheConfig<C>,
): Effect.Effect<CredentialCache<C>> =>
  Effect.gen(function* () {
    const Cell = CredentialCacheCell(config.credentials)
    const durable = (creds: C, at: number, invalidated: boolean): CredentialCacheCell<C> =>
      Cell.cases.Durable.make({ creds, at, invalidated })

    // First-touch seed: externally-owned cells may already hold fresher
    // creds from a prior layer build within the same extension instance.
    yield* SynchronizedRef.update(config.cellRef, (cell) => {
      if (cell._tag !== "Empty" || Option.isNone(config.seed)) return cell
      return durable(config.seed.value, 0, false)
    })

    const signedOut = new ProviderAuthError({
      message: `The ${config.label} sign-in was removed. Sign in again with /auth.`,
    })

    // A store write that died becomes a typed failure that names the write.
    const persistFailure = <E>(cause: Cause.Cause<E>): E | ProviderAuthError =>
      Option.getOrElse(Cause.findErrorOption(cause), () => {
        const defect = Cause.squash(cause)
        let message = String(defect)
        if (defect instanceof Error) message = defect.message
        return new ProviderAuthError({
          message: `Failed to persist refreshed ${config.label} credentials: ${message}`,
          cause: defect,
        })
      })

    // A write that failed earlier is retried before anything is served,
    // but only over the credential the rotation replaced. When another
    // writer changed the store since, its credential wins.
    const settlePending = (
      cell: CredentialCacheCell<C>,
      now: number,
    ): Effect.Effect<CredentialCacheCell<C>, ProviderAuthError> => {
      if (cell._tag !== "PendingPersist" || Option.isNone(config.store)) {
        return Effect.succeed(cell)
      }
      const store = config.store.value
      return store
        .update(
          (
            stored,
          ): Effect.Effect<
            readonly [CredentialCacheCell<C>, Option.Option<C>],
            ProviderAuthError
          > => {
            if (Option.isNone(stored)) return Effect.fail(signedOut)
            if (store.same(stored.value, cell.replaces)) {
              return Effect.succeed([
                durable(cell.creds, now, cell.invalidated),
                Option.some(cell.creds),
              ])
            }
            return Effect.succeed([durable(stored.value, now, false), Option.none()])
          },
        )
        .pipe(Effect.catchCause((cause) => Effect.fail(persistFailure(cause))))
    }

    const trusted = (cell: CredentialCacheCell<C>): Option.Option<C> => {
      if (cell._tag === "Durable" && !cell.invalidated) return Option.some(cell.creds)
      return Option.none()
    }

    type Step = readonly [Exit.Exit<C, CredentialFailure>, CredentialCacheCell<C>]

    // The store lock orders refreshes inside one process only. Another gent
    // process on the same auth files can use the refresh token first; the
    // provider then refuses this refresh (`refresh_token_reused`) for good.
    // Its rotation is in the store by then, so a refused refresh reads the
    // store once more and adopts a changed, fresh credential.
    const adoptAfterRefusal = (
      store: CredentialStore<C>,
      attempted: C,
      cause: Cause.Cause<CredentialFailure>,
      now: number,
    ): Effect.Effect<Step, CredentialFailure> => {
      const refused = Cause.findErrorOption(cause).pipe(
        Option.filter((error) => error._tag === "ProviderAuthError"),
      )
      if (Option.isNone(refused)) return Effect.failCause(cause)
      return store
        .update((stored): Effect.Effect<readonly [Option.Option<C>, Option.Option<C>]> => {
          const adoptable = Option.filter(
            stored,
            (creds) => !store.same(creds, attempted) && freshEnoughAt(config.expiresAt(creds), now),
          )
          return Effect.succeed([adoptable, Option.none<C>()])
        })
        .pipe(
          Effect.orElseSucceed(() => Option.none<C>()),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.failCause(cause),
              onSome: (creds): Effect.Effect<Step> =>
                Effect.succeed([Exit.succeed(creds), durable(creds, now, false)]),
            }),
          ),
        )
    }

    // Read and refresh under the store lock. The store's credential wins
    // over the held one when they differ: another writer put it there.
    const fromStore = (
      store: CredentialStore<C>,
      current: CredentialCacheCell<C>,
      now: number,
    ): Effect.Effect<Step, CredentialFailure> => {
      let held = Option.none<C>()
      if (current._tag !== "Empty") held = Option.some(current.creds)
      let rotated = Option.none<{ readonly creds: C; readonly replaces: C }>()
      let refreshedFrom = Option.none<C>()
      const result = (serve: C, write: Option.Option<C>): readonly [C, Option.Option<C>] => [
        serve,
        write,
      ]
      return store
        .update((stored) =>
          Effect.gen(function* () {
            // Nothing to adopt: a removed sign-in is not written back.
            if (Option.isNone(stored)) return yield* signedOut
            const adopted = Option.isNone(held) || !store.same(stored.value, held.value)
            let base = stored.value
            if (!adopted && Option.isSome(held)) base = held.value
            const trustedBase = adopted || Option.isSome(trusted(current))
            if (trustedBase && freshEnoughAt(config.expiresAt(base), now)) {
              return result(base, Option.none())
            }
            refreshedFrom = Option.some(base)
            const refreshed = yield* config.refresh(Option.some(base))
            rotated = Option.some({ creds: refreshed, replaces: base })
            return result(refreshed, Option.some(refreshed))
          }),
        )
        .pipe(
          Effect.exit,
          Effect.flatMap((exit): Effect.Effect<Step, CredentialFailure> => {
            if (Exit.isSuccess(exit)) {
              return Effect.succeed([Exit.succeed(exit.value), durable(exit.value, now, false)])
            }
            // The refresh or the read failed: the cell keeps the held
            // refresh token so a retry can re-attempt with it.
            if (Option.isNone(rotated)) {
              return Option.match(refreshedFrom, {
                onNone: () => Effect.failCause(exit.cause),
                onSome: (attempted) => adoptAfterRefusal(store, attempted, exit.cause, now),
              })
            }
            // The refresh worked but the write failed: keep the rotation.
            return Effect.succeed([
              Exit.fail(persistFailure(exit.cause)),
              Cell.cases.PendingPersist.make({
                creds: rotated.value.creds,
                replaces: rotated.value.replaces,
                at: now,
                invalidated: false,
              }),
            ])
          }),
        )
    }

    const getFresh: Effect.Effect<C, CredentialFailure> = SynchronizedRef.modifyEffect(
      config.cellRef,
      (cell): Effect.Effect<Step, CredentialFailure> =>
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

          if (Option.isSome(config.store)) return yield* fromStore(config.store.value, current, now)

          // Without an external source the cell is the only copy.
          let fromSource = cached
          if (Option.isSome(config.read)) fromSource = yield* config.read.value(cached)
          if (Option.isSome(fromSource) && freshEnoughAt(config.expiresAt(fromSource.value), now)) {
            return [Exit.succeed(fromSource.value), durable(fromSource.value, now, false)]
          }

          // Refresh failure leaves the cell untouched: the held refresh
          // token survives so a retry can re-attempt with it.
          let held = Option.none<C>()
          if (current._tag !== "Empty") held = Option.some(current.creds)
          const refreshed = yield* config.refresh(held)
          return [Exit.succeed(refreshed), durable(refreshed, now, false)]
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
 * Convert a credential failure into the `HttpClientError` the SDK's
 * `transformClient` signature requires.
 *
 * - `CredentialRefreshUnavailable` becomes a `TransportError`. The AI SDKs
 *   map it to a retryable `NetworkError`, and the loop tries again.
 * - `ProviderAuthError` becomes an `EncodeError`: the credential is part of
 *   building the request, and the request cannot be built. The AI SDKs map
 *   it to a `NetworkError` that is not retryable, so the loop does not run a
 *   refresh that cannot succeed again. `resolveModel` checks the credential
 *   first, and `explainCredentialFailure` gives a later failure (after a 401,
 *   for example) the credential's own message.
 */
const asRequestError = (
  req: HttpClientRequest.HttpClientRequest,
  cause: CredentialFailure,
): HttpClientError => {
  if (cause._tag === "CredentialRefreshUnavailable") {
    return new HttpClientError({
      reason: new TransportError({ request: req, cause, description: cause.message }),
    })
  }
  return new HttpClientError({
    reason: new EncodeError({ request: req, cause, description: cause.message }),
  })
}

/** Fetch credentials for a request, surfacing a failure through the transport channel. */
export const freshCredentials = <C>(
  creds: CredentialCache<C>,
  req: HttpClientRequest.HttpClientRequest,
): Effect.Effect<C, HttpClientError> =>
  creds.getFresh.pipe(Effect.mapError((cause) => asRequestError(req, cause)))

/** True when the SDK failed a request before it was sent: the credential is one cause. */
const isUnbuiltRequest = (error: AiError.AiError): boolean =>
  error.reason._tag === "NetworkError" && error.reason.reason === "EncodeError"

/**
 * Give a request that failed on its credential the credential's own message.
 *
 * A permanent credential failure crosses the SDK as an `EncodeError`, and the
 * SDK drops its cause and adds a hint about the request body. This happens
 * after the resolve-time check, for example when a 401 forces a refresh and
 * the server rejects the refresh token. Wrap each SDK client call: when a
 * request fails before it was sent, check the credential again. A permanent
 * failure becomes an `AuthenticationError` that carries it in its metadata,
 * and the loop shows the user its own message. Any other result keeps the
 * SDK error.
 */
export const explainCredentialFailure =
  <C>(creds: CredentialCache<C>) =>
  <A>(effect: Effect.Effect<A, AiError.AiError>): Effect.Effect<A, AiError.AiError> =>
    effect.pipe(
      Effect.catchIf(isUnbuiltRequest, (error) =>
        creds.getFresh.pipe(
          Effect.matchEffect({
            onSuccess: () => Effect.fail(error),
            onFailure: (failure) => {
              if (failure._tag === "CredentialRefreshUnavailable") return Effect.fail(error)
              return Effect.fail(
                AiError.make({
                  module: error.module,
                  method: error.method,
                  reason: new AiError.AuthenticationError({
                    kind: "Unknown",
                    description: failure.message,
                    metadata: credentialFailureMetadata(failure),
                  }),
                }),
              )
            },
          }),
        ),
      ),
    )

/**
 * Check the credential before a model is handed to the loop. A permanent
 * failure fails `resolveModel` with the `ProviderAuthError` itself, which
 * the loop reports by its own message and does not retry. A failure that
 * passes is left to the request, which fails as retryable.
 */
export const checkCredentials = <C>(
  creds: CredentialCache<C>,
): Effect.Effect<void, ProviderAuthError> =>
  creds.getFresh.pipe(
    Effect.asVoid,
    Effect.catchTag("CredentialRefreshUnavailable", () => Effect.void),
  )

/** An HTTP response carried by a retry-signal error. */
export const HttpResponseField = Schema.declare<HttpClientResponse.HttpClientResponse>(
  (input): input is HttpClientResponse.HttpClientResponse =>
    Predicate.hasProperty(input, HttpClientResponse.TypeId),
)

/**
 * Internal error driving 401 recovery. The credential cache TTL can outlive
 * a token's last minute, and tokens can be revoked server-side between cache
 * fill and wire send. Typed so the recovery fires only on this signal, not on
 * other 4xx that callers should see verbatim.
 */
class Unauthorized401Error extends Schema.TaggedError<Unauthorized401Error>(
  "@gent/extensions/src/providers/Unauthorized401Error",
)("Unauthorized401Error", {
  response: HttpResponseField,
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

// ── oauth token endpoint ────────────────────────────────────────────────────

/**
 * An OAuth token POST runs inside the credential lock, so a hung endpoint
 * would block every request of that provider. The timeout bounds it.
 */
const OAUTH_TOKEN_TIMEOUT = "15 seconds"

/** A token POST that never produced a response: transport failure or timeout. */
class OAuthTokenPostError extends Schema.TaggedError<OAuthTokenPostError>(
  "@gent/extensions/src/providers/OAuthTokenPostError",
)("OAuthTokenPostError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

interface OAuthTokenResponse {
  readonly status: number
  readonly body: string
}

/**
 * POST a form to an OAuth token endpoint and read the reply. The status is
 * the caller's to judge: each provider words its own failure. The HTTP
 * client comes from context so a login flow can reuse the one it holds.
 */
export const postOAuthForm = (
  url: string,
  params: Record<string, string>,
): Effect.Effect<OAuthTokenResponse, OAuthTokenPostError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const response = yield* http.execute(
      HttpClientRequest.post(url).pipe(HttpClientRequest.bodyUrlParams(params)),
    )
    const body = yield* response.text
    return { status: response.status, body }
  }).pipe(
    Effect.timeoutOrElse({
      duration: OAUTH_TOKEN_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new OAuthTokenPostError({ message: `${url} timed out after ${OAUTH_TOKEN_TIMEOUT}` }),
        ),
    }),
    Effect.catchTag("HttpClientError", (cause) =>
      Effect.fail(new OAuthTokenPostError({ message: cause.message, cause })),
    ),
  )

// ── models.dev catalog ──────────────────────────────────────────────────────

/**
 * The models.dev catalog, owned by the drivers that list its models.
 *
 * Core resolves a model through the driver seam and concatenates every
 * driver's `listModels`. Where a driver's list comes from is the driver's
 * concern, so the fetch, the parse, and the disk cache live here — shared by
 * the anthropic, openai, and api-key-compat drivers.
 *
 * One load per home directory. `Effect.cached` memoizes it, so several drivers
 * listing at once share one read and at most one fetch. There is no background
 * refresh: a cache older than a day refetches on the next load, and a failed
 * fetch serves whatever the disk still holds. A load that finds neither a
 * cache nor a reachable host returns nothing and forgets its memo, so the next
 * call tries again instead of serving an empty catalog for the whole process.
 */

const MODELS_URL = "https://models.dev"
const CACHE_RELATIVE = ".gent/models.json"
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000
const EMPTY_MODELS = [] satisfies ReadonlyArray<Model>

const JsonSchema = Schema.fromJsonString(Schema.Json)
const CachedModelsJson = Schema.fromJsonString(Schema.Array(Model))
const decodeJson = Schema.decodeUnknownOption(JsonSchema)
const decodeCachedModels = Schema.decodeUnknownOption(CachedModelsJson)
const encodeCachedModels = Schema.encodeSync(CachedModelsJson)

const ModelsDevCost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
})
const ModelsDevLimit = Schema.Struct({
  context: Schema.Finite,
})
const ModelsDevModel = Schema.Struct({
  name: Schema.optional(Schema.String),
  cost: Schema.optional(ModelsDevCost),
  limit: Schema.optional(ModelsDevLimit),
  release_date: Schema.optional(Schema.String),
})
type ModelsDevModel = typeof ModelsDevModel.Type
const decodeModelsDevModel = Schema.decodeUnknownOption(ModelsDevModel)

const parsePricing = (value: ModelsDevModel["cost"]): Option.Option<ModelPricing> =>
  Option.fromUndefinedOr(value).pipe(Option.map(({ input, output }) => ({ input, output })))

const parseContextLength = (value: ModelsDevModel["limit"]): Option.Option<number> =>
  Option.fromUndefinedOr(value).pipe(Option.map(({ context }) => context))

/** The models.dev payload as gent's canonical `Model[]`; a malformed entry is dropped. */
const parseModelsDev = (data: Schema.Json): ReadonlyArray<Model> => {
  if (!isRecord(data)) return []

  const models: Model[] = []
  for (const [providerId, providerValue] of Object.entries(data)) {
    if (!isRecord(providerValue)) continue
    const modelsValue = providerValue["models"]
    if (!isRecord(modelsValue)) continue

    for (const [modelKey, rawModelValue] of Object.entries(modelsValue)) {
      const decoded = decodeModelsDevModel(rawModelValue)
      if (decoded._tag === "None") continue
      const modelValue = decoded.value
      const name = Option.getOrElse(Option.fromUndefinedOr(modelValue.name), () => modelKey)
      const pricing = parsePricing(modelValue.cost)
      const contextLength = parseContextLength(modelValue.limit)
      const releaseDate = Option.fromUndefinedOr(modelValue.release_date)
      const id = ModelId.make(`${providerId}/${modelKey}`)

      models.push(
        Model.make({
          id,
          name,
          provider: ProviderId.make(providerId),
          ...omitUndefined({
            contextLength: Option.getOrUndefined(contextLength),
            pricing: Option.getOrUndefined(pricing),
            releaseDate: Option.getOrUndefined(releaseDate),
          }),
        }),
      )
    }
  }

  return models
}

/** The catalog on disk, or nothing when the file is absent, empty, or malformed. */
const readCachedModels = Effect.fn("ModelsDev.readCache")(
  function* (cachePath: string) {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(cachePath)
    if (!exists) return EMPTY_MODELS
    const content = yield* fs
      .readFileString(cachePath)
      .pipe(Effect.catchEager(() => Effect.succeed("")))
    if (content.trim().length === 0) return EMPTY_MODELS
    return Option.getOrElse(decodeCachedModels(content), () => EMPTY_MODELS)
  },
  Effect.catchEager(() => Effect.succeed(EMPTY_MODELS)),
)

const writeCachedModels = Effect.fn("ModelsDev.writeCache")(
  function* (cachePath: string, models: ReadonlyArray<Model>) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const text = yield* Effect.try({
      try: () => encodeCachedModels(models),
      catch: () => "",
    })
    if (text.length === 0) return

    yield* fs.makeDirectory(path.dirname(cachePath), { recursive: true })
    yield* fs.writeFileString(cachePath, text)
  },
  Effect.catchEager((e) =>
    Effect.logWarning("failed to write model cache").pipe(
      Effect.annotateLogs({ error: String(e) }),
    ),
  ),
)

/** True when no cache file exists or its mtime is older than a day. */
const isCacheStale = Effect.fn("ModelsDev.isCacheStale")(
  function* (cachePath: string) {
    const fs = yield* FileSystem.FileSystem
    const info = yield* fs.stat(cachePath)
    const mtime = info.mtime
    if (Option.isNone(mtime)) return true
    const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
    return now - mtime.value.getTime() > CACHE_MAX_AGE_MS
  },
  Effect.catchEager(() => Effect.succeed(true)),
)

/** The remote catalog, or nothing when the request fails, times out, or is unparsable. */
const fetchRemoteModels = Effect.fn("ModelsDev.fetchRemote")(
  function* () {
    const http = yield* HttpClient.HttpClient
    const response = yield* http.get(`${MODELS_URL}/api.json`, {
      headers: { "User-Agent": "gent" },
    })
    if (response.status >= 400) return EMPTY_MODELS
    const text = yield* response.text
    if (text.length === 0) return EMPTY_MODELS
    const decoded = decodeJson(text)
    if (decoded._tag === "None") return EMPTY_MODELS
    return parseModelsDev(decoded.value)
  },
  Effect.timeout(FETCH_TIMEOUT_MS),
  Effect.catchEager(() => Effect.succeed(EMPTY_MODELS)),
)

const loadCatalog = Effect.fn("ModelsDev.load")(function* (home: string) {
  const path = yield* Path.Path
  const cachePath = path.join(home, CACHE_RELATIVE)
  const disk = yield* readCachedModels(cachePath)
  const stale = yield* isCacheStale(cachePath)
  if (disk.length > 0 && !stale) return disk

  const remote = yield* fetchRemoteModels()
  // A failed or empty fetch keeps whatever the disk still holds; stale is fine.
  if (remote.length === 0) return disk
  yield* writeCachedModels(cachePath, remote)
  return remote
})

type CatalogEffect = Effect.Effect<
  ReadonlyArray<Model>,
  never,
  FileSystem.FileSystem | Path.Path | HttpClient.HttpClient
>

/**
 * One memoized load per home directory. The drivers each call `driverCatalog`
 * during their own `listModels`, and the memo is what makes that one read and
 * at most one fetch rather than one per driver.
 *
 * A memo that resolved to a catalog holds for the life of the process. A memo
 * that resolved to nothing does not: `loadCatalog` degrades rather than fails,
 * so an offline start would otherwise pin an empty catalog until the process
 * ends. An empty result drops its own entry, and the next `listModels` loads
 * again.
 */
const catalogsByHome = new Map<string, CatalogEffect>()

/**
 * The models.dev catalog for `home`, loaded at most once per process while the
 * load produces models.
 *
 * The memo is built the first time a home is asked for and stored before the
 * effect is handed back, so every driver that lists models for the same home
 * shares one read and at most one fetch. `Effect.cached` is a constructor: it
 * allocates the latch and performs no IO, so building the memo here decides
 * nothing about when the catalog loads.
 */
export const modelsDevCatalog = (home: string): CatalogEffect => {
  const existing = Option.fromUndefinedOr(catalogsByHome.get(home))
  if (Option.isSome(existing)) return existing.value
  // `Effect.cached` only allocates the memo's latch — no IO, no failure — so
  // running it here is allocation, not work. The catalog loads when a driver
  // runs the effect this returns.
  const memo = Effect.runSync(Effect.cached(loadCatalog(home))).pipe(
    // An empty result means no cache and no reachable host. Forget it, so a
    // later call retries instead of serving nothing for the whole process.
    Effect.tap((models) =>
      Effect.sync(() => {
        if (models.length === 0) catalogsByHome.delete(home)
      }),
    ),
  )
  catalogsByHome.set(home, memo)
  return memo
}

/** The models.dev catalog narrowed to one provider — a driver's own list. */
export const driverCatalog = (home: string, providerId: string): CatalogEffect =>
  modelsDevCatalog(home).pipe(
    Effect.map((models) => models.filter((model) => model.provider === providerId)),
  )

/**
 * What a driver needs to serve its own catalog: the home directory that holds
 * the cache, and the platform services its setup captured. Both are plain
 * values a driver factory takes; neither is yielded inside a driver leaf.
 */
export interface CatalogSource {
  readonly home: string
  readonly platform: Context.Context<FileSystem.FileSystem | Path.Path>
}

/** Capture the home and platform services a driver's catalog needs. */
export const catalogSource = Effect.fn("ModelsDev.catalogSource")(function* (home: string) {
  const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
  return { home, platform } satisfies CatalogSource
})

/**
 * A driver's `listModels`: its own models.dev entries, with the platform
 * services and the HTTP client provided from what setup captured.
 */
export const driverListModels =
  (source: CatalogSource, providerId: string) => (): Effect.Effect<ReadonlyArray<Model>> =>
    driverCatalog(source.home, providerId).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off The catalog owns its own HTTP client at the driver boundary; it outlives no scope.
      Effect.provide(FetchHttpClient.layer),
      Effect.provideContext(source.platform),
    )

// ── openai-compatible driver ────────────────────────────────────────────────

const GOOGLE_COMPAT_URL = "https://generativelanguage.googleapis.com/v1beta/openai"
const MISTRAL_COMPAT_URL = "https://api.mistral.ai/v1"

type OpenAiCompatConfig = Required<Parameters<typeof OpenAiLanguageModel.layer>[0]>["config"]

export const readOptionalEnv = (name: string): Effect.Effect<Option.Option<string>> =>
  Config.option(Config.string(name)).pipe(Effect.orElseSucceed(() => Option.none()))

/** Sampling limits every OpenAI-compatible driver sends; reasoning effort is the driver's own mapping. */
export const buildOpenAiCompatConfig = (
  hints: Option.Option<ProviderHints>,
): OpenAiCompatConfig => {
  let config: OpenAiCompatConfig = {}
  if (Option.isSome(hints)) {
    const maxTokens = Option.fromNullishOr(hints.value.maxTokens)
    if (Option.isSome(maxTokens)) config = { ...config, max_tokens: maxTokens.value }
    const temperature = Option.fromNullishOr(hints.value.temperature)
    if (Option.isSome(temperature)) config = { ...config, temperature: temperature.value }
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
  const clientLayer = OpenAiClient.layer({
    apiKey: Redacted.make(params.apiKey),
    ...Option.match(params.apiUrl, { onNone: () => ({}), onSome: (apiUrl) => ({ apiUrl }) }),
  }).pipe(Layer.provide(FetchHttpClient.layer))
  const modelLayer = OpenAiLanguageModel.layer({
    model: params.modelName,
    config: params.config,
  }).pipe(Layer.provide(clientLayer))
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
  envCredential: params.envVarName,
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
        config: buildOpenAiCompatConfig(Option.fromNullishOr(hints)),
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
