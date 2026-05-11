import { Clock, Deferred, Effect, Exit, Layer, Option, Schema, Scope } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import { BunHttpServer } from "@effect/platform-bun"

const JwtClaimsSchema = Schema.Record(Schema.String, Schema.Unknown)
const decodeJwtClaims = Schema.decodeUnknownOption(Schema.fromJsonString(JwtClaimsSchema))

const TokenResponseSchema = Schema.Struct({
  id_token: Schema.optional(Schema.String),
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.optional(Schema.Number),
})
const decodeTokenResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(TokenResponseSchema))
type TokenResponse = typeof TokenResponseSchema.Type

/**
 * Typed error for the OpenAI OAuth flow. `reason` discriminates the
 * failure mode so the surrounding `ProviderAuthError` boundary in
 * `index.ts` preserves structure in `cause`, not just a string.
 */
export class OAuthError extends Schema.TaggedErrorClass<OAuthError>()("OAuthError", {
  reason: Schema.Literals([
    "token-exchange-failed",
    "token-refresh-failed",
    "callback-error",
    "missing-code",
    "state-mismatch",
    "callback-timeout",
    "cancelled",
    "pkce-failed",
    "server-failed",
  ]),
  message: Schema.String,
}) {}

export const OPENAI_OAUTH_ALLOWED_MODELS = new Set(["gpt-5.4", "gpt-5.4-mini"])

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const ISSUER = "https://auth.openai.com"
const OAUTH_PORT = 1455

interface PkceCodes {
  readonly verifier: string
  readonly challenge: string
}

export interface OpenAIOAuthTokens {
  readonly type: "oauth"
  readonly access: string
  readonly refresh: string
  readonly expires: number
  readonly accountId?: string
}

export interface OpenAIRefreshTokens {
  readonly access: string
  readonly refresh: string
  readonly expires: number
  readonly accountId?: string
}

export interface OpenAIAuthorizationFlow {
  readonly authorization: {
    readonly url: string
    readonly method: "auto"
    readonly instructions: string
  }
  readonly callback: (manualInput?: string) => Effect.Effect<OpenAIOAuthTokens, OAuthError>
  readonly cancel: Effect.Effect<void>
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

const base64UrlDecodeToString = (input: string): string => {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/")
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4))
  const binary = atob(padded + pad)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

const generatePKCE: Effect.Effect<PkceCodes, OAuthError> = Effect.gen(function* () {
  const verifier = generateRandomString(43)
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const hash = yield* Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", data),
    catch: (e) =>
      new OAuthError({
        reason: "pkce-failed",
        message: `PKCE digest failed: ${e instanceof Error ? e.message : String(e)}`,
      }),
  })
  const challenge = base64UrlEncode(hash)
  return { verifier, challenge }
})

const generateState = (): string =>
  base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)

const parseJwtClaims = (token: string): Record<string, unknown> | undefined => {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  const json = base64UrlDecodeToString(parts[1] ?? "")
  return Option.getOrUndefined(decodeJwtClaims(json))
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

const tryParseUrl = (value: string): URL | undefined => {
  // URL parsing is the only sync operation that legitimately needs a try/catch
  // here — there is no Effect or Option-returning URL parser in the runtime.
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

const parseAuthorizationInput = (input: string): { code?: string; state?: string } => {
  const value = input.trim()
  if (value.length === 0) return {}

  const parsed = tryParseUrl(value)
  if (parsed !== undefined) {
    return {
      code: parsed.searchParams.get("code") ?? undefined,
      state: parsed.searchParams.get("state") ?? undefined,
    }
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

const exchangeCodeForTokens = (
  code: string,
  redirectUri: string,
  pkce: PkceCodes,
): Effect.Effect<TokenResponse, OAuthError> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const request = HttpClientRequest.post(`${ISSUER}/oauth/token`).pipe(
      HttpClientRequest.bodyUrlParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: CLIENT_ID,
        code_verifier: pkce.verifier,
      }),
    )
    const response = yield* http.execute(request)
    if (response.status >= 400) {
      return yield* new OAuthError({
        reason: "token-exchange-failed",
        message: `Token exchange failed: ${response.status}`,
      })
    }
    const body = yield* response.text
    return yield* decodeTokenResponse(body).pipe(
      Effect.mapError(
        (e) =>
          new OAuthError({
            reason: "token-exchange-failed",
            message: `Token exchange response invalid: ${e.message}`,
          }),
      ),
    )
  }).pipe(
    Effect.catchTag("HttpClientError", (e) =>
      Effect.fail(
        new OAuthError({
          reason: "token-exchange-failed",
          message: `Token exchange HTTP failed: ${e.message}`,
        }),
      ),
    ),
    // @effect-diagnostics-next-line strictEffectProvide:off OAuth token endpoint at extension boundary
    Effect.provide(FetchHttpClient.layer),
  )

const refreshAccessToken = (refreshToken: string): Effect.Effect<TokenResponse, OAuthError> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const request = HttpClientRequest.post(`${ISSUER}/oauth/token`).pipe(
      HttpClientRequest.bodyUrlParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    )
    const response = yield* http.execute(request)
    if (response.status >= 400) {
      return yield* new OAuthError({
        reason: "token-refresh-failed",
        message: `Token refresh failed: ${response.status}`,
      })
    }
    const body = yield* response.text
    return yield* decodeTokenResponse(body).pipe(
      Effect.mapError(
        (e) =>
          new OAuthError({
            reason: "token-refresh-failed",
            message: `Token refresh response invalid: ${e.message}`,
          }),
      ),
    )
  }).pipe(
    Effect.catchTag("HttpClientError", (e) =>
      Effect.fail(
        new OAuthError({
          reason: "token-refresh-failed",
          message: `Token refresh HTTP failed: ${e.message}`,
        }),
      ),
    ),
    // @effect-diagnostics-next-line strictEffectProvide:off OAuth token endpoint at extension boundary
    Effect.provide(FetchHttpClient.layer),
  )

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

interface PendingCallbackPayload {
  readonly code: string
  readonly state: string
}

/**
 * Build the redirect-server route layer. The handler resolves the
 * deferred with the parsed callback parameters and renders an HTML
 * status page for the browser. State validation happens here so the
 * browser sees the right page; the deferred always carries the raw
 * `(code, state)` pair.
 */
const buildCallbackRoutes = (
  expectedState: string,
  deferred: Deferred.Deferred<PendingCallbackPayload, OAuthError>,
) =>
  HttpRouter.add(
    "GET",
    "/auth/callback",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const url = new URL(request.url, `http://localhost:${OAUTH_PORT}`)
      const code = url.searchParams.get("code")
      const stateParam = url.searchParams.get("state")
      const error = url.searchParams.get("error")
      const errorDescription = url.searchParams.get("error_description")

      if (error !== null) {
        const errorMsg = errorDescription ?? error
        yield* Deferred.fail(
          deferred,
          new OAuthError({ reason: "callback-error", message: errorMsg }),
        )
        return HttpServerResponse.html(HTML_ERROR(errorMsg))
      }
      if (code === null || code.length === 0) {
        const errorMsg = "Missing authorization code"
        yield* Deferred.fail(
          deferred,
          new OAuthError({ reason: "missing-code", message: errorMsg }),
        )
        return HttpServerResponse.setStatus(HttpServerResponse.html(HTML_ERROR(errorMsg)), 400)
      }
      if (stateParam === null || stateParam !== expectedState) {
        const errorMsg = "Invalid state"
        yield* Deferred.fail(
          deferred,
          new OAuthError({ reason: "state-mismatch", message: errorMsg }),
        )
        return HttpServerResponse.setStatus(HttpServerResponse.html(HTML_ERROR(errorMsg)), 400)
      }

      yield* Deferred.succeed(deferred, { code, state: stateParam })
      return HttpServerResponse.html(HTML_SUCCESS)
    }),
  )

const startRedirectServer = (
  expectedState: string,
  deferred: Deferred.Deferred<PendingCallbackPayload, OAuthError>,
): Effect.Effect<void, OAuthError, Scope.Scope> => {
  const HttpLive = HttpRouter.serve(buildCallbackRoutes(expectedState, deferred)).pipe(
    Layer.provide(BunHttpServer.layerServer({ port: OAUTH_PORT })),
  )
  return Layer.launch(HttpLive).pipe(
    Effect.catchCause((cause) =>
      Effect.fail(
        new OAuthError({
          reason: "server-failed",
          message: `OAuth redirect server failed: ${cause.toString()}`,
        }),
      ),
    ),
  )
}

const tokensToOAuthResult = (tokens: TokenResponse, now: number): OpenAIOAuthTokens => {
  const accountId = extractAccountId(tokens)
  return {
    type: "oauth",
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: now + (tokens.expires_in ?? 3600) * 1000,
    ...(accountId !== undefined && accountId.length > 0 ? { accountId } : {}),
  }
}

const tokensToRefreshResult = (tokens: TokenResponse, now: number): OpenAIRefreshTokens => {
  const accountId = extractAccountId(tokens)
  return {
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: now + (tokens.expires_in ?? 3600) * 1000,
    ...(accountId !== undefined && accountId.length > 0 ? { accountId } : {}),
  }
}

/**
 * Begin the OpenAI OAuth (Codex CLI) flow. The returned Effect is
 * `Scope`-requiring: the caller's scope owns the redirect HTTP server
 * and the inner `Deferred`. Closing the scope tears down the listener
 * and any in-flight `callback` await.
 *
 * Two paths to completion:
 *   - Browser hits `http://localhost:1455/auth/callback?code=…&state=…`
 *     and `callback()` (no arg) drains the deferred and exchanges.
 *   - User pastes the raw redirect URL or `code#state` into the prompt
 *     and `callback(manualInput)` exchanges directly.
 *
 * Either way, `callback` returns the structured `OpenAIOAuthTokens` the
 * extension persists. `cancel` interrupts the deferred (used by the
 * 5-minute abandoned-flow timer in `index.ts`).
 */
export const authorizeOpenAI: Effect.Effect<OpenAIAuthorizationFlow, OAuthError, Scope.Scope> =
  Effect.gen(function* () {
    const pkce = yield* generatePKCE
    const state = generateState()
    const redirectUri = `http://localhost:${OAUTH_PORT}/auth/callback`
    const authUrl = buildAuthorizeUrl(redirectUri, pkce, state)
    const deferred = yield* Deferred.make<PendingCallbackPayload, OAuthError>()

    yield* Effect.forkScoped(startRedirectServer(state, deferred))

    const callback = (manualInput?: string): Effect.Effect<OpenAIOAuthTokens, OAuthError> =>
      Effect.gen(function* () {
        let code: string
        if (manualInput !== undefined && manualInput.trim().length > 0) {
          const parsed = parseAuthorizationInput(manualInput)
          if (parsed.state !== undefined && parsed.state !== state) {
            return yield* new OAuthError({
              reason: "state-mismatch",
              message: "State mismatch",
            })
          }
          if (parsed.code === undefined || parsed.code.length === 0) {
            return yield* new OAuthError({
              reason: "missing-code",
              message: "Missing authorization code",
            })
          }
          code = parsed.code
        } else {
          const payload = yield* Deferred.await(deferred)
          code = payload.code
        }

        const tokens = yield* exchangeCodeForTokens(code, redirectUri, pkce)
        const now = yield* Clock.currentTimeMillis
        return tokensToOAuthResult(tokens, now)
      })

    const cancel: Effect.Effect<void> = Deferred.fail(
      deferred,
      new OAuthError({ reason: "cancelled", message: "OAuth flow cancelled" }),
    ).pipe(Effect.asVoid)

    return {
      authorization: {
        url: authUrl,
        method: "auto",
        instructions: "Complete authorization in your browser. Paste the code if needed.",
      },
      callback,
      cancel,
    }
  })

/**
 * Refresh an OpenAI OAuth credential against the token endpoint.
 * Returns the new access/refresh pair plus computed `expires`. Pure
 * `Effect` — no scope required because the HTTP client is provided
 * locally.
 */
export const refreshOpenAIOauth = (
  refreshToken: string,
): Effect.Effect<OpenAIRefreshTokens, OAuthError> =>
  Effect.gen(function* () {
    const tokens = yield* refreshAccessToken(refreshToken)
    const now = yield* Clock.currentTimeMillis
    return tokensToRefreshResult(tokens, now)
  })

/**
 * Allocate a detached scope and run `authorizeOpenAI` inside it,
 * returning the flow handle plus a `close` Effect that tears the scope
 * down. Used by `index.ts` to bridge between the `authorize` /
 * `callback` calls — the scope must outlive the first call so the
 * redirect server stays up until the user completes (or the timeout
 * fires).
 *
 * The caller MUST eventually run `close` (whether on success, failure,
 * or timeout) or the redirect listener will leak.
 */
export const allocateOpenAIAuthorization: Effect.Effect<
  {
    readonly flow: OpenAIAuthorizationFlow
    readonly close: Effect.Effect<void>
  },
  OAuthError
> = Effect.gen(function* () {
  const scope = yield* Scope.make()
  const flow = yield* authorizeOpenAI.pipe(
    Scope.provide(scope),
    Effect.tapError(() => Scope.close(scope, Exit.void)),
  )
  const close = Scope.close(scope, Exit.void).pipe(Effect.asVoid)
  return { flow, close }
})
