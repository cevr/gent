import { Effect, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as os from "node:os"
import { ProviderAuthError } from "@gent/core/extensions/api"
import { runAnthropicFetcher } from "./fetch-boundary.js"

// ── Claude Code Keychain Reader ──

const CLAUDE_CODE_SERVICE = "Claude Code-credentials"
const CREDENTIALS_FILE = `${os.homedir()}/.claude/.credentials.json`

const ClaudeCredentials = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Number,
})

const ClaudeCredentialsWrapper = Schema.Struct({
  claudeAiOauth: ClaudeCredentials,
})

type ClaudeCredentials = typeof ClaudeCredentials.Type

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

const readFromKeychain = (): Effect.Effect<
  ClaudeCredentials,
  ProviderAuthError | ClaudeKeychainNotFoundError
> =>
  spawnSecurity(["find-generic-password", "-s", CLAUDE_CODE_SERVICE, "-w"]).pipe(
    Effect.flatMap(decodeCredentials),
  )

export const readClaudeCodeCredentials = (): Effect.Effect<
  ClaudeCredentials,
  ProviderAuthError
> => {
  if (process.platform !== "darwin") {
    return readCredentialsFile()
  }
  return readFromKeychain().pipe(
    Effect.catchIf(Schema.is(ClaudeKeychainNotFoundError), () => readCredentialsFile()),
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
      if (process.platform !== "darwin") return [CLAUDE_CODE_SERVICE]
      const proc = Bun.spawn(["security", "dump-keychain"], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      })
      const raw = await new Response(proc.stdout).text()
      const code = await proc.exited
      if (code !== 0) return [CLAUDE_CODE_SERVICE]
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
      if (seen.has(CLAUDE_CODE_SERVICE)) ordered.push(CLAUDE_CODE_SERVICE)
      for (const svc of services) {
        if (svc !== CLAUDE_CODE_SERVICE) ordered.push(svc)
      }
      return ordered.length > 0 ? ordered : [CLAUDE_CODE_SERVICE]
    },
    catch: (e) =>
      new ProviderAuthError({
        message: `Failed to enumerate Claude keychain services: ${e instanceof Error ? e.message : String(e)}`,
        cause: e,
      }),
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
 * Persist refreshed credentials back to the source they were read from
 * (keychain entry on darwin, `~/.claude/.credentials.json` elsewhere).
 * Without this, every direct OAuth refresh is wasted — the next read
 * pulls the stale `accessToken` straight back from disk/keychain. The
 * `acct` field is preserved by reading the existing entry first.
 *
 * Errors are swallowed; the caller has the new credentials in memory
 * and a write-back failure should not kill the in-flight request.
 */
export const writeBackCredentials = (
  creds: ClaudeCredentials,
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
        },
        catch: (e) =>
          new ProviderAuthError({
            message: `Failed to write Claude credentials file: ${e instanceof Error ? e.message : String(e)}`,
            cause: e,
          }),
      })
      return
    }

    const raw = yield* spawnSecurity([
      "find-generic-password",
      "-s",
      CLAUDE_CODE_SERVICE,
      "-w",
    ]).pipe(Effect.catchEager(() => Effect.succeed("")))
    if (raw === "") return
    const updated = updateCredentialBlob(raw, creds)
    if (updated === undefined) return
    const accountName = (yield* getKeychainAccountName(CLAUDE_CODE_SERVICE)) ?? CLAUDE_CODE_SERVICE
    yield* writeKeychainEntry(CLAUDE_CODE_SERVICE, accountName, updated)
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
 * Refresh the cached Claude Code credentials. Tries the direct OAuth
 * endpoint first (fast, free); falls back to spawning `claude` (slow,
 * costs Haiku tokens) only if the direct path fails. On successful
 * direct refresh, writes the new credentials back to the keychain (or
 * `~/.claude/.credentials.json` on non-darwin) so subsequent reads
 * pick up the new access_token without another HTTP round-trip.
 */
export const refreshClaudeCodeCredentials = (): Effect.Effect<void, ProviderAuthError> =>
  Effect.gen(function* () {
    const current = yield* readClaudeCodeCredentials().pipe(
      Effect.catchEager(() => Effect.succeed(undefined)),
    )
    if (current?.refreshToken !== undefined && current.refreshToken !== "") {
      const refreshed = yield* refreshViaOAuth(current.refreshToken).pipe(
        Effect.catchEager(() => Effect.succeed(undefined)),
      )
      if (refreshed !== undefined) {
        yield* writeBackCredentials(refreshed).pipe(Effect.ignore)
        return
      }
    }
    // Fall back to the CLI spawn — second attempt of the same path
    // historically helps when the CLI's first invocation just kicks
    // a stale-token error.
    yield* spawnClaudeCli().pipe(Effect.retry({ times: 1 }))
  })

// ── Beta Management ──

const DEFAULT_BETA_FLAGS =
  "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05"

export const LONG_CONTEXT_BETAS = ["context-1m-2025-08-07", "interleaved-thinking-2025-05-14"]

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

const getRequiredBetas = (): string[] =>
  (_env.betaFlags ?? DEFAULT_BETA_FLAGS)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

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

export const getNextBetaToExclude = (modelId: string): string | null => {
  const excluded = getExcludedBetas(modelId)
  for (const beta of LONG_CONTEXT_BETAS) {
    if (!excluded.has(beta)) return beta
  }
  return null
}

export const getModelBetas = (modelId: string, excluded?: Set<string>): string[] => {
  const betas = [...getRequiredBetas()]
  const lower = modelId.toLowerCase()

  // context-1m for opus/sonnet 4.6+ (1M context is default for these models)
  if (lower.includes("opus") || lower.includes("sonnet")) {
    const versionMatch = lower.match(/(opus|sonnet)-(\d+)-(\d+)/)
    if (versionMatch) {
      const majorStr = versionMatch[2]
      const minorStr = versionMatch[3]
      if (majorStr !== undefined && minorStr !== undefined) {
        const major = parseInt(majorStr, 10)
        const minor = parseInt(minorStr, 10)
        const effectiveMinor = minor > 99 ? 0 : minor
        if (major > 4 || (major === 4 && effectiveMinor >= 6)) {
          betas.push("context-1m-2025-08-07")
        }
      }
    }
  }

  // haiku doesn't get claude-code-20250219
  if (lower.includes("haiku")) {
    const idx = betas.indexOf("claude-code-20250219")
    if (idx !== -1) betas.splice(idx, 1)
  }

  if (excluded !== undefined && excluded.size > 0) {
    return betas.filter((beta) => !excluded.has(beta))
  }

  return betas
}

// ── System Identity (exported for keychain-client.ts) ──

export const SYSTEM_IDENTITY_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude."

// ── Custom Fetch ──
// Note: mcp_ tool prefixing, system identity injection, and response stream transforms
// are handled by keychain-client.ts at the AnthropicClient layer.
// This fetch wrapper only handles: auth, headers, beta flags, billing, retry.

const DEFAULT_CC_VERSION = "2.1.80"

const getCliVersion = (): string => _env.cliVersion ?? DEFAULT_CC_VERSION

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

  return attempt().pipe(
    Effect.retry({ times: LONG_CONTEXT_BETAS.length - 1 }),
    Effect.catchEager((e) => Effect.succeed(e.response)),
  )
}

export const createAnthropicKeychainFetch = (
  loadCredentials: () => Promise<ClaudeCredentials | null>,
): typeof fetch => {
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const latest = await loadCredentials()
    if (latest === null) {
      throw new Error(
        "Claude Code credentials are unavailable or expired. Run `claude` to refresh them.",
      )
    }

    const requestInit = init ?? {}

    // Extract model ID from body for header construction
    const bodyStr = typeof requestInit.body === "string" ? requestInit.body : undefined
    let modelId = "unknown"
    if (bodyStr !== undefined) {
      try {
        const body: unknown = JSON.parse(bodyStr)
        if (typeof body === "object" && body !== null && "model" in body) {
          const m = (body as Record<string, unknown>)["model"]
          if (typeof m === "string") modelId = m
        }
      } catch {
        // ignore
      }
    }

    // SDK boundary: Anthropic AI SDK invokes this fetcher as a Promise-returning
    // function (typeof fetch). Promise edge lives in `fetch-boundary.ts`.
    return runAnthropicFetcher(fetchWithBetaRetry(input, requestInit, latest.accessToken, modelId))
  }
  return Object.assign(fetcher, {
    preconnect: fetch.preconnect?.bind(fetch),
  })
}
