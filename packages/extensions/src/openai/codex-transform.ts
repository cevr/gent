/**
 * codexTransformClient — `@effect/ai-openai-compat` `transformClient`
 * callback for the ChatGPT OAuth (Codex) path.
 *
 * The SDK applies `transformClient` after its own baseline pipeline
 * (`prependUrl(${apiUrl}/v1)` + optional `bearerToken(apiKey)`). With
 * the OAuth path we omit `apiKey` entirely (counsel correction — O5),
 * so the SDK never injects a placeholder Bearer header. This middleware
 * supplies the OAuth Bearer + Codex-specific headers itself.
 *
 * This file ships the auth-header preprocess only (O2). URL rewrite,
 * body rewrite, and the Codex `OpenAI-Beta` header land in O3; 401
 * recovery lands in O4.
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

import { Effect, Option } from "effect"
import { HttpClient, HttpClientRequest, Headers } from "effect/unstable/http"
import { HttpClientError, TransportError } from "effect/unstable/http/HttpClientError"
import * as os from "node:os"
import type { OpenAICredentialServiceShape } from "./credential-service.js"

// ── Header construction ──

/**
 * Build the OAuth header set for a Codex request. Mirrors the legacy
 * `createAuthHeaders` at oauth.ts:415 — Bearer over the access token,
 * ChatGPT-Account-Id when known, plus polite-default `originator` and
 * `User-Agent` if the upstream didn't set them.
 *
 * The SDK's baseline does NOT inject `Authorization` because we omit
 * `apiKey` from the client config (O5). The defensive `Headers.remove`
 * for `authorization` here is belt-and-suspenders: if a future SDK
 * version starts injecting a placeholder header without an explicit
 * `apiKey`, this middleware still supplies the right value.
 */
const buildOauthHeaders = (
  req: HttpClientRequest.HttpClientRequest,
  accessToken: string,
  accountId: string | undefined,
): Headers.Headers => {
  let headers = Headers.remove(req.headers, "authorization")
  headers = Headers.set(headers, "authorization", `Bearer ${accessToken}`)
  if (accountId !== undefined && accountId.length > 0) {
    headers = Headers.set(headers, "chatgpt-account-id", accountId)
  }
  if (headers["originator"] === undefined) {
    headers = Headers.set(headers, "originator", "gent")
  }
  if (headers["user-agent"] === undefined) {
    headers = Headers.set(
      headers,
      "user-agent",
      `gent (${os.platform()} ${os.release()}; ${os.arch()})`,
    )
  }
  return headers
}

/**
 * Reconstruct an `HttpClientRequest` with the same method/url/body but
 * a fresh headers map. The public `setHeaders` combinator only merges
 * — to override values we already had to handle deletion via
 * `Headers.remove` upstream, so the safe shape is full reconstruction
 * via the public `make(method)(url, options)` constructor.
 *
 * Mirrors the Anthropic `withHeaders` helper — see
 * `keychain-transform.ts:167-176`.
 */
const withHeaders = (
  req: HttpClientRequest.HttpClientRequest,
  headers: Headers.Headers,
): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.make(req.method)(req.url, {
    headers,
    body: req.body,
    urlParams: req.urlParams,
    hash: Option.getOrUndefined(req.hash),
  })

// ── transformClient factory ──

/**
 * Build the `transformClient` value the OpenAI-compat SDK accepts.
 *
 * Takes the `OpenAICredentialService` instance as a closure argument
 * (not via `yield*` inside `mapRequestEffect`) for the type reasons
 * documented above.
 *
 * Per-request semantics are preserved: each request invokes
 * `creds.getFresh` which consults the live `Ref` cache (cell-resident
 * rotated refresh token survives invalidate per credential-service
 * counsel HIGH #1 fix).
 *
 * O2 ships only the auth-header preprocess. The full middleware stack
 * lands incrementally:
 *   - mapRequestEffect (preprocess) — auth headers (O2)
 *     + URL/body rewrite + OpenAI-Beta (O3)
 *   - 401 recovery (outermost transformResponse) (O4)
 */
export const buildCodexTransformClient =
  (
    creds: OpenAICredentialServiceShape,
  ): ((client: HttpClient.HttpClient) => HttpClient.HttpClient) =>
  (client) =>
    client.pipe(
      HttpClient.mapRequestEffect((req) =>
        Effect.gen(function* () {
          const fresh = yield* creds.getFresh.pipe(
            // Convert ProviderAuthError → HttpClientError so the
            // returned client type stays `With<HttpClientError, never>`
            // (what the SDK signature requires). Surfaces credential
            // unavailability through the standard transport channel.
            Effect.mapError(
              (cause) =>
                new HttpClientError({
                  reason: new TransportError({
                    request: req,
                    cause,
                    description: cause.message,
                  }),
                }),
            ),
          )
          const headers = buildOauthHeaders(req, fresh.access, fresh.accountId)
          return withHeaders(req, headers)
        }),
      ),
    )
