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

import { Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, Headers } from "effect/unstable/http"
import type { HttpBody, HttpClientResponse } from "effect/unstable/http"
import { HttpClientError, TransportError } from "effect/unstable/http/HttpClientError"
import * as os from "node:os"
import type { OpenAICredentialServiceShape } from "./credential-service.js"

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
  pathname === "/v1/chat/completions" || pathname === "/v1/responses"

const codexUrlMatches = (url: URL): boolean => isCodexBoundPath(url.pathname)

/**
 * Required `OpenAI-Beta` token for Codex backend traffic. Pure
 * preserve-when-present is unsafe — if the SDK ever starts sending
 * some other beta header for a reason of its own, the Codex request
 * would lose the required `responses=experimental` token and the
 * backend would reject it. Merge instead.
 */
const CODEX_BETA_TOKEN = "responses=experimental"

/**
 * Merge `requiredToken` into a comma-separated `OpenAI-Beta` header
 * value, preserving any other tokens already present and avoiding
 * duplicates. Order: existing tokens first, required token appended
 * last if missing. Whitespace around commas is normalized.
 */
const ensureBetaToken = (existing: string | undefined, requiredToken: string): string => {
  const tokens =
    existing === undefined
      ? []
      : existing
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
  if (tokens.includes(requiredToken)) return tokens.join(", ")
  return [...tokens, requiredToken].join(", ")
}

// ── Body rewrite ──

/**
 * Codex backend expects a responses-API payload shape:
 *   - `system`/`developer` items lifted out of `input` into a top-level
 *     `instructions` string (joined by `\n\n`)
 *   - `store: false` to prevent server-side conversation persistence
 *
 * Inputs without an `input` array (e.g. chat-completions `messages`
 * payloads) pass through untouched — the Codex backend tolerates the
 * legacy shape today, and locking it would prevent the SDK from
 * gradually migrating to `/responses`.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const isInstructionItem = (
  item: unknown,
): item is { role: "system" | "developer"; content?: unknown } => {
  if (!isRecord(item)) return false
  const role = item["role"]
  return role === "system" || role === "developer"
}

const splitInstructions = (
  input: unknown,
): { instructions: string[]; filteredInput: unknown[] } | undefined => {
  if (!Array.isArray(input)) return undefined
  const instructions: string[] = []
  const filteredInput: unknown[] = []
  for (const item of input) {
    if (isInstructionItem(item)) {
      // Only string content lifts to top-level `instructions`. Items
      // with structured (non-string) content stay in `filteredInput`
      // so the Codex backend still sees them — silently dropping them
      // would corrupt the prompt at the boundary.
      if (typeof item.content === "string") {
        instructions.push(item.content)
        continue
      }
    }
    filteredInput.push(item)
  }
  return { instructions, filteredInput }
}

/**
 * Try to read the request body as a JSON object. Returns `undefined`
 * when the body isn't a `Uint8Array` HttpBody (the only shape the SDK
 * emits via `bodyJsonUnsafe`) or when JSON parsing fails. Both cases
 * cause the URL/header rewrite to still apply but the body to pass
 * through unchanged — Codex tolerates the chat-completions shape today.
 */
const tryReadJsonBody = (body: HttpBody.HttpBody): Record<string, unknown> | undefined => {
  if (body._tag !== "Uint8Array") return undefined
  try {
    const text = new TextDecoder().decode(body.body)
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const rewriteCodexBody = (
  req: HttpClientRequest.HttpClientRequest,
): HttpClientRequest.HttpClientRequest => {
  const parsed = tryReadJsonBody(req.body)
  if (parsed === undefined) return req
  const split = splitInstructions(parsed["input"])
  if (split === undefined) return req
  const next: Record<string, unknown> = { ...parsed }
  if (split.instructions.length > 0) {
    next["instructions"] = split.instructions.join("\n\n")
  }
  next["input"] = split.filteredInput
  next["store"] = false
  const encoded = new TextEncoder().encode(JSON.stringify(next))
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

// ── 401 recovery ──

/**
 * Internal error driving 401 recovery. The credential cache TTL (30s)
 * can outlive a token's last minute, and OAuth tokens can be revoked
 * server-side between cache fill and wire send. On 401, invalidate
 * the cache and retry once — the next preprocess re-enters and
 * `creds.getFresh` forces a refresh against the rotated refresh token
 * preserved in the cell.
 *
 * Mirrors the Anthropic `Unauthorized401Error` (keychain-transform.ts:
 * 132-140) — typed so the recovery fires only on this signal, not on
 * other 4xx that callers should see verbatim.
 */
class Unauthorized401Error extends Schema.TaggedErrorClass<Unauthorized401Error>(
  "@gent/extensions/openai/Unauthorized401Error",
)("Unauthorized401Error", {
  response: Schema.Any,
}) {
  getResponse(): HttpClientResponse.HttpClientResponse {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- extension adapter narrows foreign SDK payload at boundary
    return this.response as HttpClientResponse.HttpClientResponse
  }
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
          let headers = buildOauthHeaders(req, fresh.access, fresh.accountId)
          const url = new URL(req.url)
          if (codexUrlMatches(url)) {
            headers = Headers.set(
              headers,
              "openai-beta",
              ensureBetaToken(headers["openai-beta"], CODEX_BETA_TOKEN),
            )
            const withBody = rewriteCodexBody(withHeaders(req, headers))
            return HttpClientRequest.setUrl(withBody, new URL(CODEX_API_ENDPOINT))
          }
          return withHeaders(req, headers)
        }),
      ),
      // 401 recovery (outermost): invalidate the credential cache + retry
      // ONCE. The cache TTL is 30s so it can outlive a token's last
      // minute; tokens can also be revoked between cache fill and wire
      // send. On the retry, `mapRequestEffect` re-enters and `creds.
      // getFresh` re-reads the rotated refresh token (preserved across
      // invalidate) and forces a refresh.
      // A second 401 means a real auth failure (revoked session, expired
      // refresh token) — surface the response to the caller so the user
      // can re-authorize from the auth picker.
      //
      // `tapError` runs the invalidate effect AFTER the failure but
      // BEFORE Effect.retry decides to re-attempt — invalidate must
      // commit before the next preprocess re-reads the cache.
      HttpClient.transformResponse((effect) =>
        effect.pipe(
          Effect.flatMap(
            (
              response,
            ): Effect.Effect<HttpClientResponse.HttpClientResponse, Unauthorized401Error> =>
              response.status === 401
                ? Effect.fail(new Unauthorized401Error({ response }))
                : Effect.succeed(response),
          ),
          Effect.tapError((e) =>
            e._tag === "Unauthorized401Error" ? creds.invalidate : Effect.void,
          ),
          Effect.retry({
            while: (e) => e._tag === "Unauthorized401Error",
            times: 1,
          }),
          Effect.catchTag("Unauthorized401Error", (e) => Effect.succeed(e.getResponse())),
        ),
      ),
    )
