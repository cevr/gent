/**
 * Shared HTTP middleware for provider `transformClient` callbacks.
 *
 * Both OAuth providers build their client the same way: reconstruct the
 * request with a fresh header map, surface a credential failure through the
 * transport channel, and recover once from a 401 by invalidating the cache.
 * Only the header set itself is provider-specific, so it stays with the
 * provider; everything around it lives here.
 */

import { Effect, Option, Predicate, Schema } from "effect"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  type Headers,
} from "effect/unstable/http"
import { HttpClientError, TransportError } from "effect/unstable/http/HttpClientError"
import type { ProviderAuthError } from "@gent/core/extensions/api"
import type { CredentialCache } from "./provider-credentials.js"

/**
 * Reconstruct an `HttpClientRequest` with the same method/url/body but a
 * fresh headers map. The public `setHeaders` combinator only merges; it
 * cannot remove, so overriding a baseline header needs a full
 * reconstruction via the public `make(method)(url, options)` constructor.
 */
export const withHeaders = (
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
 * Convert a `ProviderAuthError` into the `HttpClientError` the SDK's
 * `transformClient` signature requires, so credential unavailability
 * reaches the caller through the standard transport channel.
 */
export const asTransportError = (
  req: HttpClientRequest.HttpClientRequest,
  cause: ProviderAuthError,
): HttpClientError =>
  new HttpClientError({
    reason: new TransportError({ request: req, cause, description: cause.message }),
  })

/** Fetch credentials for a request, surfacing auth failure as a transport error. */
export const freshCredentials = <C>(
  creds: CredentialCache<C>,
  req: HttpClientRequest.HttpClientRequest,
): Effect.Effect<C, HttpClientError> =>
  creds.getFresh.pipe(Effect.mapError((cause) => asTransportError(req, cause)))

/**
 * Internal error driving 401 recovery. The credential cache TTL can outlive
 * a token's last minute, and tokens can be revoked server-side between cache
 * fill and wire send. Typed so the recovery fires only on this signal, not on
 * other 4xx that callers should see verbatim.
 */
export class Unauthorized401Error extends Schema.TaggedError<Unauthorized401Error>(
  "@gent/extensions/src/provider-http/Unauthorized401Error",
)("Unauthorized401Error", {
  response: Schema.declare<HttpClientResponse.HttpClientResponse>(
    (input): input is HttpClientResponse.HttpClientResponse =>
      Predicate.hasProperty(input, HttpClientResponse.TypeId),
  ),
}) {}

/**
 * 401 recovery: invalidate the credential cache and retry ONCE. On the
 * retry the request preprocess re-enters and `creds.getFresh` re-reads or
 * forces a refresh. A second 401 means a real auth failure — surface the
 * response so user-facing recovery can kick in.
 *
 * `tapError` runs the invalidate AFTER the failure but BEFORE `Effect.retry`
 * re-attempts, so the invalidate commits before the next preprocess reads
 * the cache.
 */
export const recoverUnauthorized =
  <C>(creds: CredentialCache<C>) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    client.pipe(
      HttpClient.transformResponse((effect) =>
        effect.pipe(
          Effect.flatMap(
            (
              response,
            ): Effect.Effect<HttpClientResponse.HttpClientResponse, Unauthorized401Error> => {
              switch (response.status) {
                case 401:
                  return Effect.fail(new Unauthorized401Error({ response }))
                default:
                  return Effect.succeed(response)
              }
            },
          ),
          Effect.tapError((e) => {
            if (e._tag === "Unauthorized401Error") return creds.invalidate
            return Effect.void
          }),
          Effect.retry({
            while: (e) => e._tag === "Unauthorized401Error",
            times: 1,
          }),
          Effect.catchTag("Unauthorized401Error", (e) => Effect.succeed(e.response)),
        ),
      ),
    )
