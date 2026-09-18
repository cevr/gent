import {
  Array as Arr,
  Clock,
  Context,
  Crypto,
  Deferred,
  Duration,
  Effect,
  Encoding,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Result,
  Schema,
  Scope,
  SynchronizedRef,
} from "effect"
import {
  FetchHttpClient,
  Headers,
  type HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import { BunCrypto, BunHttpServer } from "@effect/platform-bun"
import {
  AuthMethod,
  DEFAULT_RETRY_POLICY,
  defineExtension,
  ExtensionHost,
  Model,
  type ModelDriverContribution,
  ProviderAuthError,
  type ProviderAuthInfo,
  type ProviderAuthorizationResult,
  type ProviderHints,
} from "@gent/core/extensions/api"
import {
  buildOpenAiCompatConfig,
  type CredentialCache,
  type CredentialCacheCell,
  type CredentialCacheCellRef,
  EMPTY_CREDENTIAL_CELL,
  freshCredentials,
  makeCredentialCache,
  makeOpenAiCompatResolution,
  readOptionalEnv,
  recoverUnauthorized,
  withHeaders,
} from "./providers.js"
import { type CatalogSource, catalogSource, driverListModels } from "./models-dev.js"
import {
  OpenAiClient as OpenAiResponsesClient,
  OpenAiLanguageModel as OpenAiResponsesLanguageModel,
} from "@effect/ai-openai"
import { Model as AiModel } from "effect/unstable/ai"

// ── oauth ───────────────────────────────────────────────────────────────────

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
const isOpenAIOAuthModel = (modelName: string): boolean =>
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

interface OpenAIOAuthTokens {
  readonly type: "oauth"
  readonly access: string
  readonly refresh: string
  readonly expires: number
  readonly accountId?: string
}

interface OpenAIRefreshTokens {
  readonly access: string
  readonly refresh: string
  readonly expires: number
  readonly accountId?: string
}

interface OpenAIAuthorizationFlow {
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
const authorizeOpenAI: Effect.Effect<OpenAIAuthorizationFlow, OAuthError, Scope.Scope> = Effect.gen(
  function* () {
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
  },
  // @effect-diagnostics-next-line strictEffectProvide:off OAuth authorization owns its crypto layer at the extension boundary
).pipe(Effect.provide(BunCrypto.layer))

/**
 * Refresh an OpenAI OAuth credential against the token endpoint.
 * Returns the new access/refresh pair plus computed `expires`. Pure
 * `Effect` — no scope required because the HTTP client is provided
 * locally.
 */
const refreshOpenAIOauth = (refreshToken: string): Effect.Effect<OpenAIRefreshTokens, OAuthError> =>
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
const allocateOpenAIDeviceAuthorization: Effect.Effect<
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
const allocateOpenAIAuthorization: Effect.Effect<
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

// ── credential service ──────────────────────────────────────────────────────

/**
 * OpenAICredentialService — ChatGPT OAuth (Codex) credentials behind the
 * shared credential cache (`../provider-credentials.ts`).
 *
 * There is no keychain: the initial credentials come from `authInfo` and
 * the cache cell is the sole copy of the rotated refresh token until
 * persist write-back lands. The refresh path therefore always prefers
 * the held credential's refresh token over the bootstrap one — the OAuth
 * server may have revoked the bootstrap token when it issued the rotation.
 */

// ── Credential shape (matches AuthOauth) ──

export interface OpenAICredentials {
  readonly access: string
  readonly refresh: string
  readonly expires: number
  readonly accountId: Option.Option<string>
}

const OpenAICredentials: Schema.Schema<OpenAICredentials> = Schema.Struct({
  access: Schema.String,
  refresh: Schema.String,
  expires: Schema.Finite,
  accountId: Schema.OptionFromOptional(Schema.String),
})

// ── IO seam ──

/** IO the service depends on, lifted out so tests can drive it without hitting `auth.openai.com`. */
export interface OpenAICredentialIO {
  /** Refresh creds against the OpenAI token endpoint. */
  readonly refresh: (refreshToken: string) => Effect.Effect<OpenAICredentials, ProviderAuthError>
}

const realIO: OpenAICredentialIO = {
  refresh: (refreshToken: string) =>
    refreshOpenAIOauth(refreshToken).pipe(
      Effect.map((credentials) => ({
        ...credentials,
        accountId: Option.fromNullishOr(credentials.accountId),
      })),
      Effect.mapError(
        (cause) =>
          new ProviderAuthError({
            message: `Failed to refresh ChatGPT OAuth credentials: ${cause.message}`,
            cause,
          }),
      ),
    ),
}

// ── Service tag ──

export class OpenAICredentialService extends Context.Service<
  OpenAICredentialService,
  CredentialCache<OpenAICredentials>
>()("@gent/extensions/src/openai/OpenAICredentialService") {
  /**
   * Production layer. The cache cell is provided externally so its
   * lifetime is hoisted above the per-`resolveModel` layer build; a Ref
   * allocated per build would disable the cache and the rotated
   * refresh-token contract. `authInfo.persist` (when present) durably
   * writes refreshed credentials back to Auth.
   */
  static layerFromRef = (
    cellRef: CredentialCacheCellRef<OpenAICredentials>,
    authInfo: ProviderAuthInfo,
  ) => OpenAICredentialService.layerFromRefAndIO(cellRef, realIO, authInfo)

  /** Test-friendly variant — accepts the IO seam so tests can drive `refresh` deterministically. */
  static layerFromIO = (io: OpenAICredentialIO, authInfo: ProviderAuthInfo) =>
    Layer.effect(
      OpenAICredentialService,
      SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL).pipe(
        Effect.flatMap((cellRef) => build(cellRef, io, authInfo)),
      ),
    )

  static layerFromRefAndIO = (
    cellRef: CredentialCacheCellRef<OpenAICredentials>,
    io: OpenAICredentialIO,
    authInfo: ProviderAuthInfo,
  ) => Layer.effect(OpenAICredentialService, build(cellRef, io, authInfo))
}

const seedFromAuthInfo = (authInfo: ProviderAuthInfo): Option.Option<OpenAICredentials> => {
  const access = Option.getOrElse(Option.fromNullishOr(authInfo.access), () => "")
  const refresh = Option.getOrElse(Option.fromNullishOr(authInfo.refresh), () => "")
  if (access.length === 0 && refresh.length === 0) return Option.none()
  return Option.some({
    access,
    refresh,
    expires: Option.getOrElse(Option.fromNullishOr(authInfo.expires), () => 0),
    accountId: Option.fromNullishOr(authInfo.accountId),
  })
}

const build = (
  cellRef: CredentialCacheCellRef<OpenAICredentials>,
  io: OpenAICredentialIO,
  authInfo: ProviderAuthInfo,
): Effect.Effect<CredentialCache<OpenAICredentials>> =>
  makeCredentialCache({
    label: "OpenAI",
    credentials: OpenAICredentials,
    cellRef,
    authInfo: Option.some(authInfo),
    seed: seedFromAuthInfo(authInfo),
    expiresAt: (creds) => creds.expires,
    read: (cached) => Effect.succeed(cached),
    refresh: (held) => {
      // The held token is the most recently rotated one; the bootstrap
      // `authInfo.refresh` only applies before any rotation.
      const refreshToken = held.pipe(
        Option.map((creds) => creds.refresh),
        Option.orElse(() => Option.fromNullishOr(authInfo.refresh)),
      )
      if (Option.isNone(refreshToken) || refreshToken.value.length === 0) {
        return Effect.fail(
          new ProviderAuthError({
            message:
              "ChatGPT OAuth credentials are unavailable. Re-run authorization from the auth picker.",
          }),
        )
      }
      // Carry the prior accountId forward when the refresh response omits it.
      const previousAccountId = held.pipe(Option.flatMap((creds) => creds.accountId))
      return io.refresh(refreshToken.value).pipe(
        Effect.map((refreshed) => ({
          ...refreshed,
          accountId: Option.orElse(refreshed.accountId, () => previousAccountId),
        })),
      )
    },
    toPersisted: (creds) => ({
      access: creds.access,
      refresh: creds.refresh,
      expires: creds.expires,
      accountId: Option.getOrUndefined(creds.accountId),
    }),
  }).pipe(Effect.map(OpenAICredentialService.of))

// ── codex transform ─────────────────────────────────────────────────────────

/**
 * codexTransformClient — `@effect/ai-openai-compat` `transformClient`
 * callback for the ChatGPT OAuth (Codex) path.
 *
 * The SDK applies `transformClient` after its own baseline pipeline
 * (`prependUrl(${apiUrl}/v1)` + optional `bearerToken(apiKey)` +
 * `acceptJson`). With the OAuth path we omit `apiKey` entirely, so
 * the SDK never injects a placeholder Bearer header. This middleware
 * supplies the OAuth Bearer + Codex-specific headers itself, then
 * rewrites Codex-bound requests to the ChatGPT backend endpoint.
 *
 * Pipeline (in order):
 *   - auth-header preprocess (Bearer + ChatGPT-Account-Id +
 *     originator/user-agent defaults)
 *   - URL rewrite to the Codex backend, JSON body rewrite (input →
 *     top-level `instructions`, `store: false`), and `OpenAI-Beta:
 *     responses=experimental` for Codex-bound paths
 *   - 401 recovery: invalidate creds + retry once
 *

 * Why a factory `(creds) => (client) => client` instead of grabbing
 * the service from context inside `mapRequestEffect`: the SDK's
 * `transformClient` signature is `(HttpClient) => HttpClient`, which
 * requires the returned client's requirement channel to stay empty.
 * Yielding the service from context inside `mapRequestEffect` would
 * surface `OpenAICredentialService` as a requirement and break the
 * type. The factory captures the service instance in a closure;
 * per-request semantics survive because each call to `creds.getFresh`
 * still consults the live `Ref` cache. (Same precedent as the
 * Anthropic `buildKeychainTransformClient` factory — see
 * `keychain-transform.ts:22-32`.)
 */

// Preserve vendor JSON fields that this transport adapter does not interpret.
/* oxlint-disable effect/noUnknownParameters, effect/noUnsafeDictionaryType */

// ── Codex routing ──

/**
 * The ChatGPT backend endpoint Codex requests target. The SDK's
 * baseline `prependUrl("https://api.openai.com/v1")` produces e.g.
 * `https://api.openai.com/v1/chat/completions` — we rewrite the entire
 * URL to the Codex endpoint when the path matches a Codex-eligible
 * shape (see `isCodexBoundPath`).
 */
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"

/**
 * Exact path equality: only `/v1/chat/completions` and `/v1/responses`
 * qualify. Substring matching would also match e.g.
 * `/v1/chat/completions/foo` if the SDK ever added a sub-resource;
 * lock the surface to the exact paths the SDK emits today.
 *
 * The OpenAI-compat SDK only POSTs `/chat/completions` today, but
 * `/responses` is reserved for when the upstream switches to the
 * responses-API shape. Both forward to the same Codex endpoint.
 */
const isCodexBoundPath = (pathname: string): boolean =>
  pathname === "/v1/chat/completions" ||
  pathname === "/v1/responses" ||
  pathname === "/chat/completions" ||
  pathname === "/responses"

const codexUrlMatches = (url: URL): boolean => isCodexBoundPath(url.pathname)

/**
 * Required `OpenAI-Beta` token for Codex backend traffic. Pure
 * preserve-when-present is unsafe — if the SDK ever starts sending
 * some other beta header for a reason of its own, the Codex request
 * would lose the required `responses=experimental` token and the
 * backend would reject it. Merge instead.
 */
const CODEX_BETA_TOKEN = "responses=experimental"
const CODEX_DEFAULT_INSTRUCTIONS = "You are a helpful assistant."
const CODEX_USER_AGENT = "gent"

/**
 * Merge `requiredToken` into a comma-separated `OpenAI-Beta` header
 * value, preserving any other tokens already present and avoiding
 * duplicates. Order: existing tokens first, required token appended
 * last if missing. Whitespace around commas is normalized.
 */
const ensureBetaToken = (existing: Option.Option<string>, requiredToken: string): string => {
  const tokens = Option.getOrElse(existing, () => "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  if (tokens.includes(requiredToken)) return tokens.join(", ")
  return [...tokens, requiredToken].join(", ")
}

// ── Body rewrite ──

/**
 * Codex backend expects a responses-API payload shape:
 *   - Leading `system`/`developer` items move into top-level `instructions`.
 *     Later updates stay in chronological order as developer messages.
 *   - `store: false` to prevent server-side conversation persistence
 *
 * The OAuth path uses the Responses SDK, but the transformer also normalizes
 * legacy chat-completions `messages` bodies so old tests and future adapter
 * drift fail closed at this boundary instead of hitting Codex with the wrong
 * shape.
 */
const isRecord = (value: unknown): value is Record<string, unknown> => Predicate.isObject(value)

const isInstructionItem = (
  item: unknown,
): item is { role: "system" | "developer"; content?: unknown } => {
  if (!isRecord(item)) return false
  const role = item["role"]
  return role === "system" || role === "developer"
}

const textFromContent = (content: unknown): Option.Option<string> => {
  if (Predicate.isString(content)) return Option.some(content)
  if (!Array.isArray(content)) return Option.none()
  const text = content
    .flatMap((part) => {
      if (!isRecord(part)) return []
      const type = part["type"]
      const value = part["text"]
      if ((type === "input_text" || type === "text") && Predicate.isString(value)) return [value]
      return []
    })
    .join("\n")
  if (text.length > 0) return Option.some(text)
  return Option.none()
}

const splitInstructions = (
  input: unknown,
): Option.Option<{ instructions: string[]; input: unknown[] }> => {
  if (!Array.isArray(input)) return Option.none()
  const instructions: string[] = []
  const filteredInput: unknown[] = []
  for (const item of input) {
    if (filteredInput.length === 0 && isInstructionItem(item)) {
      const text = textFromContent(item.content)
      if (Option.isSome(text)) {
        instructions.push(text.value)
        continue
      }
    }
    if (isInstructionItem(item)) {
      filteredInput.push({ ...item, role: "developer" })
    } else {
      filteredInput.push(item)
    }
  }
  return Option.some({ instructions, input: filteredInput })
}

const convertChatContent = (content: unknown) => {
  if (Predicate.isString(content)) return [{ type: "input_text", text: content }]
  if (!Array.isArray(content)) return content
  return content.map((part) => {
    if (!isRecord(part)) return part
    if (part["type"] === "text" && Predicate.isString(part["text"])) {
      return { ...part, type: "input_text" }
    }
    if (part["type"] === "image_url") {
      const image = part["image_url"]
      if (Predicate.isString(image)) return { type: "input_image", image_url: image }
      if (isRecord(image) && Predicate.isString(image["url"])) {
        return { type: "input_image", image_url: image["url"] }
      }
    }
    return part
  })
}

const chatMessagesToResponsesInput = (
  messages: unknown,
): Option.Option<{ instructions: string[]; input: unknown[] }> => {
  if (!Array.isArray(messages)) return Option.none()
  const input: unknown[] = []

  for (const message of messages) {
    if (!isRecord(message)) continue
    const role = message["role"]
    if (role === "system" || role === "developer") {
      input.push({ role, content: convertChatContent(message["content"]) })
      continue
    }
    if (role === "user") {
      input.push({ role: "user", content: convertChatContent(message["content"]) })
      continue
    }
    if (role === "assistant") {
      const text = textFromContent(message["content"])
      if (Option.isSome(text)) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: text.value, annotations: [] }],
          status: "completed",
        })
        continue
      }
    }
    input.push(message)
  }

  return splitInstructions(input)
}

/**
 * Try to read the request body as a JSON object. Returns `None`
 * when the body isn't a `Uint8Array` HttpBody (the only shape the SDK
 * emits via `bodyJsonUnsafe`) or when JSON parsing fails. Both cases
 * cause the URL/header rewrite to still apply but the body to pass
 * through unchanged — Codex tolerates the chat-completions shape today.
 */
const CodexBodyJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const decodeCodexBody = Schema.decodeUnknownOption(CodexBodyJson)
const encodeCodexBody = Schema.encodeSync(CodexBodyJson)

const tryReadJsonBody = (body: HttpBody.HttpBody): Option.Option<Record<string, unknown>> => {
  if (body._tag !== "Uint8Array") return Option.none()
  return decodeCodexBody(new TextDecoder().decode(body.body))
}

const rewriteCodexBody = (
  req: HttpClientRequest.HttpClientRequest,
): HttpClientRequest.HttpClientRequest => {
  const parsed = tryReadJsonBody(req.body)
  if (Option.isNone(parsed)) return req
  const split = splitInstructions(parsed.value["input"]).pipe(
    Option.orElse(() => chatMessagesToResponsesInput(parsed.value["messages"])),
  )
  if (Option.isNone(split)) return req
  const { instructions, input } = split.value
  const next = { ...parsed.value }
  delete next["messages"]
  // The Codex backend rejects sampling limits ("Unsupported parameter:
  // max_output_tokens"); reasoning models there also take no temperature.
  delete next["max_output_tokens"]
  delete next["temperature"]
  const existingInstructions = parsed.value["instructions"]
  if (Predicate.isString(existingInstructions) && existingInstructions.length > 0) {
    instructions.unshift(existingInstructions)
  }
  next["instructions"] = CODEX_DEFAULT_INSTRUCTIONS
  if (instructions.length > 0) next["instructions"] = instructions.join("\n\n")
  next["input"] = input
  next["store"] = false
  const encoded = new TextEncoder().encode(encodeCodexBody(next))
  return HttpClientRequest.bodyUint8Array(req, encoded, "application/json")
}

// ── Header construction ──

/**
 * Build the OAuth header set for a Codex request: Bearer over the
 * access token, ChatGPT-Account-Id when known, plus polite-default
 * `originator` and `User-Agent` if the upstream didn't set them.
 *
 * The SDK's baseline does NOT inject `Authorization` because we omit
 * `apiKey` from the client config. The defensive `Headers.remove`
 * for `authorization` here is belt-and-suspenders: if a future SDK
 * version starts injecting a placeholder header without an explicit
 * `apiKey`, this middleware still supplies the right value.
 */
const buildOauthHeaders = (
  req: HttpClientRequest.HttpClientRequest,
  accessToken: string,
  accountId: Option.Option<string>,
): Headers.Headers => {
  let headers = Headers.remove(req.headers, "authorization")
  headers = Headers.set(headers, "authorization", `Bearer ${accessToken}`)
  if (Option.isSome(accountId) && accountId.value.length > 0) {
    headers = Headers.set(headers, "chatgpt-account-id", accountId.value)
  }
  if (!Headers.has(headers, "originator")) {
    headers = Headers.set(headers, "originator", "gent")
  }
  if (!Headers.has(headers, "user-agent")) {
    headers = Headers.set(headers, "user-agent", CODEX_USER_AGENT)
  }
  return headers
}

// ── transformClient factory ──

/**
 * Build the `transformClient` value the OpenAI-compat SDK accepts.
 *
 * Takes the `OpenAICredentialService` instance as a closure argument
 * (not via `yield*` inside `mapRequestEffect`) for the type reasons
 * documented above.
 *
 * Per-request semantics are preserved: each request invokes
 * `creds.getFresh` which consults the live `Ref` cache (the cell-
 * resident rotated refresh token survives invalidate so a subsequent
 * refresh attempt has a usable token).
 *
 * Pipeline (per-request, before the request hits the wire):
 *   1. `creds.getFresh` — fetch live access token + account id
 *   2. Auth headers — Bearer + ChatGPT-Account-Id +
 *      originator/user-agent defaults
 *   3. If the request URL matches a Codex-eligible path
 *      (`/v1/chat/completions` or `/v1/responses`):
 *        a. Ensure `OpenAI-Beta` carries `responses=experimental`,
 *           merged with any upstream tokens
 *        b. Rewrite body shape if it carries an `input` array
 *        c. Rewrite URL to the ChatGPT Codex endpoint
 *      Non-Codex paths pass through unchanged after auth headers.
 *
 * Response side:
 *   - 401 recovery (outermost transformResponse): on HTTP 401 invalidate
 *     the credential cache and retry once. A second 401 surfaces the
 *     response to the caller so user-facing recovery (re-run
 *     authorization from the auth picker) can kick in.
 */
export const buildCodexTransformClient =
  (
    creds: CredentialCache<OpenAICredentials>,
  ): ((client: HttpClient.HttpClient) => HttpClient.HttpClient) =>
  (client) =>
    client.pipe(
      HttpClient.mapRequestEffect((req) =>
        Effect.gen(function* () {
          const fresh = yield* freshCredentials(creds, req)
          let headers = buildOauthHeaders(req, fresh.access, fresh.accountId)
          const url = new URL(req.url, "https://api.openai.com")
          if (codexUrlMatches(url)) {
            headers = Headers.set(
              headers,
              "openai-beta",
              ensureBetaToken(Headers.get(headers, "openai-beta"), CODEX_BETA_TOKEN),
            )
            const withBody = rewriteCodexBody(withHeaders(req, headers))
            if (req.url.startsWith("/")) return withBody
            return HttpClientRequest.setUrl(withBody, new URL(CODEX_API_ENDPOINT))
          }
          return withHeaders(req, headers)
        }),
      ),
      recoverUnauthorized(creds),
    )

/* oxlint-enable effect/noUnknownParameters, effect/noUnsafeDictionaryType */

// ── extension ───────────────────────────────────────────────────────────────

type PendingCallbackEntry = {
  readonly flow: OpenAIAuthorizationFlow
  readonly close: Effect.Effect<void>
  readonly timeoutFiber: Fiber.Fiber<void>
}

/** Index-aligned with the `oauth` entries of `auth.methods` below. */
const OAUTH_ALLOCATORS: ReadonlyArray<typeof allocateOpenAIAuthorization> = [
  allocateOpenAIAuthorization,
  allocateOpenAIDeviceAuthorization,
]

type OpenAiResponsesConfig = Required<
  Parameters<typeof OpenAiResponsesLanguageModel.layer>[0]
>["config"]
type OpenAiCompatConfig = Parameters<typeof makeOpenAiCompatResolution>[0]["config"]
const OpenAiReasoningEffort = Schema.Literals([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
])

const buildOpenAiResponsesConfig = (hints: Option.Option<ProviderHints>): OpenAiResponsesConfig => {
  let config: OpenAiResponsesConfig = { store: false }
  if (Option.isSome(hints)) {
    const cacheKey = Option.fromUndefinedOr(hints.value.cacheKey)
    if (Option.isSome(cacheKey)) config = { ...config, prompt_cache_key: cacheKey.value }
    const maxTokens = Option.fromNullishOr(hints.value.maxTokens)
    if (Option.isSome(maxTokens)) config = { ...config, max_output_tokens: maxTokens.value }
    const temperature = Option.fromNullishOr(hints.value.temperature)
    if (Option.isSome(temperature)) config = { ...config, temperature: temperature.value }
    const reasoning = Schema.decodeUnknownOption(OpenAiReasoningEffort)(hints.value.reasoning)
    if (Option.isSome(reasoning) && reasoning.value !== "none") {
      config = {
        ...config,
        reasoning: { effort: reasoning.value, summary: "auto" },
      }
    }
  }
  return config
}

// ── Layer construction helpers ──

/**
 * API-key path: plain OpenAI-compatible client over `FetchHttpClient`. No
 * Codex transform — the Codex backend rewrite + OAuth headers are
 * specific to the ChatGPT OAuth path.
 */
const makeApiKeyOpenAIResolution = (
  modelName: string,
  config: OpenAiCompatConfig,
  apiKey: string,
) =>
  makeOpenAiCompatResolution({
    provider: "openai",
    modelName,
    apiKey,
    config,
    apiUrl: Option.none(),
  })

/**
 * OAuth path: builds `OpenAiClient.layer` with `transformClient` set to
 * the Codex transform middleware (auth headers, URL/body/beta rewrite,
 * 401 recovery). No `apiKey` — the SDK only injects Bearer auth when
 * `apiKey !== undefined`, so omitting it lets our middleware own the
 * Authorization header without a "scrub-the-placeholder" coupling.
 *
 * The credential cache cell is passed in from extension-closure
 * scope (allocated once by the Effectful `modelDrivers()` setup), not
 * allocated per layer build. Without this hoist, every
 * `Provider.stream`/`Provider.generate` call would rebuild the service
 * layer and reset the cache, killing credential reuse and the rotated
 * refresh-token contract.
 */
const makeOauthOpenAILayer = (
  modelName: string,
  config: OpenAiResponsesConfig,
  authInfo: ProviderAuthInfo,
  credentialCellRef: CredentialCacheCellRef<OpenAICredentials>,
) => {
  const credentialLayer = OpenAICredentialService.layerFromRef(credentialCellRef, authInfo)

  const clientLayer = Layer.unwrap(
    Effect.gen(function* () {
      const creds = yield* OpenAICredentialService
      const codexHttpClientLayer = Layer.effect(
        HttpClient.HttpClient,
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient
          return buildCodexTransformClient(creds)(client)
        }),
      ).pipe(Layer.provide(FetchHttpClient.layer))
      return OpenAiResponsesClient.layer({
        apiUrl: "https://chatgpt.com/backend-api/codex",
      }).pipe(Layer.provide(codexHttpClientLayer))
    }),
  ).pipe(Layer.provide(credentialLayer))

  return OpenAiResponsesLanguageModel.layer({ model: modelName, config }).pipe(
    Layer.provide(clientLayer),
  )
}

/**
 * Build the model-driver contribution given a pre-allocated credential
 * cache cell. Extracted from the inline `modelDrivers` factory so
 * tests can inject their own cell and assert that two `resolveModel`
 * calls share the same closure-owned cell.
 */
export const buildOpenAIModelDriver = (
  credentialCellRef: CredentialCacheCellRef<OpenAICredentials>,
  pendingCallbacks: Map<string, PendingCallbackEntry>,
  envApiKey: Option.Option<string>,
  catalog: CatalogSource,
): ModelDriverContribution => ({
  id: "openai",
  name: "OpenAI",
  retry: {
    ...DEFAULT_RETRY_POLICY,
    // An accepted request can still end with an error event inside the stream; OpenAI names its code.
    transientStreamEvent: Schema.Struct({
      code: Schema.Literals(["server_error", "rate_limit_exceeded"]),
    }),
  },
  resolveModel: (modelName, authInfo, hints) =>
    Effect.gen(function* () {
      const auth = Option.fromNullishOr(authInfo)
      // Stored OAuth — handle inline with token refresh. The ChatGPT Codex
      // backend speaks the Responses shape, so the OAuth path uses
      // @effect/ai-openai instead of the chat-completions compat adapter.
      if (Option.isSome(auth) && auth.value.type === "oauth") {
        const config = buildOpenAiResponsesConfig(Option.fromNullishOr(hints))
        if (!isOpenAIOAuthModel(modelName)) {
          return yield* new ProviderAuthError({
            message: `Model "${modelName}" not available with ChatGPT OAuth`,
          })
        }
        return AiModel.make(
          "openai",
          modelName,
          makeOauthOpenAILayer(modelName, config, auth.value, credentialCellRef),
        )
      }

      // Stored API key takes precedence over env var
      let apiKey = envApiKey
      if (Option.isSome(auth) && auth.value.type === "api") {
        apiKey = Option.fromNullishOr(auth.value.key)
      }

      if (Option.isSome(apiKey)) {
        const config = buildOpenAiCompatConfig(Option.fromNullishOr(hints), true)
        return makeApiKeyOpenAIResolution(
          modelName,
          { ...config, prompt_cache_key: hints?.cacheKey },
          apiKey.value,
        )
      }

      // Fail closed — no stored OAuth, no stored API key, no env var.
      // Previous versions fell through to `OpenAiClient.layer({})` and let
      // the unauthenticated request fail late as a generic HTTP error,
      // masking the real auth failure for non-TUI callers.
      return yield* new ProviderAuthError({
        message:
          "OpenAI credentials unavailable: no ChatGPT OAuth, stored API key, or OPENAI_API_KEY env var",
      })
    }),
  listModels: (authInfo) =>
    driverListModels(catalog, "openai")().pipe(
      Effect.map((models) => {
        // When OAuth is active, filter to allowed models + zero pricing
        const auth = Option.fromNullishOr(authInfo)
        if (Option.isNone(auth) || auth.value.type !== "oauth") return models
        return models
          .filter((model) => {
            const parts = model.id.split("/", 2)
            const modelName = Option.fromNullishOr(parts[1])
            return Option.isSome(modelName) && isOpenAIOAuthModel(modelName.value)
          })
          .map((model) => Model.make({ ...model, pricing: { input: 0, output: 0 } }))
      }),
    ),
  auth: {
    methods: [
      AuthMethod.make({ type: "oauth", label: "ChatGPT Pro/Plus (browser)" }),
      AuthMethod.make({
        type: "oauth",
        label: "ChatGPT Pro/Plus (device code)",
      }),
      AuthMethod.make({ type: "api", label: "Manually enter API key" }),
    ],
    authorize: (
      ctx,
    ): Effect.Effect<Option.Option<ProviderAuthorizationResult>, ProviderAuthError> =>
      Effect.gen(function* () {
        const allocate = Option.fromNullishOr(OAUTH_ALLOCATORS[ctx.methodIndex])
        if (Option.isNone(allocate)) return Option.none()
        const { flow, close } = yield* allocate.value.pipe(
          Effect.mapError(
            (e) =>
              new ProviderAuthError({
                message: `OpenAI OAuth authorization failed: ${e.message}`,
                cause: e,
              }),
          ),
        )
        // 5-minute TTL on abandoned auth attempts. Without this an
        // abandoned flow leaves the redirect HTTP server resident
        // until extension teardown. The fiber both clears the map
        // entry and closes the OAuth scope (tears down the listener).
        const timeoutFiber = yield* Effect.sleep(Duration.minutes(5)).pipe(
          Effect.flatMap(() =>
            Effect.gen(function* () {
              pendingCallbacks.delete(ctx.authorizationId)
              yield* close
            }),
          ),
          Effect.forkChild,
        )
        pendingCallbacks.set(ctx.authorizationId, {
          flow,
          close,
          timeoutFiber,
        })
        return Option.some(flow.authorization)
      }),
    callback: (ctx) =>
      Effect.gen(function* () {
        const entry = pendingCallbacks.get(ctx.authorizationId)
        pendingCallbacks.delete(ctx.authorizationId)
        const pendingEntry = Option.fromNullishOr(entry)
        if (Option.isNone(pendingEntry)) {
          return yield* new ProviderAuthError({
            message: "OpenAI OAuth callback state is missing or expired",
          })
        }
        yield* Fiber.interrupt(pendingEntry.value.timeoutFiber)
        const result = yield* pendingEntry.value.flow.callback(ctx.code).pipe(
          Effect.mapError(
            (e) =>
              new ProviderAuthError({
                message: `OpenAI OAuth callback failed: ${e.message}`,
                cause: e,
              }),
          ),
          Effect.ensuring(pendingEntry.value.close),
        )
        const accountId = Option.fromNullishOr(result.accountId)
        if (Option.isNone(accountId)) {
          return yield* ctx.persist({
            type: "oauth",
            access: result.access,
            refresh: result.refresh,
            expires: result.expires,
          })
        }
        yield* ctx.persist({
          type: "oauth",
          access: result.access,
          refresh: result.refresh,
          expires: result.expires,
          accountId: accountId.value,
        })
      }),
  },
})

export const OpenAIExtension = defineExtension({
  id: "@gent/provider-openai",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    // Credential cache cell hoisted to extension-closure scope so it
    // survives across `resolveModel` calls. One extension instance →
    // one cell that lives until the runtime tears the extension down.
    // Setup is Effectful, so the cache cell is allocated through
    // SynchronizedRef.make instead of an unsafe closure escape hatch.
    const credentialCellRef =
      yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL)
    // Pending OAuth callbacks keyed by authorizationId. Entries
    // self-clear on a 5-min TTL so abandoned auth attempts don't leak.
    const pendingCallbacks = new Map<string, PendingCallbackEntry>()

    const envApiKey = yield* readOptionalEnv("OPENAI_API_KEY")
    const catalog = yield* catalogSource(host.home)

    yield* host.register(
      "modelDriver",
      buildOpenAIModelDriver(credentialCellRef, pendingCallbacks, envApiKey, catalog),
    )
  }),
})
