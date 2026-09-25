import {
  Array as Arr,
  Clock,
  Crypto,
  Context,
  Deferred,
  Duration,
  Effect,
  Encoding,
  Exit,
  Fiber,
  HashSet,
  Layer,
  Option,
  Predicate,
  Redacted,
  Ref,
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
  type HttpClientResponse,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import { BunHttpServer } from "@effect/platform-bun"
import {
  AuthMethod,
  DEFAULT_RETRY_POLICY,
  defineExtension,
  ExtensionHost,
  isRecord,
  Model,
  type ModelDriverContribution,
  ProviderAuthError,
  type UpdateStoredOAuth,
  type StoredOAuthCredentials,
  type ProviderAuthorizationResult,
  type ProviderHints,
} from "@gent/core/extensions/api"
import {
  type CatalogSource,
  catalogSource,
  type CredentialCache,
  type CredentialCacheCell,
  type CredentialCacheCellRef,
  type CredentialFailure,
  checkCredentials,
  CredentialRefreshUnavailable,
  driverListModels,
  effortAtOrAbove,
  EMPTY_CREDENTIAL_CELL,
  explainCredentialFailure,
  authorizedClient,
  HttpResponseField,
  isTransientTokenStatus,
  makeCredentialCache,
  type CredentialStore,
  postOAuthForm,
  apiKeyFrom,
  readOptionalEnv,
  replaceHeldCredential,
  withHeaders,
} from "./providers.js"
import {
  OpenAiClient as OpenAiResponsesClient,
  OpenAiLanguageModel as OpenAiResponsesLanguageModel,
} from "@effect/ai-openai"
import { Model as AiModel } from "effect/unstable/ai"

// Test seam: only tests read these exports. OAuthError, authorizeOpenAIDevice,
// OpenAICredentials, OpenAICredentialIO and makeOpenAICredentialCache let a test
// run the device login and the credential cache against fake I/O;
// buildCodexTransformClient and buildOpenAIModelDriver let it run the wire
// against a fake HTTP client; OAuthRedirectPort lets it run the browser login
// on a free port.

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
 * `buildOpenAIModelDriver`'s `authorize`/`callback` preserves structure
 * in `cause`, not just a string.
 */
export class OAuthError extends Schema.TaggedError<OAuthError>()("OAuthError", {
  reason: Schema.Literals([
    "token-exchange-failed",
    "token-refresh-failed",
    "token-endpoint-unavailable",
    "callback-error",
    "missing-code",
    "state-mismatch",
    "callback-timeout",
    "pkce-failed",
    "server-failed",
    "device-code-failed",
    "device-code-denied",
    "device-code-timeout",
  ]),
  message: Schema.String,
}) {}

/**
 * ChatGPT OAuth reaches the Codex backend for the GPT-5 and GPT-6 families
 * (Astra, Sol and Luna: learn.chatgpt.com/docs/models, read 2026-09-23).
 * Chat aliases and pro tiers are API-only. The catalog itself comes from
 * models.dev, so new releases in these families need no list update here.
 */
const isOpenAIOAuthModel = (modelName: string): boolean =>
  (modelName.startsWith("gpt-5") || modelName.startsWith("gpt-6-")) &&
  !modelName.endsWith("-chat-latest") &&
  !modelName.endsWith("-pro")

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const ISSUER = "https://auth.openai.com"
/**
 * The port of the browser login's redirect listener. OpenAI registers
 * `http://localhost:1455/auth/callback` for this client id, so product code
 * never provides it. A test provides a free port, so two test processes do
 * not contend for 1455.
 */
export const OAuthRedirectPort = Context.Reference<number>(
  "@gent/extensions/src/openai/OAuthRedirectPort",
  { defaultValue: () => 1455 },
)
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

/**
 * POST one grant to the token endpoint and decode the token reply. A
 * transport failure, a timeout, a 429, or a 5xx is `token-endpoint-unavailable`
 * (it can pass); any other failure is `reason`.
 */
const requestTokens = (
  reason: "token-exchange-failed" | "token-refresh-failed",
  label: string,
  params: Record<string, string>,
): Effect.Effect<TokenResponse, OAuthError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const response = yield* postOAuthForm(`${ISSUER}/oauth/token`, params).pipe(
      Effect.mapError(
        (e) =>
          new OAuthError({
            reason: "token-endpoint-unavailable",
            message: `${label} HTTP failed: ${e.message}`,
          }),
      ),
    )
    if (isTransientTokenStatus(response.status)) {
      return yield* new OAuthError({
        reason: "token-endpoint-unavailable",
        message: `${label} failed: ${response.status}`,
      })
    }
    if (response.status >= 400) {
      return yield* new OAuthError({ reason, message: `${label} failed: ${response.status}` })
    }
    return yield* decodeTokenResponse(response.body).pipe(
      Effect.mapError(
        (e) => new OAuthError({ reason, message: `${label} response invalid: ${e.message}` }),
      ),
    )
  })

const exchangeCodeForTokens = (
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Effect.Effect<TokenResponse, OAuthError, HttpClient.HttpClient> =>
  requestTokens("token-exchange-failed", "Token exchange", {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    code_verifier: codeVerifier,
  })

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
  requestTokens("token-refresh-failed", "Token refresh", {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  }).pipe(
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

const HTML_ESCAPES = new Map([
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ['"', "&quot;"],
  ["'", "&#39;"],
])

/** The error text comes from the query string, so it is escaped before it goes into HTML. */
const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => HTML_ESCAPES.get(char) ?? char)

const HTML_ERROR = (error: string) => `<!doctype html>
<html>
  <head>
    <title>Gent - Codex Authorization Failed</title>
  </head>
  <body>
    <h1>Authorization Failed</h1>
    <p>${escapeHtml(error)}</p>
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
      const url = new URL(request.url, "http://localhost")
      const code = url.searchParams.get("code") ?? ""
      const stateParam = url.searchParams.get("state") ?? ""
      const error = Option.fromNullishOr(url.searchParams.get("error"))
      const errorDescription = url.searchParams.get("error_description")

      // The state is checked first: a request that does not carry this
      // flow's state is not the provider's redirect (a stale tab, another
      // login), so its error text is not trusted and it leaves the wait
      // running.
      if (stateParam !== expectedState) {
        return HttpServerResponse.setStatus(
          HttpServerResponse.html(HTML_ERROR("Invalid state")),
          400,
        )
      }
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

      yield* Deferred.succeed(deferred, { code, state: stateParam })
      return HttpServerResponse.html(HTML_SUCCESS)
    }),
  )

const startRedirectServer = (
  port: number,
  expectedState: string,
  deferred: Deferred.Deferred<PendingCallbackPayload, OAuthError>,
): Effect.Effect<void, OAuthError, Scope.Scope> => {
  const HttpLive = HttpRouter.serve(buildCallbackRoutes(expectedState, deferred)).pipe(
    Layer.provide(BunHttpServer.layerServer({ port })),
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
 * extension persists. The 5-minute abandoned-flow timer in
 * `buildOpenAIModelDriver`'s `authorize` closes the flow's scope, which stops
 * the redirect server.
 */
const authorizeOpenAI: Effect.Effect<
  OpenAIAuthorizationFlow,
  OAuthError,
  Scope.Scope | Crypto.Crypto
> = Effect.gen(function* () {
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
  const port = yield* OAuthRedirectPort
  const redirectUri = `http://localhost:${port}/auth/callback`
  const authUrl = buildAuthorizeUrl(redirectUri, pkce, state)
  const deferred = yield* Deferred.make<PendingCallbackPayload, OAuthError>()

  // Nothing joins the server fiber, so a failed start (the port in use,
  // for example) fails the deferred; otherwise `callback()` waits forever.
  yield* startRedirectServer(port, state, deferred).pipe(
    Effect.tapError((error) => Deferred.fail(deferred, error)),
    Effect.forkScoped,
  )
  // Closing the flow (a pasted code finished it, or the abandoned-login
  // timer fired) ends a browser wait still in flight.
  yield* Effect.addFinalizer(() =>
    Deferred.fail(
      deferred,
      new OAuthError({ reason: "callback-timeout", message: "The browser login closed" }),
    ),
  )

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

  return {
    authorization: {
      url: authUrl,
      method: "auto",
      instructions: "Complete authorization in your browser. Paste the code if needed.",
    },
    callback,
  } satisfies OpenAIAuthorizationFlow
})

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
      // The code stands on its own line: a wrap must never split it.
      instructions: `Open the URL and enter this code:\n${auth.user_code}`,
    },
    callback,
  } satisfies OpenAIAuthorizationFlow
})

/**
 * Device-code counterpart of `allocateOpenAIAuthorization`. Nothing to
 * tear down, so `close` is a no-op; the shape matches so
 * `buildOpenAIModelDriver` keeps one pending-callback table for both
 * OAuth methods.
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
 * down. Used by `buildOpenAIModelDriver` to bridge between the
 * `authorize` / `callback` calls — the scope must outlive the first call so the
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
  OAuthError,
  Crypto.Crypto
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
 * ChatGPT OAuth (Codex) credentials behind the shared credential cache (`makeCredentialCache` in `providers.ts`).
 *
 * There is no keychain: the gent auth store owns the credential, and every
 * profile's cell reads and refreshes through `authInfo.update`. The cell is
 * the sole copy of a rotated refresh token only while its write is pending.
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
  readonly refresh: (refreshToken: string) => Effect.Effect<OpenAICredentials, CredentialFailure>
}

const realIO: OpenAICredentialIO = {
  refresh: (refreshToken: string) =>
    refreshOpenAIOauth(refreshToken).pipe(
      Effect.map((credentials) => ({
        ...credentials,
        accountId: Option.fromNullishOr(credentials.accountId),
      })),
      Effect.mapError((cause): CredentialFailure => {
        if (cause.reason === "token-endpoint-unavailable") {
          return new CredentialRefreshUnavailable({
            message: `ChatGPT token endpoint unavailable: ${cause.message}`,
            cause,
          })
        }
        return new ProviderAuthError({
          message: `ChatGPT sign-in expired: ${cause.message}. Sign in again with /auth.`,
          cause,
        })
      }),
    ),
}

const fromStored = (stored: StoredOAuthCredentials): OpenAICredentials => ({
  access: stored.access,
  refresh: stored.refresh,
  expires: stored.expires,
  accountId: Option.fromNullishOr(stored.accountId),
})

const toStored = (creds: OpenAICredentials): StoredOAuthCredentials => {
  const fields = { access: creds.access, refresh: creds.refresh, expires: creds.expires }
  if (Option.isNone(creds.accountId)) return fields
  return { ...fields, accountId: creds.accountId.value }
}

/**
 * The gent auth store behind `authInfo.update`. Every profile's cell reads
 * and refreshes through it, so a sign-in or a refresh in one profile is the
 * credential the others adopt.
 */
const openAIStore = (update: UpdateStoredOAuth): CredentialStore<OpenAICredentials> => ({
  update: <A, E>(
    f: (
      stored: Option.Option<OpenAICredentials>,
    ) => Effect.Effect<readonly [A, Option.Option<OpenAICredentials>], E>,
  ) =>
    update((stored) =>
      Effect.map(
        f(Option.map(stored, fromStored)),
        (pair): readonly [A, Option.Option<StoredOAuthCredentials>] => [
          pair[0],
          Option.map(pair[1], toStored),
        ],
      ),
    ),
  same: (a, b) => a.refresh === b.refresh,
})

/**
 * The OpenAI credential cache over a cell that outlives one `resolveModel`
 * call. A cell allocated per call would disable the cache and lose the
 * rotated refresh token. `update` is the stored sign-in's store access.
 */
export const makeOpenAICredentialCache = (
  cellRef: CredentialCacheCellRef<OpenAICredentials>,
  io: OpenAICredentialIO,
  update: UpdateStoredOAuth,
): Effect.Effect<CredentialCache<OpenAICredentials>> =>
  makeCredentialCache({
    label: "OpenAI",
    credentials: OpenAICredentials,
    cellRef,
    expiresAt: (creds) => creds.expires,
    // The gent auth store is the source of truth; see `store`.
    read: Option.none(),
    // `held` is the stored credential, or the rotation the cell still holds.
    refresh: (held) => {
      const refreshToken = held.pipe(
        Option.map((creds) => creds.refresh),
        Option.filter((token) => token.length > 0),
      )
      if (Option.isNone(refreshToken)) {
        return Effect.fail(
          new ProviderAuthError({
            message: "ChatGPT OAuth credentials are unavailable. Sign in again with /auth.",
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
    store: Option.some(openAIStore(update)),
  })

// ── codex transform ─────────────────────────────────────────────────────────

/**
 * codexTransformClient — the `HttpClient` middleware for the ChatGPT
 * OAuth (Codex) path.
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

 * Why a factory `(creds) => (client) => client`: the SDK's
 * `transformClient` signature is `(HttpClient) => HttpClient`, which
 * requires the returned client's requirement channel to stay empty, so
 * the credential cache is a closure argument. Per-request semantics
 * survive because each call to `creds.getFresh` still consults the live
 * `Ref` cache. The Anthropic `buildKeychainTransformClient` factory has
 * the same shape.
 */

// ── Codex routing ──

/**
 * The ChatGPT backend endpoint Codex requests target. A request whose
 * path is a Responses path (see `isCodexBoundPath`) is sent here whole.
 */
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"

/**
 * Exact path equality: only `/v1/responses` and `/responses` qualify, so a
 * sub-resource such as `/v1/responses/foo` is left alone.
 */
const isCodexBoundPath = (pathname: string): boolean =>
  pathname === "/v1/responses" || pathname === "/responses"

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
 */
const isInstructionItem = (
  // oxlint-disable-next-line effect/noUnknownParameters -- preserve vendor JSON fields that this transport adapter does not interpret
  item: unknown,
): item is { role: "system" | "developer"; content?: unknown } => {
  if (!isRecord(item)) return false
  const role = item["role"]
  return role === "system" || role === "developer"
}

// oxlint-disable-next-line effect/noUnknownParameters -- preserve vendor JSON fields that this transport adapter does not interpret
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
  // oxlint-disable-next-line effect/noUnknownParameters -- preserve vendor JSON fields that this transport adapter does not interpret
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

/**
 * Try to read the request body as a JSON object. Returns `None`
 * when the body isn't a `Uint8Array` HttpBody (the only shape the SDK
 * emits via `bodyJsonUnsafe`) or when JSON parsing fails. Both cases
 * cause the URL/header rewrite to still apply but the body to pass
 * through unchanged.
 */
const CodexBodyJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const decodeCodexBody = Schema.decodeUnknownOption(CodexBodyJson)
const encodeCodexBody = Schema.encodeSync(CodexBodyJson)

// oxlint-disable-next-line effect/noUnsafeDictionaryType -- preserve vendor JSON fields that this transport adapter does not interpret
const tryReadJsonBody = (body: HttpBody.HttpBody): Option.Option<Record<string, unknown>> => {
  if (body._tag !== "Uint8Array") return Option.none()
  return decodeCodexBody(new TextDecoder().decode(body.body))
}

const rewriteCodexBody = (
  req: HttpClientRequest.HttpClientRequest,
): HttpClientRequest.HttpClientRequest => {
  const parsed = tryReadJsonBody(req.body)
  if (Option.isNone(parsed)) return req
  const split = splitInstructions(parsed.value["input"])
  if (Option.isNone(split)) return req
  const { instructions, input } = split.value
  const next = { ...parsed.value }
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
 * The ChatGPT backend routes prompt-cache affinity by the Responses
 * `session-id` header; `prompt_cache_key` alone does not keep a session on
 * a warm cache. Codex sends its cache key there for a root session
 * (codex-rs `core/src/client.rs`, `responses_session_id`), so the header
 * carries the request's `prompt_cache_key`: the session id, stable for every
 * request of the session. A request without a key gets no header.
 */
const codexSessionId = (req: HttpClientRequest.HttpClientRequest): Option.Option<string> =>
  tryReadJsonBody(req.body).pipe(
    Option.flatMap((body) => Option.fromUndefinedOr(body["prompt_cache_key"])),
    Option.filter(Predicate.isString),
    Option.filter((key) => key.length > 0),
  )

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
 * Build the Codex `HttpClient` middleware the OAuth path's client runs over.
 *
 * Takes the credential cache as a closure argument for the type reasons
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
 *      (`/v1/responses` or `/responses`):
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
export const buildCodexTransformClient = (
  creds: CredentialCache<OpenAICredentials>,
): ((client: HttpClient.HttpClient) => HttpClient.HttpClient) =>
  authorizedClient(creds, (req, fresh) => {
    let headers = buildOauthHeaders(req, fresh.access, fresh.accountId)
    const url = new URL(req.url, "https://api.openai.com")
    if (codexUrlMatches(url)) {
      headers = Headers.set(
        headers,
        "openai-beta",
        ensureBetaToken(Headers.get(headers, "openai-beta"), CODEX_BETA_TOKEN),
      )
      const sessionId = codexSessionId(req)
      if (Option.isSome(sessionId)) headers = Headers.set(headers, "session-id", sessionId.value)
      const withBody = rewriteCodexBody(withHeaders(req, headers))
      if (req.url.startsWith("/")) return withBody
      return HttpClientRequest.setUrl(withBody, new URL(CODEX_API_ENDPOINT))
    }
    return withHeaders(req, headers)
  })

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
const OpenAiReasoningEffort = Schema.Literals([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
])

type OpenAiReasoningEffort = typeof OpenAiReasoningEffort.Type

/** Every effort level, lowest first. */
const OPENAI_EFFORT_ORDER = OpenAiReasoningEffort.literals

/**
 * The `reasoning.effort` values each model family accepts, lowest first;
 * first match wins. From each model page's list at
 * developers.openai.com/api/docs/models. A request that names any other
 * value fails with HTTP 400. A model none of these match gets the hint as
 * it is.
 */
const OPENAI_ACCEPTED_EFFORTS: ReadonlyArray<{
  readonly pattern: RegExp
  readonly accepts: ReadonlyArray<OpenAiReasoningEffort>
}> = [
  { pattern: /^gpt-5-pro(-|$)/, accepts: ["high"] },
  // GPT-5.2, 5.4 and 5.5 Pro. Anchored, so o1-pro and o3-pro fall to the o-series row.
  { pattern: /^gpt-5\.\d+-pro(-|$)/, accepts: ["medium", "high", "xhigh"] },
  { pattern: /^gpt-6-astra(-|$)/, accepts: ["low", "medium", "high", "xhigh", "max"] },
  { pattern: /^gpt-6-(sol|luna)(-|$)/, accepts: ["none", "low", "medium", "high", "xhigh", "max"] },
  { pattern: /^gpt-5\.6(-|$)/, accepts: ["none", "low", "medium", "high", "xhigh", "max"] },
  { pattern: /codex-max|^gpt-5\.[2-9]-codex/, accepts: ["low", "medium", "high", "xhigh"] },
  { pattern: /codex|^o\d/, accepts: ["low", "medium", "high"] },
  // The first GPT-5 family.
  {
    pattern: /^gpt-5(-mini|-nano)?(-\d{4}-\d{2}-\d{2})?$/,
    accepts: ["minimal", "low", "medium", "high"],
  },
  { pattern: /^gpt-5\.1(-|$)/, accepts: ["none", "low", "medium", "high"] },
  { pattern: /^gpt-5\.[2-5](-|$)/, accepts: ["none", "low", "medium", "high", "xhigh"] },
]

/**
 * The effort a request sends for a gent reasoning hint: the lowest value the
 * model accepts at or above the hint, else its highest. OpenAI runs a
 * reasoning model at its default effort when the request names none, so a
 * hint of "none" still names the model's lowest effort. A model the catalog
 * says does not reason gets no effort.
 */
const openAiReasoningEffort = (
  modelName: string,
  hints: ProviderHints,
): Option.Option<OpenAiReasoningEffort> => {
  if (hints.supportsReasoning === false) return Option.none()
  return Schema.decodeUnknownOption(OpenAiReasoningEffort)(hints.reasoning).pipe(
    Option.flatMap((effort) => {
      const family = OPENAI_ACCEPTED_EFFORTS.find((entry) => entry.pattern.test(modelName))
      if (Predicate.isUndefined(family)) return Option.some(effort)
      return effortAtOrAbove(OPENAI_EFFORT_ORDER, family.accepts, effort)
    }),
  )
}

/** Whether the model reasons: the catalog's flag, else a known reasoning family. */
const openAiModelReasons = (modelName: string, hints: ProviderHints): boolean =>
  hints.supportsReasoning ?? OPENAI_ACCEPTED_EFFORTS.some((entry) => entry.pattern.test(modelName))

/** The one request config for both auth paths; both speak the Responses API. */
const buildOpenAiResponsesConfig = (
  modelName: string,
  hints: Option.Option<ProviderHints>,
): OpenAiResponsesConfig => {
  let config: OpenAiResponsesConfig = { store: false }
  if (Option.isSome(hints)) {
    const cacheKey = Option.fromUndefinedOr(hints.value.cacheKey)
    if (Option.isSome(cacheKey)) config = { ...config, prompt_cache_key: cacheKey.value }
    // `max_output_tokens` counts reasoning tokens too, so on a reasoning
    // model a small cap (the 768-token compaction summary) is shared with
    // the thinking the effort floor still asks for.
    const maxTokens = Option.fromNullishOr(hints.value.maxTokens)
    if (Option.isSome(maxTokens)) config = { ...config, max_output_tokens: maxTokens.value }
    // OpenAI's reasoning models reject `temperature`. GPT-5.1 and 5.2 take it
    // at effort `none`; it is dropped there too, as one rule per model.
    const temperature = Option.fromNullishOr(hints.value.temperature)
    if (Option.isSome(temperature) && !openAiModelReasons(modelName, hints.value)) {
      config = { ...config, temperature: temperature.value }
    }
    const reasoning = openAiReasoningEffort(modelName, hints.value)
    if (Option.isSome(reasoning)) {
      config = {
        ...config,
        reasoning: { effort: reasoning.value, summary: "auto" },
      }
    }
  }
  return config
}

// ── Reasoning summary refusal ──

/**
 * OpenAI gives reasoning summaries only to a verified organization: "you may
 * need to complete organization verification" (developers.openai.com/api/docs/
 * guides/reasoning, read 2026-09-23). An unverified one gets HTTP 400,
 * `invalid_request_error` with `param: "reasoning.summary"` and
 * `code: "unsupported_value"`. The summary is optional, so the API-key client
 * retries that request once without it and leaves it out from then on for
 * that key. Verification belongs to the organization behind a key, so the
 * refusal is recorded against the key. The record is the key itself: the key
 * already lives in the driver's memory, and the record is never persisted or
 * logged.
 */
const SummaryRefusal = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Struct({
      param: Schema.Literal("reasoning.summary"),
      code: Schema.Literal("unsupported_value"),
    }),
  }),
)
const decodeSummaryRefusal = Schema.decodeUnknownOption(SummaryRefusal)

/** Drives the one retry after a summary refusal; carries the refusal for when no retry is left. */
class SummaryRefusedError extends Schema.TaggedError<SummaryRefusedError>(
  "@gent/extensions/src/openai/SummaryRefusedError",
)("SummaryRefusedError", {
  response: HttpResponseField,
}) {}

/** The request with `reasoning.summary` removed; any other body as it is. */
const withoutReasoningSummary = (
  req: HttpClientRequest.HttpClientRequest,
): HttpClientRequest.HttpClientRequest => {
  const parsed = tryReadJsonBody(req.body)
  if (Option.isNone(parsed)) return req
  const reasoning = parsed.value["reasoning"]
  if (!isRecord(reasoning) || !("summary" in reasoning)) return req
  const { summary: _summary, ...kept } = reasoning
  const encoded = new TextEncoder().encode(encodeCodexBody({ ...parsed.value, reasoning: kept }))
  return HttpClientRequest.bodyUint8Array(req, encoded, "application/json")
}

/** The driver-owned record of the API keys whose summary was refused. */
type RefusedKeys = Ref.Ref<HashSet.HashSet<string>>

/** Fails a summary refusal after recording it for the key; any other response passes. */
const refusalCheck = (
  refused: RefusedKeys,
  apiKey: string,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<void, SummaryRefusedError> => {
  if (response.status !== 400) return Effect.void
  return response.text.pipe(
    Effect.orElseSucceed(() => ""),
    Effect.map(decodeSummaryRefusal),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: () =>
          Ref.update(refused, HashSet.add(apiKey)).pipe(
            Effect.andThen(Effect.fail(new SummaryRefusedError({ response }))),
          ),
      }),
    ),
  )
}

/**
 * The API-key client for `apiKey`: leaves the summary out once
 * `refused` holds the key, and adds it on a summary refusal and retries once.
 * `refused` lives as long as the driver, so a later turn on the same key does
 * not pay the refused request again, and another key is not affected.
 */
const summaryRefusalClient =
  (refused: RefusedKeys, apiKey: string) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    client.pipe(
      HttpClient.mapRequestEffect((req) =>
        Effect.map(Ref.get(refused), (keys) => {
          if (HashSet.has(keys, apiKey)) return withoutReasoningSummary(req)
          return req
        }),
      ),
      HttpClient.transformResponse((effect) =>
        effect.pipe(
          Effect.tap((response) => refusalCheck(refused, apiKey, response)),
          Effect.retry({ while: (e) => e._tag === "SummaryRefusedError", times: 1 }),
          Effect.catchTag("SummaryRefusedError", (e) => Effect.succeed(e.response)),
        ),
      ),
    )

// ── Undecryptable reasoning ──

/**
 * A stored reasoning item goes back with its `encrypted_content` (see
 * `model-context.ts`, reasoning replay). That content is bound to the model and
 * to the organization that produced it: openai/codex#17541 (a model switch
 * fails with "encrypted content could not be decrypted") and LiteLLM's
 * "Encrypted Content Failures" incident report ("Encrypted content
 * organization_id did not match the target organization"). The loop's
 * model-change rule covers the model. The organization changes when the user
 * signs in to another account or moves between the ChatGPT sign-in and an API
 * key, and the loop cannot see that. Then the API answers HTTP 400 with
 * `code: "invalid_encrypted_content"`. The request is sent once more without
 * the reasoning items it carried, and their ids are recorded so later steps
 * leave them out from the start. The model reads the rest of the history as
 * before; only that reasoning is lost. The record lives as long as the driver.
 */
const EncryptedContentRejection = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Struct({ code: Schema.Literal("invalid_encrypted_content") }),
  }),
)
const decodeEncryptedContentRejection = Schema.decodeUnknownOption(EncryptedContentRejection)

/** The driver-owned ids of the reasoning items the API could not decrypt. */
type RejectedReasoning = Ref.Ref<HashSet.HashSet<string>>

/** Drives the one retry after a rejection; carries the response for when no retry is left. */
class ReasoningRejectedError extends Schema.TaggedError<ReasoningRejectedError>(
  "@gent/extensions/src/openai/ReasoningRejectedError",
)("ReasoningRejectedError", {
  response: HttpResponseField,
}) {}

/** A replayed reasoning input item that carries encrypted content. */
const EncryptedReasoningItem = Schema.Struct({
  type: Schema.Literal("reasoning"),
  id: Schema.String,
  encrypted_content: Schema.String,
})
const isEncryptedReasoningItem = Schema.is(EncryptedReasoningItem)

/** The request body's `input` array; empty when there is none. */
const requestInput = (req: HttpClientRequest.HttpClientRequest): ReadonlyArray<unknown> => {
  const input = Option.map(tryReadJsonBody(req.body), (body) => body["input"])
  if (Option.isNone(input) || !Array.isArray(input.value)) return []
  return input.value
}

/** The ids of the request's input reasoning items that carry encrypted content. */
const encryptedReasoningIds = (req: HttpClientRequest.HttpClientRequest): ReadonlyArray<string> =>
  requestInput(req)
    .filter(isEncryptedReasoningItem)
    .map((item) => item.id)

/** The request without the reasoning items in `rejected`; any other body as it is. */
const withoutRejectedReasoning = (
  req: HttpClientRequest.HttpClientRequest,
  rejected: HashSet.HashSet<string>,
): HttpClientRequest.HttpClientRequest => {
  if (HashSet.size(rejected) === 0) return req
  const parsed = tryReadJsonBody(req.body)
  if (Option.isNone(parsed)) return req
  const input = requestInput(req)
  const kept = input.filter(
    (item) => !(isEncryptedReasoningItem(item) && HashSet.has(rejected, item.id)),
  )
  if (kept.length === input.length) return req
  const encoded = new TextEncoder().encode(encodeCodexBody({ ...parsed.value, input: kept }))
  return HttpClientRequest.bodyUint8Array(req, encoded, "application/json")
}

/**
 * Fails a rejection of the request's encrypted reasoning after recording its
 * items. A request with no encrypted reasoning has nothing to leave out, so its
 * 400 passes. The response keeps its body: a read body reads again.
 */
const rejectionCheck = (
  rejected: RejectedReasoning,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<void, ReasoningRejectedError> => {
  if (response.status !== 400) return Effect.void
  const ids = encryptedReasoningIds(response.request)
  if (ids.length === 0) return Effect.void
  return response.text.pipe(
    Effect.orElseSucceed(() => ""),
    Effect.map(decodeEncryptedContentRejection),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: () =>
          Ref.update(rejected, (current) =>
            ids.reduce((set, id) => HashSet.add(set, id), current),
          ).pipe(Effect.andThen(Effect.fail(new ReasoningRejectedError({ response })))),
      }),
    ),
  )
}

/**
 * The client both auth paths run over, next to the transport: leaves rejected
 * reasoning out, and on a rejection records it and retries once.
 */
const undecryptableReasoningClient =
  (rejected: RejectedReasoning) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    client.pipe(
      HttpClient.mapRequestEffect((req) =>
        Effect.map(Ref.get(rejected), (ids) => withoutRejectedReasoning(req, ids)),
      ),
      HttpClient.transformResponse((effect) =>
        effect.pipe(
          Effect.tap((response) => rejectionCheck(rejected, response)),
          Effect.retry({ while: (e) => e._tag === "ReasoningRejectedError", times: 1 }),
          Effect.catchTag("ReasoningRejectedError", (e) => Effect.succeed(e.response)),
        ),
      ),
    )

// ── Layer construction helpers ──

/**
 * API-key path: the Responses client with the key as Bearer auth over
 * `FetchHttpClient`, with the summary-refusal retry. No Codex transform — the
 * Codex backend rewrite + OAuth headers are specific to the ChatGPT OAuth path.
 */
const makeApiKeyOpenAIResolution = (
  modelName: string,
  config: OpenAiResponsesConfig,
  apiKey: string,
  refusedKeys: RefusedKeys,
  rejectedReasoning: RejectedReasoning,
) => {
  const httpClientLayer = Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (client) =>
      summaryRefusalClient(
        refusedKeys,
        apiKey,
      )(undecryptableReasoningClient(rejectedReasoning)(client)),
    ),
  ).pipe(Layer.provide(FetchHttpClient.layer))
  const clientLayer = OpenAiResponsesClient.layer({ apiKey: Redacted.make(apiKey) }).pipe(
    Layer.provide(httpClientLayer),
  )
  return AiModel.make(
    "openai",
    modelName,
    OpenAiResponsesLanguageModel.layer({ model: modelName, config }).pipe(
      Layer.provide(clientLayer),
    ),
  )
}

/**
 * OAuth path: builds `OpenAiClient.layer` with `transformClient` set to
 * the Codex transform middleware (auth headers, URL/body/beta rewrite,
 * 401 recovery). No `apiKey` — the SDK only injects Bearer auth when
 * `apiKey !== undefined`, so omitting it lets our middleware own the
 * Authorization header without a "scrub-the-placeholder" coupling.
 *
 * `resolveModel` builds the credential cache over the cell that the
 * Effectful `modelDrivers()` setup allocates once, and checks it before the
 * layer exists, so an expired sign-in fails with its own message. A cell
 * allocated per layer build would reset the cache and break the rotated
 * refresh-token contract.
 */
const makeOauthOpenAILayer = (
  modelName: string,
  config: OpenAiResponsesConfig,
  creds: CredentialCache<OpenAICredentials>,
  rejectedReasoning: RejectedReasoning,
) => {
  const codexHttpClientLayer = Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return buildCodexTransformClient(creds)(
        undecryptableReasoningClient(rejectedReasoning)(client),
      )
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer))
  const clientLayer = OpenAiResponsesClient.layer({
    apiUrl: "https://chatgpt.com/backend-api/codex",
  }).pipe(Layer.provide(codexHttpClientLayer))
  return OpenAiResponsesLanguageModel.layer({ model: modelName, config }).pipe(
    Layer.provide(explainedClientLayer(creds).pipe(Layer.provide(clientLayer))),
  )
}

/** Wraps the Responses client so a credential failure keeps its own message. */
const explainedClientLayer = (
  creds: CredentialCache<OpenAICredentials>,
): Layer.Layer<OpenAiResponsesClient.OpenAiClient, never, OpenAiResponsesClient.OpenAiClient> =>
  Layer.effect(
    OpenAiResponsesClient.OpenAiClient,
    Effect.gen(function* () {
      const inner = yield* OpenAiResponsesClient.OpenAiClient
      const explain = explainCredentialFailure(creds)
      return {
        client: inner.client,
        createResponse: (options) => explain(inner.createResponse(options)),
        createResponseStream: (options) => explain(inner.createResponseStream(options)),
        createEmbedding: (options) => explain(inner.createEmbedding(options)),
      }
    }),
  )

/**
 * Build the model-driver contribution given a pre-allocated credential
 * cache cell. Extracted from the inline `modelDrivers` factory so
 * tests can inject their own cell and assert that two `resolveModel`
 * calls share the same closure-owned cell. `crypto` is the host's Crypto,
 * captured at setup; the browser OAuth flow draws its PKCE and state from it.
 */
export const buildOpenAIModelDriver = (
  credentialCellRef: CredentialCacheCellRef<OpenAICredentials>,
  pendingCallbacks: Map<string, PendingCallbackEntry>,
  envApiKey: Option.Option<string>,
  catalog: CatalogSource,
  crypto: Crypto.Crypto,
): ModelDriverContribution => {
  // The keys whose organization OpenAI refused a reasoning summary.
  const refusedKeys: RefusedKeys = Ref.makeUnsafe(HashSet.empty())
  // The reasoning items the API could not decrypt for this driver's account.
  const rejectedReasoning: RejectedReasoning = Ref.makeUnsafe(HashSet.empty())
  /**
   * Hold a pending login under a 5-minute abandoned-login timer. The timer
   * clears the entry and closes the login's scope (the redirect listener).
   * It is detached: `authorize` returns at once, and a child fiber would
   * stop with it.
   */
  const holdLogin = (
    authorizationId: string,
    flow: OpenAIAuthorizationFlow,
    close: Effect.Effect<void>,
  ) =>
    Effect.gen(function* () {
      const timeoutFiber = yield* Effect.sleep(Duration.minutes(5)).pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            pendingCallbacks.delete(authorizationId)
            yield* close
          }),
        ),
        Effect.forkDetach,
      )
      pendingCallbacks.set(authorizationId, { flow, close, timeoutFiber })
    })
  /** Finish a login: stop its timer, drop it and close its scope. */
  const finishLogin = (authorizationId: string, close: Effect.Effect<void>) =>
    Effect.gen(function* () {
      const held = Option.fromNullishOr(pendingCallbacks.get(authorizationId))
      pendingCallbacks.delete(authorizationId)
      if (Option.isSome(held)) yield* Fiber.interrupt(held.value.timeoutFiber)
      yield* close
    })
  return {
    id: "openai",
    name: "OpenAI",
    envCredential: "OPENAI_API_KEY",
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
        // Stored OAuth — handle inline with token refresh. Both paths speak the
        // Responses API through @effect/ai-openai; OAuth adds the Codex rewrite.
        if (Option.isSome(auth) && auth.value._tag === "Oauth") {
          const config = buildOpenAiResponsesConfig(modelName, Option.fromNullishOr(hints))
          if (!isOpenAIOAuthModel(modelName)) {
            return yield* new ProviderAuthError({
              message: `Model "${modelName}" not available with ChatGPT OAuth`,
            })
          }
          const creds = yield* makeOpenAICredentialCache(
            credentialCellRef,
            realIO,
            auth.value.update,
          )
          yield* checkCredentials(creds)
          return AiModel.make(
            "openai",
            modelName,
            makeOauthOpenAILayer(modelName, config, creds, rejectedReasoning),
          )
        }

        // Stored API key takes precedence over env var
        const apiKey = apiKeyFrom(auth, envApiKey)

        if (Option.isSome(apiKey)) {
          const config = buildOpenAiResponsesConfig(modelName, Option.fromNullishOr(hints))
          return makeApiKeyOpenAIResolution(
            modelName,
            config,
            apiKey.value,
            refusedKeys,
            rejectedReasoning,
          )
        }

        // Fail closed — no stored OAuth, no stored API key, no env var. An
        // unauthenticated request would fail late as a generic HTTP error
        // and hide the auth failure.
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
          if (Option.isNone(auth) || auth.value._tag !== "Oauth") return models
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
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.mapError(
              (e) =>
                new ProviderAuthError({
                  message: `OpenAI OAuth authorization failed: ${e.message}`,
                  cause: e,
                }),
            ),
          )
          yield* holdLogin(ctx.authorizationId, flow, close)
          return Option.some(flow.authorization)
        }),
      callback: (ctx) =>
        Effect.gen(function* () {
          const pendingEntry = Option.fromNullishOr(pendingCallbacks.get(ctx.authorizationId))
          if (Option.isNone(pendingEntry)) {
            return yield* new ProviderAuthError({
              message: "OpenAI OAuth callback state is missing or expired",
            })
          }
          const entry = pendingEntry.value
          // A device poll can outlast the timer, so the timer stops while
          // the callback runs and a failed callback arms a new one.
          const result = yield* Fiber.interrupt(entry.timeoutFiber).pipe(
            Effect.andThen(entry.flow.callback(ctx.code)),
            Effect.mapError(
              (e) =>
                new ProviderAuthError({
                  message: `OpenAI OAuth callback failed: ${e.message}`,
                  cause: e,
                }),
            ),
            // The login stays pending after a failure or an interrupt: a
            // failed browser wait (the port taken) still leaves the pasted
            // code to finish it. Only the first of two concurrent failures
            // re-arms the timer, and a login a concurrent callback finished
            // stays gone.
            Effect.onError(() =>
              Effect.suspend(() => {
                if (pendingCallbacks.get(ctx.authorizationId) !== entry) return Effect.void
                return holdLogin(ctx.authorizationId, entry.flow, entry.close)
              }),
            ),
          )
          yield* finishLogin(ctx.authorizationId, entry.close)
          const signedIn: OpenAICredentials = {
            access: result.access,
            refresh: result.refresh,
            expires: result.expires,
            accountId: Option.fromNullishOr(result.accountId),
          }
          yield* replaceHeldCredential(
            OpenAICredentials,
            credentialCellRef,
            signedIn,
            ctx.persist(result),
          )
        }),
    },
  }
}

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
    // The host's Crypto, not one of the driver's own: a shipped provider is
    // never more privileged than a user extension.
    const crypto = yield* Crypto.Crypto

    yield* host.register(
      "modelDriver",
      buildOpenAIModelDriver(credentialCellRef, pendingCallbacks, envApiKey, catalog, crypto),
    )
  }),
})
