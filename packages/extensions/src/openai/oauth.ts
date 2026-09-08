import {
  Array as Arr,
  Clock,
  Crypto,
  Deferred,
  Duration,
  Effect,
  Encoding,
  Exit,
  Layer,
  Option,
  Predicate,
  Result,
  Schema,
  Scope,
} from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import { BunCrypto, BunHttpServer } from "@effect/platform-bun"

const JwtClaimsSchema = Schema.Struct({
  chatgpt_account_id: Schema.optional(Schema.Unknown),
  "https://api.openai.com/auth": Schema.optional(Schema.Unknown),
  organizations: Schema.optional(Schema.Unknown),
})
const decodeJwtClaims = Schema.decodeUnknownOption(Schema.fromJsonString(JwtClaimsSchema))
const decodeScopedAccount = Schema.decodeUnknownOption(
  Schema.Struct({ chatgpt_account_id: Schema.String }),
)
const decodeOrganizations = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown))
const decodeOrganization = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.String }))

const TokenResponseSchema = Schema.Struct({
  id_token: Schema.optional(Schema.String),
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.optional(Schema.Finite),
})
const decodeTokenResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(TokenResponseSchema))
type TokenResponse = typeof TokenResponseSchema.Type

const DeviceAuthResponseSchema = Schema.Struct({
  device_auth_id: Schema.String,
  user_code: Schema.String,
  interval: Schema.optional(Schema.Union([Schema.String, Schema.Finite])),
})
const decodeDeviceAuthResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DeviceAuthResponseSchema),
)
type DeviceAuthResponse = typeof DeviceAuthResponseSchema.Type

const DeviceTokenResponseSchema = Schema.Struct({
  authorization_code: Schema.String,
  code_verifier: Schema.String,
})
const decodeDeviceTokenResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DeviceTokenResponseSchema),
)

const DeviceErrorSchema = Schema.Struct({
  code: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
})
const decodeDeviceError = Schema.decodeUnknownOption(Schema.fromJsonString(DeviceErrorSchema))

/**
 * Typed error for the OpenAI OAuth flow. `reason` discriminates the
 * failure mode so the surrounding `ProviderAuthError` boundary in
 * `index.ts` preserves structure in `cause`, not just a string.
 */
export class OAuthError extends Schema.TaggedError<OAuthError>()("OAuthError", {
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
    "device-code-failed",
    "device-code-denied",
    "device-code-timeout",
  ]),
  message: Schema.String,
}) {}

/**
 * ChatGPT OAuth reaches the Codex backend for GPT-5 models and GPT-6 Astra.
 * Chat aliases and pro tiers are API-only. The catalog itself comes from
 * models.dev, so new GPT-5 releases need no list update here.
 */
export const isOpenAIOAuthModel = (modelName: string): boolean =>
  (modelName.startsWith("gpt-5") || modelName === "gpt-6-astra") &&
  !modelName.endsWith("-chat-latest") &&
  !modelName.endsWith("-pro")

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const ISSUER = "https://auth.openai.com"
const OAUTH_PORT = 1455
const DEVICE_REDIRECT_URI = `${ISSUER}/deviceauth/callback`
const DEVICE_VERIFY_URL = `${ISSUER}/codex/device`
const DEVICE_POLL_DEFAULT = Duration.seconds(5)
const DEVICE_POLL_BACKOFF = Duration.seconds(5)
const DEVICE_DEADLINE = Duration.minutes(15)

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
const generatePKCE: Effect.Effect<PkceCodes, OAuthError, Crypto.Crypto> = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const bytes = yield* crypto.randomBytes(43)
  const verifier = Array.from(bytes, (byte) => chars[byte % chars.length]).join("")
  const hash = yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier))
  return { verifier, challenge: Encoding.encodeBase64Url(hash) }
}).pipe(
  Effect.mapError(
    (error) =>
      new OAuthError({
        reason: "pkce-failed",
        message: `PKCE generation failed: ${error.message}`,
      }),
  ),
)

const parseJwtClaims = (token: string): Option.Option<typeof JwtClaimsSchema.Type> => {
  const parts = token.split(".")
  if (parts.length !== 3) return Option.none()
  return Encoding.decodeBase64UrlString(parts[1] ?? "").pipe(
    Result.getSuccess,
    Option.flatMap(decodeJwtClaims),
  )
}

const accountFromClaims = (claims: typeof JwtClaimsSchema.Type): Option.Option<string> => {
  const direct = claims.chatgpt_account_id
  if (Predicate.isString(direct)) return Option.some(direct)
  const scoped = decodeScopedAccount(claims["https://api.openai.com/auth"])
  if (Option.isSome(scoped)) return Option.some(scoped.value.chatgpt_account_id)
  return decodeOrganizations(claims.organizations).pipe(
    Option.flatMap(Arr.head),
    Option.flatMap(decodeOrganization),
    Option.map((organization) => organization.id),
  )
}

const extractAccountId = (tokens: TokenResponse): Option.Option<string> => {
  const idTokenAccount = Option.fromNullishOr(tokens.id_token).pipe(
    Option.flatMap(parseJwtClaims),
    Option.flatMap(accountFromClaims),
    Option.filter((accountId) => accountId.length > 0),
  )
  if (Option.isSome(idTokenAccount)) return idTokenAccount
  return parseJwtClaims(tokens.access_token).pipe(Option.flatMap(accountFromClaims))
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

const tryParseUrl = Option.liftThrowable((value: string) => new URL(value))

interface AuthorizationInput {
  readonly code: Option.Option<string>
  readonly state: Option.Option<string>
}

const parseAuthorizationInput = (input: string): AuthorizationInput => {
  const value = input.trim()
  if (value.length === 0) return { code: Option.none(), state: Option.none() }

  const parsed = tryParseUrl(value)
  if (Option.isSome(parsed)) {
    return {
      code: Option.fromNullishOr(parsed.value.searchParams.get("code")),
      state: Option.fromNullishOr(parsed.value.searchParams.get("state")),
    }
  }

  if (value.includes("#")) {
    const [code, state] = value.split("#", 2)
    return {
      code: Option.fromNullishOr(code),
      state: Option.fromNullishOr(state),
    }
  }

  if (value.includes("code=")) {
    const params = new URLSearchParams(value)
    return {
      code: Option.fromNullishOr(params.get("code")),
      state: Option.fromNullishOr(params.get("state")),
    }
  }

  return { code: Option.some(value), state: Option.none() }
}

const exchangeCodeForTokens = (
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Effect.Effect<TokenResponse, OAuthError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const request = HttpClientRequest.post(`${ISSUER}/oauth/token`).pipe(
      HttpClientRequest.bodyUrlParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: CLIENT_ID,
        code_verifier: codeVerifier,
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
  )

const exchangeCodeWithFetch = (
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Effect.Effect<TokenResponse, OAuthError> =>
  exchangeCodeForTokens(code, redirectUri, codeVerifier).pipe(
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
      const code = url.searchParams.get("code") ?? ""
      const stateParam = url.searchParams.get("state") ?? ""
      const error = Option.fromNullishOr(url.searchParams.get("error"))
      const errorDescription = url.searchParams.get("error_description")

      if (Option.isSome(error)) {
        const errorMsg = errorDescription ?? error.value
        yield* Deferred.fail(
          deferred,
          new OAuthError({ reason: "callback-error", message: errorMsg }),
        )
        return HttpServerResponse.html(HTML_ERROR(errorMsg))
      }
      if (code.length === 0) {
        const errorMsg = "Missing authorization code"
        yield* Deferred.fail(
          deferred,
          new OAuthError({ reason: "missing-code", message: errorMsg }),
        )
        return HttpServerResponse.setStatus(HttpServerResponse.html(HTML_ERROR(errorMsg)), 400)
      }
      if (stateParam !== expectedState) {
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

const tokensToOAuthResult = (tokens: TokenResponse, now: number): OpenAIOAuthTokens => ({
  type: "oauth",
  ...tokensToRefreshResult(tokens, now),
})

const tokensToRefreshResult = (tokens: TokenResponse, now: number): OpenAIRefreshTokens => {
  const accountId = extractAccountId(tokens).pipe(Option.filter((value) => value.length > 0))
  const result: OpenAIRefreshTokens = {
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: now + (tokens.expires_in ?? 3600) * 1000,
  }
  if (Option.isSome(accountId)) return { ...result, accountId: accountId.value }
  return result
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
    const crypto = yield* Crypto.Crypto
    const stateBytes = yield* crypto.randomBytes(32).pipe(
      Effect.mapError(
        (error) =>
          new OAuthError({
            reason: "pkce-failed",
            message: `OAuth state generation failed: ${error.message}`,
          }),
      ),
    )
    const state = Encoding.encodeBase64Url(stateBytes)
    const redirectUri = `http://localhost:${OAUTH_PORT}/auth/callback`
    const authUrl = buildAuthorizeUrl(redirectUri, pkce, state)
    const deferred = yield* Deferred.make<PendingCallbackPayload, OAuthError>()

    yield* Effect.forkScoped(startRedirectServer(state, deferred))

    const callback = (manualInput?: string): Effect.Effect<OpenAIOAuthTokens, OAuthError> =>
      Effect.gen(function* () {
        let code: string
        if (manualInput && manualInput.trim().length > 0) {
          const parsed = parseAuthorizationInput(manualInput)
          if (Option.isSome(parsed.state) && parsed.state.value !== state) {
            return yield* new OAuthError({
              reason: "state-mismatch",
              message: "State mismatch",
            })
          }
          if (Option.isNone(parsed.code) || parsed.code.value.length === 0) {
            return yield* new OAuthError({
              reason: "missing-code",
              message: "Missing authorization code",
            })
          }
          code = parsed.code.value
        } else {
          const payload = yield* Deferred.await(deferred)
          code = payload.code
        }

        const tokens = yield* exchangeCodeWithFetch(code, redirectUri, pkce.verifier)
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
    } satisfies OpenAIAuthorizationFlow
    // @effect-diagnostics-next-line strictEffectProvide:off OAuth authorization owns its crypto layer at the extension boundary
  }).pipe(Effect.provide(BunCrypto.layer))

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

const deviceFailure = (message: string) => new OAuthError({ reason: "device-code-failed", message })

const encodeJsonBody = Schema.encodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
)

const jsonRequest = (url: string, body: Record<string, string>) =>
  HttpClientRequest.post(url).pipe(
    HttpClientRequest.bodyText(encodeJsonBody(body), "application/json"),
  )

/**
 * Request a device user code. A 404 means the account (or the
 * endpoint) has device login disabled; report that plainly instead of
 * a bare status code.
 */
const startDeviceAuthorization: Effect.Effect<
  DeviceAuthResponse,
  OAuthError,
  HttpClient.HttpClient
> = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient
  const response = yield* http.execute(
    jsonRequest(`${ISSUER}/api/accounts/deviceauth/usercode`, {
      client_id: CLIENT_ID,
    }),
  )
  if (response.status === 404) {
    return yield* deviceFailure("Device code login is not enabled for this account")
  }
  if (response.status >= 400) {
    return yield* deviceFailure(`Device code request failed: ${response.status}`)
  }
  const body = yield* response.text
  return yield* decodeDeviceAuthResponse(body).pipe(
    Effect.mapError((e) => deviceFailure(`Device code response invalid: ${e.message}`)),
  )
}).pipe(
  Effect.catchTag("HttpClientError", (e) =>
    Effect.fail(deviceFailure(`Device code request HTTP failed: ${e.message}`)),
  ),
)

const pollInterval = (auth: DeviceAuthResponse): Duration.Duration =>
  Option.fromNullishOr(auth.interval).pipe(
    Option.map((value) => {
      if (Predicate.isString(value)) return Number.parseFloat(value)
      return value
    }),
    Option.filter((value) => Number.isFinite(value) && value > 0),
    Option.match({
      onNone: () => DEVICE_POLL_DEFAULT,
      onSome: (seconds) => Duration.seconds(seconds),
    }),
  )

const DevicePoll = Schema.TaggedUnion({
  Pending: { slowDown: Schema.Boolean },
  Done: { code: Schema.String, verifier: Schema.String },
})
type DevicePoll = typeof DevicePoll.Type

/**
 * One poll of the device token endpoint. Pending is signalled by
 * HTTP 403/404 or by a JSON error code; `slow_down` asks for a longer
 * interval (RFC 8628 §3.5).
 */
const pollDeviceOnce = (
  auth: DeviceAuthResponse,
): Effect.Effect<DevicePoll, OAuthError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const response = yield* http.execute(
      jsonRequest(`${ISSUER}/api/accounts/deviceauth/token`, {
        device_auth_id: auth.device_auth_id,
        user_code: auth.user_code,
      }),
    )
    if (response.status === 403 || response.status === 404) {
      return DevicePoll.cases.Pending.make({ slowDown: false })
    }
    const body = yield* response.text
    if (response.status >= 400) {
      const parsed = decodeDeviceError(body)
      const code = parsed.pipe(
        Option.flatMap((value) => Option.fromNullishOr(value.code ?? value.error)),
      )
      if (Option.isSome(code)) {
        if (code.value === "deviceauth_authorization_pending") {
          return DevicePoll.cases.Pending.make({ slowDown: false })
        }
        if (code.value === "slow_down") {
          return DevicePoll.cases.Pending.make({ slowDown: true })
        }
        if (code.value === "access_denied") {
          return yield* new OAuthError({
            reason: "device-code-denied",
            message: "Device code authorization was denied",
          })
        }
        return yield* deviceFailure(`Device code poll failed: ${code.value}`)
      }
      return yield* deviceFailure(`Device code poll failed: ${response.status}`)
    }
    const tokens = yield* decodeDeviceTokenResponse(body).pipe(
      Effect.mapError((e) => deviceFailure(`Device token response invalid: ${e.message}`)),
    )
    return DevicePoll.cases.Done.make({
      code: tokens.authorization_code,
      verifier: tokens.code_verifier,
    })
  }).pipe(
    Effect.catchTag("HttpClientError", (e) =>
      Effect.fail(deviceFailure(`Device code poll HTTP failed: ${e.message}`)),
    ),
  )

/**
 * Poll until the user approves the code, then exchange the returned
 * authorization code with the verifier the server minted. Bounded by
 * `DEVICE_DEADLINE`; each `slow_down` adds `DEVICE_POLL_BACKOFF`.
 */
const completeDeviceAuthorization = (
  auth: DeviceAuthResponse,
): Effect.Effect<TokenResponse, OAuthError, HttpClient.HttpClient> => {
  const loop = (
    interval: Duration.Duration,
  ): Effect.Effect<TokenResponse, OAuthError, HttpClient.HttpClient> =>
    Effect.gen(function* () {
      yield* Effect.sleep(interval)
      const poll = yield* pollDeviceOnce(auth)
      if (poll._tag === "Done") {
        return yield* exchangeCodeForTokens(poll.code, DEVICE_REDIRECT_URI, poll.verifier)
      }
      if (poll.slowDown) return yield* loop(Duration.sum(interval, DEVICE_POLL_BACKOFF))
      return yield* loop(interval)
    })
  return loop(pollInterval(auth)).pipe(
    Effect.timeoutOrElse({
      duration: DEVICE_DEADLINE,
      orElse: () =>
        Effect.fail(
          new OAuthError({
            reason: "device-code-timeout",
            message: "Device code authorization timed out",
          }),
        ),
    }),
  )
}

/**
 * Begin the OpenAI device-code flow (the "headless" ChatGPT login used
 * by Codex CLI, OpenCode, and Pi). No local server: the user opens
 * `auth.openai.com/codex/device`, enters the short code, and
 * `callback()` polls until the server hands back an authorization
 * code plus its verifier, then exchanges them.
 *
 * The HTTP client is taken from the environment so tests can stub the
 * three endpoints; `allocateOpenAIDeviceAuthorization` binds fetch.
 */
export const authorizeOpenAIDevice: Effect.Effect<
  OpenAIAuthorizationFlow,
  OAuthError,
  HttpClient.HttpClient
> = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient
  const auth = yield* startDeviceAuthorization
  const callback = (): Effect.Effect<OpenAIOAuthTokens, OAuthError> =>
    Effect.gen(function* () {
      const tokens = yield* completeDeviceAuthorization(auth)
      const now = yield* Clock.currentTimeMillis
      return tokensToOAuthResult(tokens, now)
    }).pipe(Effect.provideService(HttpClient.HttpClient, http))
  return {
    authorization: {
      url: DEVICE_VERIFY_URL,
      method: "auto",
      instructions: `Open ${DEVICE_VERIFY_URL} and enter code: ${auth.user_code}`,
    },
    callback,
    cancel: Effect.void,
  } satisfies OpenAIAuthorizationFlow
})

/**
 * Device-code counterpart of `allocateOpenAIAuthorization`. Nothing to
 * tear down, so `close` is a no-op; the shape matches so `index.ts`
 * keeps one pending-callback table for both OAuth methods.
 */
export const allocateOpenAIDeviceAuthorization: Effect.Effect<
  {
    readonly flow: OpenAIAuthorizationFlow
    readonly close: Effect.Effect<void>
  },
  OAuthError
> = authorizeOpenAIDevice.pipe(
  Effect.map((flow) => ({ flow, close: Effect.void })),
  // @effect-diagnostics-next-line strictEffectProvide:off device endpoints at extension boundary
  Effect.provide(FetchHttpClient.layer),
)

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
