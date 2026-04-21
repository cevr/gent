/**
 * keychainTransformClient — `@effect/ai-anthropic` `transformClient`
 * callback.
 *
 * The SDK applies `transformClient` after its own baseline header pipeline
 * (`x-api-key`, `anthropic-version`, `accept: application/json`). This
 * middleware augments + overrides what OAuth needs:
 *
 * - Sets `authorization: Bearer <accessToken>` from `AnthropicCredentialService`
 * - Sets `anthropic-beta: <merged>` from per-model defaults
 * - Sets `x-app: cli`, `user-agent: claude-cli/<version> (external, cli)`,
 *   `anthropic-dangerous-direct-browser-access: true`
 * - Removes `x-api-key` (the SDK's baseline injects `oauth-placeholder`
 *   here; Anthropic rejects requests where both `x-api-key` and
 *   `authorization: Bearer` are present)
 *
 * Why `transformClient` over a custom `HttpClient` Layer: the SDK's
 * baseline (`prependUrl`, `anthropic-version`, `acceptJson`) is exactly
 * what we want — replacing it would mean re-implementing it. See
 * `~/.cache/repo/effect-ts/effect-smol/packages/ai/anthropic/src/AnthropicClient.ts:215-232`.
 *
 * Why a factory `(creds) => (client) => client` instead of grabbing the
 * service from context inside `mapRequestEffect`: the SDK's
 * `transformClient` signature is `(HttpClient) => HttpClient`, which
 * requires the returned client's requirement channel to be empty.
 * `mapRequestEffect` widens that channel to whatever services its body
 * yields — so reading the service from context per-request would
 * surface `AnthropicCredentialService` as a requirement and not
 * type-check against the SDK signature. The factory captures the
 * service instance in a closure; per-request semantics are preserved
 * because each call to `creds.getFresh` still consults the live
 * `Ref` cache.
 *
 * This file currently ships only the auth-headers middleware (Commit
 * 2a). 429/529 retry, long-context beta retry, and 401 recovery land in
 * subsequent commits.
 */

import { Effect, Option } from "effect"
import { HttpClient, HttpClientRequest, Headers } from "effect/unstable/http"
import { HttpClientError, TransportError } from "effect/unstable/http/HttpClientError"
import type { AnthropicCredentialServiceShape } from "./credential-service.js"
import { getModelBetas, getUserAgent, parseModelIdFromBody } from "./oauth.js"

// ── Helpers ──

/**
 * Reconstruct an `HttpClientRequest` with the same method/url/etc. but a
 * fresh headers map. The public `setHeaders` combinator only merges; it
 * cannot remove. To delete `x-api-key` we need a full reconstruction
 * via the public `make(method)(url, options)` constructor — verbose,
 * but no internals.
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

/**
 * Decode the request body to a string for model-id extraction. The
 * Anthropic SDK serializes JSON bodies as Uint8Array; legacy callers
 * (Vercel-style) used Raw strings. Anything else (FormData / Stream /
 * Empty) returns undefined and the parser short-circuits to "unknown".
 */
const requestBodyText = (req: HttpClientRequest.HttpClientRequest): string | undefined => {
  if (req.body._tag === "Uint8Array") return new TextDecoder().decode(req.body.body)
  if (req.body._tag === "Raw") {
    const raw: unknown = req.body.body
    return typeof raw === "string" ? raw : undefined
  }
  return undefined
}

/**
 * Build the OAuth header set for a request. `excluded` is an optional
 * set of betas to drop (used by the beta-retry middleware in commit
 * 2d; for 2a it's always empty / undefined).
 */
const buildOauthHeaders = (
  req: HttpClientRequest.HttpClientRequest,
  accessToken: string,
  modelId: string,
  excluded?: Set<string>,
): Headers.Headers => {
  // Start from the SDK's existing headers (preserve `anthropic-version`
  // etc.) but drop `x-api-key` since OAuth uses Bearer.
  let headers = Headers.remove(req.headers, "x-api-key")

  const modelBetas = getModelBetas(modelId, excluded)
  const incomingBeta = headers["anthropic-beta"] ?? ""
  const mergedBetas = Array.from(
    new Set([
      ...modelBetas,
      ...incomingBeta
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ]),
  )

  headers = Headers.set(headers, "authorization", `Bearer ${accessToken}`)
  headers = Headers.set(headers, "anthropic-beta", mergedBetas.join(","))
  headers = Headers.set(headers, "x-app", "cli")
  headers = Headers.set(headers, "user-agent", getUserAgent())
  // The billing header lives in `system[0]` (see keychain-client.ts +
  // signing.ts), NOT as an HTTP header. We do set this declarative
  // browser-access acknowledgement to match Claude Code's behavior.
  headers = Headers.set(headers, "anthropic-dangerous-direct-browser-access", "true")

  return headers
}

// ── transformClient factory ──

/**
 * Build the `transformClient` value the Anthropic SDK accepts.
 *
 * Takes the `AnthropicCredentialService` instance as a closure
 * argument (not via `yield*` inside `mapRequestEffect`) because the
 * SDK's `transformClient` signature `(HttpClient) => HttpClient`
 * requires the returned client to have an empty requirement channel —
 * yielding the service from context inside the middleware would
 * surface it as a requirement and break the type.
 *
 * Per-request semantics are preserved: each request invokes
 * `creds.getFresh` which consults the live `Ref` cache. The closure
 * captures the dispatcher (the service instance), not a snapshot of
 * its state.
 */
export const buildKeychainTransformClient =
  (
    creds: AnthropicCredentialServiceShape,
  ): ((client: HttpClient.HttpClient) => HttpClient.HttpClient) =>
  (client) =>
    client.pipe(
      HttpClient.mapRequestEffect((req) =>
        creds.getFresh.pipe(
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
          Effect.map((fresh) => {
            const modelId = parseModelIdFromBody(requestBodyText(req))
            const headers = buildOauthHeaders(req, fresh.accessToken, modelId)
            return withHeaders(req, headers)
          }),
        ),
      ),
    )
