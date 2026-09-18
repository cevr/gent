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
 * This file ships the full middleware stack: auth headers (2a),
 * 429/529 + transport retry (2b), long-context beta retry (2d), and
 * 401 recovery (2e). Layered outside-in via `pipe`, the order is:
 *   - mapRequestEffect (preprocess) — auth + cache-aware headers
 *   - long-context beta retry (innermost transformResponse)
 *   - 429/529 + transport retry (middle)
 *   - 401 recovery (outermost) — invalidate creds + retry once
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
 *   2. Transport failures (`HttpClientError` from the wire) — retried under
 *      the same budget as transient HTTP responses.
 * The catch-tag at the end folds the terminal 429/529 back into the
 * success channel; transport failures that exhaust the budget propagate
 * as `HttpClientError` (the SDK's expected error type).
 */

import { Effect, Option, Schedule, Schema } from "effect"
import { HttpClient, Headers } from "effect/unstable/http"
import type { HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import type { HttpClientError } from "effect/unstable/http/HttpClientError"
import {
  type CredentialCache,
  freshCredentials,
  recoverUnauthorized,
  withHeaders,
} from "../providers.js"
import type { AnthropicBetaCacheApi } from "./beta-cache.js"
import type { ClaudeCredentials } from "./oauth/credentials.js"
import {
  getLongContextBetasForWith,
  getUserAgent,
  isLongContextError,
  parseModelIdFromBody,
} from "./oauth/anthropic-headers.js"
import { getModelBetas } from "./model-config.js"
import type { AnthropicKeychainEnv } from "./platform-adapter.js"

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
class TransientResponseError extends Schema.TaggedError<TransientResponseError>(
  "@gent/extensions/src/anthropic/keychain-transform/TransientResponseError",
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
class LongContextBetaError extends Schema.TaggedError<LongContextBetaError>(
  "@gent/extensions/src/anthropic/keychain-transform/LongContextBetaError",
)("LongContextBetaError", {
  response: Schema.Any,
}) {
  getResponse(): HttpClientResponse.HttpClientResponse {
    return this.response
  }
}

/**
 * Pick the next long-context beta to drop given the candidates the
 * model actually emits and the set already excluded.
 */
const pickNextBetaToExclude = (
  modelId: string,
  currentBetaFlags: Option.Option<string>,
  excluded: ReadonlySet<string>,
): Option.Option<string> => {
  for (const beta of getLongContextBetasForWith(modelId, currentBetaFlags)) {
    if (!excluded.has(beta)) return Option.some(beta)
  }
  return Option.none()
}

// ── Helpers ──

/**
 * Decode the request body to a string for model-id extraction. The
 * Anthropic SDK serializes JSON bodies as Uint8Array; some caller surfaces use
 * Raw strings. Anything else (FormData / Stream / Empty) returns None and
 * the parser short-circuits to "unknown".
 */
const decodeString = Schema.decodeUnknownOption(Schema.String)

const requestBodyText = (req: HttpClientRequest.HttpClientRequest): Option.Option<string> => {
  if (req.body._tag === "Uint8Array") {
    return Option.some(new TextDecoder().decode(req.body.body))
  }
  if (req.body._tag === "Raw") {
    return decodeString(req.body.body)
  }
  return Option.none()
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
  env: AnthropicKeychainEnv,
  excluded?: Set<string>,
): Headers.Headers => {
  // Start from the SDK's existing headers (preserve `anthropic-version`
  // etc.) but drop `x-api-key` since OAuth uses Bearer.
  let headers = Headers.remove(req.headers, "x-api-key")

  const modelBetas = getModelBetas(
    modelId,
    Option.fromNullishOr(env.betaFlags),
    Option.fromNullishOr(excluded),
  )
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
  headers = Headers.set(headers, "user-agent", getUserAgent(env))
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
    creds: CredentialCache<ClaudeCredentials>,
    betaCache: AnthropicBetaCacheApi,
    env: AnthropicKeychainEnv,
  ): ((client: HttpClient.HttpClient) => HttpClient.HttpClient) =>
  (client) =>
    client.pipe(
      HttpClient.mapRequestEffect((req) =>
        Effect.gen(function* () {
          const fresh = yield* freshCredentials(creds, req)
          const modelId = parseModelIdFromBody(requestBodyText(req))
          const betaFlags = env.betaFlags
          // Read the cross-request-learned exclusion set from the
          // betaCache. On retry, mapRequestEffect re-runs and reads the
          // updated set — the beta-retry transformResponse below records
          // the rejected beta into the cache before failing to retry.
          const excluded = yield* betaCache.getExcluded(modelId, Option.fromNullishOr(betaFlags))
          const headers = buildOauthHeaders(req, fresh.accessToken, modelId, env, new Set(excluded))
          return withHeaders(req, headers)
        }),
      ),
      // Long-context beta retry: on 400 with the long-context marker in
      // the body, record the offending beta into the cache and fail with
      // LongContextBetaError so Effect.retry re-runs preprocess (which
      // re-reads the now-larger excluded set) + postprocess. Budget = one
      // retry slot per long-context candidate the model actually emits
      // (Counsel  deep at the to-be-deleted oauth.ts:847-887 fixed
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
              switch (response.status) {
                case 400:
                  return response.text.pipe(
                    Effect.flatMap((body) => {
                      if (!isLongContextError(body)) return Effect.succeed(response)
                      // Body matches: try to record the next beta + retry.
                      const modelId = parseModelIdFromBody(requestBodyText(response.request))
                      const betaFlags = env.betaFlags
                      return betaCache.getExcluded(modelId, Option.fromNullishOr(betaFlags)).pipe(
                        Effect.flatMap((excluded) => {
                          const beta = pickNextBetaToExclude(
                            modelId,
                            Option.fromNullishOr(betaFlags),
                            excluded,
                          )
                          if (Option.isNone(beta)) return Effect.succeed(response)
                          return betaCache
                            .recordExcluded(modelId, beta.value, Option.fromNullishOr(betaFlags))
                            .pipe(
                              Effect.flatMap(() =>
                                Effect.fail(new LongContextBetaError({ response })),
                              ),
                            )
                        }),
                      )
                    }),
                  )
                default:
                  return Effect.succeed(response)
              }
            },
          ),
          // Budget: at most one retry per long-context beta — bounded
          // because every retry adds one beta to the cache's excluded
          // set, and `pickNextBetaToExclude` returns `None` once
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
      //   - Transport failures (HttpClientError from the wire).
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
            ): Effect.Effect<HttpClientResponse.HttpClientResponse, TransientResponseError> => {
              switch (isTransientStatus(response.status)) {
                case true:
                  return Effect.fail(new TransientResponseError({ response }))
                default:
                  return Effect.succeed(response)
              }
            },
          ),
          Effect.retry({
            schedule: Schedule.exponential("1 second"),
            times: 2,
          }),
          Effect.catchTag("TransientResponseError", (e) => Effect.succeed(e.getResponse())),
        ),
      ),
      recoverUnauthorized(creds),
    )
