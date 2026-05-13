import { Clock, Duration, Effect, Schema, type FileSystem, type Path } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import type { ChildProcessSpawner } from "effect/unstable/process"
import { ProviderAuthError } from "@gent/core/extensions/api"
import { readClaudeCodeCredentials, writeBackCredentials } from "./accounts.js"
import { parseOAuthResponse, type ClaudeCredentials } from "./credentials.js"
import { shouldFallBackToCli } from "./keychain.js"
import { AnthropicPlatform } from "../platform-adapter.js"

/**
 * Anthropic's OAuth refresh endpoint and CLI client id. Discovered by
 * `griffinmartin/opencode-claude-auth` from the Claude Code CLI's
 * traffic; both values are public (the client id ships in every
 * `claude` install) so checking them in is safe.
 */
const OAUTH_TOKEN_URL = "https://claude.ai/v1/oauth/token"
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

/**
 * Refresh the OAuth token by POSTing directly to Anthropic's OAuth
 * endpoint, then writing the new credentials back so the next
 * `readClaudeCodeCredentials` call sees them. Costs zero LLM tokens —
 * matches the path `griffinmartin/opencode-claude-auth` discovered.
 *
 * Falls back to `claude -p . --model haiku` (which triggers the CLI's own
 * refresh logic) when the direct refresh fails for any reason — auth-server
 * downtime, refresh-token revoked, schema change, etc.
 */
const refreshViaOAuth = (
  refreshToken: string,
): Effect.Effect<ClaudeCredentials, ProviderAuthError> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const request = HttpClientRequest.post(OAUTH_TOKEN_URL).pipe(
      HttpClientRequest.bodyUrlParams({
        grant_type: "refresh_token",
        client_id: OAUTH_CLIENT_ID,
        refresh_token: refreshToken,
      }),
    )
    const response = yield* http.execute(request)
    if (response.status >= 400) {
      const errText = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* new ProviderAuthError({
        message: `Direct OAuth refresh failed: ${response.status} ${errText}`,
      })
    }
    const body = yield* response.text
    const now = yield* Clock.currentTimeMillis
    const creds = parseOAuthResponse(body, refreshToken, now)
    if (creds === undefined) {
      return yield* new ProviderAuthError({
        message: "OAuth refresh response missing access_token",
      })
    }
    return creds
  }).pipe(
    Effect.timeout("15 seconds"),
    Effect.catchEager((e) =>
      Schema.is(ProviderAuthError)(e)
        ? Effect.fail(e)
        : Effect.fail(
            new ProviderAuthError({
              message: `Direct OAuth refresh failed: ${e instanceof Error ? e.message : String(e)}`,
              cause: e,
            }),
          ),
    ),
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(FetchHttpClient.layer),
  )

const spawnClaudeCli = (): Effect.Effect<
  void,
  ProviderAuthError,
  AnthropicPlatform | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const platform = yield* AnthropicPlatform
    const env = { ...platform.parentEnv, TERM: "dumb" }
    return yield* platform
      .runProcess("claude", ["-p", ".", "--model", "haiku"], {
        env,
        timeout: Duration.millis(60_000),
        stdout: "ignore",
        stderr: "ignore",
      })
      .pipe(
        Effect.flatMap((result) => {
          if (result.exitCode === 0) return Effect.void
          return Effect.fail(
            new ProviderAuthError({
              message: `Failed to refresh Claude Code credentials via CLI: claude CLI exited with code ${result.exitCode}`,
            }),
          )
        }),
        Effect.catchTag("ExtensionHostProcessError", (e) =>
          Effect.fail(
            new ProviderAuthError({
              message: `Failed to refresh Claude Code credentials via CLI: ${e.message}`,
              cause: e,
            }),
          ),
        ),
      )
  })

/**
 * Refresh the cached Claude Code credentials and return the fresh ones
 * directly to the caller. Tries the direct OAuth endpoint first (fast,
 * free); falls back to spawning `claude` (slow, costs Haiku tokens)
 * only if the direct path fails. The CLI fallback writes back via the
 * Claude binary itself; we re-read keychain afterwards.
 *
 * Crucially the caller MUST use the returned value rather than
 * re-reading keychain after the call. A void-returning shape would
 * silently lose direct-OAuth tokens whenever write-back failed
 * (locked keychain, file perms, race with `claude` CLI). Write-back
 * here is best-effort; the in-memory creds are authoritative for this
 * turn.
 */
export const refreshClaudeCodeCredentials = (
  source: string,
): Effect.Effect<
  ClaudeCredentials,
  ProviderAuthError,
  AnthropicPlatform | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const current = yield* readClaudeCodeCredentials(source).pipe(
      Effect.catchEager(() => Effect.sync((): ClaudeCredentials | undefined => undefined)),
    )
    if (current?.refreshToken !== undefined && current.refreshToken !== "") {
      const refreshed = yield* refreshViaOAuth(current.refreshToken).pipe(
        Effect.catchEager(() => Effect.sync((): ClaudeCredentials | undefined => undefined)),
      )
      if (refreshed !== undefined) {
        // Best-effort write-back so subsequent processes pick up the
        // new token. A failure here doesn't lose the refresh — the
        // caller has it in memory.
        yield* writeBackCredentials(refreshed, source).pipe(
          Effect.catchEager((e: ProviderAuthError) =>
            Effect.logWarning("anthropic.oauth.writeback.failed").pipe(
              Effect.annotateLogs({ error: String(e), source }),
            ),
          ),
        )
        return refreshed
      }
    }
    // Direct path failed — fall back to the CLI spawn (second attempt
    // historically helps when the first invocation kicks a stale-token
    // error). The CLI persists its own credentials to whichever
    // account it considers active, so this fallback is ONLY safe for
    // the primary source. For non-primary accounts a CLI spawn could
    // refresh the wrong account; surface a typed failure instead so
    // the picker can prompt the user to refresh that account
    // explicitly.
    if (!shouldFallBackToCli(source)) {
      return yield* new ProviderAuthError({
        message: `Direct OAuth refresh failed for ${source}; CLI fallback would target the active account, not this one. Refresh the account in Claude Code directly.`,
      })
    }
    yield* spawnClaudeCli().pipe(Effect.retry({ times: 1 }))
    return yield* readClaudeCodeCredentials(source)
  })
