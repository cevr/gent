import { Effect } from "effect"
import { AuthOauth, type AuthStoreService } from "@gent/core"
import { Buffer } from "node:buffer"

export const OPENAI_OAUTH_ALLOWED_MODELS = new Set([
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.1-codex",
])

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

const waitForOAuthCallback = (pkce: PkceCodes, state: string): Promise<TokenResponse> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        if (pendingOAuth.has(state)) {
          pendingOAuth.delete(state)
          if (pendingOAuth.size === 0) stopOAuthServer()
          reject(new Error("OAuth callback timeout"))
        }
      },
      5 * 60 * 1000,
    )

    pendingOAuth.set(state, {
      pkce,
      state,
      resolve: (tokens) => {
        clearTimeout(timeout)
        resolve(tokens)
      },
      reject: (error) => {
        clearTimeout(timeout)
        reject(error)
      },
    })
  })

export const authorizeOpenAI = async () => {
  const { redirectUri } = await startOAuthServer()
  const pkce = await generatePKCE()
  const state = generateState()
  const authUrl = buildAuthorizeUrl(redirectUri, pkce, state)
  const callbackPromise = waitForOAuthCallback(pkce, state)

  return {
    authorization: {
      url: authUrl,
      method: "auto" as const,
      instructions: "Complete authorization in your browser.",
    },
    callback: async () => {
      const tokens = await callbackPromise
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

export const createOpenAIOAuthFetch = (authStore: AuthStoreService): typeof fetch => {
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const current = await Effect.runPromise(
      authStore.get("openai").pipe(Effect.catchAll(() => Effect.succeed(undefined))),
    )
    if (current === undefined || current.type !== "oauth") {
      throw new Error("OpenAI OAuth credentials missing")
    }
    let auth = current as AuthOauth
    if (auth.access.length === 0 || auth.expires < Date.now()) {
      const refreshed = await refreshOpenAIOauth(auth.refresh)
      auth = new AuthOauth({ type: "oauth", ...refreshed })
      await Effect.runPromise(authStore.set("openai", auth))
    }

    const headers = new Headers()
    if (init?.headers !== undefined) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => headers.set(key, value))
      } else if (Array.isArray(init.headers)) {
        for (const [key, value] of init.headers) {
          if (value !== undefined) headers.set(key, String(value))
        }
      } else {
        for (const [key, value] of Object.entries(init.headers)) {
          if (value !== undefined) headers.set(key, String(value))
        }
      }
    }

    headers.delete("authorization")
    headers.delete("Authorization")
    headers.set("authorization", `Bearer ${auth.access}`)
    if (auth.accountId !== undefined && auth.accountId.length > 0) {
      headers.set("ChatGPT-Account-Id", auth.accountId)
    }

    const parsed =
      input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url)
    const shouldRewrite =
      parsed.pathname.includes("/responses") || parsed.pathname.includes("/chat/completions")
    const url = shouldRewrite ? new URL(CODEX_API_ENDPOINT) : parsed

    return fetch(url, {
      ...init,
      headers,
    })
  }
  return Object.assign(fetcher, {
    preconnect: fetch.preconnect?.bind(fetch),
  })
}
