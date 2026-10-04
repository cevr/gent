import { describe, expect, it } from "effect-bun-test"
import type { ChildProcessSpawner } from "effect/process"
import {
  Context,
  Crypto,
  Effect,
  type FileSystem,
  Layer,
  type Path,
  Predicate,
  Option,
  Schema,
  SynchronizedRef,
} from "effect"
import { BunCrypto, BunServices } from "@effect/platform-bun"
import * as Prompt from "effect/ai/Prompt"
import {
  type ModelDriverContribution,
  type ProviderAuthInfo,
  ProviderAuthInfo as ProviderAuthInfoSchema,
  type ProviderHints,
  type ReasoningEffort,
} from "@gent/core/extensions/api"
import { modelCatalogFromBodies } from "@gent/core/test-utils"
import {
  AnthropicPlatform,
  buildAnthropicModelDriver,
  type ClaudeCredentials,
} from "../src/anthropic.js"
import { buildCloudflareModelDriver } from "../src/cloudflare.js"
import { buildOpenAIModelDriver, type OpenAICredentials } from "../src/openai.js"
import { buildOpenCodeModelDriver, OPENCODE_GATEWAYS } from "../src/opencode.js"
import { type CredentialCacheCell, EMPTY_CREDENTIAL_CELL } from "../src/providers.js"
import { resolveShipped } from "./helpers/api-classes.js"
import { encodeExternalJson } from "./helpers/external-wire.js"
import {
  type CapturedRequest,
  fakeFetchLayer,
  makeFakeFetchState,
} from "./helpers/fake-http-client.js"
import { LanguageModel } from "effect/ai"

/**
 * The request body each driver sends, per model and per reasoning hint,
 * pinned: a change to a planner or a builder shows here as a changed line.
 * Each line is one request's fields outside the conversation (`input`,
 * `messages`, `system`, `tools`), its cache markers by path and lifetime,
 * and its `anthropic-beta` header. The models are models.dev entries as
 * served on 2026-10-02. Every request goes to a captured fake `fetch`.
 */

// ── catalog ─────────────────────────────────────────────────────────────────

const payload = {
  openai: {
    npm: "@ai-sdk/openai",
    models: {
      "gpt-5.5-pro": {
        name: "GPT-5.5 Pro",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["medium", "high", "xhigh"] }],
        tool_call: true,
        temperature: false,
        limit: { context: 1050000, input: 922000, output: 128000 },
      },
      "gpt-5.3-codex": {
        name: "GPT-5.3 Codex",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
        tool_call: true,
        temperature: true,
        limit: { context: 400000, input: 272000, output: 128000 },
      },
      "gpt-6.1-sol": {
        name: "GPT-6.1 Sol",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
        tool_call: true,
        temperature: false,
        limit: { context: 1050000, input: 922000, output: 128000 },
      },
      "gpt-5.1": {
        name: "GPT-5.1",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high"] }],
        tool_call: true,
        temperature: true,
        limit: { context: 400000, input: 272000, output: 128000 },
      },
      "gpt-4.1": {
        name: "GPT-4.1",
        reasoning: false,
        tool_call: true,
        temperature: true,
        limit: { context: 1047576, output: 32768 },
      },
      o3: {
        name: "o3",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
        tool_call: true,
        temperature: false,
        limit: { context: 200000, output: 100000 },
      },
      "gpt-5": {
        name: "GPT-5",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["minimal", "low", "medium", "high"] }],
        tool_call: true,
        temperature: false,
        limit: { context: 400000, input: 272000, output: 128000 },
      },
      "gpt-6-sol": {
        name: "GPT-6 Sol",
        reasoning: true,
        reasoning_options: [
          { type: "effort", values: ["none", "low", "medium", "high", "xhigh", "max"] },
        ],
        tool_call: true,
        temperature: false,
        limit: { context: 1050000, input: 922000, output: 128000 },
      },
    },
  },
  anthropic: {
    npm: "@ai-sdk/anthropic",
    models: {
      "claude-haiku-4-5": {
        name: "Claude Haiku 4.5 (latest)",
        reasoning: true,
        reasoning_options: [{ type: "budget_tokens", min: 1024 }],
        tool_call: true,
        temperature: true,
        limit: { context: 200000, output: 64000 },
      },
      "claude-opus-4-5": {
        name: "Claude Opus 4.5 (latest)",
        reasoning: true,
        reasoning_options: [
          { type: "effort", values: ["low", "medium", "high"] },
          { type: "budget_tokens", min: 1024 },
        ],
        tool_call: true,
        temperature: true,
        limit: { context: 200000, output: 64000 },
      },
      "claude-sonnet-4-5": {
        name: "Claude Sonnet 4.5 (latest)",
        reasoning: true,
        reasoning_options: [{ type: "budget_tokens", min: 1024 }],
        tool_call: true,
        temperature: true,
        limit: { context: 1000000, output: 64000 },
      },
      "claude-opus-5": {
        name: "Claude Opus 5",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
        tool_call: true,
        temperature: false,
        limit: { context: 1000000, output: 128000 },
      },
      "claude-fable-5": {
        name: "Claude Fable 5",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
        tool_call: true,
        temperature: false,
        limit: { context: 1000000, output: 128000 },
      },
      "claude-fable-5-1": {
        name: "Claude Fable 5.1",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
        tool_call: true,
        temperature: false,
        limit: { context: 1000000, output: 128000 },
      },
      "claude-opus-5-5": {
        name: "Claude Opus 5.5",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
        tool_call: true,
        temperature: false,
        limit: { context: 1000000, output: 128000 },
      },
      "claude-sonnet-5-5": {
        name: "Claude Sonnet 5.5",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
        tool_call: true,
        temperature: false,
        limit: { context: 1000000, output: 128000 },
      },
      "claude-sonnet-5": {
        name: "Claude Sonnet 5",
        reasoning: true,
        reasoning_options: [
          { type: "toggle" },
          { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] },
        ],
        tool_call: true,
        temperature: false,
        limit: { context: 1000000, output: 128000 },
      },
      "claude-opus-4-6": {
        name: "Claude Opus 4.6",
        reasoning: true,
        reasoning_options: [
          { type: "effort", values: ["low", "medium", "high", "max"] },
          { type: "budget_tokens", min: 1024 },
        ],
        tool_call: true,
        temperature: true,
        limit: { context: 1000000, output: 128000 },
      },
      "claude-opus-4-7": {
        name: "Claude Opus 4.7",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
        tool_call: true,
        temperature: false,
        limit: { context: 1000000, output: 128000 },
      },
    },
  },
  opencode: {
    npm: "@ai-sdk/openai-compatible",
    api: "https://opencode.ai/zen/v1",
    models: {
      "gpt-5.5-pro": {
        name: "GPT-5.5 Pro",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["medium", "high", "xhigh"] }],
        tool_call: true,
        temperature: false,
        limit: { context: 1050000, input: 922000, output: 128000 },
        provider: { npm: "@ai-sdk/openai" },
      },
      "minimax-m3-free": {
        name: "MiniMax-M3 Free",
        reasoning: true,
        reasoning_options: [{ type: "toggle" }],
        tool_call: true,
        temperature: true,
        limit: { context: 200000, output: 32000 },
        provider: { npm: "@ai-sdk/anthropic" },
      },
      "claude-opus-4-5": {
        name: "Claude Opus 4.5",
        reasoning: true,
        reasoning_options: [
          { type: "effort", values: ["low", "medium", "high"] },
          { type: "budget_tokens", min: 1024 },
        ],
        tool_call: true,
        temperature: true,
        limit: { context: 200000, output: 64000 },
        provider: { npm: "@ai-sdk/anthropic" },
      },
      "glm-5": {
        name: "GLM-5",
        reasoning: true,
        reasoning_options: [{ type: "toggle" }],
        tool_call: true,
        interleaved: { field: "reasoning_content" },
        temperature: true,
        limit: { context: 204800, output: 131072 },
      },
      "kimi-k2.6": {
        name: "Kimi K2.6",
        reasoning: true,
        reasoning_options: [{ type: "toggle" }],
        tool_call: true,
        interleaved: { field: "reasoning_content" },
        temperature: true,
        limit: { context: 262144, output: 65536 },
      },
      "claude-sonnet-4-5": {
        name: "Claude Sonnet 4.5",
        reasoning: true,
        reasoning_options: [{ type: "budget_tokens", min: 1024 }],
        tool_call: true,
        interleaved: true,
        temperature: true,
        limit: { context: 1000000, output: 64000 },
        provider: { npm: "@ai-sdk/anthropic" },
      },
      "gpt-6.1-sol": {
        name: "GPT-6.1 Sol",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
        tool_call: true,
        temperature: false,
        limit: { context: 1050000, input: 922000, output: 128000 },
        provider: { npm: "@ai-sdk/openai" },
      },
      "claude-opus-5": {
        name: "Claude Opus 5",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
        tool_call: true,
        temperature: false,
        limit: { context: 1000000, output: 128000 },
        provider: { npm: "@ai-sdk/anthropic" },
      },
      "claude-opus-4-6": {
        name: "Claude Opus 4.6",
        reasoning: true,
        reasoning_options: [
          { type: "effort", values: ["low", "medium", "high", "max"] },
          { type: "budget_tokens", min: 1024 },
        ],
        tool_call: true,
        temperature: true,
        limit: { context: 1000000, output: 128000 },
        provider: { npm: "@ai-sdk/anthropic" },
      },
      "qwen3.6-plus": {
        name: "Qwen3.6 Plus",
        reasoning: true,
        reasoning_options: [{ type: "toggle" }, { type: "budget_tokens", max: 81920 }],
        tool_call: true,
        temperature: true,
        limit: { context: 262144, output: 65536 },
        provider: { npm: "@ai-sdk/anthropic" },
      },
      "deepseek-v4-flash": {
        name: "DeepSeek V4 Flash",
        reasoning: true,
        reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
        tool_call: true,
        interleaved: { field: "reasoning_content" },
        temperature: true,
        limit: { context: 1000000, output: 384000 },
      },
    },
  },
  "cloudflare-workers-ai": {
    npm: "@ai-sdk/openai-compatible",
    api: "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1",
    models: {
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast": {
        name: "Llama 3.3 70B Instruct fp8 Fast",
        reasoning: false,
        tool_call: true,
        temperature: true,
        limit: { context: 24000, output: 24000 },
      },
    },
  },
}

const catalog = modelCatalogFromBodies({ chat: encodeExternalJson(payload), decision: "{}" })

// ── drivers ─────────────────────────────────────────────────────────────────

const hostCrypto = Effect.service(Crypto.Crypto).pipe(Effect.provide(BunCrypto.layer))

const apiKey = (metadata?: Record<string, string>): ProviderAuthInfo =>
  ProviderAuthInfoSchema.cases.Api.make({ key: "test-key", ...(metadata && { metadata }) })

interface Route {
  readonly label: string
  /** The models.dev provider the route's models come from. */
  readonly provider: string
  readonly driver: ModelDriverContribution
  readonly auth: ProviderAuthInfo
}

/** Each driver on its API-key path, as setup builds it. */
const routes = Effect.gen(function* () {
  const crypto = yield* hostCrypto
  const openAiCell =
    yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL)
  const anthropicCell =
    yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL)
  const anthropicServices = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
  >().pipe(
    Effect.map(
      Context.add(
        AnthropicPlatform,
        AnthropicPlatform.of({ platform: "linux", home: "/nonexistent/gent-test-home", env: {} }),
      ),
    ),
    Effect.provide(BunServices.layer),
  )
  const routes: ReadonlyArray<Route> = [
    {
      label: "openai",
      provider: "openai",
      driver: buildOpenAIModelDriver(openAiCell, new Map(), Option.none(), crypto),
      auth: apiKey(),
    },
    {
      label: "anthropic",
      provider: "anthropic",
      driver: buildAnthropicModelDriver(anthropicCell, Option.none(), anthropicServices, "1h"),
      auth: apiKey(),
    },
    {
      label: "opencode",
      provider: "opencode",
      driver: buildOpenCodeModelDriver(OPENCODE_GATEWAYS.zen, Option.none(), crypto),
      auth: apiKey(),
    },
    {
      label: "cloudflare",
      provider: "cloudflare-workers-ai",
      driver: buildCloudflareModelDriver({
        token: Option.none(),
        accountId: Option.none(),
        gatewayId: Option.none(),
      }),
      auth: apiKey({ accountId: "acct-1" }),
    },
  ]
  return routes
})

// ── hints ───────────────────────────────────────────────────────────────────

/** The hints the loop sends: a turn, a turn with a temperature, the compaction summary, two levels. */
const HINTS: ReadonlyArray<readonly [string, (reasons: boolean) => ProviderHints]> = [
  ["turn", (reasons) => ({ cacheKey: "session-1", supportsReasoning: reasons })],
  ["temp", (reasons) => ({ temperature: 0.3, cacheKey: "session-1", supportsReasoning: reasons })],
  ["none", (reasons) => ({ reasoning: "none", maxTokens: 768, supportsReasoning: reasons })],
  [
    "medium",
    (reasons) => ({ reasoning: "medium", cacheKey: "session-1", supportsReasoning: reasons }),
  ],
  ["max", (reasons) => ({ reasoning: "max", cacheKey: "session-1", supportsReasoning: reasons })],
]

const PROMPT: Prompt.RawInput = [
  { role: "system", content: "You are terse." },
  { role: "user", content: "hi" },
]

// ── projection ──────────────────────────────────────────────────────────────

const decodeBody = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))
const isObject = Schema.is(Schema.Record(Schema.String, Schema.Json))
const isList = Schema.is(Schema.Array(Schema.Json))

/** The conversation and the constant fields; what is left is what a planner decides. */
const CONVERSATION = new Set([
  "input",
  "messages",
  "system",
  "tools",
  "tool_choice",
  "model",
  "stream",
  "stream_options",
])

/** The value with each object's keys sorted, so a line does not move with key order. */
const sorted = (value: Schema.Json): Schema.Json => {
  if (isList(value)) return value.map(sorted)
  if (!isObject(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .flatMap((key) =>
        Option.toArray(
          Option.map(Option.fromUndefinedOr(value[key]), (item) => [key, sorted(item)] as const),
        ),
      ),
  )
}

/** Every `cache_control` in the body, as `path=ttl` (`-` for none named). */
const cacheMarkers = (value: Schema.Json, path: string): ReadonlyArray<string> => {
  if (isList(value)) return value.flatMap((item, index) => cacheMarkers(item, `${path}.${index}`))
  if (!isObject(value)) return []
  const own = Option.match(
    Option.filter(Option.fromUndefinedOr(value["cache_control"]), isObject),
    {
      onNone: () => [],
      onSome: (marker) => [
        `${path}=${Option.getOrElse(Option.filter(Option.fromUndefinedOr(marker["ttl"]), Predicate.isString), () => "-")}`,
      ],
    },
  )
  return [
    ...own,
    ...Object.entries(value)
      .filter(([key]) => key !== "cache_control")
      .flatMap(([key, item]) => cacheMarkers(item, `${path}.${key}`)),
  ]
}

/** A request id the driver draws itself; the line names that it is one, not its value. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

const line = (label: string, request: CapturedRequest): string => {
  const body = decodeBody(request.body ?? "{}")
  if (!isObject(body)) return `${label}: <no JSON body>`
  const planned = Object.fromEntries(Object.entries(body).filter(([key]) => !CONVERSATION.has(key)))
  const markers = cacheMarkers(body, "").map((marker) => marker.slice(1))
  const beta = request.headers["anthropic-beta"] ?? "-"
  const fields = encodeExternalJson(sorted(planned)).replace(UUID, "<uuid>")
  return `${label}: ${fields} cache=[${markers.join(" ")}] beta=${beta}`
}

/** One request through the route, captured and refused, so nothing past the body matters. */
const captureRequest = (
  route: Route,
  modelName: string,
  hints: ProviderHints,
  prompt: Prompt.RawInput = PROMPT,
) =>
  Effect.gen(function* () {
    const state = makeFakeFetchState()
    const fetch = fakeFetchLayer(state, () => ({
      status: 400,
      body: '{"error":{"message":"pinned"}}',
    }))
    yield* Effect.exit(
      resolveShipped(
        route.driver,
        catalog,
        modelName,
        Option.some(route.auth),
        Option.some(hints),
      ).pipe(
        Effect.flatMap((model) =>
          LanguageModel.generateText({ prompt }).pipe(
            Effect.provide(Layer.provideMerge(model, fetch)),
          ),
        ),
        Effect.scoped,
      ),
    )
    return Option.fromUndefinedOr(state.captured[0])
  })

const requestLine = (route: Route, modelName: string, label: string, hints: ProviderHints) =>
  Effect.map(captureRequest(route, modelName, hints), (request) =>
    Option.match(request, {
      onNone: () => `${label}: <no request>`,
      onSome: (captured) => line(label, captured),
    }),
  )

const matrix = Effect.gen(function* () {
  const lines: Array<string> = []
  for (const route of yield* routes) {
    const provider = Option.getOrThrow(catalog.provider(route.provider))
    for (const entry of provider.models) {
      for (const [hintLabel, hints] of HINTS) {
        lines.push(
          yield* requestLine(
            route,
            entry.id,
            `${route.label} ${entry.id} ${hintLabel}`,
            hints(entry.reasoning === true),
          ),
        )
      }
    }
  }
  return lines
})

// ── pins ────────────────────────────────────────────────────────────────────

const PINNED = [
  'openai gpt-5.5-pro turn: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'openai gpt-5.5-pro temp: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'openai gpt-5.5-pro none: {"include":["reasoning.encrypted_content"],"max_output_tokens":768,"reasoning":{"effort":"medium","summary":"auto"},"store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'openai gpt-5.5-pro medium: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","reasoning":{"effort":"medium","summary":"auto"},"store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'openai gpt-5.5-pro max: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","reasoning":{"effort":"xhigh","summary":"auto"},"store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'openai gpt-5.3-codex turn: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","store":false,"text":{"format":{"type":"text"}}} cache=[] beta=-',
  'openai gpt-5.3-codex temp: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","store":false,"text":{"format":{"type":"text"}}} cache=[] beta=-',
  'openai gpt-5.3-codex none: {"include":["reasoning.encrypted_content"],"max_output_tokens":768,"reasoning":{"effort":"none","summary":"auto"},"store":false,"text":{"format":{"type":"text"}}} cache=[] beta=-',
  'openai gpt-5.3-codex medium: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","reasoning":{"effort":"medium","summary":"auto"},"store":false,"text":{"format":{"type":"text"}}} cache=[] beta=-',
  'openai gpt-5.3-codex max: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","reasoning":{"effort":"xhigh","summary":"auto"},"store":false,"text":{"format":{"type":"text"}}} cache=[] beta=-',
  'openai gpt-6.1-sol turn: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'openai gpt-6.1-sol temp: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'openai gpt-6.1-sol none: {"include":["reasoning.encrypted_content"],"max_output_tokens":768,"reasoning":{"effort":"none","summary":"auto"},"store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'openai gpt-6.1-sol medium: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","reasoning":{"effort":"medium","summary":"auto"},"store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'openai gpt-6.1-sol max: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","reasoning":{"effort":"max","summary":"auto"},"store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'openai gpt-5.1 turn: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'openai gpt-5.1 temp: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'openai gpt-5.1 none: {"include":["reasoning.encrypted_content"],"max_output_tokens":768,"reasoning":{"effort":"none","summary":"auto"},"store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'openai gpt-5.1 medium: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","reasoning":{"effort":"medium","summary":"auto"},"store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'openai gpt-5.1 max: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","reasoning":{"effort":"high","summary":"auto"},"store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'openai gpt-4.1 turn: {"prompt_cache_key":"session-1","store":false,"text":{"format":{"type":"text"}}} cache=[] beta=-',
  'openai gpt-4.1 temp: {"prompt_cache_key":"session-1","store":false,"temperature":0.3,"text":{"format":{"type":"text"}}} cache=[] beta=-',
  'openai gpt-4.1 none: {"max_output_tokens":768,"store":false,"text":{"format":{"type":"text"}}} cache=[] beta=-',
  'openai gpt-4.1 medium: {"prompt_cache_key":"session-1","store":false,"text":{"format":{"type":"text"}}} cache=[] beta=-',
  'openai gpt-4.1 max: {"prompt_cache_key":"session-1","store":false,"text":{"format":{"type":"text"}}} cache=[] beta=-',
  'openai o3 turn: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","store":false,"text":{"format":{"type":"text"}}} cache=[] beta=-',
  'openai o3 temp: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","store":false,"text":{"format":{"type":"text"}}} cache=[] beta=-',
  'openai o3 none: {"include":["reasoning.encrypted_content"],"max_output_tokens":768,"reasoning":{"effort":"low","summary":"auto"},"store":false,"text":{"format":{"type":"text"}}} cache=[] beta=-',
  'openai o3 medium: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","reasoning":{"effort":"medium","summary":"auto"},"store":false,"text":{"format":{"type":"text"}}} cache=[] beta=-',
  'openai o3 max: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","reasoning":{"effort":"high","summary":"auto"},"store":false,"text":{"format":{"type":"text"}}} cache=[] beta=-',
  'openai gpt-5 turn: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'openai gpt-5 temp: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'openai gpt-5 none: {"include":["reasoning.encrypted_content"],"max_output_tokens":768,"reasoning":{"effort":"minimal","summary":"auto"},"store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'openai gpt-5 medium: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","reasoning":{"effort":"medium","summary":"auto"},"store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'openai gpt-5 max: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","reasoning":{"effort":"high","summary":"auto"},"store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'openai gpt-6-sol turn: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'openai gpt-6-sol temp: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'openai gpt-6-sol none: {"include":["reasoning.encrypted_content"],"max_output_tokens":768,"reasoning":{"effort":"none","summary":"auto"},"store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'openai gpt-6-sol medium: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","reasoning":{"effort":"medium","summary":"auto"},"store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'openai gpt-6-sol max: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","reasoning":{"effort":"max","summary":"auto"},"store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'anthropic claude-haiku-4-5 turn: {"max_tokens":64000} cache=[messages.0.content.0=1h system.0=1h] beta=-',
  'anthropic claude-haiku-4-5 temp: {"max_tokens":64000,"temperature":0.3} cache=[messages.0.content.0=1h system.0=1h] beta=-',
  'anthropic claude-haiku-4-5 none: {"max_tokens":768} cache=[] beta=-',
  'anthropic claude-haiku-4-5 medium: {"max_tokens":64000,"thinking":{"budget_tokens":16000,"type":"enabled"}} cache=[messages.0.content.0=1h system.0=1h] beta=-',
  'anthropic claude-haiku-4-5 max: {"max_tokens":64000,"thinking":{"budget_tokens":31999,"type":"enabled"}} cache=[messages.0.content.0=1h system.0=1h] beta=-',
  'anthropic claude-opus-4-5 turn: {"max_tokens":64000} cache=[messages.0.content.0=1h system.0=1h] beta=-',
  'anthropic claude-opus-4-5 temp: {"max_tokens":64000,"temperature":0.3} cache=[messages.0.content.0=1h system.0=1h] beta=-',
  'anthropic claude-opus-4-5 none: {"max_tokens":768} cache=[] beta=-',
  'anthropic claude-opus-4-5 medium: {"max_tokens":64000,"output_config":{"effort":"medium"},"thinking":{"budget_tokens":16000,"type":"enabled"}} cache=[messages.0.content.0=1h system.0=1h] beta=-',
  'anthropic claude-opus-4-5 max: {"max_tokens":64000,"output_config":{"effort":"high"},"thinking":{"budget_tokens":31999,"type":"enabled"}} cache=[messages.0.content.0=1h system.0=1h] beta=-',
  'anthropic claude-sonnet-4-5 turn: {"max_tokens":64000} cache=[messages.0.content.0=1h system.0=1h] beta=-',
  'anthropic claude-sonnet-4-5 temp: {"max_tokens":64000,"temperature":0.3} cache=[messages.0.content.0=1h system.0=1h] beta=-',
  'anthropic claude-sonnet-4-5 none: {"max_tokens":768} cache=[] beta=-',
  'anthropic claude-sonnet-4-5 medium: {"max_tokens":64000,"thinking":{"budget_tokens":16000,"type":"enabled"}} cache=[messages.0.content.0=1h system.0=1h] beta=-',
  'anthropic claude-sonnet-4-5 max: {"max_tokens":64000,"thinking":{"budget_tokens":31999,"type":"enabled"}} cache=[messages.0.content.0=1h system.0=1h] beta=-',
  'anthropic claude-opus-5 turn: {"max_tokens":128000,"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=1h system.0=1h] beta=thinking-binding-controls-2026-08-01',
  'anthropic claude-opus-5 temp: {"max_tokens":128000,"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=1h system.0=1h] beta=thinking-binding-controls-2026-08-01',
  'anthropic claude-opus-5 none: {"max_tokens":768,"thinking":{"type":"disabled"}} cache=[] beta=-',
  'anthropic claude-opus-5 medium: {"max_tokens":128000,"output_config":{"effort":"medium"},"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=1h system.0=1h] beta=thinking-binding-controls-2026-08-01',
  'anthropic claude-opus-5 max: {"max_tokens":128000,"output_config":{"effort":"max"},"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=1h system.0=1h] beta=thinking-binding-controls-2026-08-01',
  'anthropic claude-fable-5 turn: {"max_tokens":128000,"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=1h system.0=1h] beta=thinking-binding-controls-2026-08-01',
  'anthropic claude-fable-5 temp: {"max_tokens":128000,"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=1h system.0=1h] beta=thinking-binding-controls-2026-08-01',
  'anthropic claude-fable-5 none: {"max_tokens":768,"output_config":{"effort":"low"}} cache=[] beta=-',
  'anthropic claude-fable-5 medium: {"max_tokens":128000,"output_config":{"effort":"medium"},"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=1h system.0=1h] beta=thinking-binding-controls-2026-08-01',
  'anthropic claude-fable-5 max: {"max_tokens":128000,"output_config":{"effort":"max"},"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=1h system.0=1h] beta=thinking-binding-controls-2026-08-01',
  'anthropic claude-fable-5-1 turn: {"max_tokens":128000,"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=1h system.0=1h] beta=thinking-binding-controls-2026-08-01',
  'anthropic claude-fable-5-1 temp: {"max_tokens":128000,"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=1h system.0=1h] beta=thinking-binding-controls-2026-08-01',
  'anthropic claude-fable-5-1 none: {"max_tokens":768,"output_config":{"effort":"low"}} cache=[] beta=-',
  'anthropic claude-fable-5-1 medium: {"max_tokens":128000,"output_config":{"effort":"medium"},"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=1h system.0=1h] beta=thinking-binding-controls-2026-08-01',
  'anthropic claude-fable-5-1 max: {"max_tokens":128000,"output_config":{"effort":"max"},"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=1h system.0=1h] beta=thinking-binding-controls-2026-08-01',
  'anthropic claude-opus-5-5 turn: {"max_tokens":128000,"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=1h system.0=1h] beta=thinking-binding-controls-2026-08-01',
  'anthropic claude-opus-5-5 temp: {"max_tokens":128000,"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=1h system.0=1h] beta=thinking-binding-controls-2026-08-01',
  'anthropic claude-opus-5-5 none: {"max_tokens":768,"output_config":{"effort":"low"}} cache=[] beta=-',
  'anthropic claude-opus-5-5 medium: {"max_tokens":128000,"output_config":{"effort":"medium"},"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=1h system.0=1h] beta=thinking-binding-controls-2026-08-01',
  'anthropic claude-opus-5-5 max: {"max_tokens":128000,"output_config":{"effort":"max"},"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=1h system.0=1h] beta=thinking-binding-controls-2026-08-01',
  'anthropic claude-sonnet-5-5 turn: {"max_tokens":128000,"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=1h system.0=1h] beta=thinking-binding-controls-2026-08-01',
  'anthropic claude-sonnet-5-5 temp: {"max_tokens":128000,"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=1h system.0=1h] beta=thinking-binding-controls-2026-08-01',
  'anthropic claude-sonnet-5-5 none: {"max_tokens":768,"output_config":{"effort":"low"},"thinking":{"type":"between_tools"}} cache=[] beta=-',
  'anthropic claude-sonnet-5-5 medium: {"max_tokens":128000,"output_config":{"effort":"medium"},"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=1h system.0=1h] beta=thinking-binding-controls-2026-08-01',
  'anthropic claude-sonnet-5-5 max: {"max_tokens":128000,"output_config":{"effort":"max"},"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=1h system.0=1h] beta=thinking-binding-controls-2026-08-01',
  'anthropic claude-sonnet-5 turn: {"max_tokens":128000,"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=1h system.0=1h] beta=thinking-binding-controls-2026-08-01',
  'anthropic claude-sonnet-5 temp: {"max_tokens":128000,"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=1h system.0=1h] beta=thinking-binding-controls-2026-08-01',
  'anthropic claude-sonnet-5 none: {"max_tokens":768,"thinking":{"type":"disabled"}} cache=[] beta=-',
  'anthropic claude-sonnet-5 medium: {"max_tokens":128000,"output_config":{"effort":"medium"},"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=1h system.0=1h] beta=thinking-binding-controls-2026-08-01',
  'anthropic claude-sonnet-5 max: {"max_tokens":128000,"output_config":{"effort":"max"},"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=1h system.0=1h] beta=thinking-binding-controls-2026-08-01',
  'anthropic claude-opus-4-6 turn: {"max_tokens":128000} cache=[messages.0.content.0=1h system.0=1h] beta=-',
  'anthropic claude-opus-4-6 temp: {"max_tokens":128000,"temperature":0.3} cache=[messages.0.content.0=1h system.0=1h] beta=-',
  'anthropic claude-opus-4-6 none: {"max_tokens":768} cache=[] beta=-',
  'anthropic claude-opus-4-6 medium: {"max_tokens":128000,"output_config":{"effort":"medium"},"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=1h system.0=1h] beta=thinking-binding-controls-2026-08-01',
  'anthropic claude-opus-4-6 max: {"max_tokens":128000,"output_config":{"effort":"max"},"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=1h system.0=1h] beta=thinking-binding-controls-2026-08-01',
  'anthropic claude-opus-4-7 turn: {"max_tokens":128000} cache=[messages.0.content.0=1h system.0=1h] beta=-',
  'anthropic claude-opus-4-7 temp: {"max_tokens":128000} cache=[messages.0.content.0=1h system.0=1h] beta=-',
  'anthropic claude-opus-4-7 none: {"max_tokens":768} cache=[] beta=-',
  'anthropic claude-opus-4-7 medium: {"max_tokens":128000,"output_config":{"effort":"medium"},"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=1h system.0=1h] beta=thinking-binding-controls-2026-08-01',
  'anthropic claude-opus-4-7 max: {"max_tokens":128000,"output_config":{"effort":"max"},"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=1h system.0=1h] beta=thinking-binding-controls-2026-08-01',
  'opencode gpt-5.5-pro turn: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'opencode gpt-5.5-pro temp: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'opencode gpt-5.5-pro none: {"include":["reasoning.encrypted_content"],"max_output_tokens":768,"reasoning":{"effort":"medium","summary":"auto"},"store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'opencode gpt-5.5-pro medium: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","reasoning":{"effort":"medium","summary":"auto"},"store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'opencode gpt-5.5-pro max: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","reasoning":{"effort":"xhigh","summary":"auto"},"store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'opencode minimax-m3-free turn: {"max_tokens":128000} cache=[messages.0.content.0=5m system.0=5m] beta=-',
  'opencode minimax-m3-free temp: {"max_tokens":128000,"temperature":0.3} cache=[messages.0.content.0=5m system.0=5m] beta=-',
  'opencode minimax-m3-free none: {"max_tokens":768,"thinking":{"type":"disabled"}} cache=[] beta=-',
  'opencode minimax-m3-free medium: {"max_tokens":128000,"thinking":{"type":"adaptive"}} cache=[messages.0.content.0=5m system.0=5m] beta=-',
  'opencode minimax-m3-free max: {"max_tokens":128000,"thinking":{"type":"adaptive"}} cache=[messages.0.content.0=5m system.0=5m] beta=-',
  'opencode claude-opus-4-5 turn: {"max_tokens":64000} cache=[messages.0.content.0=5m system.0=5m] beta=-',
  'opencode claude-opus-4-5 temp: {"max_tokens":64000,"temperature":0.3} cache=[messages.0.content.0=5m system.0=5m] beta=-',
  'opencode claude-opus-4-5 none: {"max_tokens":768} cache=[] beta=-',
  'opencode claude-opus-4-5 medium: {"max_tokens":64000,"output_config":{"effort":"medium"},"thinking":{"budget_tokens":16000,"type":"enabled"}} cache=[messages.0.content.0=5m system.0=5m] beta=-',
  'opencode claude-opus-4-5 max: {"max_tokens":64000,"output_config":{"effort":"high"},"thinking":{"budget_tokens":31999,"type":"enabled"}} cache=[messages.0.content.0=5m system.0=5m] beta=-',
  "opencode glm-5 turn: {} cache=[] beta=-",
  "opencode glm-5 temp: {} cache=[] beta=-",
  'opencode glm-5 none: {"max_tokens":768} cache=[] beta=-',
  "opencode glm-5 medium: {} cache=[] beta=-",
  "opencode glm-5 max: {} cache=[] beta=-",
  "opencode kimi-k2.6 turn: {} cache=[] beta=-",
  "opencode kimi-k2.6 temp: {} cache=[] beta=-",
  'opencode kimi-k2.6 none: {"max_tokens":768} cache=[] beta=-',
  "opencode kimi-k2.6 medium: {} cache=[] beta=-",
  "opencode kimi-k2.6 max: {} cache=[] beta=-",
  'opencode claude-sonnet-4-5 turn: {"max_tokens":64000} cache=[messages.0.content.0=5m system.0=5m] beta=-',
  'opencode claude-sonnet-4-5 temp: {"max_tokens":64000,"temperature":0.3} cache=[messages.0.content.0=5m system.0=5m] beta=-',
  'opencode claude-sonnet-4-5 none: {"max_tokens":768} cache=[] beta=-',
  'opencode claude-sonnet-4-5 medium: {"max_tokens":64000,"thinking":{"budget_tokens":16000,"type":"enabled"}} cache=[messages.0.content.0=5m system.0=5m] beta=-',
  'opencode claude-sonnet-4-5 max: {"max_tokens":64000,"thinking":{"budget_tokens":31999,"type":"enabled"}} cache=[messages.0.content.0=5m system.0=5m] beta=-',
  'opencode gpt-6.1-sol turn: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'opencode gpt-6.1-sol temp: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'opencode gpt-6.1-sol none: {"include":["reasoning.encrypted_content"],"max_output_tokens":768,"reasoning":{"effort":"low","summary":"auto"},"store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'opencode gpt-6.1-sol medium: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","reasoning":{"effort":"medium","summary":"auto"},"store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'opencode gpt-6.1-sol max: {"include":["reasoning.encrypted_content"],"prompt_cache_key":"session-1","reasoning":{"effort":"max","summary":"auto"},"store":false,"text":{"format":{"type":"text"},"verbosity":"low"}} cache=[] beta=-',
  'opencode claude-opus-5 turn: {"max_tokens":128000,"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=5m system.0=5m] beta=thinking-binding-controls-2026-08-01',
  'opencode claude-opus-5 temp: {"max_tokens":128000,"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=5m system.0=5m] beta=thinking-binding-controls-2026-08-01',
  'opencode claude-opus-5 none: {"max_tokens":768,"thinking":{"type":"disabled"}} cache=[] beta=-',
  'opencode claude-opus-5 medium: {"max_tokens":128000,"output_config":{"effort":"medium"},"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=5m system.0=5m] beta=thinking-binding-controls-2026-08-01',
  'opencode claude-opus-5 max: {"max_tokens":128000,"output_config":{"effort":"max"},"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=5m system.0=5m] beta=thinking-binding-controls-2026-08-01',
  'opencode claude-opus-4-6 turn: {"max_tokens":128000} cache=[messages.0.content.0=5m system.0=5m] beta=-',
  'opencode claude-opus-4-6 temp: {"max_tokens":128000,"temperature":0.3} cache=[messages.0.content.0=5m system.0=5m] beta=-',
  'opencode claude-opus-4-6 none: {"max_tokens":768} cache=[] beta=-',
  'opencode claude-opus-4-6 medium: {"max_tokens":128000,"output_config":{"effort":"medium"},"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=5m system.0=5m] beta=thinking-binding-controls-2026-08-01',
  'opencode claude-opus-4-6 max: {"max_tokens":128000,"output_config":{"effort":"max"},"thinking":{"block_binding":{"prefix_mismatch_behavior":"drop_block"},"display":"summarized","type":"adaptive"}} cache=[messages.0.content.0=5m system.0=5m] beta=thinking-binding-controls-2026-08-01',
  'opencode qwen3.6-plus turn: {"max_tokens":128000} cache=[messages.0.content.0=5m system.0=5m] beta=-',
  'opencode qwen3.6-plus temp: {"max_tokens":128000,"temperature":0.3} cache=[messages.0.content.0=5m system.0=5m] beta=-',
  'opencode qwen3.6-plus none: {"max_tokens":768,"thinking":{"type":"disabled"}} cache=[] beta=-',
  'opencode qwen3.6-plus medium: {"max_tokens":128000,"thinking":{"budget_tokens":16000,"type":"enabled"}} cache=[messages.0.content.0=5m system.0=5m] beta=-',
  'opencode qwen3.6-plus max: {"max_tokens":128000,"thinking":{"budget_tokens":31999,"type":"enabled"}} cache=[messages.0.content.0=5m system.0=5m] beta=-',
  "opencode deepseek-v4-flash turn: {} cache=[] beta=-",
  "opencode deepseek-v4-flash temp: {} cache=[] beta=-",
  'opencode deepseek-v4-flash none: {"max_tokens":768,"reasoning_effort":"low"} cache=[] beta=-',
  'opencode deepseek-v4-flash medium: {"reasoning_effort":"high"} cache=[] beta=-',
  'opencode deepseek-v4-flash max: {"reasoning_effort":"max"} cache=[] beta=-',
  "cloudflare @cf/meta/llama-3.3-70b-instruct-fp8-fast turn: {} cache=[] beta=-",
  'cloudflare @cf/meta/llama-3.3-70b-instruct-fp8-fast temp: {"temperature":0.3} cache=[] beta=-',
  'cloudflare @cf/meta/llama-3.3-70b-instruct-fp8-fast none: {"max_tokens":768} cache=[] beta=-',
  "cloudflare @cf/meta/llama-3.3-70b-instruct-fp8-fast medium: {} cache=[] beta=-",
  "cloudflare @cf/meta/llama-3.3-70b-instruct-fp8-fast max: {} cache=[] beta=-",
]

describe("request bodies", () => {
  it.live("each driver sends the pinned body for each model and hint", () =>
    Effect.gen(function* () {
      expect(yield* matrix).toEqual(PINNED)
    }).pipe(Effect.timeout("60 seconds")),
  )
})

// ── effort changes ──────────────────────────────────────────────────────────

/**
 * One session's conversation, whole: a tool step, a text step, then a second
 * user turn. Request `n` sends the first `PREFIXES[n]` messages.
 */
const SESSION: Prompt.RawInput = [
  { role: "system", content: "You are terse." },
  { role: "user", content: "Read a.txt." },
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        id: "call_read",
        name: "read",
        params: { path: "a.txt" },
        providerExecuted: false,
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        id: "call_read",
        name: "read",
        result: "alpha",
        isFailure: false,
        providerExecuted: false,
      },
    ],
  },
  { role: "assistant", content: [{ type: "text", text: "It says alpha." }] },
  { role: "user", content: "Thanks." },
]

const sessionPrompt = (messages: number): Prompt.RawInput =>
  Prompt.make(SESSION).content.slice(0, messages)

/**
 * The session's three requests: the first step at `low`, the second at
 * `high` after the tool result, the third at `low` after the user's turn.
 * Each request names the effort every earlier assistant run was sent at.
 */
const SESSION_REQUESTS: ReadonlyArray<{
  readonly messages: number
  readonly reasoning: ReasoningEffort
  readonly history: ReadonlyArray<Option.Option<ReasoningEffort>>
}> = [
  { messages: 2, reasoning: "low", history: [] },
  { messages: 4, reasoning: "high", history: [Option.some("low")] },
  { messages: 6, reasoning: "low", history: [Option.some("low"), Option.some("high")] },
]

const sessionHints = (
  reasoning: ReasoningEffort,
  history: ReadonlyArray<Option.Option<ReasoningEffort>>,
): ProviderHints => ({
  reasoning,
  cacheKey: "session-1",
  supportsReasoning: true,
  reasoningHistory: history,
})

const routeNamed = (label: string) =>
  Effect.map(routes, (all) =>
    Option.getOrThrow(Option.fromUndefinedOr(all.find((route) => route.label === label))),
  )

/** The captured request's JSON body; a request with none fails the test. */
const bodyOf = (request: Option.Option<CapturedRequest>): Schema.JsonObject =>
  Option.getOrThrow(
    Option.filter(Option.some(decodeBody(Option.getOrThrow(request).body ?? "{}")), isObject),
  )

/** The value without its `cache_control` fields: a marker moves with the tail, and the cache matches the content. */
const withoutCacheMarkers = (value: Schema.Json): Schema.Json => {
  if (isList(value)) return value.map(withoutCacheMarkers)
  if (!isObject(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "cache_control")
      .map(([key, item]) => [key, withoutCacheMarkers(item)] as const),
  )
}

/** The body's conversation: Messages `messages`, Responses `input`. */
const conversationOf = (body: Schema.JsonObject): Array<Schema.Json> => {
  const items = body["messages"] ?? body["input"]
  if (Predicate.isUndefined(items) || !isList(items)) return []
  return items.map(withoutCacheMarkers)
}

/** The body outside its conversation, without cache markers. */
const topLevelOf = (body: Schema.JsonObject): Schema.Json =>
  withoutCacheMarkers(
    Object.fromEntries(
      Object.entries(body).filter(([key]) => key !== "messages" && key !== "input"),
    ),
  )

/** Each conversation item by its role or type; an effort marker as `effort:<level>`. */
const itemKinds = (body: Schema.JsonObject): ReadonlyArray<string> =>
  conversationOf(body).map((item) => {
    if (!isObject(item)) return "?"
    const config = item["output_config"] ?? item["reasoning"]
    if (isObject(config) && Predicate.isString(config["effort"]))
      return `effort:${config["effort"]}`
    const role = item["role"]
    if (Predicate.isString(role)) return role
    const type = item["type"]
    if (Predicate.isString(type)) return type
    return "?"
  })

/** The effort the body's top level names. */
const topLevelEffort = (body: Schema.JsonObject): string => {
  const config = body["output_config"] ?? body["reasoning"]
  if (isObject(config) && Predicate.isString(config["effort"])) return config["effort"]
  return "-"
}

const sessionBodies = (label: string, modelName: string) =>
  Effect.gen(function* () {
    const route = yield* routeNamed(label)
    const requests: Array<CapturedRequest> = []
    for (const step of SESSION_REQUESTS) {
      const request = yield* captureRequest(
        route,
        modelName,
        sessionHints(step.reasoning, step.history),
        sessionPrompt(step.messages),
      )
      requests.push(Option.getOrThrow(request))
    }
    return requests
  })

/** The same request with the effort history and without it. */
const withAndWithoutHistory = (
  label: string,
  modelName: string,
  hints: ProviderHints,
  messages: number,
) =>
  Effect.gen(function* () {
    const route = yield* routeNamed(label)
    const { reasoningHistory: _history, ...plain } = hints
    const carried = yield* captureRequest(route, modelName, hints, sessionPrompt(messages))
    const without = yield* captureRequest(route, modelName, plain, sessionPrompt(messages))
    return [bodyOf(carried), bodyOf(without)] as const
  })

const MID_CONVERSATION_BETA = "mid-conversation-output-config-2026-07-01"

/** The models whose requests carry an effort change inside the conversation. */
const CARRYING: ReadonlyArray<readonly [string, string, ReadonlyArray<string>]> = [
  ...["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"].map(
    (model) =>
      [
        "anthropic",
        model,
        ["user", "assistant", "user", "effort:high", "assistant", "effort:low", "user"],
      ] as const,
  ),
  [
    "openai",
    "gpt-6.1-sol",
    [
      "system",
      "user",
      "function_call",
      "function_call_output",
      "effort:high",
      "assistant",
      "user",
      "effort:low",
    ],
  ],
]

describe("effort changes", () => {
  it.live("an effort change keeps every byte the earlier request sent", () =>
    Effect.gen(function* () {
      for (const [label, modelName, kinds] of CARRYING) {
        const bodies = (yield* sessionBodies(label, modelName)).map((request) =>
          bodyOf(Option.some(request)),
        )
        const at = (index: number) => Option.getOrThrow(Option.fromUndefinedOr(bodies[index]))
        const first = at(0)
        const second = at(1)
        const third = at(2)
        expect([modelName, ...bodies.map(topLevelEffort)]).toEqual([modelName, "low", "low", "low"])
        expect([modelName, topLevelOf(second), topLevelOf(third)]).toEqual([
          modelName,
          topLevelOf(first),
          topLevelOf(first),
        ])
        const earlier = conversationOf(first)
        expect([modelName, conversationOf(second).slice(0, earlier.length)]).toEqual([
          modelName,
          earlier,
        ])
        const middle = conversationOf(second)
        expect([modelName, conversationOf(third).slice(0, middle.length)]).toEqual([
          modelName,
          middle,
        ])
        expect([modelName, itemKinds(third)]).toEqual([modelName, kinds])
      }
    }).pipe(Effect.timeout("30 seconds")),
  )

  it.live("a Messages request names the effort beta only when it carries an effort marker", () =>
    Effect.gen(function* () {
      const requests = yield* sessionBodies("anthropic", "claude-fable-5-1")
      expect(
        requests.map((request) =>
          (request.headers["anthropic-beta"] ?? "").split(",").includes(MID_CONVERSATION_BETA),
        ),
      ).toEqual([false, true, true])
    }).pipe(Effect.timeout("30 seconds")),
  )

  it.live("the conversation's cache marker skips an effort marker at the tail", () =>
    Effect.gen(function* () {
      const requests = yield* sessionBodies("anthropic", "claude-fable-5-1")
      const second = Option.getOrThrow(Option.fromUndefinedOr(requests[1]))
      expect(itemKinds(bodyOf(Option.some(second)))).toEqual([
        "user",
        "assistant",
        "user",
        "effort:high",
      ])
      expect(line("tail", second)).toContain("cache=[messages.2.content.0=1h system.0=1h]")
    }).pipe(Effect.timeout("30 seconds")),
  )

  it.live("a model without per-message effort sends what it sends without a history", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, string]> = [
        ["anthropic", "claude-fable-5"],
        ["anthropic", "claude-opus-4-6"],
        ["anthropic", "claude-sonnet-5"],
        ["openai", "gpt-5.5-pro"],
        ["openai", "gpt-5.1"],
        ["opencode", "claude-opus-5"],
        ["opencode", "gpt-6.1-sol"],
      ]
      for (const [label, modelName] of cases) {
        const [carried, without] = yield* withAndWithoutHistory(
          label,
          modelName,
          sessionHints("low", [Option.some("low"), Option.some("high")]),
          6,
        )
        expect([label, modelName, carried]).toEqual([label, modelName, without])
      }
    }).pipe(Effect.timeout("30 seconds")),
  )

  it.live("an effort history the request cannot carry sends the plain request", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, string, string, ProviderHints]> = [
        [
          "no cache key",
          "anthropic",
          "claude-fable-5-1",
          {
            reasoning: "low",
            supportsReasoning: true,
            reasoningHistory: [Option.some("low"), Option.some("high")],
          },
        ],
        [
          "no receipts",
          "anthropic",
          "claude-fable-5-1",
          sessionHints("low", [Option.none(), Option.none()]),
        ],
        [
          "no receipts",
          "openai",
          "gpt-6.1-sol",
          sessionHints("low", [Option.none(), Option.none()]),
        ],
        [
          "runs not aligned",
          "anthropic",
          "claude-fable-5-1",
          sessionHints("low", [Option.some("high")]),
        ],
        ["runs not aligned", "openai", "gpt-6.1-sol", sessionHints("low", [Option.some("high")])],
        [
          "thinking turned off",
          "anthropic",
          "claude-opus-5",
          sessionHints("high", [Option.some("none"), Option.some("high")]),
        ],
        [
          "thinking between tools",
          "anthropic",
          "claude-sonnet-5-5",
          sessionHints("high", [Option.some("none"), Option.some("high")]),
        ],
      ]
      for (const [reason, label, modelName, hints] of cases) {
        const [carried, without] = yield* withAndWithoutHistory(label, modelName, hints, 6)
        expect([reason, modelName, carried]).toEqual([reason, modelName, without])
      }
    }).pipe(Effect.timeout("30 seconds")),
  )
})
