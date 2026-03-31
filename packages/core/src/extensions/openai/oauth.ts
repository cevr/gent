import type { AuthOauth } from "../../domain/auth-store.js"
import { Buffer } from "node:buffer"
import * as os from "node:os"

export const OPENAI_OAUTH_ALLOWED_MODELS = new Set(["gpt-5.4", "gpt-5.4-mini"])

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const ISSUER = "https://auth.openai.com"
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
const OAUTH_PORT = 1455

interface PkceCodes {
  verifier: string
  challenge: string
}

interface TokenResponse {
  id_token?: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

interface PendingOAuth {
  pkce: PkceCodes
  state: string
  resolve: (tokens: TokenResponse) => void
  reject: (error: Error) => void
}

let oauthServer: ReturnType<typeof Bun.serve> | undefined
const pendingOAuth = new Map<string, PendingOAuth>()

interface ResolvedRequestTarget {
  url: URL
  shouldRewrite: boolean
}

const generateRandomString = (length: number): string => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join("")
}

const base64UrlEncode = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer)
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

const generatePKCE = async (): Promise<PkceCodes> => {
  const verifier = generateRandomString(43)
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const hash = await crypto.subtle.digest("SHA-256", data)
  const challenge = base64UrlEncode(hash)
  return { verifier, challenge }
}

const generateState = (): string =>
  base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)

const parseJwtClaims = (token: string): Record<string, unknown> | undefined => {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString())
  } catch {
    return undefined
  }
}

const extractAccountId = (tokens: TokenResponse): string | undefined => {
  const fromClaims = (claims: Record<string, unknown> | undefined): string | undefined => {
    if (claims === undefined) return undefined
    const direct = claims["chatgpt_account_id"]
    if (typeof direct === "string") return direct
    const scoped = claims["https://api.openai.com/auth"]
    if (scoped !== null && typeof scoped === "object") {
      const value = (scoped as { chatgpt_account_id?: unknown }).chatgpt_account_id
      if (typeof value === "string") return value
    }
    const orgs = claims["organizations"]
    if (Array.isArray(orgs) && orgs.length > 0) {
      const id = orgs[0]?.id
      if (typeof id === "string") return id
    }
    return undefined
  }

  if (typeof tokens.id_token === "string") {
    const accountId = fromClaims(parseJwtClaims(tokens.id_token))
    if (accountId !== undefined && accountId.length > 0) return accountId
  }
  if (typeof tokens.access_token === "string") {
    return fromClaims(parseJwtClaims(tokens.access_token))
  }
  return undefined
}

const buildAuthorizeUrl = (redirectUri: string, pkce: PkceCodes, state: string): string => {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "gent",
  })
  return `${ISSUER}/oauth/authorize?${params.toString()}`
}

const parseAuthorizationInput = (input: string): { code?: string; state?: string } => {
  const value = input.trim()
  if (value.length === 0) return {}

  try {
    const url = new URL(value)
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    }
  } catch {
    // not a URL
  }

  if (value.includes("#")) {
    const [code, state] = value.split("#", 2)
    return { code, state }
  }

  if (value.includes("code=")) {
    const params = new URLSearchParams(value)
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    }
  }

  return { code: value }
}

const exchangeCodeForTokens = async (
  code: string,
  redirectUri: string,
  pkce: PkceCodes,
): Promise<TokenResponse> => {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`)
  }
  return response.json()
}

const refreshAccessToken = async (refreshToken: string): Promise<TokenResponse> => {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`)
  }
  return response.json()
}

const HTML_SUCCESS = `<!doctype html>
<html>
  <head>
    <title>Gent - Codex Authorization Successful</title>
  </head>
  <body>
    <h1>Authorization Successful</h1>
    <p>You can close this window and return to Gent.</p>
    <script>
      setTimeout(() => window.close(), 2000)
    </script>
  </body>
</html>`

const HTML_ERROR = (error: string) => `<!doctype html>
<html>
  <head>
    <title>Gent - Codex Authorization Failed</title>
  </head>
  <body>
    <h1>Authorization Failed</h1>
    <p>${error}</p>
  </body>
</html>`

const startOAuthServer = async (): Promise<{ port: number; redirectUri: string }> => {
  if (oauthServer !== undefined) {
    return { port: OAUTH_PORT, redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
  }

  oauthServer = Bun.serve({
    port: OAUTH_PORT,
    fetch(req) {
      const url = new URL(req.url)

      if (url.pathname === "/auth/callback") {
        const code = url.searchParams.get("code")
        const stateParam = url.searchParams.get("state")
        const error = url.searchParams.get("error")
        const errorDescription = url.searchParams.get("error_description")
        const pending = stateParam !== null ? pendingOAuth.get(stateParam) : undefined

        if (error !== null) {
          const errorMsg = errorDescription ?? error
          if (pending !== undefined && stateParam !== null) {
            pendingOAuth.delete(stateParam)
            pending.reject(new Error(errorMsg))
          }
          if (pendingOAuth.size === 0) stopOAuthServer()
          return new Response(HTML_ERROR(errorMsg), { headers: { "Content-Type": "text/html" } })
        }

        if (code === null || code.length === 0) {
          const errorMsg = "Missing authorization code"
          if (pending !== undefined && stateParam !== null) {
            pendingOAuth.delete(stateParam)
            pending.reject(new Error(errorMsg))
          }
          if (pendingOAuth.size === 0) stopOAuthServer()
          return new Response(HTML_ERROR(errorMsg), {
            status: 400,
            headers: { "Content-Type": "text/html" },
          })
        }

        if (stateParam === null || pending === undefined) {
          const errorMsg = "Invalid state"
          if (pending !== undefined && stateParam !== null) {
            pendingOAuth.delete(stateParam)
            pending.reject(new Error(errorMsg))
          }
          if (pendingOAuth.size === 0) stopOAuthServer()
          return new Response(HTML_ERROR(errorMsg), {
            status: 400,
            headers: { "Content-Type": "text/html" },
          })
        }

        pendingOAuth.delete(stateParam)
        if (pendingOAuth.size === 0) stopOAuthServer()

        exchangeCodeForTokens(code, `http://localhost:${OAUTH_PORT}/auth/callback`, pending.pkce)
          .then((tokens) => pending.resolve(tokens))
          .catch((err) => pending.reject(err))

        return new Response(HTML_SUCCESS, { headers: { "Content-Type": "text/html" } })
      }

      return new Response("Not found", { status: 404 })
    },
  })

  return { port: OAUTH_PORT, redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
}

const stopOAuthServer = () => {
  if (oauthServer !== undefined) {
    oauthServer.stop()
    oauthServer = undefined
  }
}

const waitForOAuthCallback = (
  pkce: PkceCodes,
  state: string,
): { promise: Promise<TokenResponse>; cancel: (reason: string) => void } => {
  let resolveFn: (tokens: TokenResponse) => void
  let rejectFn: (error: Error) => void
  const promise = new Promise<TokenResponse>((resolve, reject) => {
    resolveFn = resolve
    rejectFn = reject
  })

  const timeout = setTimeout(
    () => {
      if (pendingOAuth.has(state)) {
        pendingOAuth.delete(state)
        if (pendingOAuth.size === 0) stopOAuthServer()
        rejectFn(new Error("OAuth callback timeout"))
      }
    },
    5 * 60 * 1000,
  )

  pendingOAuth.set(state, {
    pkce,
    state,
    resolve: (tokens) => {
      clearTimeout(timeout)
      resolveFn(tokens)
    },
    reject: (error) => {
      clearTimeout(timeout)
      rejectFn(error)
    },
  })

  const cancel = (reason: string) => {
    if (pendingOAuth.has(state)) {
      pendingOAuth.delete(state)
      if (pendingOAuth.size === 0) stopOAuthServer()
    }
    clearTimeout(timeout)
    rejectFn(new Error(reason))
  }

  return { promise, cancel }
}

export const authorizeOpenAI = async () => {
  const { redirectUri } = await startOAuthServer()
  const pkce = await generatePKCE()
  const state = generateState()
  const authUrl = buildAuthorizeUrl(redirectUri, pkce, state)
  const pending = waitForOAuthCallback(pkce, state)

  return {
    authorization: {
      url: authUrl,
      method: "auto" as const,
      instructions: "Complete authorization in your browser. Paste the code if needed.",
    },
    callback: async (manualInput?: string) => {
      if (manualInput !== undefined && manualInput.trim().length > 0) {
        const parsed = parseAuthorizationInput(manualInput)
        if (parsed.state !== undefined && parsed.state !== state) {
          pending.cancel("State mismatch")
          void pending.promise.catch(() => {})
          throw new Error("State mismatch")
        }
        if (parsed.code === undefined || parsed.code.length === 0) {
          pending.cancel("Missing authorization code")
          void pending.promise.catch(() => {})
          throw new Error("Missing authorization code")
        }
        pending.cancel("Manual authorization code provided")
        void pending.promise.catch(() => {})
        const tokens = await exchangeCodeForTokens(parsed.code, redirectUri, pkce)
        const accountId = extractAccountId(tokens)
        return {
          type: "oauth" as const,
          access: tokens.access_token,
          refresh: tokens.refresh_token,
          expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
          ...(accountId !== undefined && accountId.length > 0 ? { accountId } : {}),
        }
      }

      const tokens = await pending.promise
      const accountId = extractAccountId(tokens)
      return {
        type: "oauth" as const,
        access: tokens.access_token,
        refresh: tokens.refresh_token,
        expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
        ...(accountId !== undefined && accountId.length > 0 ? { accountId } : {}),
      }
    },
  }
}

export const refreshOpenAIOauth = async (refreshToken: string) => {
  const tokens = await refreshAccessToken(refreshToken)
  const accountId = extractAccountId(tokens)
  return {
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    ...(accountId !== undefined && accountId.length > 0 ? { accountId } : {}),
  }
}

const copyHeadersInto = (headers: Headers, source: HeadersInit) => {
  if (source instanceof Headers) {
    source.forEach((value, key) => headers.set(key, value))
    return
  }
  if (Array.isArray(source)) {
    for (const [key, value] of source) {
      if (value !== undefined) headers.set(key, String(value))
    }
    return
  }
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) headers.set(key, String(value))
  }
}

const createAuthHeaders = (initHeaders: HeadersInit | undefined, auth: AuthOauth) => {
  const headers = new Headers()
  if (initHeaders !== undefined) copyHeadersInto(headers, initHeaders)

  headers.delete("authorization")
  headers.delete("Authorization")
  headers.set("authorization", `Bearer ${auth.access}`)
  if (auth.accountId !== undefined && auth.accountId.length > 0) {
    headers.set("ChatGPT-Account-Id", auth.accountId)
  }
  if (!headers.has("originator")) headers.set("originator", "gent")
  if (!headers.has("User-Agent")) {
    headers.set("User-Agent", `gent (${os.platform()} ${os.release()}; ${os.arch()})`)
  }

  return headers
}

const resolveRequestTarget = (input: RequestInfo | URL): ResolvedRequestTarget => {
  const parsed =
    input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url)
  const shouldRewrite =
    parsed.pathname.includes("/responses") || parsed.pathname.includes("/chat/completions")
  return {
    url: shouldRewrite ? new URL(CODEX_API_ENDPOINT) : parsed,
    shouldRewrite,
  }
}

const splitInstructions = (input: unknown) => {
  if (!Array.isArray(input)) return undefined

  const instructions: string[] = []
  const filteredInput: unknown[] = []
  for (const item of input) {
    if (
      item !== null &&
      typeof item === "object" &&
      (item.role === "developer" || item.role === "system")
    ) {
      if (typeof item.content === "string") instructions.push(item.content)
      continue
    }
    filteredInput.push(item)
  }

  return { instructions, filteredInput }
}

const rewriteCodexBody = (body: BodyInit | null | undefined): BodyInit | null | undefined => {
  if (typeof body !== "string") return body

  try {
    const parsedBody = JSON.parse(body)
    const split = splitInstructions(parsedBody.input)
    if (split !== undefined) {
      if (split.instructions.length > 0) {
        parsedBody.instructions = split.instructions.join("\n\n")
      }
      parsedBody.input = split.filteredInput
      parsedBody.store = false
    }
    return JSON.stringify(parsedBody)
  } catch (e) {
    // Body rewrite failed — leave unchanged, log for debugging
    console.debug("[openai-oauth] body rewrite failed:", e)
    return body
  }
}

export const createOpenAIOAuthFetch = (loadAuth: () => Promise<AuthOauth>): typeof fetch => {
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const auth = await loadAuth()
    const { url, shouldRewrite } = resolveRequestTarget(input)
    const headers = createAuthHeaders(init?.headers, auth)
    if (shouldRewrite && !headers.has("OpenAI-Beta")) {
      headers.set("OpenAI-Beta", "responses=experimental")
    }
    const body = shouldRewrite ? rewriteCodexBody(init?.body) : init?.body

    return fetch(url, {
      ...init,
      body,
      headers,
    })
  }
  return Object.assign(fetcher, {
    preconnect: fetch.preconnect?.bind(fetch),
  })
}
