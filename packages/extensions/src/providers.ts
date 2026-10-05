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
  Ref,
  Redacted,
  Schema,
  Stream,
  SynchronizedRef,
} from "effect"
import {
  acceptedEfforts,
  type CredentialSlot,
  DEFAULT_CREDENTIAL_SLOT,
  type ApiClassContribution,
  type ApiClassRequest,
  type CatalogModel,
  catalogModelEntry,
  type CatalogPlan,
  clampEffort,
  isRecordArray,
  type JsonRecord,
  Model,
  type ModelCatalogView,
  modelFromCatalog,
  credentialFailureMetadata,
  ProviderAuthError,
  type ProviderAuthInfo,
  type ProviderHints,
  type ReasoningEffort,
  type ReasoningOption,
  type RunEffort,
} from "@gent/core/extensions/api"
import {
  FetchHttpClient,
  type Headers,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http"
import { EncodeError, HttpClientError, TransportError } from "effect/http/HttpClientError"
import { AiError, Model as AiModel } from "effect/ai"
import type { OpenAiLanguageModel as OpenAiChatLanguageModel } from "@effect/ai-openai-compat"
import type * as ChatSdkModule from "@effect/ai-openai-compat"

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

/** Profile-owned cells. A warm credential can only serve its own slot. */
export const credentialCells = <C>(defaultCell: CredentialCacheCellRef<C>) => {
  const cells = new Map<CredentialSlot, CredentialCacheCellRef<C>>([
    [DEFAULT_CREDENTIAL_SLOT, defaultCell],
  ])
  return (slot: CredentialSlot = DEFAULT_CREDENTIAL_SLOT): CredentialCacheCellRef<C> => {
    const held = cells.get(slot)
    if (Predicate.isNotUndefined(held)) return held
    const cell = SynchronizedRef.makeUnsafe<CredentialCacheCell<C>>(EMPTY_CREDENTIAL_CELL)
    cells.set(slot, cell)
    return cell
  }
}

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
  write: (onPersisted: Effect.Effect<void, never, never>) => Effect.Effect<void, E>,
): Effect.Effect<void, E> =>
  Effect.suspend(() =>
    write(
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis
        yield* Ref.set(
          cellRef.backing,
          CredentialCacheCell(credentials).cases.Durable.make({ creds, at, invalidated: false }),
        )
      }),
    ),
  ).pipe(cellRef.semaphore.withPermits(1))

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
      credentialFailure: "Unavailable",
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
 * Anthropic, OpenAI, OpenCode, Cloudflare and TypeSafe model clients build on it.
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

// ── reasoning plan ──────────────────────────────────────────────────────────
//
// Every API class plans a request's reasoning from the catalog entry: the
// effort list, the on/off toggle and the thinking budget models.dev lists
// under `reasoning_options`, and `temperature: false` for a model that
// refuses a sampling temperature. No class keeps a table of model families.
// The effort list and its clamp are core's (`acceptedEfforts`, `clampEffort`):
// the step's receipt and a client's level read the same ones.

/** The model's reasoning controls; none when the catalog lists none. */
const reasoningOptions = (entry: CatalogModel): ReadonlyArray<ReasoningOption> =>
  entry.reasoningOptions ?? []

/** The effort a request names for `level`: the lowest the model accepts at or above it, else its highest. */
export const effortFor = (
  entry: CatalogModel,
  level: ReasoningEffort,
): Option.Option<ReasoningEffort> => clampEffort(acceptedEfforts(entry), level)

/** The lowest effort the model accepts; none without an effort list. */
export const lowestEffort = (entry: CatalogModel): Option.Option<ReasoningEffort> =>
  Option.fromUndefinedOr(acceptedEfforts(entry)[0])

/** Whether the model lists an on/off thinking toggle. */
export const hasToggle = (entry: CatalogModel): boolean =>
  reasoningOptions(entry).some((option) => option.type === "toggle")

/**
 * Whether the model reasons: the hint's word (`supportsReasoning`, from the
 * catalog), else the entry's flag, else whether it lists reasoning controls.
 */
export const modelReasons = (entry: CatalogModel, hints: Option.Option<ProviderHints>): boolean =>
  Option.getOrElse(
    Option.flatMap(hints, (value) => Option.fromUndefinedOr(value.supportsReasoning)),
    () => entry.reasoning ?? reasoningOptions(entry).length > 0,
  )

/** The hint's level, when the model reasons and the request names one. */
export const reasoningHint = (
  entry: CatalogModel,
  hints: Option.Option<ProviderHints>,
): Option.Option<ReasoningEffort> =>
  hints.pipe(
    Option.filter(() => modelReasons(entry, hints)),
    Option.flatMap((value) => Option.fromUndefinedOr(value.reasoning)),
  )

/** The request's output cap; none when the hints name none. */
export const maxTokensOf = (hints: Option.Option<ProviderHints>): Option.Option<number> =>
  Option.flatMap(hints, (value) => Option.fromNullishOr(value.maxTokens))

/**
 * A `temperature` for a request that may carry one: Responses and Chat
 * Completions send it only to a model that does not reason and takes one.
 */
export const sampledTemperature = (
  entry: CatalogModel,
  hints: Option.Option<ProviderHints>,
): Option.Option<number> =>
  hints.pipe(
    Option.filter(() => !modelReasons(entry, hints) && entry.temperature !== false),
    Option.flatMap((value) => Option.fromNullishOr(value.temperature)),
  )

// ── effort carrier ──────────────────────────────────────────────────────────
//
// A change of the top-level effort invalidates the provider's prompt cache
// (Anthropic: `output_config.effort` invalidates the cached messages; OpenAI:
// `reasoning.effort` can change the hidden instructions). Two wires carry a
// change inside the conversation instead: the Messages effort marker and the
// Responses `configuration_update` item. A driver that sends one keeps the
// top level at the effort before the first change and puts one marker at each
// change. It rebuilds them from the steps' receipts on every request
// (`ProviderHints.reasoningHistory`), so request `n + 1` repeats request `n`'s
// bytes and adds after them. Nothing about the carrier is stored.

/** One effort change inside the conversation. */
interface EffortChange {
  /** The assistant run the change starts at; `EffortCarrier.runs` names the reply the request asks for. */
  readonly run: number
  readonly effort: ReasoningEffort
}

/** The effort changes a request carries inside its conversation. */
export interface EffortCarrier {
  /**
   * The effort the top level names: the one the first run was sent at.
   * `"default"` names none, as that run's request did.
   */
  readonly pinned: RunEffort
  /** The number of assistant runs the request's conversation holds. */
  readonly runs: number
  /** In run order, never two at one run. */
  readonly changes: ReadonlyArray<EffortChange>
}

/**
 * The effort changes for a request that sends `current`, from the hints'
 * history. `"default"` is a request that named no level; `defaultLevel` is
 * the level the model then runs at, and a change is a change of the level
 * applied, so a marker always names a level. None, so the request is plain,
 * when the request writes no prompt cache (a compaction summary), sends no
 * effort, or would send the same body plain (no change, and its top level
 * already names the first run's effort); or when `carries` refuses one of the
 * efforts (the driver cannot send it as a marker, for example when its plan
 * changes the thinking too). With no change and a first run at another form
 * of the same level (the default against that level named), the carrier keeps
 * the first run's top level.
 *
 * A run with no receipt (a step on another model, a step stored before
 * receipts, a forked branch), or one at a default the driver does not know,
 * takes the next known effort, else `current`. The last marker so always
 * equals `current`: a request whose history disagrees with the receipts (a
 * revert, a fork) gets no stale marker at its tail.
 */
export const effortCarrier = (
  hints: Option.Option<ProviderHints>,
  current: Option.Option<RunEffort>,
  defaultLevel: Option.Option<ReasoningEffort>,
  carries: (effort: RunEffort) => boolean,
): Option.Option<EffortCarrier> => {
  const known = (entry: Option.Option<RunEffort>): Option.Option<RunEffort> =>
    Option.filter(entry, (effort) => effort !== "default" || Option.isSome(defaultLevel))
  const now = known(current)
  if (!writesPromptCache(hints) || Option.isNone(now)) return Option.none()
  const history = Option.getOrElse(
    Option.flatMap(hints, (value) => Option.fromUndefinedOr(value.reasoningHistory)),
    (): ReadonlyArray<Option.Option<RunEffort>> => [],
  )
  const sequence = history.reduceRight<ReadonlyArray<RunEffort>>(
    (later, entry) => [Option.getOrElse(known(entry), () => later[0] ?? now.value), ...later],
    [now.value],
  )
  const levelOf = (effort: RunEffort): Option.Option<ReasoningEffort> => {
    if (effort === "default") return defaultLevel
    return Option.some(effort)
  }
  return Option.flatMap(Option.all(sequence.map(levelOf)), (levels) => {
    const changes = levels.flatMap((effort, run): ReadonlyArray<EffortChange> => {
      if (run === 0 || effort === levels[run - 1]) return []
      return [{ run, effort }]
    })
    const pinned = sequence[0] ?? now.value
    if ((changes.length === 0 && pinned === now.value) || !sequence.every(carries)) {
      return Option.none()
    }
    return Option.some({ pinned, runs: history.length, changes })
  })
}

/**
 * A request's effort on the wire: the effort the request applies (`current`,
 * none when it sends no effort) and the changes it carries (none: a plain
 * request, whose top level names `current`).
 */
interface EffortPlan {
  readonly current: Option.Option<RunEffort>
  readonly carrier: Option.Option<EffortCarrier>
}

/** The effort a plan's top level names (`"default"`: none), and the changes before the reply. */
const effortWire = (plan: EffortPlan) =>
  Option.match(plan.carrier, {
    onNone: () => ({
      top: Option.getOrElse(plan.current, (): RunEffort => "default"),
      changes: [],
    }),
    onSome: (carrier) => ({ top: carrier.pinned, changes: carrier.changes }),
  })

/**
 * Whether the request `hints` describe carries its change of effort and
 * keeps the prefix the previous request wrote to the cache: the request
 * carries the change (a plain request changes the top level), and the request before it, at the effort of the history's
 * last run over the runs before that, is planned the same way, and both name
 * the same top-level effort and the same changes up to that run. The next
 * request may add only the change for the reply it asks for. False where the
 * last run's effort is unknown (no receipt), so no previous plan can be
 * rebuilt. `planOf` is the driver's own plan, so a driver whose wire cannot
 * name an effort (a provider default it does not know) is held to what it
 * sent: a change after a run at the default pins a top level that run did
 * not name, and is refused.
 */
export const keepsEffortPrefix = (
  hints: ProviderHints,
  planOf: (hints: Option.Option<ProviderHints>) => EffortPlan,
): boolean => {
  const history = Option.getOrElse(
    Option.fromUndefinedOr(hints.reasoningHistory),
    (): ReadonlyArray<Option.Option<RunEffort>> => [],
  )
  const last = Option.flatten(Option.fromUndefinedOr(history.at(-1)))
  if (Option.isNone(last)) return false
  const { reasoning: _next, ...rest } = hints
  const previousHints: ProviderHints = {
    ...rest,
    reasoningHistory: history.slice(0, -1),
    ...Option.match(
      Option.filter(last, (effort): effort is ReasoningEffort => effort !== "default"),
      {
        onNone: () => ({}),
        onSome: (reasoning) => ({ reasoning }),
      },
    ),
  }
  const planned = planOf(Option.some(hints))
  if (Option.isNone(planned.carrier)) return false
  const previous = effortWire(planOf(Option.some(previousHints)))
  const next = effortWire(planned)
  const before = next.changes.filter((change) => change.run < history.length)
  return (
    previous.top === next.top &&
    before.length === previous.changes.length &&
    before.every(
      (change, index) =>
        change.run === previous.changes[index]?.run &&
        change.effort === previous.changes[index]?.effort,
    )
  )
}

/** OpenCode's own cap on a thinking budget (`OUTPUT_TOKEN_MAX - 1` in `provider/transform.ts`). */
const BUDGET_CEILING = 31_999

/**
 * The thinking budget for a hint, as OpenCode sets it (`budgetVariants`): the
 * most the model and the output cap allow for `xhigh` and `max`, half of that
 * (at least the model's minimum) for any other level. The output cap is the
 * request's, else the model's. None when the model lists no budget, or the
 * cap leaves less than the model's minimum.
 */
export const thinkingBudget = (
  entry: CatalogModel,
  level: ReasoningEffort,
  hints: Option.Option<ProviderHints>,
): Option.Option<number> =>
  Option.fromUndefinedOr(
    reasoningOptions(entry).find((option) => option.type === "budget_tokens"),
  ).pipe(
    Option.flatMap((option) => {
      const cap = Option.orElse(maxTokensOf(hints), () =>
        Option.fromUndefinedOr(entry.limit?.output),
      )
      const minimum = Option.getOrElse(Option.fromUndefinedOr(option.min), () => 1)
      const maximum = Math.min(
        Option.getOrElse(Option.fromUndefinedOr(option.max), () => BUDGET_CEILING),
        Option.getOrElse(
          Option.map(cap, (value) => value - 1),
          () => BUDGET_CEILING,
        ),
        BUDGET_CEILING,
      )
      const high = Math.min(Math.max(minimum, Math.floor((maximum + 1) / 2)), maximum)
      let budget = high
      if (level === "xhigh" || level === "max") budget = maximum
      return Option.liftPredicate(budget, (value) => value >= minimum)
    }),
  )

// ── models.dev catalog ──────────────────────────────────────────────────────

/**
 * Core owns the catalog (`ModelCatalogSource`: a SQLite snapshot of
 * models.dev, revalidated by ETag), lists a driver's models and composes its
 * requests, unless the driver lists or resolves them itself. These helpers
 * are for such a driver: one provider's entries as `Model`s, and one model's
 * entry.
 */

/**
 * The catalog entries of one provider the agent loop can drive, as models.
 * A model without tool calling is dropped: every gent turn sends tools. Each
 * model carries `promptCacheTtl`, how long the provider keeps a request's
 * prompt cached; models.dev does not say. `apiClass` is the class the
 * driver plans its requests with: its effort levels and its tool-image bound
 * are the model's.
 */
export const catalogModels = (
  catalog: ModelCatalogView,
  providerId: string,
  promptCacheTtl: Duration.Duration,
  apiClass: CatalogPlan,
): ReadonlyArray<Model> =>
  Option.match(catalog.provider(providerId), {
    onNone: () => [],
    onSome: (provider) =>
      provider.models
        .filter((entry) => entry.toolCall !== false && entry.decision !== true)
        .map((entry) =>
          Model.make({
            ...modelFromCatalog(providerId, entry, apiClass),
            promptCacheTtlMs: Duration.toMillis(promptCacheTtl),
          }),
        ),
  })

/**
 * The catalog entry a driver that resolves its own models plans a request
 * from. A direct caller that passes no catalog, or a model the catalog does
 * not list, gets a bare entry: the request names no reasoning controls.
 */
export const adapterEntry = (
  catalog: Option.Option<ModelCatalogView>,
  providerId: string,
  modelName: string,
): CatalogModel =>
  Option.getOrElse(
    Option.flatMap(catalog, (view) => catalogModelEntry(view, providerId, modelName)),
    () => ({ id: modelName, name: modelName }),
  )

// ── api classes ─────────────────────────────────────────────────────────────

/** The SDK option for an endpoint's key: none when the endpoint signs in `transformClient`. */
export const sdkApiKey = (apiKey: Option.Option<string>) =>
  Option.getOrUndefined(Option.map(apiKey, Redacted.make))

/**
 * The client a class's SDK sends through: the class's own body rewrite next
 * to the SDK, then the endpoint's transform (its headers, its signing).
 */
export const endpointClient =
  (endpoint: ApiClassRequest, rewrite: (client: HttpClient.HttpClient) => HttpClient.HttpClient) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    Option.match(endpoint.transformClient, {
      onNone: () => rewrite(client),
      onSome: (transform) => transform(rewrite(client)),
    })

// ── chat completions ────────────────────────────────────────────────────────

type ChatSdk = typeof ChatSdkModule
type ChatConfig = NonNullable<Parameters<typeof OpenAiChatLanguageModel.layer>[0]["config"]>

// oxlint-disable-next-line effect/noDynamicImports -- the SDK loads at the first model build, not at launch
const loadChatSdk = Effect.promise((): Promise<ChatSdk> => import("@effect/ai-openai-compat"))

const isJsonString = Schema.is(Schema.String)

/**
 * The Chat Completions request: `reasoning_effort` from the catalog's effort
 * list (OpenCode sends nothing for a toggle or a budget on this format), and
 * tools without strict schemas, which the OpenAI-compatible upstreams do not
 * all take. `replayReasoning` is the patched SDK's opt-in: the model's
 * reasoning goes back on its own assistant message (see `patches/README.md`).
 */
const chatConfig = (entry: CatalogModel, hints: Option.Option<ProviderHints>): ChatConfig => {
  let config: ChatConfig = { strictJsonSchema: false, replayReasoning: true }
  const maxTokens = maxTokensOf(hints)
  if (Option.isSome(maxTokens)) config = { ...config, max_output_tokens: maxTokens.value }
  const temperature = sampledTemperature(entry, hints)
  if (Option.isSome(temperature)) config = { ...config, temperature: temperature.value }
  const effort = Option.flatMap(reasoningHint(entry, hints), (level) => effortFor(entry, level))
  if (Option.isSome(effort)) config = { ...config, reasoning_effort: effort.value }
  return config
}

/**
 * The reasoning a model wrote goes back to it on its assistant message, in the
 * field its catalog entry names (`interleaved.field`). DeepSeek needs the field
 * on every assistant message, empty when it wrote none (OpenCode's
 * `normalizeMessages`). The patched SDK writes the text as `reasoning_content`;
 * a model without the field gets none.
 */
const reasoningInField =
  (reasoningField: Option.Option<string>) =>
  (body: Schema.JsonObject): Schema.JsonObject =>
    Option.match(Option.filter(Option.fromUndefinedOr(body["messages"]), isArray), {
      onNone: () => body,
      onSome: (messages) => ({
        ...body,
        messages: messages.map((message): Schema.Json => {
          if (!isJsonObject(message) || message["role"] !== "assistant") return message
          const { reasoning_content: written, ...rest } = message
          if (Option.isNone(reasoningField)) return rest
          const text = Option.getOrElse(
            Option.filter(Option.fromUndefinedOr(written), isJsonString),
            () => "",
          )
          return { ...rest, [reasoningField.value]: text }
        }),
      }),
    })

type ImageCostOf = NonNullable<ApiClassContribution["imageCost"]>
type ImageCost = ReturnType<ImageCostOf>

/**
 * OpenAI's image costs at the `high` detail, by model name, most specific
 * first, from its vision guide: tiles (base and per-tile tokens) for the
 * older models, 32-pixel patches (a multiplier, and the patch budget the
 * `high` detail shrinks an image to) for the newer ones.
 */
export const OPENAI_IMAGE_COSTS: ReadonlyArray<readonly [RegExp, ImageCost]> = [
  [/^gpt-4o-mini/, { _tag: "Tiles", baseTokens: 2_833, tileTokens: 5_667 }],
  [/^gpt-4o/, { _tag: "Tiles", baseTokens: 85, tileTokens: 170 }],
  [/^gpt-4\.1-mini/, { _tag: "Patches", multiplier: 1.62, maxPatches: 6_144 }],
  [/^gpt-4\.1-nano/, { _tag: "Patches", multiplier: 2.46, maxPatches: 1_536 }],
  [/^gpt-4\.1/, { _tag: "Tiles", baseTokens: 85, tileTokens: 170 }],
  [/^o4-mini/, { _tag: "Patches", multiplier: 1.72, maxPatches: 1_536 }],
  [/^o[13]/, { _tag: "Tiles", baseTokens: 75, tileTokens: 150 }],
  [/^gpt-5-nano/, { _tag: "Patches", multiplier: 1.5, maxPatches: 1_536 }],
  [/^gpt-5-mini/, { _tag: "Patches", multiplier: 1.2, maxPatches: 1_536 }],
  [/^gpt-5\.2/, { _tag: "Patches", multiplier: 1.2, maxPatches: 6_144 }],
  [/^gpt-5(\.1)?($|-)/, { _tag: "Tiles", baseTokens: 70, tileTokens: 140 }],
]

/** A newer OpenAI model (GPT-5.4 on) counts patches at 1.2, shrunk to 2,500 at the `high` detail. */
const OPENAI_PATCH_COST: ImageCost = { _tag: "Patches", multiplier: 1.2, maxPatches: 2_500 }

/** What one image costs an OpenAI model (`Model.imageCost`), read from its name. */
export const openAiImageCost: ImageCostOf = (entry) => {
  const name = entry.id.split("/").at(-1) ?? entry.id
  const known = OPENAI_IMAGE_COSTS.find(([pattern]) => pattern.test(name))
  return known?.[1] ?? OPENAI_PATCH_COST
}

/**
 * Each image part of an OpenAI request names the `high` detail, the one its
 * cost counts at: `auto` lets a newer model send an image whole, up to
 * 30,000 patches, which no estimate could foresee.
 */
export const OPENAI_IMAGE_PART_OPTIONS = { openai: { imageDetail: "high" } }

/**
 * OpenAI Chat Completions, as OpenAI-compatible upstreams speak it. Its
 * upstreams cache implicitly with no write price, so a model on it has no
 * cache lifetime and never goes cold: a cold handoff there would cost more
 * than the warm resend it replaces, and lose detail.
 *
 * Its upstreams take fewer images than the Messages and Responses APIs (Groq
 * takes 5 a request and 4 MB of base64 an image), so its requests keep within
 * that tighter bound. It counts and sends images as OpenAI does.
 */
export const CHAT_COMPLETIONS_CLASS: ApiClassContribution = {
  id: "openai-chat",
  npm: ["@ai-sdk/openai-compatible"],
  protocols: ["completions"],
  promptCacheTtl: Option.none(),
  imageLimit: { images: 5, base64Chars: 4_000_000 },
  imageCost: openAiImageCost,
  imagePartOptions: OPENAI_IMAGE_PART_OPTIONS,
  resolveModel: (request) =>
    Effect.map(loadChatSdk, ({ OpenAiClient, OpenAiLanguageModel }) => {
      const reasoningField = Option.fromUndefinedOr(request.model.reasoningField)
      const client = OpenAiClient.layer({
        apiKey: sdkApiKey(request.apiKey),
        apiUrl: Option.getOrUndefined(request.baseUrl),
        transformClient: endpointClient(request, rewriteJsonBody(reasoningInField(reasoningField))),
      }).pipe(Layer.provide(ModelHttpClient))
      return AiModel.make(
        request.providerId,
        request.model.id,
        OpenAiLanguageModel.layer({
          model: request.model.id,
          config: chatConfig(request.model, request.hints),
        }).pipe(Layer.provide(client)),
      )
    }),
}

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

// ── rate-limit resets ───────────────────────────────────────────────────────
//
// A 429 can name when each rate limit is full again in its headers. Each
// driver decodes its own header names by schema into these limits; the rule
// that picks the time a retry can succeed is one for every driver.

/** One rate limit as a response reports it: what is left of it, and when it is full again (epoch ms). */
interface ReportedLimit {
  readonly remaining: Option.Option<number>
  readonly resetAt: Option.Option<number>
}

/**
 * The latest of the reset times a failure names; none when it names none.
 * A retry before the latest meets a limit still spent, so a short generic
 * retry-after never shortens a usage limit's own reset.
 */
export const latestReset = (resets: ReadonlyArray<Option.Option<number>>): Option.Option<number> =>
  resets.reduce<Option.Option<number>>(
    (latest, reset) =>
      Option.match(reset, {
        onNone: () => latest,
        onSome: (at) =>
          Option.some(
            Math.max(
              at,
              Option.getOrElse(latest, () => at),
            ),
          ),
      }),
    Option.none(),
  )

/**
 * When a retry can succeed: once every spent limit (none left) is full
 * again, the latest of their resets. A limit with some left does not hold
 * the retry, so its reset does not count; none when no limit reports itself
 * spent with a reset.
 */
export const spentLimitsReset = (limits: ReadonlyArray<ReportedLimit>): Option.Option<number> =>
  latestReset(
    limits.map((limit) => Option.filter(limit.resetAt, () => Option.contains(limit.remaining, 0))),
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
  Option.match(authInfo, {
    onNone: () => envApiKey,
    onSome: (auth) => {
      if (auth._tag === "Api") return Option.some(auth.key)
      if (Predicate.isNotUndefined(auth.slot) && auth.slot !== DEFAULT_CREDENTIAL_SLOT)
        return Option.none()
      return envApiKey
    },
  })
