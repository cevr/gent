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
 * This file currently ships auth headers (Commit 2a) + 429/529 retry
 * (Commit 2b) + long-context beta retry (Commit 2d). 401 recovery
 * lands in 2e.
 *
 * On the long-context beta retry: the Anthropic API rejects requests
 * that include both `context-1m-2025-08-07` and `interleaved-thinking-
 * 2025-05-14` for some accounts/models with a 400 + a body string
 * containing "Extra usage is required for long context requests" or
 * "long context beta is not yet available". The fix is to retry with
 * one of those betas removed, learning across requests so the next
 * turn doesn't re-include it. The cross-request learning state lives
 * in `AnthropicBetaCache` (Commit 2c); this middleware reads from it
 * in `mapRequestEffect` (so the outgoing header reflects what we've
 * learned) and writes to it in the beta-retry `transformResponse` (so
 * the next attempt's preprocess sees the updated set).
 *
 * On retry: covers two failure classes with one budget (2 retries / 3
 * attempts at 1s exponential):
 *   1. 429/529 responses — Anthropic rate-limit + Overloaded.
 *      `HttpClient.retryTransient` covers 408/429/500/502/503/504 but
 *      NOT 529, so we re-raise both as a typed `TransientResponseError`
 *      via `HttpClient.transformResponse` and let `Effect.retry` see it.
 *   2. Transport failures (`HttpClientError` from the wire) — matches
 *      legacy `fetchOnce`/`fetchWithRetry` semantics at the to-be-
 *      deleted `oauth.ts:813-838` which mapped thrown fetch errors to a
 *      synthetic 500 and retried under the same budget.
 * The catch-tag at the end folds the terminal 429/529 back into the
 * success channel; transport failures that exhaust the budget propagate
 * as `HttpClientError` (the SDK's expected error type).
 */

import { Effect, Option, Schedule, Schema } from "effect"
import { HttpClient, HttpClientRequest, Headers } from "effect/unstable/http"
import type { HttpClientResponse } from "effect/unstable/http"
import { HttpClientError, TransportError } from "effect/unstable/http/HttpClientError"
import type { AnthropicBetaCacheShape } from "./beta-cache.js"
import type { AnthropicCredentialServiceShape } from "./credential-service.js"
import {
  getCurrentBetaFlagsEnv,
  getLongContextBetasForWith,
  getModelBetas,
  getUserAgent,
  isLongContextError,
  parseModelIdFromBody,
} from "./oauth.js"

// ── Typed errors ──

/**
 * Internal error used to drive 429/529 retry through `Effect.retry`.
 * Carries the response so the catch-tag can hand the final 429/529
 * back to the caller after the retry budget is exhausted (instead of
 * surfacing as an unrelated typed failure).
 *
 * `response` is declared as `Schema.Any` because `HttpClientResponse`
 * is a class-shaped type from a vendor module and embedding its full
 * Schema would force this module to depend on undocumented internals.
 * The typed accessor `getResponse` re-narrows for the catch-tag.
 */
class TransientResponseError extends Schema.TaggedErrorClass<TransientResponseError>(
  "@gent/extensions/anthropic/TransientResponseError",
)("TransientResponseError", {
  response: Schema.Any,
}) {
  getResponse(): HttpClientResponse.HttpClientResponse {
    return this.response
  }
}

const isTransientStatus = (status: number): boolean => status === 429 || status === 529

/**
 * Internal error driving the long-context beta retry. Same Schema.Any
 * accessor pattern as `TransientResponseError` for the same vendor-class
 * Schema reason.
 */
class LongContextBetaError extends Schema.TaggedErrorClass<LongContextBetaError>(
  "@gent/extensions/anthropic/LongContextBetaError",
)("LongContextBetaError", {
  response: Schema.Any,
}) {
  getResponse(): HttpClientResponse.HttpClientResponse {
    return this.response
  }
}

/**
 * Pick the next long-context beta to drop given the candidates the
 * model actually emits and the set already excluded. Returns `null`
 * when every candidate has been tried — caller must surface the 400.
 */
const pickNextBetaToExclude = (
  modelId: string,
  currentBetaFlags: string | undefined,
  excluded: ReadonlySet<string>,
): string | null => {
  for (const beta of getLongContextBetasForWith(modelId, currentBetaFlags)) {
    if (!excluded.has(beta)) return beta
  }
  return null
}

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
    betaCache: AnthropicBetaCacheShape,
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
          const modelId = parseModelIdFromBody(requestBodyText(req))
          const betaFlags = getCurrentBetaFlagsEnv()
          // Read the cross-request-learned exclusion set from the
          // betaCache. On retry, mapRequestEffect re-runs and reads the
          // updated set — the beta-retry transformResponse below records
          // the rejected beta into the cache before failing to retry.
          const excluded = yield* betaCache.getExcluded(modelId, betaFlags)
          const headers = buildOauthHeaders(req, fresh.accessToken, modelId, new Set(excluded))
          return withHeaders(req, headers)
        }),
      ),
      // Long-context beta retry: on 400 with the long-context marker in
      // the body, record the offending beta into the cache and fail with
      // LongContextBetaError so Effect.retry re-runs preprocess (which
      // re-reads the now-larger excluded set) + postprocess. Budget = one
      // retry slot per long-context candidate the model actually emits
      // (Counsel C8 deep at the to-be-deleted oauth.ts:847-887 fixed
      // the prior off-by-one + per-model-override bugs; this port
      // preserves that fix). When candidates exhaust, the catch-tag
      // folds the terminal 400 back into the success channel.
      HttpClient.transformResponse((effect) =>
        effect.pipe(
          Effect.flatMap(
            (
              response,
            ): Effect.Effect<
              HttpClientResponse.HttpClientResponse,
              LongContextBetaError | HttpClientError
            > => {
              if (response.status !== 400 && response.status !== 429) {
                return Effect.succeed(response)
              }
              return response.text.pipe(
                Effect.flatMap((body) => {
                  if (!isLongContextError(body)) return Effect.succeed(response)
                  // Body matches: try to record the next beta + retry.
                  const modelId = parseModelIdFromBody(requestBodyText(response.request))
                  const betaFlags = getCurrentBetaFlagsEnv()
                  return betaCache.getExcluded(modelId, betaFlags).pipe(
                    Effect.flatMap((excluded) => {
                      const beta = pickNextBetaToExclude(modelId, betaFlags, excluded)
                      if (beta === null) return Effect.succeed(response)
                      return betaCache
                        .recordExcluded(modelId, beta, betaFlags)
                        .pipe(
                          Effect.flatMap(() => Effect.fail(new LongContextBetaError({ response }))),
                        )
                    }),
                  )
                }),
              )
            },
          ),
          // Budget: at most LONG_CONTEXT_BETAS.length retries — bounded
          // because every retry adds one beta to the cache's excluded
          // set, and `pickNextBetaToExclude` returns `null` once
          // exhausted (which short-circuits to success above without
          // re-failing). The numeric `times` is a belt-and-suspenders
          // bound; the real terminator is the `null` short-circuit.
          Effect.retry({
            while: (e) => e._tag === "LongContextBetaError",
            times: 8,
          }),
          Effect.catchTag("LongContextBetaError", (e) => Effect.succeed(e.getResponse())),
        ),
      ),
      // Retry: 2 retries (3 attempts total) with exponential backoff
      // starting at 1s. Retries both:
      //   - 429/529 responses (Anthropic rate-limit + Overloaded)
      //   - Transport failures (HttpClientError from the wire), matching
      //     the legacy `fetchOnce` semantics at the to-be-deleted
      //     `oauth.ts:813-838` which mapped thrown fetch errors to a
      //     synthetic 500 and retried.
      // `transformResponse` re-raises 429/529 as a typed failure so
      // `Effect.retry` can react. The catch-tag at the end folds the
      // terminal 429/529 back into the success channel after the budget
      // is exhausted, keeping the public HttpClient contract intact.
      // Genuine transport errors that exhaust the budget propagate as
      // `HttpClientError` — the SDK's expected error type.
      HttpClient.transformResponse((effect) =>
        effect.pipe(
          Effect.flatMap(
            (
              response,
            ): Effect.Effect<HttpClientResponse.HttpClientResponse, TransientResponseError> =>
              isTransientStatus(response.status)
                ? Effect.fail(new TransientResponseError({ response }))
                : Effect.succeed(response),
          ),
          Effect.retry({
            schedule: Schedule.exponential("1 second"),
            times: 2,
          }),
          Effect.catchTag("TransientResponseError", (e) => Effect.succeed(e.getResponse())),
        ),
      ),
    )
