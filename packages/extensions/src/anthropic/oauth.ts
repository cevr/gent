import { Effect, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as os from "node:os"
import * as fsPromises from "node:fs/promises"
import { ProviderAuthError } from "@gent/core/extensions/api"
import { runAnthropicFetcher } from "./fetch-boundary.js"

// ── Claude Code Keychain Reader ──

/**
 * Default keychain service name and on-disk file path. Counsel K2
 * called out that hard-coding the primary service silently broke any
 * future multi-account UI consumer — every credential helper now takes
 * an explicit `source` so callers spell out which account they mean.
 */
export const PRIMARY_CLAUDE_SERVICE = "Claude Code-credentials"
const CREDENTIALS_FILE = `${os.homedir()}/.claude/.credentials.json`

const ClaudeCredentials = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Number,
})

const ClaudeCredentialsWrapper = Schema.Struct({
  claudeAiOauth: ClaudeCredentials,
})

export type ClaudeCredentials = typeof ClaudeCredentials.Type

/**
 * A credential is "fresh enough to use" if it expires more than 60s
 * from now. Below that, callers should refresh before sending it on
 * the wire — the Anthropic auth gate rejects a token in its last
 * minute and a refresh round-trip can take that long.
 */
const FRESH_ENOUGH_MS = 60_000

export const freshEnoughForUse = (creds: ClaudeCredentials, now: number): boolean =>
  creds.expiresAt > now + FRESH_ENOUGH_MS

const decodeCredentials = (raw: string): Effect.Effect<ClaudeCredentials, ProviderAuthError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeCredentialsWrapper))(raw).pipe(
    Effect.map((w) => w.claudeAiOauth),
    Effect.catchEager(() =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeCredentials))(raw).pipe(
        Effect.mapError(
          (e) =>
            new ProviderAuthError({
              message: "Invalid Claude credentials JSON",
              cause: e,
            }),
        ),
      ),
    ),
  )

const readCredentialsFile = (): Effect.Effect<ClaudeCredentials, ProviderAuthError> =>
  Effect.tryPromise({
    try: async () => {
      const file = Bun.file(CREDENTIALS_FILE)
      const exists = await file.exists()
      if (!exists) throw new Error(`Credentials file not found: ${CREDENTIALS_FILE}`)
      return file.text()
    },
    catch: (e) =>
      new ProviderAuthError({
        message: `Failed to read Claude credentials file: ${e instanceof Error ? e.message : String(e)}`,
        cause: e,
      }),
  }).pipe(Effect.flatMap(decodeCredentials))

class ClaudeKeychainNotFoundError extends Schema.TaggedErrorClass<ClaudeKeychainNotFoundError>()(
  "ClaudeKeychainNotFoundError",
  {},
) {}

const spawnSecurity = (
  args: readonly string[],
): Effect.Effect<string, ProviderAuthError | ClaudeKeychainNotFoundError> =>
  Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["security", ...args], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      })
      const raw = await new Response(proc.stdout).text()
      const code = await proc.exited
      if (code !== 0) {
        const err = await new Response(proc.stderr).text()
        throw Object.assign(new Error(err || `Exit code ${code}`), { exitCode: code })
      }
      return raw.trim()
    },
    catch: (e) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const error = e as { exitCode?: number; killed?: boolean; code?: string }
      if (error.killed || error.code === "ETIMEDOUT") {
        return new ProviderAuthError({
          message: "Keychain read timed out. Try restarting Keychain Access.",
        })
      }
      if (error.exitCode === 44) {
        return new ClaudeKeychainNotFoundError()
      }
      if (error.exitCode === 36) {
        return new ProviderAuthError({
          message:
            "macOS Keychain is locked. Unlock it or run: security unlock-keychain ~/Library/Keychains/login.keychain-db",
        })
      }
      if (error.exitCode === 128) {
        return new ProviderAuthError({
          message: "Keychain access was denied. Grant access when prompted by macOS.",
        })
      }
      return new ProviderAuthError({
        message: `Failed to read Claude Code credentials from Keychain: ${e instanceof Error ? e.message : String(e)}`,
        cause: e,
      })
    },
  })

const readFromKeychain = (
  source: string,
): Effect.Effect<ClaudeCredentials, ProviderAuthError | ClaudeKeychainNotFoundError> =>
  spawnSecurity(["find-generic-password", "-s", source, "-w"]).pipe(
    Effect.flatMap(decodeCredentials),
  )

/**
 * Pure policy: should a keychain miss for `source` fall back to the
 * on-disk credentials file? Only when we're not on darwin (no
 * keychain at all) or the request is for the primary account. For
 * non-primary sources on darwin, source means source — silently
 * returning the disk credential would leak the primary into a
 * multi-account picker.
 *
 * Exported so the policy can be unit-tested without spawning
 * `security`. Counsel C4 review surfaced this as a real defect.
 */
export const shouldFallBackToCredentialsFile = (platform: string, source: string): boolean =>
  platform !== "darwin" || source === PRIMARY_CLAUDE_SERVICE

/**
 * Pure policy: when direct OAuth refresh fails, should we spawn the
 * `claude` CLI as a fallback? Only safe for the primary source — the
 * CLI persists to whichever account it considers active, so a
 * non-primary spawn could refresh the wrong account.
 *
 * Exported so the policy can be unit-tested without spawning a
 * subprocess. Counsel C4 review.
 */
export const shouldFallBackToCli = (source: string): boolean => source === PRIMARY_CLAUDE_SERVICE

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
 * the requested source (counsel C4 review).
 */
export const readClaudeCodeCredentials = (
  source: string,
): Effect.Effect<ClaudeCredentials, ProviderAuthError> => {
  if (process.platform !== "darwin") {
    return readCredentialsFile()
  }
  return readFromKeychain(source).pipe(
    Effect.catchIf(Schema.is(ClaudeKeychainNotFoundError), () =>
      shouldFallBackToCredentialsFile(process.platform, source)
        ? readCredentialsFile()
        : Effect.fail(
            new ProviderAuthError({
              message: `No Claude credentials found in keychain for source: ${source}`,
            }),
          ),
    ),
  )
}

// ── Multi-account discovery (counsel keychain alignment K2) ──

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
  ProviderAuthError
> =>
  Effect.tryPromise({
    try: async () => {
      if (process.platform !== "darwin") return [PRIMARY_CLAUDE_SERVICE]
      const proc = Bun.spawn(["security", "dump-keychain"], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      })
      const raw = await new Response(proc.stdout).text()
      const code = await proc.exited
      if (code !== 0) return [PRIMARY_CLAUDE_SERVICE]
      const services: string[] = []
      const seen = new Set<string>()
      const re = /"Claude Code-credentials(?:-[0-9a-f]+)?"/g
      let m = re.exec(raw)
      while (m !== null) {
        const svc = m[0].slice(1, -1)
        if (!seen.has(svc)) {
          seen.add(svc)
          services.push(svc)
        }
        m = re.exec(raw)
      }
      const ordered: string[] = []
      if (seen.has(PRIMARY_CLAUDE_SERVICE)) ordered.push(PRIMARY_CLAUDE_SERVICE)
      for (const svc of services) {
        if (svc !== PRIMARY_CLAUDE_SERVICE) ordered.push(svc)
      }
      return ordered.length > 0 ? ordered : [PRIMARY_CLAUDE_SERVICE]
    },
    catch: (e) =>
      new ProviderAuthError({
        message: `Failed to enumerate Claude keychain services: ${e instanceof Error ? e.message : String(e)}`,
        cause: e,
      }),
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
 * Foundation for the multi-account auth UI; see counsel K2.
 */
export const listClaudeAccounts = (): Effect.Effect<ReadonlyArray<ClaudeAccount>> =>
  Effect.gen(function* () {
    const sources = yield* listClaudeCodeKeychainServices().pipe(
      Effect.catchEager(() => Effect.succeed([PRIMARY_CLAUDE_SERVICE] as ReadonlyArray<string>)),
    )
    const accounts: ClaudeAccount[] = []
    for (const source of sources) {
      const credentials = yield* readClaudeCodeCredentials(source).pipe(
        Effect.catchEager(() => Effect.succeed(undefined)),
      )
      if (credentials === undefined) continue
      const label = (yield* getKeychainAccountName(source)) ?? source
      accounts.push({ source, label, credentials })
    }
    return accounts
  })

// ── Write-back (counsel keychain alignment K2) ──

/**
 * Discover the macOS username stored on a keychain entry. The Claude
 * CLI uses the user's account name (e.g. "alice") as the keychain
 * `acct` field, NOT the service name. Writing with the wrong `acct`
 * creates a duplicate entry instead of updating the existing one —
 * exactly the bug `griffinmartin/opencode-claude-auth` ran into.
 */
const getKeychainAccountName = (serviceName: string): Effect.Effect<string | undefined> =>
  Effect.tryPromise(async () => {
    const proc = Bun.spawn(["security", "find-generic-password", "-s", serviceName], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 2000,
    })
    const raw = await new Response(proc.stdout).text()
    await proc.exited
    const match = /"acct"<blob>="([^"]*)"/.exec(raw)
    return match?.[1]
  }).pipe(Effect.catchEager(() => Effect.succeed(undefined)))

const writeKeychainEntry = (
  serviceName: string,
  accountName: string,
  payload: string,
): Effect.Effect<void, ProviderAuthError> =>
  Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(
        [
          "security",
          "add-generic-password",
          "-s",
          serviceName,
          "-a",
          accountName,
          "-w",
          payload,
          "-U",
        ],
        { stdout: "ignore", stderr: "pipe", timeout: 2000 },
      )
      const code = await proc.exited
      if (code !== 0) {
        const err = await new Response(proc.stderr).text()
        throw new Error(err || `security add-generic-password exit ${code}`)
      }
    },
    catch: (e) =>
      new ProviderAuthError({
        message: `Failed to write Claude credentials to Keychain: ${e instanceof Error ? e.message : String(e)}`,
        cause: e,
      }),
  })

/**
 * Splice fresh credentials into an existing keychain blob, preserving
 * any other fields (e.g. `subscriptionType`, `mcpOAuth`) so a write-back
 * doesn't blow away CLI state. Returns `undefined` if the blob isn't
 * valid JSON. Exported for testing.
 *
 * @internal
 */
export const updateCredentialBlob = (
  existingJson: string,
  newCreds: ClaudeCredentials,
): string | undefined => {
  let parsed: Record<string, unknown>
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    parsed = JSON.parse(existingJson) as Record<string, unknown>
  } catch {
    return undefined
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const wrapper = parsed["claudeAiOauth"] as Record<string, unknown> | undefined
  const target = wrapper ?? parsed
  target["accessToken"] = newCreds.accessToken
  target["refreshToken"] = newCreds.refreshToken
  target["expiresAt"] = newCreds.expiresAt
  return JSON.stringify(parsed)
}

/**
 * Persist refreshed credentials back to the keychain entry named by
 * `source` (or `~/.claude/.credentials.json` on non-darwin). Without
 * this, every direct OAuth refresh is wasted — the next read pulls
 * the stale `accessToken` straight back from disk/keychain. The
 * `acct` field is preserved by reading the existing entry first.
 *
 * Errors are surfaced as `ProviderAuthError` for the caller to log
 * (per C2: write-back is best-effort; the in-memory creds are
 * authoritative for the in-flight request).
 */
export const writeBackCredentials = (
  creds: ClaudeCredentials,
  source: string,
): Effect.Effect<void, ProviderAuthError> =>
  Effect.gen(function* () {
    if (process.platform !== "darwin") {
      yield* Effect.tryPromise({
        try: async () => {
          const file = Bun.file(CREDENTIALS_FILE)
          const exists = await file.exists()
          const raw = exists ? await file.text() : JSON.stringify({ claudeAiOauth: {} })
          const updated = updateCredentialBlob(raw, creds)
          if (updated === undefined) return
          await Bun.write(CREDENTIALS_FILE, updated)
          // Counsel C8 deep — chmod 0600 after write so the credentials
          // file isn't world-readable on first creation. Matches the
          // opencode reference's keychain.ts:297 behavior.
          await fsPromises.chmod(CREDENTIALS_FILE, 0o600)
        },
        catch: (e) =>
          new ProviderAuthError({
            message: `Failed to write Claude credentials file: ${e instanceof Error ? e.message : String(e)}`,
            cause: e,
          }),
      })
      return
    }

    // Counsel C8 deep — surface the read failure as a typed error
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

interface OAuthTokenResponse {
  readonly access_token?: string
  readonly refresh_token?: string
  readonly expires_in?: number
}

/**
 * Parse a raw OAuth refresh response body into `ClaudeCredentials`.
 * Returns `undefined` if the body is not valid JSON, not an object,
 * or missing `access_token`. Defaults `expires_in` to 36 000s (10h) per
 * Anthropic's observed token lifetime. Exported for testing.
 *
 * @internal
 */
export const parseOAuthResponse = (
  raw: string,
  fallbackRefreshToken: string,
  now: number = Date.now(),
): ClaudeCredentials | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const data = parsed as OAuthTokenResponse
  if (typeof data.access_token !== "string") return undefined
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 36_000
  return {
    accessToken: data.access_token,
    refreshToken:
      typeof data.refresh_token === "string" ? data.refresh_token : fallbackRefreshToken,
    expiresAt: now + expiresIn * 1000,
  }
}

/**
 * Refresh the OAuth token by POSTing directly to Anthropic's OAuth
 * endpoint, then writing the new credentials back so the next
 * `readClaudeCodeCredentials` call sees them. Costs zero LLM tokens —
 * matches the path `griffinmartin/opencode-claude-auth` discovered.
 *
 * Falls back to the legacy `claude -p . --model haiku` spawn (which
 * triggers the CLI's own refresh logic) when the direct refresh fails
 * for any reason — auth-server downtime, refresh-token revoked, schema
 * change, etc.
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
      return yield* Effect.fail(
        new ProviderAuthError({
          message: `Direct OAuth refresh failed: ${response.status} ${errText}`,
        }),
      )
    }
    const body = yield* response.text
    const creds = parseOAuthResponse(body, refreshToken)
    if (creds === undefined) {
      return yield* Effect.fail(
        new ProviderAuthError({
          message: "OAuth refresh response missing access_token",
        }),
      )
    }
    return creds
  }).pipe(
    Effect.timeout("15 seconds"),
    Effect.catchEager((e) =>
      e instanceof ProviderAuthError
        ? Effect.fail(e)
        : Effect.fail(
            new ProviderAuthError({
              message: `Direct OAuth refresh failed: ${e instanceof Error ? e.message : String(e)}`,
              cause: e,
            }),
          ),
    ),
    Effect.provide(FetchHttpClient.layer),
  )

const spawnClaudeCli = (): Effect.Effect<void, ProviderAuthError> =>
  Effect.tryPromise({
    try: async () => {
      // eslint-disable-next-line no-process-env
      const env = { ...process.env, TERM: "dumb" }
      const proc = Bun.spawn(["claude", "-p", ".", "--model", "haiku"], {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        stdout: "ignore" as unknown as "pipe",
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        stderr: "ignore" as unknown as "pipe",
        env,
        timeout: 60_000,
      })
      const code = await proc.exited
      if (code !== 0) throw new Error(`claude CLI exited with code ${code}`)
    },
    catch: (e) =>
      new ProviderAuthError({
        message: `Failed to refresh Claude Code credentials via CLI: ${e instanceof Error ? e.message : String(e)}`,
        cause: e,
      }),
  })

/**
 * Refresh the cached Claude Code credentials and return the fresh ones
 * directly to the caller. Tries the direct OAuth endpoint first (fast,
 * free); falls back to spawning `claude` (slow, costs Haiku tokens)
 * only if the direct path fails. The CLI fallback writes back via the
 * Claude binary itself; we re-read keychain afterwards.
 *
 * Crucially the caller MUST use the returned value rather than
 * re-reading keychain after the call. The previous void-returning
 * shape silently lost direct-OAuth tokens whenever write-back failed
 * (locked keychain, file perms, race with `claude` CLI) — counsel
 * HIGH #1. Write-back here is best-effort; the in-memory creds are
 * authoritative for this turn.
 */
export const refreshClaudeCodeCredentials = (
  source: string,
): Effect.Effect<ClaudeCredentials, ProviderAuthError> =>
  Effect.gen(function* () {
    const current = yield* readClaudeCodeCredentials(source).pipe(
      Effect.catchEager(() => Effect.succeed(undefined)),
    )
    if (current?.refreshToken !== undefined && current.refreshToken !== "") {
      const refreshed = yield* refreshViaOAuth(current.refreshToken).pipe(
        Effect.catchEager(() => Effect.succeed(undefined)),
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
    // explicitly (counsel C4 review).
    if (!shouldFallBackToCli(source)) {
      return yield* Effect.fail(
        new ProviderAuthError({
          message: `Direct OAuth refresh failed for ${source}; CLI fallback would target the active account, not this one. Refresh the account in Claude Code directly.`,
        }),
      )
    }
    yield* spawnClaudeCli().pipe(Effect.retry({ times: 1 }))
    return yield* readClaudeCodeCredentials(source)
  })

// ── Beta Management ──
//
// Counsel C8 — beta + ccVersion config delegates to `model-config.ts`
// (port of `griffinmartin/opencode-claude-auth/src/model-config.ts`).
// This module keeps the env-var override + per-process exclusion cache
// (used by the long-context backoff path) and forwards to
// `getModelBetas` for the actual derivation.

import { getModelBetas as deriveModelBetas, MODEL_CONFIG, getCcVersion } from "./model-config.js"

export const LONG_CONTEXT_BETAS: ReadonlyArray<string> = MODEL_CONFIG.longContextBetas

/** Env vars for Anthropic keychain, read once at init via Config */
export interface AnthropicKeychainEnv {
  betaFlags?: string
  cliVersion?: string
  userAgent?: string
}

let _env: AnthropicKeychainEnv = {}

/** Call once at layer construction with values from Config */
export const initAnthropicKeychainEnv = (env: AnthropicKeychainEnv): void => {
  _env = env
  lastBetaFlagsEnv = env.betaFlags
}

// Session-level excluded betas per model
const excludedBetas = new Map<string, Set<string>>()
let lastBetaFlagsEnv: string | undefined
let lastModelId: string | undefined

export const getExcludedBetas = (modelId: string): Set<string> => {
  const currentBetaFlags = _env.betaFlags
  if (currentBetaFlags !== lastBetaFlagsEnv) {
    excludedBetas.clear()
    lastBetaFlagsEnv = currentBetaFlags
  }
  if (lastModelId !== undefined && lastModelId !== modelId) {
    excludedBetas.clear()
  }
  lastModelId = modelId
  return excludedBetas.get(modelId) ?? new Set()
}

export const addExcludedBeta = (modelId: string, beta: string): void => {
  const existing = excludedBetas.get(modelId) ?? new Set()
  existing.add(beta)
  excludedBetas.set(modelId, existing)
}

export const isLongContextError = (responseBody: string): boolean =>
  responseBody.includes("Extra usage is required for long context requests") ||
  responseBody.includes("long context beta is not yet available")

/**
 * Long-context backoff candidates — only the long-context betas that
 * actually appear in this model's effective header. Counsel C8 deep
 * surfaced two related defects in the prior shape:
 *   1. We walked `LONG_CONTEXT_BETAS` directly, ignoring per-model
 *      overrides — so a haiku request (which excludes
 *      `interleaved-thinking-2025-05-14` via the override) would still
 *      "exclude" it on backoff, burning a retry on a beta that wasn't
 *      sent.
 *   2. The retry budget at the call site was `length - 1`, so the
 *      second exclusion attempt never went on the wire.
 * Both are fixed by deriving candidates from the model's actual
 * outgoing betas and giving each one a retry slot.
 */
export const getLongContextBetasFor = (modelId: string): ReadonlyArray<string> => {
  const modelBetas = new Set(deriveModelBetas(modelId, _env.betaFlags))
  return LONG_CONTEXT_BETAS.filter((beta) => modelBetas.has(beta))
}

export const getNextBetaToExclude = (modelId: string): string | null => {
  const excluded = getExcludedBetas(modelId)
  for (const beta of getLongContextBetasFor(modelId)) {
    if (!excluded.has(beta)) return beta
  }
  return null
}

export const getModelBetas = (modelId: string, excluded?: Set<string>): ReadonlyArray<string> =>
  deriveModelBetas(modelId, _env.betaFlags, excluded)

// ── System Identity (exported for keychain-client.ts) ──

export const SYSTEM_IDENTITY_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude."

// ── Custom Fetch ──
// Note: mcp_ tool prefixing, system identity injection, and response stream transforms
// are handled by keychain-client.ts at the AnthropicClient layer.
// This fetch wrapper only handles: auth, headers, beta flags, billing, retry.

// Counsel C8 — single source of truth in `model-config.ts`
// (`MODEL_CONFIG.ccVersion`). Env-var override still wins so users can
// pin a specific CC version without editing source.
const getCliVersion = (): string => _env.cliVersion ?? getCcVersion()

const getUserAgent = (): string => _env.userAgent ?? `claude-cli/${getCliVersion()} (external, cli)`

/**
 * Inputs the billing-header builder needs (CLI version + entrypoint).
 * Lives here because `_env` is the source of truth for the version
 * after `initAnthropicKeychainEnv` runs at extension setup. The actual
 * header text is built in `signing.ts` per request because both hashes
 * depend on the live first-user-message text.
 */
export const getBillingHeaderInputs = (): { version: string; entrypoint: string } => ({
  version: getCliVersion(),
  // eslint-disable-next-line no-process-env
  entrypoint: process.env["CLAUDE_CODE_ENTRYPOINT"] ?? "cli",
})

const buildRequestHeaders = (
  input: RequestInfo | URL,
  init: RequestInit,
  accessToken: string,
  modelId: string,
  excluded?: Set<string>,
): Headers => {
  const headers = new Headers()

  if (input instanceof Request) {
    input.headers.forEach((value, key) => headers.set(key, value))
  }

  if (init.headers instanceof Headers) {
    init.headers.forEach((value, key) => headers.set(key, value))
  } else if (Array.isArray(init.headers)) {
    for (const [key, value] of init.headers) {
      if (typeof value !== "undefined") headers.set(key, String(value))
    }
  } else if (init.headers !== undefined) {
    for (const [key, value] of Object.entries(init.headers)) {
      if (typeof value !== "undefined") headers.set(key, String(value))
    }
  }

  const modelBetas = getModelBetas(modelId, excluded)
  const incomingBeta = headers.get("anthropic-beta") ?? ""
  const mergedBetas = [
    ...new Set([
      ...modelBetas,
      ...incomingBeta
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ]),
  ]

  headers.set("authorization", `Bearer ${accessToken}`)
  headers.set("anthropic-beta", mergedBetas.join(","))
  headers.set("x-app", "cli")
  headers.set("user-agent", getUserAgent())
  // The billing header lives in `system[0]` (see keychain-client.ts +
  // signing.ts), NOT as an HTTP header. The previous header path sent
  // a hard-coded `cch=c5e82` placeholder that tripped the OAuth
  // billing validator on every request — symptom: `InvalidKey` from
  // the SDK on a fresh prompt.
  headers.set("anthropic-dangerous-direct-browser-access", "true")
  headers.delete("x-api-key")

  return headers
}

// Retryable fetch — 429/529 with exponential backoff
class FetchRetryableError extends Schema.TaggedErrorClass<FetchRetryableError>(
  "@gent/extensions/anthropic/oauth/FetchRetryableError",
)("FetchRetryableError", {
  response: Schema.Any,
}) {}

const fetchOnce = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Effect.Effect<Response, FetchRetryableError> =>
  Effect.gen(function* () {
    const doFetch = yield* FetchHttpClient.Fetch
    return yield* Effect.tryPromise({
      try: () => doFetch(input, init),
      catch: (e) => new FetchRetryableError({ response: new Response(String(e), { status: 500 }) }),
    })
  }).pipe(
    Effect.flatMap((res) =>
      res.status === 429 || res.status === 529
        ? Effect.fail(new FetchRetryableError({ response: res }))
        : Effect.succeed(res),
    ),
  )

const fetchWithRetry = (input: RequestInfo | URL, init?: RequestInit): Effect.Effect<Response> =>
  fetchOnce(input, init).pipe(
    Effect.retry({
      times: 2,
      schedule: Schedule.exponential("1 second"),
    }),
    Effect.catchEager((e) => Effect.succeed(e.response)),
  )

// Long-context beta error — retried by excluding offending betas
class LongContextBetaError extends Schema.TaggedErrorClass<LongContextBetaError>(
  "@gent/extensions/anthropic/oauth/LongContextBetaError",
)("LongContextBetaError", {
  response: Schema.Any,
}) {}

const fetchWithBetaRetry = (
  input: RequestInfo | URL,
  init: RequestInit,
  accessToken: string,
  modelId: string,
): Effect.Effect<Response> => {
  const attempt = (): Effect.Effect<Response, LongContextBetaError> =>
    fetchWithRetry(input, {
      ...init,
      headers: buildRequestHeaders(input, init, accessToken, modelId, getExcludedBetas(modelId)),
    }).pipe(
      Effect.flatMap((response) => {
        if (response.status !== 400 && response.status !== 429) {
          return Effect.succeed(response)
        }
        return Effect.tryPromise({
          try: () => response.clone().text(),
          catch: () => new LongContextBetaError({ response }),
        }).pipe(
          Effect.flatMap((body) => {
            if (!isLongContextError(body)) return Effect.succeed(response)
            const beta = getNextBetaToExclude(modelId)
            if (beta === null) return Effect.succeed(response)
            addExcludedBeta(modelId, beta)
            return Effect.fail(new LongContextBetaError({ response }))
          }),
        )
      }),
    )

  // Counsel C8 deep — retry budget = one slot per long-context candidate
  // that actually rides on this model's header. Prior shape used the
  // module-wide LONG_CONTEXT_BETAS.length - 1 which (a) under-counted by
  // one (the second exclusion never reached the wire) and (b) didn't
  // account for per-model overrides removing candidates entirely.
  const candidates = getLongContextBetasFor(modelId)
  return attempt().pipe(
    Effect.retry({ times: candidates.length }),
    Effect.catchEager((e) => Effect.succeed(e.response)),
  )
}

/**
 * Two-callback boundary for the Anthropic SDK fetcher: `load` produces
 * cached/refreshed credentials, `invalidate` busts the cache so the
 * next `load` re-reads. The fetcher uses `invalidate` on a 401 mid-
 * flight to recover from a token that expired between the cache check
 * and the wire send (the credential cache TTL is 30s; a token's last
 * minute can fall inside that window).
 *
 * Defined as a local interface mirror of `runtime-boundary.ts`'s
 * `CredentialLoader` so this module avoids importing from
 * `runtime-boundary.ts` and creating a circular dependency
 * (runtime-boundary already imports `freshEnoughForUse` etc. from here).
 */
export interface AnthropicCredentialLoader {
  readonly load: () => Promise<ClaudeCredentials | null>
  readonly invalidate: () => void
}

export const createAnthropicKeychainFetch = (loader: AnthropicCredentialLoader): typeof fetch => {
  const requireFreshCreds = async (): Promise<ClaudeCredentials> => {
    const latest = await loader.load()
    if (latest === null) {
      throw new Error(
        "Claude Code credentials are unavailable or expired. Run `claude` to refresh them.",
      )
    }
    return latest
  }

  const extractModelId = (init: RequestInit): string => {
    const bodyStr = typeof init.body === "string" ? init.body : undefined
    if (bodyStr === undefined) return "unknown"
    try {
      const body: unknown = JSON.parse(bodyStr)
      if (typeof body === "object" && body !== null && "model" in body) {
        const m = (body as Record<string, unknown>)["model"]
        if (typeof m === "string") return m
      }
    } catch {
      // ignore — modelId stays "unknown"
    }
    return "unknown"
  }

  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestInit = init ?? {}
    const modelId = extractModelId(requestInit)

    let creds = await requireFreshCreds()
    // SDK boundary: Anthropic AI SDK invokes this fetcher as a Promise-
    // returning function (typeof fetch). Promise edge lives in
    // `fetch-boundary.ts`.
    let response = await runAnthropicFetcher(
      fetchWithBetaRetry(input, requestInit, creds.accessToken, modelId),
    )

    // 401 recovery: cache TTL (30s) can outlive the token's last minute,
    // and a token can be revoked server-side between cache fill and
    // wire send. Bust the cache once and retry — `loader.load()` then
    // re-reads from keychain or forces a refresh. One retry only; a
    // 401 on the second attempt is a real auth failure (revoked
    // session, missing scope) and needs to surface to the caller.
    if (response.status === 401) {
      loader.invalidate()
      creds = await requireFreshCreds()
      response = await runAnthropicFetcher(
        fetchWithBetaRetry(input, requestInit, creds.accessToken, modelId),
      )
    }

    return response
  }
  return Object.assign(fetcher, {
    preconnect: fetch.preconnect?.bind(fetch),
  })
}
