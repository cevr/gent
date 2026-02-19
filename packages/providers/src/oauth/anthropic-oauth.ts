import { Effect } from "effect"
import { AuthOauth, type AuthStoreService } from "@gent/core"

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize"
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token"
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback"
const SCOPES = "org:create_api_key user:profile user:inference"

interface PkceCodes {
  verifier: string
  challenge: string
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in?: number
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

const buildAuthorizeUrl = (pkce: PkceCodes, state: string): string => {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state,
  })
  return `${AUTHORIZE_URL}?${params.toString()}`
}

const parseAuthorizationInput = (input: string): { code?: string; state?: string } => {
  const value = input.trim()
  if (value.length === 0) return {}

  if (value.includes("#")) {
    const [code, state] = value.split("#", 2)
    return { code, state }
  }

  return { code: value }
}

const exchangeCodeForTokens = async (
  code: string,
  state: string,
  pkce: PkceCodes,
): Promise<TokenResponse> => {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      state,
      redirect_uri: REDIRECT_URI,
      code_verifier: pkce.verifier,
    }),
  })
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`)
  }
  return response.json()
}

const refreshAccessToken = async (refreshToken: string): Promise<TokenResponse> => {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }),
  })
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`)
  }
  return response.json()
}

export const authorizeAnthropic = async () => {
  const pkce = await generatePKCE()
  const state = generateState()
  const authUrl = buildAuthorizeUrl(pkce, state)

  return {
    authorization: {
      url: authUrl,
      method: "code" as const,
      instructions: "Paste the authorization code from the browser (format: code#state)",
    },
    callback: async (manualInput?: string) => {
      const input = manualInput?.trim() ?? ""
      if (input.length === 0) {
        throw new Error("Authorization code required")
      }

      const parsed = parseAuthorizationInput(input)
      if (parsed.code === undefined || parsed.code.length === 0) {
        throw new Error("Missing authorization code")
      }
      if (parsed.state !== undefined && parsed.state !== state) {
        throw new Error("State mismatch")
      }

      const tokens = await exchangeCodeForTokens(parsed.code, parsed.state ?? state, pkce)
      return {
        type: "oauth" as const,
        access: tokens.access_token,
        refresh: tokens.refresh_token,
        expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      }
    },
  }
}

export const refreshAnthropicOauth = async (refreshToken: string) => {
  const tokens = await refreshAccessToken(refreshToken)
  return {
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  }
}

export const createAnthropicOAuthFetch = (authStore: AuthStoreService): typeof fetch => {
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const current = await Effect.runPromise(
      authStore.get("anthropic").pipe(Effect.catchEager(() => Effect.succeed(undefined))),
    )
    if (current === undefined || current.type !== "oauth") {
      throw new Error("Anthropic OAuth credentials missing")
    }
    let auth = current as AuthOauth
    if (auth.access.length === 0 || auth.expires < Date.now()) {
      const refreshed = await refreshAnthropicOauth(auth.refresh)
      auth = new AuthOauth({ type: "oauth", ...refreshed })
      await Effect.runPromise(authStore.set("anthropic", auth))
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

    // Replace API key auth with Bearer token
    headers.delete("x-api-key")
    headers.set("Authorization", `Bearer ${auth.access}`)

    // Identity headers for Claude Code OAuth
    headers.set("anthropic-beta", "claude-code-20250219,oauth-2025-04-20")
    headers.set("user-agent", "claude-cli/2.1.2 (external, cli)")
    headers.set("x-app", "cli")
    headers.set("anthropic-dangerous-direct-browser-access", "true")

    return fetch(input, {
      ...init,
      headers,
    })
  }
  return Object.assign(fetcher, {
    preconnect: fetch.preconnect?.bind(fetch),
  })
}
