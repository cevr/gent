import { Effect, Schedule, Schema } from "effect"
import * as os from "node:os"
import { ProviderAuthError } from "../provider-auth"
import { AuthOauth, type AuthStoreService } from "../../domain/auth-store.js"

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

// ── Token Refresh ──

const spawnClaudeCli = (): Effect.Effect<void, ProviderAuthError> =>
  Effect.tryPromise({
    try: async () => {
      // eslint-disable-next-line no-process-env
      const env = { ...process.env, TERM: "dumb" }
      const proc = Bun.spawn(["claude", "-p", ".", "--model", "haiku"], {
        stdout: "ignore" as unknown as "pipe",
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

export const refreshClaudeCodeCredentials = (): Effect.Effect<void, ProviderAuthError> =>
  spawnClaudeCli().pipe(Effect.retry({ times: 1 }))

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

// ── Tool Name Transforms (mcp_ prefix) ──

const TOOL_PREFIX = "mcp_"

/** Prefix all tool names with mcp_ in outgoing request bodies (Claude Code convention) */
const transformBody = (body: BodyInit | null | undefined): BodyInit | null | undefined => {
  if (typeof body !== "string") return body
  try {
    const parsed = JSON.parse(body) as {
      tools?: Array<{ name?: string } & Record<string, unknown>>
      messages?: Array<{ content?: Array<Record<string, unknown>> }>
    }

    const prefixName = (name: string): string =>
      name.startsWith(TOOL_PREFIX) ? name : `${TOOL_PREFIX}${name}`

    if (Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map((tool) => ({
        ...tool,
        name: tool.name ? prefixName(tool.name) : tool.name,
      }))
    }

    if (Array.isArray(parsed.messages)) {
      parsed.messages = parsed.messages.map((message) => {
        if (!Array.isArray(message.content)) return message
        return {
          ...message,
          content: message.content.map((block) => {
            if (block["type"] !== "tool_use" || typeof block["name"] !== "string") return block
            return { ...block, name: prefixName(block["name"] as string) }
          }),
        }
      })
    }

    return JSON.stringify(parsed)
  } catch {
    return body
  }
}

/** Strip mcp_ prefix from tool names in response stream */
const stripToolPrefix = (text: string): string =>
  text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"')

/** Transform response stream to strip mcp_ prefixes */
const transformResponseStream = (response: Response): Response => {
  if (!response.body) return response

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""

  const drain = async (controller: ReadableStreamDefaultController): Promise<void> => {
    // Emit complete SSE events from buffer
    const boundary = buffer.indexOf("\n\n")
    if (boundary !== -1) {
      const completeEvent = buffer.slice(0, boundary + 2)
      buffer = buffer.slice(boundary + 2)
      controller.enqueue(encoder.encode(stripToolPrefix(completeEvent)))
      return
    }

    const { done, value } = await reader.read()
    if (done) {
      if (buffer) {
        controller.enqueue(encoder.encode(stripToolPrefix(buffer)))
        buffer = ""
      }
      controller.close()
      return
    }

    buffer += decoder.decode(value, { stream: true })
    return drain(controller)
  }

  const stream = new ReadableStream({ pull: (controller) => drain(controller) })

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

// ── System Identity ──

const SYSTEM_IDENTITY_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude."

/** Inject Claude Code system identity into request body if not already present */
const injectSystemIdentity = (body: BodyInit | null | undefined): BodyInit | null | undefined => {
  if (typeof body !== "string") return body
  try {
    const parsed = JSON.parse(body) as {
      system?: string | Array<{ type?: string; text?: string }>
    }

    if (typeof parsed.system === "string") {
      if (!parsed.system.includes(SYSTEM_IDENTITY_PREFIX)) {
        parsed.system = `${SYSTEM_IDENTITY_PREFIX}\n\n${parsed.system}`
      }
    } else if (Array.isArray(parsed.system)) {
      const hasPrefix = parsed.system.some(
        (entry) => typeof entry.text === "string" && entry.text.includes(SYSTEM_IDENTITY_PREFIX),
      )
      if (!hasPrefix) {
        parsed.system.unshift({ type: "text", text: SYSTEM_IDENTITY_PREFIX })
      }
    } else {
      parsed.system = SYSTEM_IDENTITY_PREFIX
    }

    return JSON.stringify(parsed)
  } catch {
    return body
  }
}

// ── Custom Fetch ──

const DEFAULT_CC_VERSION = "2.1.80"

const getCliVersion = (): string => _env.cliVersion ?? DEFAULT_CC_VERSION

const getUserAgent = (): string => _env.userAgent ?? `claude-cli/${getCliVersion()} (external, cli)`

const getBillingHeader = (modelId: string): string =>
  `cc_version=${getCliVersion()}.${modelId}; cc_entrypoint=cli; cch=c5e82;`

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
  headers.set("x-anthropic-billing-header", getBillingHeader(modelId))
  headers.set("anthropic-dangerous-direct-browser-access", "true")
  headers.delete("x-api-key")

  return headers
}

// Retryable fetch — 429/529 with exponential backoff
class FetchRetryableError {
  readonly _tag = "FetchRetryableError"
  constructor(readonly response: Response) {}
}

const fetchOnce = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Effect.Effect<Response, FetchRetryableError> =>
  Effect.tryPromise({
    try: () => fetch(input, init),
    catch: (e) => new FetchRetryableError(new Response(String(e), { status: 500 })),
  }).pipe(
    Effect.flatMap((res) =>
      res.status === 429 || res.status === 529
        ? Effect.fail(new FetchRetryableError(res))
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
class LongContextBetaError {
  readonly _tag = "LongContextBetaError"
  constructor(readonly response: Response) {}
}

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
          catch: () => new LongContextBetaError(response),
        }).pipe(
          Effect.flatMap((body) => {
            if (!isLongContextError(body)) return Effect.succeed(response)
            const beta = getNextBetaToExclude(modelId)
            if (beta === null) return Effect.succeed(response)
            addExcludedBeta(modelId, beta)
            return Effect.fail(new LongContextBetaError(response))
          }),
        )
      }),
    )

  return attempt().pipe(
    Effect.retry({ times: LONG_CONTEXT_BETAS.length - 1 }),
    Effect.catchEager((e) => Effect.succeed(e.response)),
  )
}

// Credential cache
const CREDENTIAL_CACHE_TTL_MS = 30_000
let cachedCredentials: ClaudeCredentials | null = null
let cachedCredentialsAt = 0

const isCredentialUsable = (creds: ClaudeCredentials): boolean =>
  creds.expiresAt > Date.now() + 60_000

const getCachedCredentials = (
  authStore: AuthStoreService,
): Effect.Effect<ClaudeCredentials | null> =>
  Effect.gen(function* () {
    const now = Date.now()
    if (
      cachedCredentials !== null &&
      now - cachedCredentialsAt < CREDENTIAL_CACHE_TTL_MS &&
      isCredentialUsable(cachedCredentials)
    ) {
      return cachedCredentials
    }

    // Read fresh from keychain
    const result = yield* readClaudeCodeCredentials().pipe(
      Effect.catchEager(() => Effect.succeed(null)),
    )
    if (result === null) {
      cachedCredentials = null
      cachedCredentialsAt = 0
      return null
    }

    if (!isCredentialUsable(result)) {
      // Try refresh
      yield* refreshClaudeCodeCredentials().pipe(Effect.catchEager(() => Effect.void))
      const refreshed = yield* readClaudeCodeCredentials().pipe(
        Effect.catchEager(() => Effect.succeed(null)),
      )
      if (refreshed === null || !isCredentialUsable(refreshed)) {
        cachedCredentials = null
        cachedCredentialsAt = 0
        return null
      }
      // Update store with refreshed creds
      yield* authStore
        .set(
          "anthropic",
          new AuthOauth({
            type: "oauth",
            access: refreshed.accessToken,
            refresh: refreshed.refreshToken,
            expires: refreshed.expiresAt,
          }),
        )
        .pipe(Effect.catchEager(() => Effect.void))
      cachedCredentials = refreshed
      cachedCredentialsAt = now
      return refreshed
    }

    cachedCredentials = result
    cachedCredentialsAt = now
    return result
  })

export const createAnthropicKeychainFetch = (authStore: AuthStoreService): typeof fetch => {
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const latest = await Effect.runPromise(getCachedCredentials(authStore))
    if (latest === null) {
      throw new Error(
        "Claude Code credentials are unavailable or expired. Run `claude` to refresh them.",
      )
    }

    const requestInit = init ?? {}
    // Apply body transforms: mcp_ tool prefix + system identity injection
    const transformedBody = injectSystemIdentity(transformBody(requestInit.body))
    const finalInit = { ...requestInit, body: transformedBody }

    const bodyStr = typeof transformedBody === "string" ? transformedBody : undefined
    let modelId = "unknown"
    if (bodyStr !== undefined) {
      try {
        modelId = (JSON.parse(bodyStr) as { model?: string }).model ?? "unknown"
      } catch {
        // ignore
      }
    }

    const response = await Effect.runPromise(
      fetchWithBetaRetry(input, finalInit, latest.accessToken, modelId),
    )
    // Strip mcp_ prefixes from response stream
    return transformResponseStream(response)
  }
  return Object.assign(fetcher, {
    preconnect: fetch.preconnect?.bind(fetch),
  })
}
