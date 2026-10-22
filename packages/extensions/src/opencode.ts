import { Crypto, Effect, Option, Predicate, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import {
  AuthMethod,
  DEFAULT_RETRY_POLICY,
  defineExtension,
  ExtensionHost,
  type ModelDriverContribution,
  ProviderAuthError,
  type ProviderAuthInfo,
  omitUndefined,
  type SpendLimit,
} from "@gent/core/extensions/api"
import { typeSafeDecisionModel } from "./typesafe.js"
import {
  apiKeyFrom,
  readOptionalEnv,
  MessagesTransientStreamEvent,
  ResponsesTransientStreamEvent,
} from "./providers.js"

// Test seam: only tests read OPENCODE_GATEWAYS, buildOpenCodeModelDriver and
// openCodeModelDrivers, which let a test run one gateway's driver against a
// fake fetch and read the drivers setup registers.

/**
 * OpenCode's model gateways: Zen (pay as you go) and Go (a subscription; Go
 * Plus is a higher tier of the same gateway, key and base URL). One driver
 * constructor serves both. A gateway serves each model over one of several
 * wire formats; the models.dev catalog names it per model, and core picks
 * the API class that speaks it. The driver adds what models.dev lacks: the
 * gateway's headers and the shared sign-in.
 *
 * Docs: opencode.ai/docs/go and opencode.ai/docs/zen (read 2026-10-01).
 */

// ── gateways ────────────────────────────────────────────────────────────────

interface Gateway {
  /** The driver id and the models.dev provider key. */
  readonly id: string
  /** The gateway's name in error messages. */
  readonly name: string
  /** The gateway root; the APIs live under `/v1`. */
  readonly origin: string
  /** The driver's display name, which `/auth` shows for the sign-in it owns. */
  readonly signInName: string
  readonly authLabel: string
  /**
   * The driver whose sign-in this gateway's driver uses. Core hides this
   * driver's own sign-in while that driver is registered; without it, this
   * driver signs in with its own key.
   */
  readonly credentialFrom?: string
}

/**
 * One OpenCode API key serves Zen, Go and Go Plus, so gent asks for it once:
 * the Zen driver owns the sign-in, stored under `opencode`, and the Go driver
 * reads it (`credentialFrom`). A key stored for Go before the two shared
 * still serves both. The catalogs and model ids stay apart: the gateways
 * bill differently, and one model can sit in both. OpenCode itself lists the
 * two in `/connect` with a key each.
 */
export const OPENCODE_GATEWAYS = {
  zen: {
    id: "opencode",
    name: "OpenCode Zen",
    origin: "https://opencode.ai/zen",
    signInName: "OpenCode",
    authLabel: "OpenCode API key — Zen, Go and Go Plus",
  },
  go: {
    id: "opencode-go",
    name: "OpenCode Go",
    origin: "https://opencode.ai/zen/go",
    signInName: "OpenCode Go",
    authLabel: "OpenCode Go / Go Plus API key",
    credentialFrom: "opencode",
  },
} satisfies Record<string, Gateway>

/** models.dev names this variable for both gateways. */
const ENV_CREDENTIAL = "OPENCODE_API_KEY"

// ── Go usage limits ─────────────────────────────────────────────────────────

/**
 * Go limits each model by what its requests cost at the listed token prices
 * (models.dev lists the same prices): in any 5 hours 20% of the model's
 * monthly dollars, in a week 50%, in a month 100%. Spend past a limit is
 * billed as extra usage when the account turns that on, and is never quota.
 * A model the table does not name (the free ones) has no limit.
 *
 * `OPENCODE_GO_PLAN=plus` reads the Go Plus column; any other value, or none,
 * reads Go, the stricter. Gemini 4 Argon's doubled limit is for a limited
 * time, so the table keeps its base limit. Docs:
 * opencode.ai/v2/docs/console/go/#usage-limits (read 2026-10-22).
 */
const ENV_GO_PLAN = "OPENCODE_GO_PLAN"

/** Model name → its monthly limit in dollars on Go and on Go Plus. */
const GO_MONTHLY_USD = new Map<string, readonly [go: number, plus: number]>([
  ["glm-5.3-flash", [60, 180]],
  ["glm-5.3", [15, 120]],
  ["glm-5.2", [60, 180]],
  ["kimi-k3", [15, 60]],
  ["kimi-k2.7-code", [60, 180]],
  ["longcat-2.0", [60, 240]],
  ["step-5-preview", [15, 60]],
  ["mimo-v2.6-flash", [60, 120]],
  ["mimo-v2.6-pro", [15, 60]],
  ["mimo-v2.5", [60, 120]],
  ["mimo-v2.5-pro", [15, 60]],
  ["minimax-m3", [60, 180]],
  ["muse-spark-1.3-contributor", [60, 120]],
  ["muse-spark-1.2-contributor", [60, 120]],
  ["qwen3.8-max", [15, 60]],
  ["qwen3.8-flash", [30, 90]],
  ["qwen3.7-plus", [60, 180]],
  ["deepseek-v4.1-flash", [80, 160]],
  ["deepseek-v4-pro", [15, 60]],
  ["hy4-preview", [30, 120]],
  ["hy3", [60, 240]],
  ["grok-4.7", [15, 60]],
  ["gpt-6-luna", [15, 60]],
  ["gpt-5.6-luna", [15, 60]],
  ["claude-haiku-5-5", [15, 60]],
  ["gemini-4-argon-contributor", [30, 120]],
])

/** Each window's share of the monthly limit. */
const GO_WINDOW_SHARES = [
  ["5h", 0.2],
  ["7d", 0.5],
  ["31d", 1],
] as const

/** The spend windows a Go plan sets on each model: Go Plus when `plan` is `plus`. */
const goSpendLimits =
  (plan: Option.Option<string>) =>
  (modelName: string): ReadonlyArray<SpendLimit> => {
    const monthly = GO_MONTHLY_USD.get(modelName)
    if (Predicate.isUndefined(monthly)) return []
    let usd = monthly[0]
    if (Option.contains(plan, "plus")) usd = monthly[1]
    return GO_WINDOW_SHARES.map(([window, share]) => ({ window, usd: usd * share }))
  }

// ── headers ─────────────────────────────────────────────────────────────────

/**
 * Every request names its conversation in `x-opencode-session`: the gateway
 * refuses a request without it (400 `MissingSessionID`, since 2026-09-06) and
 * uses it as the sticky routing key, which keeps the upstream prompt cache
 * warm. The client and the user agent name gent, as the docs ask. Only the
 * SDK's auth header carries the key. OpenCode's own client sends the same
 * set for every `opencode*` provider (`session/llm/request.ts`).
 */
const CLIENT_NAME = "gent"
const USER_AGENT = "gent"

const gatewayHeaders =
  (sessionId: string) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    HttpClient.mapRequest(client, (request) =>
      HttpClientRequest.setHeaders(request, {
        "x-opencode-session": sessionId,
        "x-opencode-client": CLIENT_NAME,
        "user-agent": USER_AGENT,
      }),
    )

// ── driver ──────────────────────────────────────────────────────────────────

/** The gateway's API key: a stored key first, then `OPENCODE_API_KEY`. */
const gatewayApiKey = (
  gateway: Gateway,
  authInfo: Option.Option<ProviderAuthInfo>,
  envApiKey: Option.Option<string>,
): Effect.Effect<string, ProviderAuthError> =>
  Effect.fromOption(apiKeyFrom(authInfo, envApiKey)).pipe(
    Effect.mapError(
      () =>
        new ProviderAuthError({
          message: `${gateway.name} credentials unavailable: no stored API key and no ${ENV_CREDENTIAL} env var`,
        }),
    ),
  )

/**
 * One gateway's model driver. `envApiKey` is `OPENCODE_API_KEY`, read at
 * setup; a stored key wins over it. `crypto` is the host's, captured at setup:
 * it names a request that carries no conversation (`ProviderHints.cacheKey`
 * absent: the compaction summary) with a session id of its own, since the
 * gateway refuses a request without one. Core lists the gateway's catalog
 * models a class speaks, then its decision models (Jev on Zen).
 */
export const buildOpenCodeModelDriver = (
  gateway: Gateway,
  envApiKey: Option.Option<string>,
  crypto: Crypto.Crypto,
  spendLimits?: ModelDriverContribution["spendLimits"],
): ModelDriverContribution => ({
  id: gateway.id,
  name: gateway.signInName,
  ...Option.match(Option.fromUndefinedOr(gateway.credentialFrom), {
    onNone: () => ({}),
    onSome: (credentialFrom) => ({ credentialFrom }),
  }),
  ...omitUndefined({ spendLimits }),
  envCredential: ENV_CREDENTIAL,
  retry: {
    ...DEFAULT_RETRY_POLICY,
    // A gateway model speaks Messages or Responses. Chat Completions names
    // no stream error event the SDK passes on as a part.
    transientStreamEvent: Schema.Union([
      MessagesTransientStreamEvent,
      ResponsesTransientStreamEvent,
    ]),
  },
  endpoint: (_modelName, authInfo, hints) =>
    Effect.gen(function* () {
      const apiKey = yield* gatewayApiKey(gateway, Option.fromNullishOr(authInfo), envApiKey)
      const sessionId = yield* Option.match(
        Option.flatMap(Option.fromNullishOr(hints), (value) =>
          Option.fromUndefinedOr(value.cacheKey),
        ),
        {
          onNone: () => crypto.randomUUIDv4().pipe(Effect.orDie),
          onSome: Effect.succeed,
        },
      )
      return {
        apiKey: Option.some(apiKey),
        baseUrl: Option.some(`${gateway.origin}/v1`),
        transformClient: Option.some(gatewayHeaders(sessionId)),
      }
    }),
  auth: {
    methods: [AuthMethod.make({ type: "api", label: gateway.authLabel })],
  },
  // A decision model (Jev) speaks TypeSafe's API under the gateway's `/v1`,
  // with the same key and session headers; each call is its own session.
  resolveDecisionModel: (modelName, authInfo) =>
    Effect.gen(function* () {
      const apiKey = yield* gatewayApiKey(gateway, Option.fromNullishOr(authInfo), envApiKey)
      const sessionId = yield* crypto.randomUUIDv4().pipe(Effect.orDie)
      return typeSafeDecisionModel(modelName, {
        apiKey,
        apiUrl: `${gateway.origin}/v1`,
        transformClient: gatewayHeaders(sessionId),
      })
    }),
})

/** The Zen and Go drivers, from `OPENCODE_API_KEY` and `OPENCODE_GO_PLAN` as setup reads them. */
export const openCodeModelDrivers = Effect.gen(function* () {
  const envApiKey = yield* readOptionalEnv(ENV_CREDENTIAL)
  const goPlan = yield* readOptionalEnv(ENV_GO_PLAN)
  // The host's Crypto, not one of the driver's own: a shipped provider is
  // never more privileged than a user extension.
  const crypto = yield* Crypto.Crypto
  return [
    buildOpenCodeModelDriver(OPENCODE_GATEWAYS.zen, envApiKey, crypto),
    buildOpenCodeModelDriver(OPENCODE_GATEWAYS.go, envApiKey, crypto, goSpendLimits(goPlan)),
  ] as const
})

export const OpenCodeExtension = defineExtension({
  id: "@gent/provider-opencode",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("modelDriver", ...(yield* openCodeModelDrivers))
  }),
})
