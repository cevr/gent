/**
 * AnthropicCredentialService — Effect-native credential loader.
 *
 * Replaces the Promise-callback `AnthropicCredentialLoader` shape that
 * existed only because the downstream consumer was a `typeof fetch`
 * adapter. With `@effect/ai-anthropic` the consumer is HttpClient
 * middleware reading creds via `mapRequestEffect`, so callbacks become
 * Effects.
 *
 * The cache shape (TTL 30s + 60s freshness margin + refresh-on-stale +
 * best-effort write-back via `authInfo.persist`) is a verbatim port from
 * the to-be-deleted `runtime-boundary.ts:loadCredentialsEffect`. Behavior
 * unchanged; only the interface shape differs.
 *
 * Why typed errors instead of `Effect<ClaudeCredentials | null>`: the
 * old shape returned `null` to mean "no creds available" because the
 * fetcher then threw an Error string. With Effect-native middleware,
 * `Effect.catchTag("ProviderAuthError", ...)` is the idiomatic
 * short-circuit. Less plumbing, more type-system enforcement.
 */

import { Clock, Context, Effect, Layer, Ref } from "effect"
import { ProviderAuthError, type ProviderAuthInfo } from "@gent/core/extensions/api"
import {
  freshEnoughForUse,
  PRIMARY_CLAUDE_SERVICE,
  readClaudeCodeCredentials,
  refreshClaudeCodeCredentials,
  type ClaudeCredentials,
} from "./oauth.js"

// ── Cache constants ──

const CREDENTIAL_CACHE_TTL_MS = 30_000

// ── Internal cache cell ──

interface CacheCell {
  readonly creds: ClaudeCredentials | null
  readonly at: number
}

const EMPTY_CELL: CacheCell = { creds: null, at: 0 }

// ── Service interface ──

export interface AnthropicCredentialServiceShape {
  /**
   * Resolve cached/refreshed Claude Code credentials. Fails with
   * `ProviderAuthError` when keychain has no usable credentials and
   * refresh paths exhausted.
   */
  readonly getFresh: Effect.Effect<ClaudeCredentials, ProviderAuthError>
  /** Bust the cache so the next `getFresh` re-reads from keychain or forces a refresh. */
  readonly invalidate: Effect.Effect<void>
}

// ── IO seam ──

/**
 * IO operations the service depends on. Lifted out so tests can drive
 * them deterministically without spawning `security` or hitting the
 * keychain. `layer` wires the real implementations from `oauth.ts`;
 * `layerFromIO` accepts overrides.
 */
export interface AnthropicCredentialIO {
  /** Read currently-stored creds for the primary source. */
  readonly read: Effect.Effect<ClaudeCredentials, ProviderAuthError>
  /** Refresh creds for the primary source via OAuth or CLI fallback. */
  readonly refresh: Effect.Effect<ClaudeCredentials, ProviderAuthError>
}

const realIO: AnthropicCredentialIO = {
  read: readClaudeCodeCredentials(PRIMARY_CLAUDE_SERVICE),
  refresh: refreshClaudeCodeCredentials(PRIMARY_CLAUDE_SERVICE),
}

// ── Service tag ──

export class AnthropicCredentialService extends Context.Service<
  AnthropicCredentialService,
  AnthropicCredentialServiceShape
>()("@gent/extensions/anthropic/CredentialService") {
  /**
   * Build the credential service for the OAuth path. `authInfo.persist`
   * (when present) writes refreshed credentials back to AuthStore as a
   * best-effort side effect — failures log a warning but do not fail
   * the get. This preserves session continuity even when AuthStore
   * write-back races with another writer (e.g. `claude` CLI itself).
   *
   * The PRIMARY_CLAUDE_SERVICE source is the only one wired here —
   * multi-account picker UI doesn't exist yet. Spelling out the source
   * so a future audit-grep finds every site that still assumes one
   * account.
   */
  static layer = (authInfo?: ProviderAuthInfo): Layer.Layer<AnthropicCredentialService> =>
    AnthropicCredentialService.layerFromIO(realIO, authInfo)

  /**
   * Test-friendly variant — accepts the IO seam as a parameter so tests
   * can drive read/refresh deterministically.
   */
  static layerFromIO = (
    io: AnthropicCredentialIO,
    authInfo?: ProviderAuthInfo,
  ): Layer.Layer<AnthropicCredentialService> =>
    Layer.effect(
      AnthropicCredentialService,
      Effect.gen(function* () {
        const cellRef = yield* Ref.make<CacheCell>(EMPTY_CELL)

        const persistRefreshed = (creds: ClaudeCredentials): Effect.Effect<void> => {
          const persist = authInfo?.persist
          if (persist === undefined) return Effect.void
          // `persist` returns `Effect<void>` (no error channel) so only
          // defects can leak. Catch defects → log warning → succeed
          // void; the get path keeps moving with the in-memory creds.
          return persist({
            access: creds.accessToken,
            refresh: creds.refreshToken,
            expires: creds.expiresAt,
          }).pipe(
            Effect.catchDefect((cause) =>
              Effect.logWarning("anthropic.credential.persist.failed").pipe(
                Effect.annotateLogs({ error: String(cause) }),
              ),
            ),
          )
        }

        const getFresh: Effect.Effect<ClaudeCredentials, ProviderAuthError> = Effect.gen(
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

            // Read from keychain. A read failure surfaces as
            // ProviderAuthError; the catch turns it into a refresh
            // attempt rather than failing immediately.
            const fromKeychain = yield* io.read.pipe(
              Effect.catchTag("ProviderAuthError", () => Effect.succeed(null)),
            )

            if (fromKeychain !== null && freshEnoughForUse(fromKeychain, now)) {
              yield* Ref.set(cellRef, { creds: fromKeychain, at: now })
              return fromKeychain
            }

            // Either no keychain creds or they're expiring inside the
            // freshness window. Refresh — counsel HIGH #1: use the
            // returned creds directly; the previous shape re-read
            // keychain after refresh and silently lost direct-OAuth
            // tokens whenever write-back failed.
            const refreshed = yield* io.refresh.pipe(
              Effect.catchTag("ProviderAuthError", () => Effect.succeed(null)),
            )

            if (refreshed === null || !freshEnoughForUse(refreshed, now)) {
              yield* Ref.set(cellRef, EMPTY_CELL)
              return yield* Effect.fail(
                new ProviderAuthError({
                  message:
                    "Claude Code credentials are unavailable or expired. Run `claude` to refresh them.",
                }),
              )
            }

            yield* persistRefreshed(refreshed)
            yield* Ref.set(cellRef, { creds: refreshed, at: now })
            return refreshed
          },
        )

        const invalidate: Effect.Effect<void> = Ref.set(cellRef, EMPTY_CELL)

        return AnthropicCredentialService.of({ getFresh, invalidate })
      }),
    )
}
