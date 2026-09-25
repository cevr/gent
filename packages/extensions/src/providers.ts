import {
  Cause,
  Clock,
  Config,
  Context,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Hash,
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
  type ProviderAuthInfo,
  ProviderId,
  writeFileAtomic,
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

// Test seam: only a test reads modelsDevCatalog, the catalog loader, which it
// runs against a scratch home.

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
 * `invalidate` names the credential the server rejected. When the cell
 * still holds it, the next `getFresh` skips the cache but keeps it — its
 * refresh token is the only copy a provider without a keychain has.
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
  /**
   * The server rejected `rejected`. When the cell still holds it, skip the
   * cache on the next `getFresh` without dropping it; its refresh token may
   * be the only copy. When the cell holds another credential, do nothing.
   */
  readonly invalidate: (rejected: C) => Effect.Effect<void>
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
  Effect.sync(() => {
    const Cell = CredentialCacheCell(config.credentials)
    const sameCredential = Schema.toEquivalence(config.credentials)
    const durable = (creds: C, at: number, invalidated: boolean): CredentialCacheCell<C> =>
      Cell.cases.Durable.make({ creds, at, invalidated })

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
            if (Option.isNone(rotated)) return Effect.failCause(exit.cause)
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
          // After a 401 the source may still hold the rejected credential, and
          // its expiry says nothing about a revocation: only a refresh helps.
          const rejected =
            current._tag !== "Empty" &&
            current.invalidated &&
            Option.isSome(fromSource) &&
            sameCredential(fromSource.value, current.creds)
          if (
            !rejected &&
            Option.isSome(fromSource) &&
            freshEnoughAt(config.expiresAt(fromSource.value), now)
          ) {
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

    // Compare, then invalidate: a 401 for a credential the cell already
    // replaced says nothing about the one it holds now.
    const invalidate = (rejected: C): Effect.Effect<void> =>
      SynchronizedRef.update(config.cellRef, (cell) => {
        if (cell._tag === "Empty" || !sameCredential(cell.creds, rejected)) return cell
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
const freshCredentials = <C>(
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
 * Sign each request with a fresh credential, and recover once from a 401.
 *
 * Signing and recovery are one combinator because recovery must name the
 * credential the request carried. The credential cache TTL can outlive a
 * token's last minute, and a token can be revoked between cache fill and
 * wire send. On a 401 the cache invalidates the credential this request
 * sent — only if it still holds it — and the request is signed and sent
 * once more. A second 401 is a real auth failure: its response goes to the
 * caller, so user-facing recovery can start. Two requests that sent the same
 * old token therefore refresh it once: the later 401 names a credential the
 * cache already replaced.
 *
 * Signing stays in the request chain, where the SDK's own request mapping
 * (a base URL, its headers) wraps it. The SDK runs that chain inside the
 * response side, so each attempt gives the chain a slot, and the signing
 * step records there how to reject the credential it used.
 */
export const authorizedClient =
  <C>(
    creds: CredentialCache<C>,
    sign: (
      request: HttpClientRequest.HttpClientRequest,
      credential: C,
    ) => HttpClientRequest.HttpClientRequest,
  ) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient => {
    const signed = HttpClient.mapRequestEffect(client, (request) =>
      Effect.gen(function* () {
        const credential = yield* freshCredentials(creds, request)
        const slot = yield* CredentialRejection
        if (Option.isSome(slot)) slot.value.reject = creds.invalidate(credential)
        return sign(request, credential)
      }),
    )
    return HttpClient.makeWith((prepared) => {
      const send = Effect.gen(function* () {
        const slot = { reject: Effect.void }
        const response = yield* signed.postprocess(
          prepared.pipe(Effect.provideService(CredentialRejection, Option.some(slot))),
        )
        return { response, reject: slot.reject }
      })
      return Effect.gen(function* () {
        const first = yield* send
        if (first.response.status !== 401) return first.response
        yield* first.reject
        return (yield* send).response
      })
    }, signed.preprocess)
  }

/** Where one attempt's signing step records how to reject the credential it sent. */
const CredentialRejection = Context.Reference<Option.Option<{ reject: Effect.Effect<void> }>>(
  "@gent/extensions/src/providers/CredentialRejection",
  { defaultValue: () => Option.none() },
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

// ── reasoning effort ────────────────────────────────────────────────────────

/**
 * The effort a request names for a hint: the lowest level the model accepts
 * at or above `level`, else the highest it accepts. `order` ranks every level
 * lowest first; `accepts` is the model's own list, in the same order. A model
 * that accepts nothing gets none.
 */
export const effortAtOrAbove = <Level extends string>(
  order: ReadonlyArray<Level>,
  accepts: ReadonlyArray<Level>,
  level: Level,
): Option.Option<Level> => {
  const rank = order.indexOf(level)
  return Option.fromUndefinedOr(accepts.find((each) => order.indexOf(each) >= rank)).pipe(
    Option.orElse(() => Option.fromUndefinedOr(accepts.at(-1))),
  )
}

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
 * refresh: a cache older than a day, or written in another format, refetches
 * on the next load, and a failed fetch serves whatever the disk still holds. A load that finds neither a
 * cache nor a reachable host returns nothing and forgets its memo, so the next
 * call tries again instead of serving an empty catalog for the whole process.
 */

const MODELS_URL = "https://models.dev"
const CACHE_RELATIVE = ".gent/models.json"
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000
const EMPTY_MODELS = [] satisfies ReadonlyArray<Model>

const JsonSchema = Schema.fromJsonString(Schema.Json)
const decodeJson = Schema.decodeUnknownOption(JsonSchema)

const ModelsDevCost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache_read: Schema.optional(Schema.Finite),
  cache_write: Schema.optional(Schema.Finite),
})
const ModelsDevLimit = Schema.Struct({
  context: Schema.Finite,
  /** The input cap, where it is below the window (the GPT-5 family: 272k of 400k). */
  input: Schema.optional(Schema.Finite),
  /** The most output one reply may carry. */
  output: Schema.optional(Schema.Finite),
})
const ModelsDevModel = Schema.Struct({
  name: Schema.optional(Schema.String),
  cost: Schema.optional(ModelsDevCost),
  limit: Schema.optional(ModelsDevLimit),
  release_date: Schema.optional(Schema.String),
  /** False for embedding, image and other models the agent loop cannot drive. */
  tool_call: Schema.optional(Schema.Boolean),
  reasoning: Schema.optional(Schema.Boolean),
})
type ModelsDevModel = typeof ModelsDevModel.Type
const decodeModelsDevModel = Schema.decodeUnknownOption(ModelsDevModel)

/**
 * The format of the disk cache, derived from the two shapes that decide what
 * a cached catalog holds: the models.dev entry the parser reads and the
 * `Model` it writes. A build that parses a new field, or adds one to `Model`,
 * gets a new format, so a cache an older build wrote refetches at once
 * instead of serving models without that field for up to a day.
 */
const CACHE_FORMAT = (
  Hash.string(
    Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))([
      Schema.toJsonSchemaDocument(ModelsDevModel),
      Schema.toJsonSchemaDocument(Model),
    ]),
  ) >>> 0
).toString(16)

/**
 * The cache file: the catalog and the format that wrote it. A bare array is a
 * file from a build before the format stamp; it still decodes, so an offline
 * load can serve it.
 */
const CachedCatalog = Schema.Struct({ format: Schema.String, models: Schema.Array(Model) })
const CachedCatalogJson = Schema.fromJsonString(Schema.Union([CachedCatalog, Schema.Array(Model)]))
const decodeCachedCatalog = Schema.decodeUnknownOption(CachedCatalogJson)
const encodeCachedCatalog = Schema.encodeSync(CachedCatalogJson)

interface DiskCatalog {
  readonly models: ReadonlyArray<Model>
  /** True when this build's format wrote the file. */
  readonly current: boolean
}
const NO_DISK_CATALOG: DiskCatalog = { models: EMPTY_MODELS, current: false }

const parsePricing = (value: ModelsDevModel["cost"]): Option.Option<ModelPricing> =>
  Option.fromUndefinedOr(value).pipe(
    Option.map((cost) => ({
      input: cost.input,
      output: cost.output,
      ...omitUndefined({ cacheRead: cost.cache_read, cacheWrite: cost.cache_write }),
    })),
  )

const parseContextLength = (value: ModelsDevModel["limit"]): Option.Option<number> =>
  Option.fromUndefinedOr(value).pipe(Option.map(({ context }) => context))

const parseInputLimit = (value: ModelsDevModel["limit"]): Option.Option<number> =>
  Option.fromUndefinedOr(value).pipe(Option.flatMap(({ input }) => Option.fromUndefinedOr(input)))

const parseOutputLimit = (value: ModelsDevModel["limit"]): Option.Option<number> =>
  Option.fromUndefinedOr(value).pipe(Option.flatMap(({ output }) => Option.fromUndefinedOr(output)))

/**
 * The models.dev payload as gent's canonical `Model[]`. A malformed entry is
 * dropped, and so is a model without tool calling: every gent turn sends tools.
 */
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
      if (modelValue.tool_call === false) continue
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
            inputLimit: Option.getOrUndefined(parseInputLimit(modelValue.limit)),
            outputLimit: Option.getOrUndefined(parseOutputLimit(modelValue.limit)),
            pricing: Option.getOrUndefined(pricing),
            releaseDate: Option.getOrUndefined(releaseDate),
            reasoning: modelValue.reasoning,
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
    if (!exists) return NO_DISK_CATALOG
    const content = yield* fs
      .readFileString(cachePath)
      .pipe(Effect.catchEager(() => Effect.succeed("")))
    if (content.trim().length === 0) return NO_DISK_CATALOG
    return Option.match(decodeCachedCatalog(content), {
      onNone: () => NO_DISK_CATALOG,
      onSome: (cached): DiskCatalog => {
        if (!("format" in cached)) return { models: cached, current: false }
        return { models: cached.models, current: cached.format === CACHE_FORMAT }
      },
    })
  },
  Effect.catchEager(() => Effect.succeed(NO_DISK_CATALOG)),
)

const writeCachedModels = Effect.fn("ModelsDev.writeCache")(
  function* (cachePath: string, models: ReadonlyArray<Model>) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const text = yield* Effect.try({
      try: () => encodeCachedCatalog({ format: CACHE_FORMAT, models }),
      catch: () => "",
    })
    if (text.length === 0) return

    yield* fs.makeDirectory(path.dirname(cachePath), { recursive: true })
    // Another gent process may read the cache while this one writes it.
    yield* writeFileAtomic(cachePath, text)
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
  if (disk.models.length > 0 && disk.current && !stale) return disk.models

  const remote = yield* fetchRemoteModels()
  // A failed or empty fetch keeps whatever the disk still holds: stale, or
  // in an older format, is better than no catalog.
  if (remote.length === 0) return disk.models
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
 * A memo that resolved to a catalog holds for `CATALOG_MEMO_TTL`, then the next
 * `listModels` loads again. `loadCatalog` degrades rather than fails, so an
 * offline start serves the stale disk cache (or nothing); the reload re-reads
 * the disk and fetches only when the cache is still stale, so a long-lived
 * process picks up the fresh catalog once the host is reachable. A memo that
 * resolved to nothing drops its own entry at once, and the next `listModels`
 * loads again.
 */
const CATALOG_MEMO_TTL = Duration.minutes(5)

const catalogsByHome = new Map<string, CatalogEffect>()

/**
 * The models.dev catalog for `home`, loaded at most once per `CATALOG_MEMO_TTL`
 * while the load produces models.
 *
 * The memo is built the first time a home is asked for and stored before the
 * effect is handed back, so every driver that lists models for the same home
 * shares one read and at most one fetch. `Effect.cachedWithTTL` is a constructor: it
 * allocates the latch and performs no IO, so building the memo here decides
 * nothing about when the catalog loads.
 */
export const modelsDevCatalog = (home: string): CatalogEffect => {
  const existing = Option.fromUndefinedOr(catalogsByHome.get(home))
  if (Option.isSome(existing)) return existing.value
  // `Effect.cachedWithTTL` only allocates the memo's latch — no IO, no failure —
  // so running it here is allocation, not work. The catalog loads when a driver
  // runs the effect this returns, and the TTL reads that driver's clock.
  const memo = Effect.runSync(Effect.cachedWithTTL(loadCatalog(home), CATALOG_MEMO_TTL)).pipe(
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

// ── host context update ─────────────────────────────────────────────────────

/**
 * A system message after the conversation (the runtime's turn notices) is
 * the host speaking, not the user. An API that takes no system message after
 * the conversation gets it as a user message in this wrap: the Anthropic SDK
 * builds this text from a later system message (`prepareMessages` in
 * `@effect/ai-anthropic`), and the OpenAI-compatible drivers build it here.
 * The Anthropic driver reads the wrap to keep its cache marker off the update.
 * The content is escaped, so a notice cannot close the wrap.
 */
const HOST_CONTEXT_UPDATE_OPEN = "<host-context-update>\n"
const HOST_CONTEXT_UPDATE_CLOSE = "\n</host-context-update>"

/** The user-message text that carries a later system message. */
export const hostContextUpdateText = (content: string): string =>
  `${HOST_CONTEXT_UPDATE_OPEN}${content.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}${HOST_CONTEXT_UPDATE_CLOSE}`

/** True for a text block that carries a later system message. */
export const isHostContextUpdateText = Schema.is(
  Schema.String.check(Schema.isStartsWith(HOST_CONTEXT_UPDATE_OPEN)),
)

// ── openai-compatible driver ────────────────────────────────────────────────

const GOOGLE_COMPAT_URL = "https://generativelanguage.googleapis.com/v1beta/openai"
const MISTRAL_COMPAT_URL = "https://api.mistral.ai/v1"

type OpenAiCompatConfig = Required<Parameters<typeof OpenAiLanguageModel.layer>[0]>["config"]

export const readOptionalEnv = (name: string): Effect.Effect<Option.Option<string>> =>
  Config.option(Config.nonEmptyString(name)).pipe(Effect.orElseSucceed(() => Option.none()))

/** The API key a driver sends: a stored key first, then its env variable. */
export const apiKeyFrom = (
  authInfo: Option.Option<ProviderAuthInfo>,
  envApiKey: Option.Option<string>,
): Option.Option<string> =>
  authInfo.pipe(
    Option.flatMap((auth) => {
      if (auth._tag === "Api") return Option.some(auth.key)
      return Option.none()
    }),
    Option.orElse(() => envApiKey),
  )

const ChatBodyJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const decodeChatBody = Schema.decodeUnknownOption(ChatBodyJson)
const ChatMessages = Schema.Array(Schema.Unknown)
const isChatMessages = Schema.is(ChatMessages)
/** A system message as the SDK encodes it; it names `developer` for some model ids. */
const isSystemChatMessage = Schema.is(
  Schema.Struct({ role: Schema.Literals(["system", "developer"]), content: Schema.String }),
)
const isDeveloperChatMessage = Schema.is(
  Schema.Struct({ role: Schema.Literal("developer"), content: Schema.String }),
)

/**
 * The request in the shape a chat-completions API expects of the system
 * messages. The leading run (the system prompt, one message per cache block
 * from `toPrompt`) goes as one message, joined as the blocks join: only the
 * Anthropic marker reads the blocks, and these APIs cache prefixes on their
 * own. The system messages after the last conversation message go as a host
 * context update: Mistral rejects a request whose last message is not user or
 * tool, and `toPrompt` puts the turn notices there. A system message inside
 * the conversation keeps its role: the rule is about the last message only.
 * Every system message goes with the `system` role: the SDK names `developer`
 * for any model id that starts with `o` (Mistral's `open-*` models), and the
 * Mistral chat schema has no `developer` role.
 */
const withHostContextUpdates = (
  request: HttpClientRequest.HttpClientRequest,
): HttpClientRequest.HttpClientRequest => {
  if (request.body._tag !== "Uint8Array") return request
  const body = decodeChatBody(new TextDecoder().decode(request.body.body))
  if (Option.isNone(body)) return request
  const messages = body.value["messages"]
  if (!isChatMessages(messages)) return request
  const start = messages.findIndex((message) => !isSystemChatMessage(message))
  const end = messages.findLastIndex((message) => !isSystemChatMessage(message))
  if (start < 0) return request
  const leading = messages.slice(0, start).filter(isSystemChatMessage)
  const developer = messages.some(isDeveloperChatMessage)
  if (!developer && leading.length <= 1 && end === messages.length - 1) return request
  const head = Option.match(Option.fromUndefinedOr(leading[0]), {
    onNone: () => [],
    onSome: () => [
      { role: "system", content: leading.map((message) => message.content).join("\n\n") },
    ],
  })
  const conversation = messages.slice(start, end + 1).map((message) => {
    if (!isDeveloperChatMessage(message)) return message
    return { ...message, role: "system" }
  })
  const trailing = messages.slice(end + 1).map((message) => {
    if (!isSystemChatMessage(message)) return message
    return { role: "user", content: hostContextUpdateText(message.content) }
  })
  return HttpClientRequest.bodyJsonUnsafe(request, {
    ...body.value,
    messages: [...head, ...conversation, ...trailing],
  })
}

const makeApiKeyCompatDriver = (params: {
  readonly id: string
  readonly name: string
  readonly envApiKey: Option.Option<string>
  readonly envVarName: string
  readonly apiUrl: string
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
      const apiKey = apiKeyFrom(Option.fromUndefinedOr(authInfo), params.envApiKey)
      if (Option.isNone(apiKey)) {
        return yield* new ProviderAuthError({
          message: `${params.name} credentials unavailable: no stored API key or ${params.envVarName} env var`,
        })
      }
      // The sampling limits the chat-completions APIs take.
      let config: OpenAiCompatConfig = {}
      const maxTokens = Option.fromNullishOr(hints?.maxTokens)
      if (Option.isSome(maxTokens)) config = { ...config, max_tokens: maxTokens.value }
      const temperature = Option.fromNullishOr(hints?.temperature)
      if (Option.isSome(temperature)) config = { ...config, temperature: temperature.value }
      const clientLayer = OpenAiClient.layer({
        apiKey: Redacted.make(apiKey.value),
        apiUrl: params.apiUrl,
        transformClient: HttpClient.mapRequest(withHostContextUpdates),
      }).pipe(Layer.provide(FetchHttpClient.layer))
      const modelLayer = OpenAiLanguageModel.layer({ model: modelName, config }).pipe(
        Layer.provide(clientLayer),
      )
      return AiModel.make(params.id, modelName, modelLayer)
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
          apiUrl: params.apiUrl,
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
