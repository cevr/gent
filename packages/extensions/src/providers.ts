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
  Option,
  Path,
  Predicate,
  Schema,
  Scope,
  SynchronizedRef,
} from "effect"
import {
  isRecord,
  isRecordArray,
  type JsonRecord,
  Model,
  ModelId,
  type ModelPricing,
  omitUndefined,
  credentialFailureMetadata,
  ProviderAuthError,
  type ProviderAuthInfo,
  type ProviderHints,
  ProviderId,
  writeFileAtomic,
} from "@gent/core/extensions/api"
import {
  FetchHttpClient,
  type Headers,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http"
import { EncodeError, HttpClientError, TransportError } from "effect/http/HttpClientError"
import { AiError } from "effect/ai"
import { makeStartedMemo } from "./started-memo.js"

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

    // A refresh and the write of its result are one step a caller cannot
    // stop: the provider spends the token it is sent, so a rotation stopped
    // before it is stored would leave only the spent token. The step is
    // uninterruptible from the lock to the cell write, except the store
    // retry and the source read (`restore`). Request and interruptible IO
    // timeouts bound those operations. Masked filesystem acquisition and
    // finalizers can exceed the deadline, so the full step has no absolute bound.
    const getFresh: Effect.Effect<C, CredentialFailure> = Effect.uninterruptibleMask((restore) =>
      SynchronizedRef.modifyEffect(config.cellRef, (cell): Effect.Effect<Step, CredentialFailure> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const current = yield* restore(settlePending(cell, now))
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
          if (Option.isSome(config.read)) fromSource = yield* restore(config.read.value(cached))
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
      ),
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

// ── json request bodies ─────────────────────────────────────────────────────

/**
 * The provider SDKs send every JSON body as bytes (`bodyJsonUnsafe`). A
 * driver that rewrites a request reads the body with `requestJsonObject` and
 * writes it back the same way; a body of any other kind passes unread.
 */
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))
const isObject = Schema.is(Schema.JsonObject)
const isArray = Schema.is(Schema.Array(Schema.Json))

/** True for a JSON object (not an array). */
export const isJsonObject = (value: Schema.Json): value is Schema.JsonObject => isObject(value)

/** The request's JSON object body; none for any other body. */
export const requestJsonObject = (
  request: HttpClientRequest.HttpClientRequest,
): Option.Option<Schema.JsonObject> => {
  if (request.body._tag !== "Uint8Array") return Option.none()
  return decodeJson(new TextDecoder().decode(request.body.body)).pipe(Option.filter(isJsonObject))
}

/** A client that rewrites each JSON object body with `rewrite`; any other body passes. */
export const rewriteJsonBody =
  (rewrite: (body: Schema.JsonObject) => Schema.JsonObject) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    HttpClient.mapRequest(client, (request) =>
      Option.match(requestJsonObject(request), {
        onNone: () => request,
        onSome: (body) => HttpClientRequest.bodyJsonUnsafe(request, rewrite(body)),
      }),
    )

// ── responses requests ──────────────────────────────────────────────────────

/**
 * How long OpenAI keeps a Responses prompt cached. OpenAI documents 5 to 10
 * minutes of inactivity for in-memory prompt caching, but a cache lives
 * longer in practice: in the owner's Codex transcripts 238 of 244 requests
 * after a 5-10 minute gap, and 108 of 110 after a 10-30 minute gap, still read
 * the cache. At 5 minutes about 45% of the turn starts a cold handoff would
 * compact had a warm cache. The OpenAI driver and the OpenCode gateways'
 * Responses models use it.
 */
export const RESPONSES_PROMPT_CACHE_TTL = Duration.minutes(30)

/**
 * A Responses request with `store: false` keeps no reasoning on the server,
 * so a reasoning item can go back to the model only with its
 * `encrypted_content`, and a reply carries that only when `include` asks for
 * it. `@effect/ai-openai` asks only for the model prefixes it knows (`o1`,
 * `o3`, `o4-mini`, `codex-mini`, `gpt-5`), and its computed `include`
 * replaces any the config names. So every request without store to a model
 * that reasons asks for it here. A reasoning model reasons at its default
 * effort when the request names none, so the model decides, not the body's
 * `reasoning` field.
 */
const ENCRYPTED_REASONING = "reasoning.encrypted_content"

/** Whether the resolved model reasons: the catalog's word (`supportsReasoning`), else `fallback`. */
export const modelReasons = (
  hints: Option.Option<ProviderHints>,
  fallback: () => boolean,
): boolean =>
  Option.getOrElse(
    Option.flatMap(hints, (value) => Option.fromUndefinedOr(value.supportsReasoning)),
    fallback,
  )

export const withEncryptedReasoning =
  (reasons: boolean) =>
  (body: Schema.JsonObject): Schema.JsonObject => {
    if (body["store"] !== false || !reasons) return body
    const include = Option.getOrElse(
      Option.filter(Option.fromUndefinedOr(body["include"]), isArray),
      (): ReadonlyArray<Schema.Json> => [],
    )
    if (include.includes(ENCRYPTED_REASONING)) return body
    return { ...body, include: [...include, ENCRYPTED_REASONING] }
  }

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
 * the anthropic and openai drivers.
 *
 * One load per home directory. `makeStartedMemo` memoizes it, so several drivers
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
 * One reasoning control a model accepts, as models.dev lists it under
 * `reasoning_options`: a list of effort values, an on/off toggle, or a
 * thinking budget in tokens. models.dev writes the "no reasoning" effort as
 * `null`; the catalog keeps it as `"none"`.
 */
export const ReasoningOption = Schema.Union([
  Schema.Struct({ type: Schema.Literal("effort"), values: Schema.Array(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("toggle") }),
  Schema.Struct({
    type: Schema.Literal("budget_tokens"),
    min: Schema.optional(Schema.Finite),
    max: Schema.optional(Schema.Finite),
  }),
]).pipe(Schema.toTaggedUnion("type"))
export type ReasoningOption = typeof ReasoningOption.Type

/**
 * How a driver talks to a model, from its models.dev entry. A gateway that
 * serves several wire formats names each model's format here, so the driver
 * reads it instead of keeping its own list.
 */
export const ModelWire = Schema.Struct({
  /**
   * The AI SDK package models.dev names for the model's API: the model's own
   * `provider.npm`, else its provider's `npm`. The package names the wire
   * format (`@ai-sdk/openai` Responses, `@ai-sdk/anthropic` Messages,
   * `@ai-sdk/openai-compatible` Chat Completions).
   */
  npm: Schema.optional(Schema.String),
  /** The reasoning controls the model accepts; empty when it has none to set. */
  reasoningOptions: Schema.optional(Schema.Array(ReasoningOption)),
  /**
   * The assistant-message field that carries the model's reasoning back to it
   * (`interleaved.field`, such as `reasoning_content`).
   */
  reasoningField: Schema.optional(Schema.String),
})
export type ModelWire = typeof ModelWire.Type

/** The wire fields of a models.dev entry, each decoded alone so one odd field drops only itself. */
const ModelsDevWireFields = Schema.Struct({
  provider: Schema.optional(Schema.Json),
  reasoning_options: Schema.optional(Schema.Json),
  interleaved: Schema.optional(Schema.Json),
})
type ModelsDevWireFields = typeof ModelsDevWireFields.Type
const decodeModelsDevWireFields = Schema.decodeUnknownOption(ModelsDevWireFields)
const decodeNpm = Schema.decodeUnknownOption(Schema.Struct({ npm: Schema.String }))
const decodeRawReasoningOptions = Schema.decodeUnknownOption(Schema.Array(Schema.Json))
const decodeReasoningOption = Schema.decodeUnknownOption(ReasoningOption)
const RawEffortOption = Schema.Struct({
  type: Schema.Literal("effort"),
  values: Schema.Array(Schema.Json),
})
const decodeRawEffortOption = Schema.decodeUnknownOption(RawEffortOption)
const decodeReasoningField = Schema.decodeUnknownOption(Schema.Struct({ field: Schema.String }))

/** One `reasoning_options` entry; an effort list's `null` becomes `"none"`. */
const parseReasoningOption = (value: Schema.Json): Option.Option<ReasoningOption> =>
  Option.match(decodeRawEffortOption(value), {
    onNone: () => decodeReasoningOption(value),
    onSome: (effort) =>
      Option.some(
        ReasoningOption.cases.effort.make({
          type: "effort",
          values: effort.values.flatMap((each) => {
            if (Predicate.isString(each)) return [each]
            if (Predicate.isNull(each)) return ["none"]
            return []
          }),
        }),
      ),
  })

/**
 * The wire facts of one models.dev entry; none when it names nothing a driver
 * reads. Each field is decoded alone, so an odd one drops only itself, never
 * the model.
 */
const parseModelWire = (
  fields: ModelsDevWireFields,
  providerNpm: Option.Option<string>,
): Option.Option<ModelWire> => {
  const npm = decodeNpm(fields.provider).pipe(
    Option.map((value) => value.npm),
    Option.orElse(() => providerNpm),
  )
  const reasoningOptions = decodeRawReasoningOptions(fields.reasoning_options).pipe(
    Option.map((values) => values.flatMap((each) => Option.toArray(parseReasoningOption(each)))),
  )
  const reasoningField = Option.map(
    decodeReasoningField(fields.interleaved),
    (value) => value.field,
  )
  if (Option.isNone(npm) && Option.isNone(reasoningOptions) && Option.isNone(reasoningField)) {
    return Option.none()
  }
  return Option.some(
    ModelWire.make(
      omitUndefined({
        npm: Option.getOrUndefined(npm),
        reasoningOptions: Option.getOrUndefined(reasoningOptions),
        reasoningField: Option.getOrUndefined(reasoningField),
      }),
    ),
  )
}

/**
 * The format of the disk cache, derived from the shapes that decide what a
 * cached catalog holds: the models.dev entry the parser reads, and the
 * `Model` and `ModelWire` it writes. A build that parses a new field, or adds
 * one to either, gets a new format, so a cache an older build wrote refetches
 * at once instead of serving models without that field for up to a day.
 */
const CACHE_FORMAT = (
  Hash.string(
    Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))([
      Schema.toJsonSchemaDocument(ModelsDevModel),
      Schema.toJsonSchemaDocument(Model),
      Schema.toJsonSchemaDocument(ModelWire),
    ]),
  ) >>> 0
).toString(16)

/** The wire facts of the catalog's models, by model id; a model that names none has no entry. */
const CatalogWire = Schema.Record(Schema.String, ModelWire)
type CatalogWire = typeof CatalogWire.Type

/** One parsed catalog: the models, and how a driver talks to each. */
interface Catalog {
  readonly models: ReadonlyArray<Model>
  readonly wire: CatalogWire
}
const EMPTY_CATALOG: Catalog = { models: EMPTY_MODELS, wire: {} }

/**
 * The cache file: the catalog and the format that wrote it. A file without
 * the stamp reads as absent, so the next load fetches and rewrites it.
 */
const CachedCatalog = Schema.Struct({
  format: Schema.String,
  models: Schema.Array(Model),
  wire: Schema.optional(CatalogWire),
})
const CachedCatalogJson = Schema.fromJsonString(CachedCatalog)
const decodeCachedCatalog = Schema.decodeUnknownOption(CachedCatalogJson)
const encodeCachedCatalog = Schema.encodeSync(CachedCatalogJson)

interface DiskCatalog {
  readonly catalog: Catalog
  /** True when this build's format wrote the file. */
  readonly current: boolean
}
const NO_DISK_CATALOG: DiskCatalog = { catalog: EMPTY_CATALOG, current: false }

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
 * The models.dev payload as gent's canonical `Model[]`, with each model's wire
 * facts. A malformed entry is dropped, and so is a model without tool calling:
 * every gent turn sends tools.
 */
const parseModelsDev = (data: Schema.Json): Catalog => {
  if (!isRecord(data)) return EMPTY_CATALOG

  const models: Model[] = []
  const wire: Record<string, ModelWire> = {}
  for (const [providerId, providerValue] of Object.entries(data)) {
    if (!isRecord(providerValue)) continue
    const modelsValue = providerValue["models"]
    if (!isRecord(modelsValue)) continue
    const providerNpm = Option.map(decodeNpm(providerValue), (value) => value.npm)

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
      const modelWire = Option.flatMap(decodeModelsDevWireFields(rawModelValue), (fields) =>
        parseModelWire(fields, providerNpm),
      )
      if (Option.isSome(modelWire)) wire[id] = modelWire.value
    }
  }

  return { models, wire }
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
      onSome: (cached): DiskCatalog => ({
        catalog: {
          models: cached.models,
          wire: Option.getOrElse(Option.fromUndefinedOr(cached.wire), () => ({})),
        },
        current: cached.format === CACHE_FORMAT,
      }),
    })
  },
  Effect.catchEager(() => Effect.succeed(NO_DISK_CATALOG)),
)

const writeCachedModels = Effect.fn("ModelsDev.writeCache")(
  function* (cachePath: string, catalog: Catalog) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const text = yield* Effect.try({
      try: () =>
        encodeCachedCatalog({ format: CACHE_FORMAT, models: catalog.models, wire: catalog.wire }),
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
    if (response.status >= 400) return EMPTY_CATALOG
    const text = yield* response.text
    if (text.length === 0) return EMPTY_CATALOG
    const decoded = decodeJson(text)
    if (decoded._tag === "None") return EMPTY_CATALOG
    return parseModelsDev(decoded.value)
  },
  Effect.timeout(FETCH_TIMEOUT_MS),
  Effect.catchEager(() => Effect.succeed(EMPTY_CATALOG)),
)

const loadCatalog = Effect.fn("ModelsDev.load")(function* (home: string) {
  const path = yield* Path.Path
  const cachePath = path.join(home, CACHE_RELATIVE)
  const disk = yield* readCachedModels(cachePath)
  const stale = yield* isCacheStale(cachePath)
  if (disk.catalog.models.length > 0 && disk.current && !stale) return disk.catalog

  const remote = yield* fetchRemoteModels()
  // A failed or empty fetch keeps whatever the disk still holds: stale, or
  // in an older format, is better than no catalog.
  if (remote.models.length === 0) return disk.catalog
  yield* writeCachedModels(cachePath, remote)
  return remote
})

type CatalogServices = FileSystem.FileSystem | Path.Path | HttpClient.HttpClient
type CatalogEffect = Effect.Effect<ReadonlyArray<Model>, never, CatalogServices>

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
 *
 * The memo starts the load as its own fiber (`makeStartedMemo`). A caller
 * that is stopped (an Esc during the day's first fetch) only stops waiting:
 * the load goes on, with a timeout on its fetch, and the next caller joins
 * it instead of getting the interruption back.
 */
const CATALOG_MEMO_TTL = Duration.minutes(5)

/** A catalog holds for `CATALOG_MEMO_TTL`; an empty one (no cache, no reachable host) is not kept. */
const catalogMemoTtl = (catalog: Catalog) => {
  if (catalog.models.length > 0) return CATALOG_MEMO_TTL
  return Duration.zero
}

// The memo lives as long as the process, so its loads run in a scope that
// never closes. Building it only allocates — no IO, no failure — so running
// it here is allocation, not work. The services come from each `get`.
const catalogsByHome = Effect.runSync(
  makeStartedMemo({ load: loadCatalog, keep: catalogMemoTtl }).pipe(
    Effect.provideService(Scope.Scope, Scope.makeUnsafe()),
  ),
)

/**
 * The parsed catalog for `home`, loaded at most once per `CATALOG_MEMO_TTL`
 * while the load produces models. Every driver that lists models for the same
 * home shares one read and at most one fetch.
 */
const catalogFor = (home: string): Effect.Effect<Catalog, never, CatalogServices> =>
  catalogsByHome.get(home)

/** The models.dev catalog for `home`: every provider's models. */
export const modelsDevCatalog = (home: string): CatalogEffect =>
  catalogFor(home).pipe(Effect.map((catalog) => catalog.models))

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
 * services and the HTTP client provided from what setup captured. Each entry
 * carries `promptCacheTtl`, how long the driver's provider keeps a request's
 * prompt cached; models.dev does not say. A driver whose models differ passes
 * none and stamps each model with `withPromptCacheTtl`.
 */
export const driverListModels =
  (source: CatalogSource, providerId: string, promptCacheTtl: Option.Option<Duration.Duration>) =>
  (): Effect.Effect<ReadonlyArray<Model>> =>
    readCatalog(
      source,
      driverCatalog(source.home, providerId).pipe(
        Effect.map((models) => models.map((model) => withPromptCacheTtl(model, promptCacheTtl))),
      ),
    )

/** The model with `promptCacheTtl` as its cache lifetime; a model with none never goes cold. */
export const withPromptCacheTtl = (
  model: Model,
  promptCacheTtl: Option.Option<Duration.Duration>,
): Model =>
  Option.match(promptCacheTtl, {
    onNone: () => model,
    onSome: (ttl) => Model.make({ ...model, promptCacheTtlMs: Duration.toMillis(ttl) }),
  })

/**
 * The wire facts of one model of the catalog, for a driver's `resolveModel`:
 * none when the catalog has no entry for it or the entry names nothing.
 */
export const driverModelWire = (
  source: CatalogSource,
  modelId: string,
): Effect.Effect<Option.Option<ModelWire>> =>
  readCatalog(
    source,
    catalogFor(source.home).pipe(
      Effect.map((catalog) => Option.fromUndefinedOr(catalog.wire[modelId])),
    ),
  )

/** A catalog read, run on the platform setup captured with an HTTP client of its own. */
const readCatalog = <A>(
  source: CatalogSource,
  read: Effect.Effect<A, never, CatalogServices>,
): Effect.Effect<A> =>
  read.pipe(
    // @effect-diagnostics-next-line strictEffectProvide:off -- The catalog owns its own HTTP client at the driver boundary; it outlives no scope.
    Effect.provide(FetchHttpClient.layer),
    Effect.provideContext(source.platform),
  )

// ── host context update ─────────────────────────────────────────────────────

/**
 * A system message after the conversation (the runtime's turn notices) is
 * the host speaking, not the user. An API that takes no system message after
 * the conversation gets it as a user message in this wrap: the Anthropic SDK
 * builds this text from a later system message (`prepareMessages` in
 * `@effect/ai-anthropic`, patched). The Messages drivers read the wrap to keep
 * their cache markers off the update. The content is escaped, so a notice
 * cannot close the wrap.
 */
const HOST_CONTEXT_UPDATE_OPEN = "<host-context-update>\n"
const HOST_CONTEXT_UPDATE_CLOSE = "\n</host-context-update>"

/** The user-message text that carries a later system message. */
export const hostContextUpdateText = (content: string): string =>
  `${HOST_CONTEXT_UPDATE_OPEN}${content.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}${HOST_CONTEXT_UPDATE_CLOSE}`

/** True for a text block that carries a later system message. */
const isHostContextUpdateText = Schema.is(
  Schema.String.check(Schema.isStartingWith(HOST_CONTEXT_UPDATE_OPEN)),
)

// ── messages prompt cache ───────────────────────────────────────────────────
//
// The block rule both Messages drivers (Anthropic, and the OpenCode gateways'
// Messages models) mark by. A request that names no conversation (its hints
// carry no `cacheKey`: the compaction summary) writes no cache, since no later
// request reads it back. A marker goes on a block the API takes one on, never
// on a thinking block or an empty text block (the API refuses it), and never
// on a host context update, which the next turn does not repeat.

const CACHEABLE_BLOCK_TYPES: ReadonlySet<unknown> = new Set([
  "text",
  "image",
  "document",
  "search_result",
  "tool_use",
  "tool_result",
])

/** Whether a request writes a prompt cache: only one that names its conversation. */
export const writesPromptCache = (hints: Option.Option<ProviderHints>): boolean =>
  Option.exists(hints, (value) => Predicate.isNotUndefined(value.cacheKey))

/** True for a content block that takes `cache_control`. */
export const isCacheableBlock = (block: JsonRecord): boolean =>
  CACHEABLE_BLOCK_TYPES.has(block["type"]) && !(block["type"] === "text" && block["text"] === "")

/** True for a user message the SDK built from a later system message, not from the conversation. */
export const isHostContextUpdate = (message: JsonRecord): boolean => {
  const content = message["content"]
  if (message["role"] !== "user" || !isRecordArray(content) || content.length === 0) return false
  return content.every(
    (block) => block["type"] === "text" && isHostContextUpdateText(block["text"]),
  )
}

// ── api keys ────────────────────────────────────────────────────────────────

export const readOptionalEnv = (name: string): Effect.Effect<Option.Option<string>> =>
  Config.option(Config.NonEmptyString(name)).pipe(Effect.orElseSucceed(() => Option.none()))

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
