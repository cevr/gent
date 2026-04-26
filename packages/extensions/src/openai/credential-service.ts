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

import { Clock, Context, Effect, Layer, Ref, Schema } from "effect"
import {
  ProviderAuthError,
  TaggedEnumClass,
  type ProviderAuthInfo,
} from "@gent/core/extensions/api"
import { refreshOpenAIOauth } from "./oauth.js"

// ── Cache constants ──

const CREDENTIAL_CACHE_TTL_MS = 30_000
const FRESH_ENOUGH_MS = 60_000

// ── Credential shape (matches AuthOauth) ──

export interface OpenAICredentials {
  readonly access: string
  readonly refresh: string
  readonly expires: number
  readonly accountId?: string
}

const freshEnoughForUse = (creds: OpenAICredentials, now: number): boolean =>
  creds.expires > now + FRESH_ENOUGH_MS

// ── Internal cache cell ──

const OpenAICredentialsSchema: Schema.Schema<OpenAICredentials> = Schema.Struct({
  access: Schema.String,
  refresh: Schema.String,
  expires: Schema.Number,
  accountId: Schema.optional(Schema.String),
})

export const CredentialCacheCell = TaggedEnumClass("@gent/extensions/openai/CredentialCacheCell", {
  Empty: {
    creds: Schema.Null,
    at: Schema.Literal(0),
  },
  Durable: {
    creds: OpenAICredentialsSchema,
    at: Schema.Number,
    invalidated: Schema.Boolean,
  },
  PendingPersist: {
    creds: OpenAICredentialsSchema,
    at: Schema.Number,
    invalidated: Schema.Boolean,
  },
})
export type CredentialCacheCell = Schema.Schema.Type<typeof CredentialCacheCell>

export const EMPTY_CREDENTIAL_CELL: CredentialCacheCell = CredentialCacheCell.Empty.make({
  creds: null,
  at: 0,
})

const durableCell = (
  creds: OpenAICredentials,
  at: number,
  invalidated: boolean,
): CredentialCacheCell =>
  CredentialCacheCell.Durable.make({
    creds,
    at,
    invalidated,
  })

const pendingPersistCell = (
  creds: OpenAICredentials,
  at: number,
  invalidated: boolean,
): CredentialCacheCell =>
  CredentialCacheCell.PendingPersist.make({
    creds,
    at,
    invalidated,
  })

// ── Service interface ──

export interface OpenAICredentialServiceShape {
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
    Effect.tryPromise({
      try: () => refreshOpenAIOauth(refreshToken),
      catch: (cause) =>
        new ProviderAuthError({
          message: "Failed to refresh ChatGPT OAuth credentials",
          cause,
        }),
    }),
}

// ── Service tag ──

export class OpenAICredentialService extends Context.Service<
  OpenAICredentialService,
  OpenAICredentialServiceShape
>()("@gent/extensions/openai/CredentialService") {
  /**
   * Build the credential service for the OAuth path. `authInfo.persist`
   * (when present) durably writes refreshed credentials back to AuthStore.
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
    cellRef: Ref.Ref<CredentialCacheCell>,
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
        const cellRef = yield* Ref.make<CredentialCacheCell>(seedCellFromAuthInfo(authInfo))
        return yield* OpenAICredentialService.buildShape(cellRef, io, authInfo)
      }),
    )

  static layerFromRefAndIO = (
    cellRef: Ref.Ref<CredentialCacheCell>,
    io: OpenAICredentialIO,
    authInfo: ProviderAuthInfo,
  ): Layer.Layer<OpenAICredentialService> =>
    Layer.effect(
      OpenAICredentialService,
      Effect.gen(function* () {
        // First-touch seed: only fill the cell if it is still empty.
        // Externally-owned Refs may already hold fresher creds from a
        // prior `resolveModel` call within the same extension instance.
        yield* Ref.update(cellRef, (cell) =>
          cell.creds === null ? seedCellFromAuthInfo(authInfo) : cell,
        )
        return yield* OpenAICredentialService.buildShape(cellRef, io, authInfo)
      }),
    )

  private static buildShape = (
    cellRef: Ref.Ref<CredentialCacheCell>,
    io: OpenAICredentialIO,
    authInfo: ProviderAuthInfo,
  ): Effect.Effect<OpenAICredentialServiceShape> =>
    Effect.sync(() => {
      const persistRefreshed = (
        creds: OpenAICredentials,
      ): Effect.Effect<void, ProviderAuthError> => {
        const persist = authInfo.persist
        if (persist === undefined) return Effect.void
        return persist({
          access: creds.access,
          refresh: creds.refresh,
          expires: creds.expires,
          ...(creds.accountId !== undefined ? { accountId: creds.accountId } : {}),
        }).pipe(
          Effect.catchDefect((cause) =>
            Effect.fail(
              new ProviderAuthError({
                message: `Failed to persist refreshed OpenAI credentials: ${
                  cause instanceof Error ? cause.message : String(cause)
                }`,
                cause,
              }),
            ),
          ),
        )
      }

      const getFresh: Effect.Effect<OpenAICredentials, ProviderAuthError> = Effect.gen(
        function* () {
          const now = yield* Clock.currentTimeMillis
          let cell = yield* Ref.get(cellRef)

          if (cell._tag === "PendingPersist") {
            yield* persistRefreshed(cell.creds)
            cell = durableCell(cell.creds, now, cell.invalidated)
            yield* Ref.set(cellRef, cell)
          }

          // Cache hit: still warm AND >60s before expiry
          if (
            cell._tag === "Durable" &&
            !cell.invalidated &&
            now - cell.at < CREDENTIAL_CACHE_TTL_MS &&
            freshEnoughForUse(cell.creds, now)
          ) {
            return cell.creds
          }

          // If we still have creds in the cell that are fresh enough
          // (cache TTL elapsed but not yet stale), update the timestamp
          // and return them — no need to spend a refresh round-trip.
          if (cell._tag === "Durable" && !cell.invalidated && freshEnoughForUse(cell.creds, now)) {
            yield* Ref.set(cellRef, durableCell(cell.creds, now, false))
            return cell.creds
          }

          // Need to refresh. Always prefer the in-memory refresh token
          // from the cell — that's the most recently rotated one. Only
          // fall back to `authInfo.refresh` (the bootstrap token) when
          // no rotation has happened yet. Dropping the rotated token
          // on refresh failure or invalidate would silently roll back
          // to a stale bootstrap that the OAuth server may have
          // already revoked once the new one was issued.
          const refreshToken = cell.creds?.refresh ?? authInfo.refresh
          if (refreshToken === undefined || refreshToken.length === 0) {
            yield* Ref.set(cellRef, EMPTY_CREDENTIAL_CELL)
            return yield* Effect.fail(
              new ProviderAuthError({
                message:
                  "ChatGPT OAuth credentials are unavailable. Re-run authorization from the auth picker.",
              }),
            )
          }

          // Refresh failure does NOT clear the cell. The rotated refresh
          // token survives so a subsequent retry can re-attempt with it
          // (e.g., transient network failure). Only the explicit
          // "no usable refresh token" branch above resets to empty.
          const refreshed = yield* io.refresh(refreshToken)

          // Carry the prior accountId forward when the refresh response omits it.
          const merged: OpenAICredentials = {
            access: refreshed.access,
            refresh: refreshed.refresh,
            expires: refreshed.expires,
            ...((refreshed.accountId ?? cell.creds?.accountId) !== undefined
              ? { accountId: refreshed.accountId ?? cell.creds?.accountId }
              : {}),
          }

          yield* Ref.set(cellRef, pendingPersistCell(merged, now, false))
          yield* persistRefreshed(merged)
          yield* Ref.set(cellRef, durableCell(merged, now, false))
          return merged
        },
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
      const invalidate: Effect.Effect<void> = Ref.update(cellRef, (cell) => {
        if (cell.creds === null) return cell
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
      ...(authInfo.accountId !== undefined ? { accountId: authInfo.accountId } : {}),
    },
    0,
    false,
  )
}
