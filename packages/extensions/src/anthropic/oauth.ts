import { Clock, Duration, Effect, FileSystem, Path, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import type { ChildProcessSpawner } from "effect/unstable/process"
import { ProviderAuthError } from "@gent/core/extensions/api"
import { AnthropicPlatform } from "./platform-adapter.js"
import {
  decodeCredentials,
  parseOAuthResponse,
  updateCredentialBlob,
  type ClaudeCredentials,
} from "./oauth/credentials.js"
import {
  ClaudeKeychainNotFoundError,
  getKeychainAccountName,
  PRIMARY_CLAUDE_SERVICE,
  readFromKeychain,
  shouldFallBackToCli,
  shouldFallBackToCredentialsFile,
  spawnSecurity,
  writeKeychainEntry,
} from "./oauth/keychain.js"
export {
  freshEnoughForUse,
  parseOAuthResponse,
  updateCredentialBlob,
  type ClaudeCredentials,
} from "./oauth/credentials.js"
export {
  getBillingHeaderInputs,
  getCliVersion,
  getLongContextBetasForWith,
  getModelBetas,
  getUserAgent,
  isLongContextError,
  LONG_CONTEXT_BETAS,
  parseModelIdFromBody,
  SYSTEM_IDENTITY_PREFIX,
} from "./oauth/anthropic-headers.js"
export {
  PRIMARY_CLAUDE_SERVICE,
  shouldFallBackToCli,
  shouldFallBackToCredentialsFile,
} from "./oauth/keychain.js"

// ── Claude Code Keychain Reader ──

const credentialsFilePath = (home: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    return path.join(home, ".claude", ".credentials.json")
  })

const readCredentialsFile = (): Effect.Effect<
  ClaudeCredentials,
  ProviderAuthError,
  AnthropicPlatform | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const platform = yield* AnthropicPlatform
    const fs = yield* FileSystem.FileSystem
    const credentialsFile = yield* credentialsFilePath(platform.home)
    const exists = yield* fs.exists(credentialsFile).pipe(
      Effect.mapError(
        (e) =>
          new ProviderAuthError({
            message: `Failed to read Claude credentials file: ${e.message}`,
            cause: e,
          }),
      ),
    )
    if (!exists) {
      return yield* new ProviderAuthError({
        message: `Failed to read Claude credentials file: Credentials file not found: ${credentialsFile}`,
      })
    }
    const raw = yield* fs.readFileString(credentialsFile).pipe(
      Effect.mapError(
        (e) =>
          new ProviderAuthError({
            message: `Failed to read Claude credentials file: ${e.message}`,
            cause: e,
          }),
      ),
    )
    return yield* decodeCredentials(raw)
  })

/**
 * Read Claude Code credentials for `source` (the keychain service name).
 * Use `PRIMARY_CLAUDE_SERVICE` for the default account; pass another
 * service from `listClaudeCodeKeychainServices()` for additional ones.
 *
 * On non-darwin (no keychain), `source` is ignored and the on-disk
 * `.credentials.json` is read instead — that file holds only one
 * credential, mirroring the CLI's behaviour.
 *
 * On darwin, the on-disk fallback is gated to PRIMARY only. A
 * non-primary keychain miss propagates `ProviderAuthError` rather
 * than silently returning the disk credential as if it belonged to
 * the requested source.
 */
export const readClaudeCodeCredentials = (
  source: string,
): Effect.Effect<
  ClaudeCredentials,
  ProviderAuthError,
  AnthropicPlatform | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const platform = yield* AnthropicPlatform
    if (platform.platform !== "darwin") {
      return yield* readCredentialsFile()
    }
    return yield* readFromKeychain(source).pipe(
      Effect.catchIf(Schema.is(ClaudeKeychainNotFoundError), () =>
        shouldFallBackToCredentialsFile(platform.platform, source)
          ? readCredentialsFile()
          : Effect.fail(
              new ProviderAuthError({
                message: `No Claude credentials found in keychain for source: ${source}`,
              }),
            ),
      ),
    )
  })

// ── Multi-account discovery ──

/**
 * Enumerate every `Claude Code-credentials*` keychain entry — the CLI
 * stores per-account credentials with the suffix `-<random hex>`. Used
 * to surface multiple Claude accounts in the auth picker. Returns the
 * primary first, then the rest in keychain dump order.
 *
 * On non-darwin (no keychain), or when `dump-keychain` itself fails,
 * returns just the primary so callers fall back to the existing
 * single-credential path.
 */
export const listClaudeCodeKeychainServices = (): Effect.Effect<
  ReadonlyArray<string>,
  ProviderAuthError,
  AnthropicPlatform | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const platform = yield* AnthropicPlatform
    if (platform.platform !== "darwin") return [PRIMARY_CLAUDE_SERVICE] as ReadonlyArray<string>
    const result = yield* platform
      .runProcess("security", ["dump-keychain"], {
        timeout: Duration.millis(5000),
      })
      .pipe(Effect.catchEager(() => Effect.sync(() => undefined)))
    if (result === undefined || result.exitCode !== 0)
      return [PRIMARY_CLAUDE_SERVICE] as ReadonlyArray<string>
    const services: string[] = []
    const seen = new Set<string>()
    const re = /"Claude Code-credentials(?:-[0-9a-f]+)?"/g
    let m = re.exec(result.stdout)
    while (m !== null) {
      const svc = m[0].slice(1, -1)
      if (!seen.has(svc)) {
        seen.add(svc)
        services.push(svc)
      }
      m = re.exec(result.stdout)
    }
    const ordered: string[] = []
    if (seen.has(PRIMARY_CLAUDE_SERVICE)) ordered.push(PRIMARY_CLAUDE_SERVICE)
    for (const svc of services) {
      if (svc !== PRIMARY_CLAUDE_SERVICE) ordered.push(svc)
    }
    return (ordered.length > 0 ? ordered : [PRIMARY_CLAUDE_SERVICE]) as ReadonlyArray<string>
  })

/**
 * One Claude account discovered on this machine. `source` is the
 * keychain service name (or `"file"` on non-darwin) and is what every
 * source-aware credential helper expects. `label` is the
 * human-readable account name (the keychain `acct` field, e.g.
 * `"alice@example.com"`) — this is what the auth picker UI displays.
 */
export interface ClaudeAccount {
  readonly source: string
  readonly label: string
  readonly credentials: ClaudeCredentials
}

/**
 * Discover every Claude Code account on this machine: enumerate the
 * keychain services, read each credential, and pair it with its
 * keychain `acct` label. Accounts whose credentials fail to decode
 * are dropped (the slot may exist but be empty / corrupted) — the
 * list returned is ready to render in a picker.
 *
 * Foundation for the multi-account auth UI.
 */
export const listClaudeAccounts = (): Effect.Effect<
  ReadonlyArray<ClaudeAccount>,
  never,
  AnthropicPlatform | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const sources = yield* listClaudeCodeKeychainServices().pipe(
      Effect.catchEager(() => Effect.succeed([PRIMARY_CLAUDE_SERVICE] as ReadonlyArray<string>)),
    )
    const accounts: ClaudeAccount[] = []
    for (const source of sources) {
      const credentials = yield* readClaudeCodeCredentials(source).pipe(
        Effect.catchEager(() => Effect.sync((): ClaudeCredentials | undefined => undefined)),
      )
      if (credentials === undefined) continue
      const label = (yield* getKeychainAccountName(source)) ?? source
      accounts.push({ source, label, credentials })
    }
    return accounts
  })

// ── Write-back ──

/**
 * Persist refreshed credentials back to the keychain entry named by
 * `source` (or `~/.claude/.credentials.json` on non-darwin). Without
 * this, every direct OAuth refresh is wasted — the next read pulls
 * the stale `accessToken` straight back from disk/keychain. The
 * `acct` field is preserved by reading the existing entry first.
 *
 * Errors are surfaced as `ProviderAuthError` for the caller to log
 * (per : write-back is best-effort; the in-memory creds are
 * authoritative for the in-flight request).
 */
export const writeBackCredentials = (
  creds: ClaudeCredentials,
  source: string,
): Effect.Effect<
  void,
  ProviderAuthError,
  AnthropicPlatform | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const platform = yield* AnthropicPlatform
    if (platform.platform !== "darwin") {
      const fs = yield* FileSystem.FileSystem
      const credentialsFile = yield* credentialsFilePath(platform.home)
      const mapFsError = (e: { readonly message: string }) =>
        new ProviderAuthError({
          message: `Failed to write Claude credentials file: ${e.message}`,
          cause: e,
        })
      const exists = yield* fs.exists(credentialsFile).pipe(Effect.mapError(mapFsError))
      const raw = exists
        ? yield* fs.readFileString(credentialsFile).pipe(Effect.mapError(mapFsError))
        : '{"claudeAiOauth":{}}'
      const updated = updateCredentialBlob(raw, creds)
      if (updated === undefined) return
      yield* fs.writeFileString(credentialsFile, updated).pipe(Effect.mapError(mapFsError))
      // Counsel  deep — chmod 0600 after write so the credentials
      // file isn't world-readable on first creation. Matches the
      // opencode reference's keychain.ts:297 behavior.
      yield* platform.runProcess("chmod", ["600", credentialsFile], { stdout: "ignore" }).pipe(
        Effect.mapError(
          (e) =>
            new ProviderAuthError({
              message: `Failed to write Claude credentials file: ${e.message}`,
              cause: e,
            }),
        ),
      )
      return
    }

    // Counsel  deep — surface the read failure as a typed error
    // instead of swallowing it into "" and silently returning success.
    // The previous shape bypassed the warn-on-failure path at the
    // refresh call site, so a keychain read fault during write-back
    // looked indistinguishable from a successful update.
    //
    // ClaudeKeychainNotFoundError is mapped to a ProviderAuthError so
    // the public signature stays narrow — write-back callers use a
    // best-effort `catchEager` that doesn't need to know about the
    // internal not-found tag.
    const raw = yield* spawnSecurity(["find-generic-password", "-s", source, "-w"]).pipe(
      Effect.catchIf(Schema.is(ClaudeKeychainNotFoundError), () =>
        Effect.fail(
          new ProviderAuthError({
            message: `Cannot write back: no keychain entry for source: ${source}`,
          }),
        ),
      ),
    )
    const updated = updateCredentialBlob(raw, creds)
    if (updated === undefined) return
    const accountName = (yield* getKeychainAccountName(source)) ?? source
    yield* writeKeychainEntry(source, accountName, updated)
  })

// ── Token Refresh ──

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
