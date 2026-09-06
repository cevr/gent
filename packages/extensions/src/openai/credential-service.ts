/**
 * OpenAICredentialService — Effect-native credential loader for the
 * ChatGPT OAuth (Codex) path.
 *
 * Cache shape: TTL 30s + 60s freshness margin + refresh-on-stale +
 * durable `authInfo.persist` write-back. The initial credentials
 * come from `authInfo` rather than an OS keychain — there is no
 * "read from keychain" IO for OpenAI, so the cell IS the sole copy of
 * the rotated refresh token until persist write-back lands.
 *
 * Mirrors `packages/extensions/src/anthropic/credential-service.ts` —
 * see that file for the architectural justification of the IO seam +
 * `layerFromRef` hoist.
 */

import { Cause, Clock, Context, Effect, Exit, Layer, Option, Schema, SynchronizedRef } from "effect"
import { ProviderAuthError, type ProviderAuthInfo } from "@gent/core/extensions/api"
import { refreshOpenAIOauth } from "./oauth.js"

// ── Cache constants ──

const CREDENTIAL_CACHE_TTL_MS = 30_000
const FRESH_ENOUGH_MS = 60_000

// ── Credential shape (matches AuthOauth) ──

export interface OpenAICredentials {
  readonly access: string
  readonly refresh: string
  readonly expires: number
  readonly accountId: Option.Option<string>
}

const freshEnoughForUse = (creds: OpenAICredentials, now: number): boolean =>
  creds.expires > now + FRESH_ENOUGH_MS

// ── Internal cache cell ──

const OpenAICredentialsSchema: Schema.Schema<OpenAICredentials> = Schema.Struct({
  access: Schema.String,
  refresh: Schema.String,
  expires: Schema.Finite,
  accountId: Schema.OptionFromOptional(Schema.String),
})

export const CredentialCacheCell = Schema.TaggedUnion({
  Empty: {
    at: Schema.Literal(0),
  },
  Durable: {
    creds: OpenAICredentialsSchema,
    at: Schema.Finite,
    invalidated: Schema.Boolean,
  },
  PendingPersist: {
    creds: OpenAICredentialsSchema,
    at: Schema.Finite,
    invalidated: Schema.Boolean,
  },
})
export type CredentialCacheCell = Schema.Schema.Type<typeof CredentialCacheCell>

export const EMPTY_CREDENTIAL_CELL: CredentialCacheCell = CredentialCacheCell.cases.Empty.make({
  at: 0,
})

export type CredentialCacheCellRef = SynchronizedRef.SynchronizedRef<CredentialCacheCell>

type CredentialResult = Exit.Exit<OpenAICredentials, ProviderAuthError>

const durableCell = (
  creds: OpenAICredentials,
  at: number,
  invalidated: boolean,
): CredentialCacheCell =>
  CredentialCacheCell.cases.Durable.make({
    creds,
    at,
    invalidated,
  })

const pendingPersistCell = (
  creds: OpenAICredentials,
  at: number,
  invalidated: boolean,
): CredentialCacheCell =>
  CredentialCacheCell.cases.PendingPersist.make({
    creds,
    at,
    invalidated,
  })

const successResult = (creds: OpenAICredentials): CredentialResult => Exit.succeed(creds)

const failureResult = (error: ProviderAuthError): CredentialResult => Exit.fail(error)

const providerAuthErrorFromCause = (cause: Cause.Cause<ProviderAuthError>): ProviderAuthError => {
  const error = Cause.findErrorOption(cause)
  return Option.getOrElse(error, () => new ProviderAuthError({ message: Cause.pretty(cause) }))
}

// ── Service interface ──

export interface OpenAICredentialServiceApi {
  /**
   * Resolve cached/refreshed ChatGPT OAuth credentials. Fails with
   * `ProviderAuthError` when no usable refresh token is available or
   * the refresh round-trip fails terminally.
   */
  readonly getFresh: Effect.Effect<OpenAICredentials, ProviderAuthError>
  /** Bust the cache so the next `getFresh` forces a refresh. */
  readonly invalidate: Effect.Effect<void>
}

// ── IO seam ──

/**
 * IO operations the service depends on. Lifted out so tests can drive
 * the refresh deterministically without hitting `auth.openai.com`.
 *
 * Unlike Anthropic there is no `read` — initial credentials come from
 * `authInfo` (stored in the cache cell at layer construction). Only
 * `refresh` is a real IO call.
 */
export interface OpenAICredentialIO {
  /** Refresh creds against the OpenAI token endpoint. */
  readonly refresh: (refreshToken: string) => Effect.Effect<OpenAICredentials, ProviderAuthError>
}

const realIO: OpenAICredentialIO = {
  refresh: (refreshToken: string) =>
    refreshOpenAIOauth(refreshToken).pipe(
      Effect.map((credentials) => ({
        access: credentials.access,
        refresh: credentials.refresh,
        expires: credentials.expires,
        accountId: Option.fromNullishOr(credentials.accountId),
      })),
      Effect.mapError(
        (cause) =>
          new ProviderAuthError({
            message: `Failed to refresh ChatGPT OAuth credentials: ${cause.message}`,
            cause,
          }),
      ),
    ),
}

// ── Service tag ──

export class OpenAICredentialService extends Context.Service<
  OpenAICredentialService,
  OpenAICredentialServiceApi
>()("@gent/extensions/src/openai/credential-service/OpenAICredentialService") {
  /**
   * Build the credential service for the OAuth path. `authInfo.persist`
   * (when present) durably writes refreshed credentials back to Auth.
   * Write-back failures fail the credential load so callers never run with
   * refresh state that only exists in process memory.
   */
  static layer = (authInfo: ProviderAuthInfo): Layer.Layer<OpenAICredentialService> =>
    OpenAICredentialService.layerFromIO(realIO, authInfo)

  /**
   * Cache cell `Ref` provided externally so its lifetime can be hoisted
   * above the per-`resolveModel` layer build. Without this, every
   * `Provider.stream`/`Provider.generate` call re-allocates the Ref and
   * the cache effectively disables itself.
   */
  static layerFromRef = (
    cellRef: CredentialCacheCellRef,
    authInfo: ProviderAuthInfo,
  ): Layer.Layer<OpenAICredentialService> =>
    OpenAICredentialService.layerFromRefAndIO(cellRef, realIO, authInfo)

  /**
   * Test-friendly variant — accepts the IO seam as a parameter so tests
   * can drive `refresh` deterministically.
   */
  static layerFromIO = (
    io: OpenAICredentialIO,
    authInfo: ProviderAuthInfo,
  ): Layer.Layer<OpenAICredentialService> =>
    Layer.effect(
      OpenAICredentialService,
      Effect.gen(function* () {
        const cellRef = yield* SynchronizedRef.make<CredentialCacheCell>(
          seedCellFromAuthInfo(authInfo),
        )
        return yield* OpenAICredentialService.buildService(cellRef, io, authInfo)
      }),
    )

  static layerFromRefAndIO = (
    cellRef: CredentialCacheCellRef,
    io: OpenAICredentialIO,
    authInfo: ProviderAuthInfo,
  ): Layer.Layer<OpenAICredentialService> =>
    Layer.effect(
      OpenAICredentialService,
      Effect.gen(function* () {
        // First-touch seed: only fill the cell if it is still empty.
        // Externally-owned cells may already hold fresher creds from a
        // prior `resolveModel` call within the same extension instance.
        yield* SynchronizedRef.update(cellRef, (cell) => {
          if (cell._tag === "Empty") return seedCellFromAuthInfo(authInfo)
          return cell
        })
        return yield* OpenAICredentialService.buildService(cellRef, io, authInfo)
      }),
    )

  private static buildService = (
    cellRef: CredentialCacheCellRef,
    io: OpenAICredentialIO,
    authInfo: ProviderAuthInfo,
  ): Effect.Effect<OpenAICredentialServiceApi> =>
    Effect.sync(() => {
      const persistRefreshed = (
        creds: OpenAICredentials,
      ): Effect.Effect<void, ProviderAuthError> => {
        const persist = Option.fromNullishOr(authInfo.persist)
        if (Option.isNone(persist)) return Effect.void
        const payload = {
          access: creds.access,
          refresh: creds.refresh,
          expires: creds.expires,
        }
        const accountId = Option.getOrUndefined(creds.accountId)
        return persist.value({ ...payload, accountId }).pipe(
          Effect.catchDefect((cause) => {
            let message = String(cause)
            if (cause instanceof Error) message = cause.message
            return Effect.fail(
              new ProviderAuthError({
                message: `Failed to persist refreshed OpenAI credentials: ${message}`,
                cause,
              }),
            )
          }),
        )
      }

      const getFresh: Effect.Effect<OpenAICredentials, ProviderAuthError> =
        SynchronizedRef.modifyEffect(
          cellRef,
          (
            cell,
          ): Effect.Effect<readonly [CredentialResult, CredentialCacheCell], ProviderAuthError> =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis
              let current = cell

              if (current._tag === "PendingPersist") {
                const persistExit = yield* Effect.exit(persistRefreshed(current.creds))
                if (persistExit._tag === "Failure") {
                  return [failureResult(providerAuthErrorFromCause(persistExit.cause)), current]
                }
                current = durableCell(current.creds, now, current.invalidated)
              }

              // Cache hit: still warm AND >60s before expiry
              if (
                current._tag === "Durable" &&
                !current.invalidated &&
                now - current.at < CREDENTIAL_CACHE_TTL_MS &&
                freshEnoughForUse(current.creds, now)
              ) {
                return [successResult(current.creds), current]
              }

              // If we still have creds in the cell that are fresh enough
              // (cache TTL elapsed but not yet stale), update the timestamp
              // and return them — no need to spend a refresh round-trip.
              if (
                current._tag === "Durable" &&
                !current.invalidated &&
                freshEnoughForUse(current.creds, now)
              ) {
                return [successResult(current.creds), durableCell(current.creds, now, false)]
              }

              // Need to refresh. Always prefer the in-memory refresh token
              // from the cell — that's the most recently rotated one. Only
              // fall back to `authInfo.refresh` (the bootstrap token) when
              // no rotation has happened yet. Dropping the rotated token
              // on refresh failure or invalidate would silently roll back
              // to a stale bootstrap that the OAuth server may have
              // already revoked once the new one was issued.
              let refreshToken = Option.fromNullishOr(authInfo.refresh)
              if (current._tag !== "Empty") refreshToken = Option.some(current.creds.refresh)
              if (Option.isNone(refreshToken) || refreshToken.value.length === 0) {
                return [
                  failureResult(
                    new ProviderAuthError({
                      message:
                        "ChatGPT OAuth credentials are unavailable. Re-run authorization from the auth picker.",
                    }),
                  ),
                  EMPTY_CREDENTIAL_CELL,
                ]
              }

              // Refresh failure does NOT clear the cell. The rotated refresh
              // token survives so a subsequent retry can re-attempt with it
              // (e.g., transient network failure). Only the explicit
              // "no usable refresh token" branch above resets to empty.
              const refreshed = yield* io.refresh(refreshToken.value)

              // Carry the prior accountId forward when the refresh response omits it.
              let previousAccountId = Option.none<string>()
              if (current._tag !== "Empty") previousAccountId = current.creds.accountId
              const merged: OpenAICredentials = {
                access: refreshed.access,
                refresh: refreshed.refresh,
                expires: refreshed.expires,
                accountId: Option.orElse(refreshed.accountId, () => previousAccountId),
              }

              const pendingCell = pendingPersistCell(merged, now, false)
              const persistExit = yield* Effect.exit(persistRefreshed(merged))
              if (persistExit._tag === "Failure") {
                return [failureResult(providerAuthErrorFromCause(persistExit.cause)), pendingCell]
              }
              return [successResult(merged), durableCell(merged, now, false)]
            }),
        ).pipe(
          Effect.flatMap((result) => {
            if (Exit.isSuccess(result)) return Effect.succeed(result.value)
            return Effect.fail(providerAuthErrorFromCause(result.cause))
          }),
        )

      // Invalidate must NOT drop the rotated refresh token. Anthropic's
      // invalidate is safe because the next `getFresh` re-reads from
      // the OS keychain (which holds the most recent token); OpenAI
      // has no keychain — the cell is the only copy of the rotated
      // token. Hard-resetting to EMPTY would force the next refresh
      // to fall back to `authInfo.refresh`, the bootstrap token, which
      // the OAuth server may have already revoked when it issued the
      // rotation.
      //
      // Instead: mark the cell invalidated. The refresh path then uses
      // `cell.creds.refresh` (the rotated token) and gets a new access
      // token. Pending persisted credentials keep their actual access
      // payload so the next `getFresh` can first make the rotation
      // durable, then honor the invalidation by refreshing before use.
      const invalidate: Effect.Effect<void> = SynchronizedRef.update(cellRef, (cell) => {
        if (cell._tag === "Empty") return cell
        if (cell._tag === "PendingPersist") {
          return pendingPersistCell(cell.creds, cell.at, true)
        }
        return durableCell(cell.creds, cell.at, true)
      })

      return OpenAICredentialService.of({ getFresh, invalidate })
    })
}

const seedCellFromAuthInfo = (authInfo: ProviderAuthInfo): CredentialCacheCell => {
  const access = authInfo.access ?? ""
  const refresh = authInfo.refresh ?? ""
  const expires = authInfo.expires ?? 0
  if (access.length === 0 && refresh.length === 0) {
    return EMPTY_CREDENTIAL_CELL
  }
  return durableCell(
    {
      access,
      refresh,
      expires,
      accountId: Option.fromNullishOr(authInfo.accountId),
    },
    0,
    false,
  )
}
