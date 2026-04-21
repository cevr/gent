/**
 * OpenAICredentialService — Effect-native credential loader for the
 * ChatGPT OAuth (Codex) path.
 *
 * Replaces the Promise-callback `buildOAuthLoader` shape that existed
 * because the downstream consumer was a `typeof fetch` adapter. With
 * `@effect/ai-openai-compat`'s `transformClient` middleware reading
 * creds via `mapRequestEffect`, callbacks become Effects.
 *
 * Cache shape (TTL 30s + 60s freshness margin + refresh-on-stale +
 * best-effort `authInfo.persist` write-back) mirrors the Anthropic
 * service exactly. The initial credentials come from `authInfo` rather
 * than an OS keychain — there is no "read from keychain" IO for OpenAI.
 *
 * Mirrors `packages/extensions/src/anthropic/credential-service.ts` —
 * see that file for the architectural justification of the IO seam +
 * `layerFromRef` hoist.
 */

import { Clock, Context, Effect, Layer, Ref } from "effect"
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
  readonly accountId?: string
}

const freshEnoughForUse = (creds: OpenAICredentials, now: number): boolean =>
  creds.expires > now + FRESH_ENOUGH_MS

// ── Internal cache cell ──

export interface CredentialCacheCell {
  readonly creds: OpenAICredentials | null
  readonly at: number
}

export const EMPTY_CREDENTIAL_CELL: CredentialCacheCell = { creds: null, at: 0 }

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
   * (when present) writes refreshed credentials back to AuthStore as a
   * best-effort side effect — failures log a warning but do not fail
   * the get. Preserves session continuity across token refresh races.
   */
  static layer = (authInfo: ProviderAuthInfo): Layer.Layer<OpenAICredentialService> =>
    OpenAICredentialService.layerFromIO(realIO, authInfo)

  /**
   * Cache cell `Ref` provided externally so its lifetime can be hoisted
   * above the per-`resolveModel` layer build. Without this, every
   * `Provider.stream`/`Provider.generate` call re-allocates the Ref and
   * the cache effectively disables itself. Mirrors Anthropic counsel C3
   * fix.
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
      const persistRefreshed = (creds: OpenAICredentials): Effect.Effect<void> => {
        const persist = authInfo.persist
        if (persist === undefined) return Effect.void
        return persist({
          access: creds.access,
          refresh: creds.refresh,
          expires: creds.expires,
          ...(creds.accountId !== undefined ? { accountId: creds.accountId } : {}),
        }).pipe(
          Effect.catchDefect((cause) =>
            Effect.logWarning("openai.credential.persist.failed").pipe(
              Effect.annotateLogs({ error: String(cause) }),
            ),
          ),
        )
      }

      const getFresh: Effect.Effect<OpenAICredentials, ProviderAuthError> = Effect.gen(
        function* () {
          const now = yield* Clock.currentTimeMillis
          const cell = yield* Ref.get(cellRef)

          // Cache hit: still warm AND >60s before expiry
          if (
            cell.creds !== null &&
            now - cell.at < CREDENTIAL_CACHE_TTL_MS &&
            freshEnoughForUse(cell.creds, now)
          ) {
            return cell.creds
          }

          // If we still have creds in the cell that are fresh enough
          // (cache TTL elapsed but not yet stale), update the timestamp
          // and return them — no need to spend a refresh round-trip.
          if (cell.creds !== null && freshEnoughForUse(cell.creds, now)) {
            yield* Ref.set(cellRef, { creds: cell.creds, at: now })
            return cell.creds
          }

          // Need to refresh. Use the most recent refresh token we have.
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

          const refreshed = yield* io.refresh(refreshToken).pipe(
            Effect.catchTag("ProviderAuthError", (e) =>
              Effect.gen(function* () {
                yield* Ref.set(cellRef, EMPTY_CREDENTIAL_CELL)
                return yield* Effect.fail(e)
              }),
            ),
          )

          // Carry the prior accountId forward when the refresh response
          // omits it (matches buildOAuthLoader behavior).
          const merged: OpenAICredentials = {
            access: refreshed.access,
            refresh: refreshed.refresh,
            expires: refreshed.expires,
            ...((refreshed.accountId ?? cell.creds?.accountId) !== undefined
              ? { accountId: refreshed.accountId ?? cell.creds?.accountId }
              : {}),
          }

          yield* persistRefreshed(merged)
          yield* Ref.set(cellRef, { creds: merged, at: now })
          return merged
        },
      )

      const invalidate: Effect.Effect<void> = Ref.set(cellRef, EMPTY_CREDENTIAL_CELL)

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
  return {
    creds: {
      access,
      refresh,
      expires,
      ...(authInfo.accountId !== undefined ? { accountId: authInfo.accountId } : {}),
    },
    // Seed with at: 0 so the cache TTL check fires immediately on first
    // get and the freshness gate decides whether to refresh.
    at: 0,
  }
}
