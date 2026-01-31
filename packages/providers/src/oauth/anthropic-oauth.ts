import { Effect } from "effect"
import { AuthApi, AuthOauth, type AuthStoreService } from "@gent/core"

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const CONSOLE_URL = "https://console.anthropic.com"
const CLAUDE_URL = "https://claude.ai"
const TOKEN_URL = `${CONSOLE_URL}/v1/oauth/token`
const TOOL_PREFIX = "mcp_"

interface PkceCodes {
  verifier: string
  challenge: string
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
}

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const stripToolPrefix = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripToolPrefix)
  if (!isRecord(value)) return value
  const type = value["type"]
  const next: JsonRecord = {}
  for (const [key, val] of Object.entries(value)) {
    if (key === "name" && type === "tool_use" && typeof val === "string") {
      next[key] = val.startsWith(TOOL_PREFIX) ? val.slice(TOOL_PREFIX.length) : val
    } else {
      next[key] = stripToolPrefix(val)
    }
  }
  return next
}

export const rewriteAnthropicSseLine = (line: string): string => {
  const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line
  if (!trimmed.startsWith("data:")) return trimmed
  const payload = trimmed.slice(5).trim()
  if (payload.length === 0 || payload === "[DONE]") return trimmed
  try {
    const parsed = JSON.parse(payload)
    const rewritten = stripToolPrefix(parsed)
    return `data: ${JSON.stringify(rewritten)}`
  } catch {
    return trimmed
  }
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

const buildAuthorizeUrl = async (mode: "max" | "console") => {
  const pkce = await generatePKCE()
  const base = mode === "console" ? CONSOLE_URL : CLAUDE_URL
  const url = new URL(`${base}/oauth/authorize`)
  url.searchParams.set("code", "true")
  url.searchParams.set("client_id", CLIENT_ID)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("redirect_uri", `${CONSOLE_URL}/oauth/code/callback`)
  url.searchParams.set("scope", "org:create_api_key user:profile user:inference")
  url.searchParams.set("code_challenge", pkce.challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", pkce.verifier)
  return { url: url.toString(), verifier: pkce.verifier }
}

const exchangeCode = async (code: string, verifier: string): Promise<TokenResponse | undefined> => {
  const splits = code.split("#")
  const result = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: splits[0],
      state: splits[1],
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: `${CONSOLE_URL}/oauth/code/callback`,
      code_verifier: verifier,
    }),
  })
  if (!result.ok) return undefined
  return result.json()
}

const refreshToken = async (refresh: string): Promise<TokenResponse> => {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: CLIENT_ID,
    }),
  })
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`)
  }
  return response.json()
}

export const authorizeAnthropicMax = async () => {
  const { url, verifier } = await buildAuthorizeUrl("max")
  return {
    authorization: {
      url,
      method: "code" as const,
      instructions: "Paste the authorization code here:",
    },
    callback: async (code?: string) => {
      if (code === undefined || code.length === 0) return { type: "failed" as const }
      const tokens = await exchangeCode(code, verifier)
      if (tokens === undefined) return { type: "failed" as const }
      return {
        type: "oauth" as const,
        access: tokens.access_token,
        refresh: tokens.refresh_token,
        expires: Date.now() + tokens.expires_in * 1000,
      }
    },
  }
}

export const authorizeAnthropicCreateApiKey = async () => {
  const { url, verifier } = await buildAuthorizeUrl("console")
  return {
    authorization: {
      url,
      method: "code" as const,
      instructions: "Paste the authorization code here:",
    },
    callback: async (code?: string) => {
      if (code === undefined || code.length === 0) return { type: "failed" as const }
      const tokens = await exchangeCode(code, verifier)
      if (tokens === undefined) return { type: "failed" as const }
      const result = await fetch(`${CONSOLE_URL}/api/oauth/claude_cli/create_api_key`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${tokens.access_token}`,
        },
      }).then((r) => r.json())
      return { type: "api" as const, key: result.raw_key as string }
    },
  }
}

export const createAnthropicOAuthFetch = (authStore: AuthStoreService): typeof fetch => {
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const current = await Effect.runPromise(
      authStore.get("anthropic").pipe(Effect.catchAll(() => Effect.succeed(undefined))),
    )
    if (current === undefined || current.type !== "oauth") {
      throw new Error("Anthropic OAuth credentials missing")
    }
    let auth = current as AuthOauth
    if (auth.access.length === 0 || auth.expires < Date.now()) {
      const tokens = await refreshToken(auth.refresh)
      auth = new AuthOauth({
        type: "oauth",
        access: tokens.access_token,
        refresh: tokens.refresh_token,
        expires: Date.now() + tokens.expires_in * 1000,
      })
      await Effect.runPromise(authStore.set("anthropic", auth))
    }

    const requestInit = init ?? {}
    const requestHeaders = new Headers()
    if (input instanceof Request) {
      input.headers.forEach((value, key) => requestHeaders.set(key, value))
    }
    if (requestInit.headers !== undefined) {
      if (requestInit.headers instanceof Headers) {
        requestInit.headers.forEach((value, key) => requestHeaders.set(key, value))
      } else if (Array.isArray(requestInit.headers)) {
        for (const [key, value] of requestInit.headers) {
          if (typeof value !== "undefined") requestHeaders.set(key, String(value))
        }
      } else {
        for (const [key, value] of Object.entries(requestInit.headers)) {
          if (typeof value !== "undefined") requestHeaders.set(key, String(value))
        }
      }
    }

    const incomingBeta = requestHeaders.get("anthropic-beta") ?? ""
    const incomingBetas = incomingBeta
      .split(",")
      .map((b) => b.trim())
      .filter(Boolean)
    const requiredBetas = ["oauth-2025-04-20", "interleaved-thinking-2025-05-14"]
    const mergedBetas = [...new Set([...requiredBetas, ...incomingBetas])].join(",")

    requestHeaders.set("authorization", `Bearer ${auth.access}`)
    requestHeaders.set("anthropic-beta", mergedBetas)
    requestHeaders.set("user-agent", "claude-cli/2.1.2 (external, cli)")
    requestHeaders.delete("x-api-key")

    let body = requestInit.body
    if (body !== undefined && body !== null && typeof body === "string") {
      try {
        const parsed = JSON.parse(body) as unknown
        if (isRecord(parsed)) {
          const next: JsonRecord = { ...parsed }
          const toolsValue = parsed["tools"]
          if (Array.isArray(toolsValue)) {
            next["tools"] = toolsValue.map((tool) => {
              if (!isRecord(tool)) return tool
              const name = tool["name"]
              if (typeof name !== "string" || name.startsWith(TOOL_PREFIX)) return tool
              return { ...tool, name: `${TOOL_PREFIX}${name}` }
            })
          }
          const messagesValue = parsed["messages"]
          if (Array.isArray(messagesValue)) {
            next["messages"] = messagesValue.map((msg) => {
              if (!isRecord(msg)) return msg
              const content = msg["content"]
              if (!Array.isArray(content)) return msg
              return {
                ...msg,
                content: content.map((block) => {
                  if (!isRecord(block)) return block
                  if (block["type"] !== "tool_use") return block
                  const name = block["name"]
                  if (typeof name !== "string" || name.startsWith(TOOL_PREFIX)) return block
                  return { ...block, name: `${TOOL_PREFIX}${name}` }
                }),
              }
            })
          }
          body = JSON.stringify(next)
        }
      } catch {
        // ignore parse errors
      }
    }

    let requestInput: RequestInfo | URL = input
    let requestUrl: URL | null = null
    try {
      if (typeof input === "string" || input instanceof URL) {
        requestUrl = new URL(input.toString())
      } else if (input instanceof Request) {
        requestUrl = new URL(input.url)
      }
    } catch {
      requestUrl = null
    }

    if (
      requestUrl !== null &&
      requestUrl.pathname === "/v1/messages" &&
      !requestUrl.searchParams.has("beta")
    ) {
      requestUrl.searchParams.set("beta", "true")
      requestInput =
        input instanceof Request ? new Request(requestUrl.toString(), input) : requestUrl
    }

    const response = await fetch(requestInput, {
      ...requestInit,
      body,
      headers: requestHeaders,
    })

    if (response.body !== null) {
      const contentType = response.headers.get("content-type") ?? ""
      if (contentType.includes("text/event-stream")) {
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        const encoder = new TextEncoder()
        let buffer = ""
        const stream = new ReadableStream({
          async pull(controller) {
            const { done, value } = await reader.read()
            if (done) {
              if (buffer.length > 0) {
                const line = buffer
                buffer = ""
                const rewritten = rewriteAnthropicSseLine(line)
                controller.enqueue(encoder.encode(rewritten + "\n"))
              }
              controller.close()
              return
            }
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split("\n")
            buffer = lines.pop() ?? ""
            for (const line of lines) {
              const rewritten = rewriteAnthropicSseLine(line)
              controller.enqueue(encoder.encode(rewritten + "\n"))
            }
          },
        })
        return new Response(stream, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      }
    }

    if (response.body !== null) {
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const encoder = new TextEncoder()
      const chunks: Uint8Array[] = []
      let total = 0
      const readAll = async (): Promise<void> => {
        const { done, value } = await reader.read()
        if (done) return
        if (value !== undefined) {
          chunks.push(value)
          total += value.length
        }
        await readAll()
      }
      await readAll()
      const merged = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        merged.set(chunk, offset)
        offset += chunk.length
      }
      const text = decoder.decode(merged)
      try {
        const parsed = JSON.parse(text)
        const rewritten = stripToolPrefix(parsed)
        return new Response(JSON.stringify(rewritten), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      } catch {
        return new Response(encoder.encode(text), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      }
    }

    return response
  }

  return Object.assign(fetcher, {
    preconnect: fetch.preconnect?.bind(fetch),
  })
}

export const toAuthApi = (key: string) => new AuthApi({ type: "api", key })
