import {
  Cause,
  Clock,
  Config,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Schema,
  Stream,
  SynchronizedRef,
} from "effect"
import {
  type CatalogModel,
  isRecordArray,
  type JsonRecord,
  Model,
  type ModelCatalogView,
  modelFromCatalog,
  credentialFailureMetadata,
  ProviderAuthError,
  type ProviderAuthInfo,
  type ProviderHints,
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

/** What a lost connection reports: on the retry notice, and as the final error. */
const CONNECTION_LOST = "connection lost while reading the response"

/**
 * A body read failure as the lost connection it is. Effect reports any failed
 * read of a response body stream as a `DecodeError` with no description,
 * before a byte is decoded, and the AI SDKs turn that into "Invalid output:
 * Failed to decode response". As a `TransportError` the SDKs map it to a
 * retryable `NetworkError` that names the cause. A `DecodeError` with a
 * description is a real decode failure and stays.
 */
const asLostConnection = (error: HttpClientError): HttpClientError => {
  const reason = error.reason
  if (reason._tag !== "DecodeError" || Predicate.isNotUndefined(reason.description)) return error
  return new HttpClientError({
    reason: new TransportError({
      request: reason.request,
      cause: reason.cause,
      description: CONNECTION_LOST,
    }),
  })
}

/** The response, with its body stream's read failures named as a lost connection. */
const namingLostConnection = (
  response: HttpClientResponse.HttpClientResponse,
): HttpClientResponse.HttpClientResponse => {
  const named: HttpClientResponse.HttpClientResponse = Object.create(response, {
    stream: { get: () => response.stream.pipe(Stream.mapError(asLostConnection)) },
  })
  return named
}

/**
 * The `HttpClient` every model client sends through: `FetchHttpClient`, with
 * a connection lost mid-body reported as one (see `asLostConnection`). The
 * Anthropic, OpenAI, OpenCode and TypeSafe model clients build on it.
 */
export const ModelHttpClient: Layer.Layer<HttpClient.HttpClient> = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(HttpClient.HttpClient, (client) =>
    HttpClient.transformResponse(client, Effect.map(namingLostConnection)),
  ),
).pipe(Layer.provide(FetchHttpClient.layer))

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
 * Whether a Responses request asks the model for low text verbosity: the
 * models that accept one (GPT-6, the first GPT-5 family and GPT-5.1 to 5.6),
 * as Codex (`models-manager/models.json`, `default_verbosity`) and opencode
 * (`plugin/verbosity.ts`) send. Chat and codex variants, older models and the
 * o-series get none, so the API's `medium` applies.
 */
export const takesLowVerbosity = (modelName: string): boolean => {
  const id = modelName.toLowerCase()
  if (id.startsWith("gpt-6")) return true
  if (/-chat|-image|codex/.test(id)) return false
  return /^gpt-5\.[1-6](-|$)/.test(id) || /^gpt-5(-mini|-nano)?(-\d{4}-\d{2}-\d{2})?$/.test(id)
}

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
 * Core owns the catalog (`ModelCatalogSource`: a SQLite snapshot of
 * models.dev, revalidated by ETag) and hands each driver a read-only view as
 * the input of `listModels` and `resolveModel`. These helpers are the driver
 * side: one provider's entries as `Model`s, and one model's entry for the
 * wire facts a driver reads.
 */

/**
 * The catalog entries of one provider the agent loop can drive, as models.
 * A model without tool calling is dropped: every gent turn sends tools. Each
 * model carries `promptCacheTtl`, how long the provider keeps a request's
 * prompt cached; models.dev does not say. A driver whose models differ
 * passes none and stamps each model with `withPromptCacheTtl`.
 */
export const catalogModels = (
  catalog: ModelCatalogView,
  providerId: string,
  promptCacheTtl: Option.Option<Duration.Duration>,
): ReadonlyArray<Model> =>
  Option.match(catalog.provider(providerId), {
    onNone: () => [],
    onSome: (provider) =>
      provider.models
        .filter((entry) => entry.toolCall !== false && entry.decision !== true)
        .map((entry) => modelFromCatalog(providerId, entry))
        .map((model) => withPromptCacheTtl(model, promptCacheTtl)),
  })

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
 * The catalog entry of one model of `providerId`, for a driver's
 * `resolveModel`: none when the catalog has no entry for it. An entry that
 * names no AI SDK package of its own takes its provider's.
 */
export const catalogEntry = (
  catalog: ModelCatalogView,
  providerId: string,
  modelKey: string,
): Option.Option<CatalogModel> =>
  Option.flatMap(catalog.provider(providerId), (provider) =>
    Option.fromUndefinedOr(provider.models.find((entry) => entry.id === modelKey)).pipe(
      Option.map((entry) =>
        Option.match(Option.fromUndefinedOr(entry.npm ?? provider.npm), {
          onNone: () => entry,
          onSome: (npm) => ({ ...entry, npm }),
        }),
      ),
    ),
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

// ── transient stream events ─────────────────────────────────────────────────
//
// An accepted request can still end with an `error` event inside the stream.
// The SDK passes that event on as an error part, and the loop retries it when
// it matches the driver's `RetryPolicy.transientStreamEvent`. One shape per
// wire format: the native drivers and the OpenCode gateways, which speak the
// same formats through the same SDKs, name the same events. The two shapes
// are disjoint (`type` against `code`).

/** A Messages stream error a retry can clear: the SDK's part carries `event.error`. */
export const MessagesTransientStreamEvent = Schema.Struct({
  type: Schema.Literals(["overloaded_error", "api_error", "rate_limit_error"]),
})

/** A Responses stream error a retry can clear: the SDK's part carries the event and its `code`. */
export const ResponsesTransientStreamEvent = Schema.Struct({
  code: Schema.Literals(["server_error", "rate_limit_exceeded"]),
})

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
