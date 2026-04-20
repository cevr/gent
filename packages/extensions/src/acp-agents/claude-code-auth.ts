/**
 * Claude Code OAuth token reader for the ACP/SDK path.
 *
 * The existing `@gent/extensions/anthropic/oauth` module reads keychain
 * credentials for the model driver; the SDK path needs the same access
 * token, with the same expiry/refresh dance, but no provider-side wiring.
 *
 * @module
 */
import { Clock, Effect } from "effect"
import type { ProviderAuthError } from "@gent/core/extensions/api"
import { readClaudeCodeCredentials, refreshClaudeCodeCredentials } from "../anthropic/oauth.js"

const REFRESH_THRESHOLD_MS = 60_000

/**
 * Read the Claude Code OAuth access token from macOS Keychain (or
 * `~/.claude/.credentials.json` on non-darwin), refreshing if it expires
 * within the next minute.
 */
export const readClaudeCodeOAuthToken = (): Effect.Effect<string, ProviderAuthError> =>
  Effect.gen(function* () {
    let creds = yield* readClaudeCodeCredentials()
    const now = yield* Clock.currentTimeMillis
    if (creds.expiresAt < now + REFRESH_THRESHOLD_MS) {
      yield* refreshClaudeCodeCredentials().pipe(Effect.catchEager(() => Effect.void))
      creds = yield* readClaudeCodeCredentials()
    }
    return creds.accessToken
  })
