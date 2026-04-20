/**
 * Boundary helper for the Anthropic credential loader.
 *
 * The Anthropic SDK invokes a Promise-returning credential loader. This
 * module owns the loader's Effect (cache + refresh + persistence policy)
 * and exits Effect-land behind a `() => Promise<ClaudeCredentials | null>`
 * thunk.
 *
 * The fetch-Promise edge lives separately in `fetch-boundary.ts` to avoid
 * a circular import (the fetcher is colocated in `oauth.ts` with the
 * credential-reading helpers this module imports).
 *
 * Per `gent/no-runpromise-outside-boundary`, the Promise edge lives here.
 * The export NAMES the specific external seam — no generic `runAnyEffect`.
 */

import { Clock, Effect } from "effect"
import type { ProviderAuthInfo } from "@gent/core/extensions/api"
import {
  freshEnoughForUse,
  PRIMARY_CLAUDE_SERVICE,
  readClaudeCodeCredentials,
  refreshClaudeCodeCredentials,
} from "./oauth.js"

const CREDENTIAL_CACHE_TTL_MS = 30_000

export interface ClaudeCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

/** Cache cell — owned by extension closure, not module globals. */
export interface CredentialCache {
  creds: ClaudeCredentials | null
  at: number
}

/**
 * Resolve cached/refreshed Claude Code credentials. Returns `null` when
 * keychain has no usable credentials (caller surfaces a "run claude to
 * refresh" hint).
 */
const loadCredentialsEffect = (
  cache: CredentialCache,
  authInfo?: ProviderAuthInfo,
): Effect.Effect<ClaudeCredentials | null> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis

    // Cache hit: still warm AND >60s before expiry
    if (
      cache.creds !== null &&
      now - cache.at < CREDENTIAL_CACHE_TTL_MS &&
      cache.creds.expiresAt > now + 60_000
    ) {
      return cache.creds
    }

    // The provider-side credential loader always uses the primary
    // account (multi-account picker UI doesn't exist yet). Spell out
    // PRIMARY_CLAUDE_SERVICE so a future audit-grep finds every site
    // that still assumes one account.
    const result = yield* readClaudeCodeCredentials(PRIMARY_CLAUDE_SERVICE).pipe(
      Effect.catchEager(() => Effect.succeed(null)),
    )
    if (result === null) {
      cache.creds = null
      cache.at = 0
      return null
    }

    if (!freshEnoughForUse(result, now)) {
      // Refresh and use the returned creds directly. The previous
      // shape re-read keychain after refresh, which silently lost
      // direct-OAuth tokens whenever write-back failed (counsel
      // HIGH #1). Now write-back is best-effort inside the refresh
      // helper and the in-memory creds are authoritative.
      const refreshed = yield* refreshClaudeCodeCredentials(PRIMARY_CLAUDE_SERVICE).pipe(
        Effect.catchEager(() => Effect.succeed(null)),
      )
      if (refreshed === null || !freshEnoughForUse(refreshed, now)) {
        cache.creds = null
        cache.at = 0
        return null
      }
      // Persist refreshed creds back to AuthStore
      const persist = authInfo?.persist
      if (persist !== undefined) {
        yield* persist({
          access: refreshed.accessToken,
          refresh: refreshed.refreshToken,
          expires: refreshed.expiresAt,
        }).pipe(
          Effect.catchDefect((cause) =>
            Effect.logWarning("anthropic.persist.refreshed.credentials.failed").pipe(
              Effect.annotateLogs({ error: String(cause) }),
            ),
          ),
        )
      }
      cache.creds = refreshed
      cache.at = now
      return refreshed
    }

    cache.creds = result
    cache.at = now
    return result
  })

/**
 * Two-callback shape for the Anthropic SDK boundary. `load` returns
 * cached/refreshed credentials (Promise edge); `invalidate` busts the
 * cache so the next `load` re-reads from keychain or forces a refresh.
 *
 * The split keeps cache *invalidation* a separate concern from
 * credential *loading* — the fetcher detects staleness (401 mid-flight)
 * and calls `invalidate()` without knowing the cache shape, then retries
 * once. Equivalent shapes considered + rejected:
 *   - `load(forceRefresh?: boolean)`: callers thread the flag through
 *     every layer; the boundary loses one-job-per-callback.
 *   - exposing `cache` directly: leaks the cell shape across the
 *     Effect→Promise edge.
 */
export interface CredentialLoader {
  readonly load: () => Promise<ClaudeCredentials | null>
  readonly invalidate: () => void
}

/**
 * Build the loader pair the Anthropic SDK + keychain fetcher consume.
 * The thunks cross Effect→Promise via `Effect.runPromise`; the loader
 * body has its context fully provided (only Clock + closure state).
 */
export const buildAnthropicCredentialLoader = (
  cache: CredentialCache,
  authInfo?: ProviderAuthInfo,
): CredentialLoader => ({
  load: () => Effect.runPromise(loadCredentialsEffect(cache, authInfo)),
  invalidate: () => {
    cache.creds = null
    cache.at = 0
  },
})
