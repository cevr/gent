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
import {
  freshEnoughForUse,
  readClaudeCodeCredentials,
  refreshClaudeCodeCredentials,
} from "../anthropic/oauth.js"

/**
 * Read the Claude Code OAuth access token from macOS Keychain (or
 * `~/.claude/.credentials.json` on non-darwin), refreshing if it expires
 * within the next minute. Uses the refreshed creds returned from the
 * refresh call directly — re-reading keychain would silently lose
 * direct-OAuth tokens on write-back failure (counsel HIGH #1).
 */
export const readClaudeCodeOAuthToken = (): Effect.Effect<string, ProviderAuthError> =>
  Effect.gen(function* () {
    let creds = yield* readClaudeCodeCredentials()
    const now = yield* Clock.currentTimeMillis
    if (!freshEnoughForUse(creds, now)) {
      creds = yield* refreshClaudeCodeCredentials()
    }
    return creds.accessToken
  })
