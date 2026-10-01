import { Crypto, Duration, Effect, Layer, Option, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { Model as AiModel } from "effect/ai"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import {
  OpenAiClient as OpenAiResponsesClient,
  OpenAiLanguageModel as OpenAiResponsesLanguageModel,
} from "@effect/ai-openai"
import {
  OpenAiClient as OpenAiChatClient,
  OpenAiLanguageModel as OpenAiChatLanguageModel,
} from "@effect/ai-openai-compat"
import {
  AuthMethod,
  DEFAULT_RETRY_POLICY,
  defineExtension,
  ExtensionHost,
  type ModelDriverContribution,
  ProviderAuthError,
  type ProviderAuthInfo,
  type ProviderHints,
} from "@gent/core/extensions/api"
import { type ClassifierEntry, classifierModel, typeSafeDecisionModel } from "./typesafe.js"
import {
  apiKeyFrom,
  type CatalogSource,
  catalogSource,
  driverListModels,
  driverModelWire,
  effortAtOrAbove,
  type ModelWire,
  type ReasoningOption,
  readOptionalEnv,
} from "./providers.js"

// Test seam: only tests read OPENCODE_GATEWAYS and buildOpenCodeModelDriver,
// which let a test run one gateway's driver against a fake fetch.

/**
 * OpenCode's model gateways: Zen (pay as you go) and Go (a subscription; Go
 * Plus is a higher tier of the same gateway, key and base URL). One driver
 * constructor serves both. A gateway serves each model over one of several
 * wire formats, and the models.dev catalog names it per model, so the driver
 * reads the format from the catalog entry and builds the matching Effect AI
 * model.
 *
 * Docs: opencode.ai/docs/go and opencode.ai/docs/zen (read 2026-10-01).
 */

// ── gateways ────────────────────────────────────────────────────────────────

interface Gateway {
  /** The driver id and the models.dev provider key. */
  readonly id: string
  /** The gateway's name in error messages. */
  readonly name: string
  /** The gateway root. The OpenAI paths live under `/v1`; the Anthropic SDK adds `/v1/messages` itself. */
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
  /** The classifier models (Jev) the gateway serves over TypeSafe's API; models.dev lists none. */
  readonly classifiers: ReadonlyArray<ClassifierEntry>
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
    // From Zen's own list, `https://opencode.ai/zen/v1/models` (read 2026-10-01),
    // priced per its docs: $0.042 per million input tokens, output free.
    // Zen serves no `jev-latest`.
    classifiers: [
      { name: "jev-1.13", label: "Jev 1.13", pricing: { input: 0.042, output: 0 } },
      { name: "jev-1.13-free", label: "Jev 1.13 (free)", pricing: { input: 0, output: 0 } },
    ],
  },
  go: {
    id: "opencode-go",
    name: "OpenCode Go",
    origin: "https://opencode.ai/zen/go",
    signInName: "OpenCode Go",
    authLabel: "OpenCode Go / Go Plus API key",
    credentialFrom: "opencode",
    classifiers: [],
  },
} satisfies Record<string, Gateway>

/** models.dev names this variable for both gateways. */
const ENV_CREDENTIAL = "OPENCODE_API_KEY"

/**
 * How long a prompt stays cached. The gateways do not say, and the upstreams
 * differ; 5 minutes is the shortest of them (an Anthropic `ephemeral` entry).
 */
const PROMPT_CACHE_TTL = Duration.minutes(5)

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

// ── wire format ─────────────────────────────────────────────────────────────

const WireFormat = Schema.Literals(["responses", "messages", "chat-completions"])
type WireFormat = typeof WireFormat.Type

/**
 * The wire format each AI SDK package that models.dev names speaks. A package
 * outside this map (the gateway's `@ai-sdk/google` models) has no Effect AI
 * client, so the driver lists none of its models and refuses to resolve one.
 */
const WIRE_FORMATS: ReadonlyMap<string, WireFormat> = new Map([
  ["@ai-sdk/openai", "responses"],
  ["@ai-sdk/anthropic", "messages"],
  ["@ai-sdk/openai-compatible", "chat-completions"],
])

const wireFormatOf = (wire: Option.Option<ModelWire>): Option.Option<WireFormat> =>
  wire.pipe(
    Option.flatMap((value) => Option.fromUndefinedOr(value.npm)),
    Option.flatMap((npm) => Option.fromUndefinedOr(WIRE_FORMATS.get(npm))),
  )

/** A model whose catalog entry names no wire format the driver speaks. */
class UnsupportedWireFormat extends Schema.TaggedError<UnsupportedWireFormat>(
  "@gent/extensions/src/opencode/UnsupportedWireFormat",
)("UnsupportedWireFormat", {
  message: Schema.String,
}) {}

const unsupportedWireFormat = (
  gateway: Gateway,
  modelName: string,
  wire: Option.Option<ModelWire>,
): UnsupportedWireFormat => {
  const npm = Option.flatMap(wire, (value) => Option.fromUndefinedOr(value.npm))
  return new UnsupportedWireFormat({
    message: Option.match(npm, {
      onNone: () => `${gateway.name} model "${modelName}" has no entry in the models.dev catalog`,
      onSome: (name) =>
        `${gateway.name} model "${modelName}" speaks the ${name} wire format, which gent does not support`,
    }),
  })
}

// ── reasoning ───────────────────────────────────────────────────────────────

/** Every effort level, lowest first; the catalog's `null` effort reads as `"none"`. */
const Effort = Schema.Literals(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
type Effort = typeof Effort.Type
const EFFORT_ORDER = Effort.literals
const decodeEffort = Schema.decodeUnknownOption(Effort)

/** The hint's level, when the model reasons, the catalog says so, and the request names one. */
const reasoningHint = (hints: Option.Option<ProviderHints>): Option.Option<Effort> =>
  hints.pipe(
    Option.filter((value) => value.supportsReasoning !== false),
    Option.flatMap((value) => decodeEffort(value.reasoning)),
  )

/** The model's reasoning controls; none when the catalog lists none. */
const reasoningOptions = (wire: Option.Option<ModelWire>): ReadonlyArray<ReasoningOption> =>
  Option.getOrElse(
    Option.flatMap(wire, (value) => Option.fromUndefinedOr(value.reasoningOptions)),
    () => [],
  )

/** The effort the request names: the lowest the model accepts at or above the hint, else its highest. */
const effortFor = (options: ReadonlyArray<ReasoningOption>, hint: Effort): Option.Option<Effort> =>
  Option.fromUndefinedOr(options.find((option) => option.type === "effort")).pipe(
    Option.flatMap((option) =>
      effortAtOrAbove(
        EFFORT_ORDER,
        EFFORT_ORDER.filter((level) => option.values.includes(level)),
        hint,
      ),
    ),
  )

const hasToggle = (options: ReadonlyArray<ReasoningOption>): boolean =>
  options.some((option) => option.type === "toggle")

/** OpenCode's own cap on a thinking budget (`OUTPUT_TOKEN_MAX - 1` in `provider/transform.ts`). */
const BUDGET_CEILING = 31_999

/**
 * The thinking budget for a hint, as OpenCode sets it (`budgetVariants`): the
 * most the model and the output cap allow for `xhigh` and `max`, half of that
 * (at least the model's minimum) for any other level. None when the cap
 * leaves less than the model's minimum.
 */
const thinkingBudget = (
  options: ReadonlyArray<ReasoningOption>,
  hint: Effort,
  maxTokens: Option.Option<number>,
): Option.Option<number> =>
  Option.fromUndefinedOr(options.find((option) => option.type === "budget_tokens")).pipe(
    Option.flatMap((option) => {
      const minimum = Option.getOrElse(Option.fromUndefinedOr(option.min), () => 1)
      const maximum = Math.min(
        Option.getOrElse(Option.fromUndefinedOr(option.max), () => BUDGET_CEILING),
        Option.getOrElse(
          Option.map(maxTokens, (cap) => cap - 1),
          () => BUDGET_CEILING,
        ),
        BUDGET_CEILING,
      )
      const high = Math.min(Math.max(minimum, Math.floor((maximum + 1) / 2)), maximum)
      let budget = high
      if (hint === "xhigh" || hint === "max") budget = maximum
      return Option.liftPredicate(budget, (value) => value >= minimum)
    }),
  )

// ── request bodies ──────────────────────────────────────────────────────────

const JsonBody = Schema.fromJsonString(Schema.Json)
const decodeJsonBody = Schema.decodeUnknownOption(JsonBody)
const isObject = Schema.is(Schema.JsonObject)
const isArray = Schema.is(Schema.Array(Schema.Json))
const isJsonObject = (value: Schema.Json): value is Schema.JsonObject => isObject(value)
const isJsonArray = (value: Schema.Json): value is Schema.JsonArray => isArray(value)
const isJsonString = Schema.is(Schema.String)

/** A field of a JSON object; none when it is absent. */
const field = (object: Schema.JsonObject, key: string): Option.Option<Schema.Json> =>
  Option.fromUndefinedOr(object[key])

/** The request's JSON object body; none for any other body. */
const requestJson = (
  request: HttpClientRequest.HttpClientRequest,
): Option.Option<Schema.JsonObject> => {
  if (request.body._tag !== "Uint8Array") return Option.none()
  return decodeJsonBody(new TextDecoder().decode(request.body.body)).pipe(
    Option.filter(isJsonObject),
  )
}

/** A client that rewrites each JSON request body with `rewrite`; any other body passes. */
const rewriteJsonBody =
  (rewrite: (body: Schema.JsonObject) => Schema.JsonObject) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    HttpClient.mapRequest(client, (request) =>
      Option.match(requestJson(request), {
        onNone: () => request,
        onSome: (body) => HttpClientRequest.bodyJsonUnsafe(request, rewrite(body)),
      }),
    )

/** The body's `messages`; none when it has no list there. */
const messagesOf = (body: Schema.JsonObject): Option.Option<ReadonlyArray<Schema.Json>> =>
  Option.filter(field(body, "messages"), isJsonArray)

// ── responses ───────────────────────────────────────────────────────────────

type ResponsesConfig = Required<Parameters<typeof OpenAiResponsesLanguageModel.layer>[0]>["config"]

/**
 * The Responses request: not stored, the session as the prompt cache key
 * (OpenCode sets `promptCacheKey` for its gateways), and the effort the
 * catalog accepts with a reasoning summary.
 */
const responsesConfig = (
  hints: Option.Option<ProviderHints>,
  wire: Option.Option<ModelWire>,
  sessionId: string,
): ResponsesConfig => {
  let config: ResponsesConfig = { store: false, prompt_cache_key: sessionId }
  const maxTokens = Option.flatMap(hints, (value) => Option.fromNullishOr(value.maxTokens))
  if (Option.isSome(maxTokens)) config = { ...config, max_output_tokens: maxTokens.value }
  const temperature = temperatureFor(hints)
  if (Option.isSome(temperature)) config = { ...config, temperature: temperature.value }
  const effort = Option.flatMap(reasoningHint(hints), (hint) =>
    effortFor(reasoningOptions(wire), hint),
  )
  if (Option.isSome(effort)) {
    config = { ...config, reasoning: { effort: effort.value, summary: "auto" } }
  }
  return config
}

/** A `temperature` goes only to a model the catalog says does not reason. */
const temperatureFor = (hints: Option.Option<ProviderHints>): Option.Option<number> =>
  hints.pipe(
    Option.filter((value) => value.supportsReasoning === false),
    Option.flatMap((value) => Option.fromNullishOr(value.temperature)),
  )

// ── chat completions ────────────────────────────────────────────────────────

type ChatConfig = NonNullable<Parameters<typeof OpenAiChatLanguageModel.layer>[0]["config"]>

/**
 * The Chat Completions request: `reasoning_effort` from the catalog's effort
 * list (OpenCode sends nothing for a toggle or a budget on this format), and
 * tools without strict schemas, which the OpenAI-compatible upstreams do not
 * all take. `replayReasoning` is the patched SDK's opt-in: the model's
 * reasoning goes back on its own assistant message (see `patches/README.md`).
 */
const chatConfig = (
  hints: Option.Option<ProviderHints>,
  wire: Option.Option<ModelWire>,
): ChatConfig => {
  let config: ChatConfig = { strictJsonSchema: false, replayReasoning: true }
  const maxTokens = Option.flatMap(hints, (value) => Option.fromNullishOr(value.maxTokens))
  if (Option.isSome(maxTokens)) config = { ...config, max_output_tokens: maxTokens.value }
  const temperature = temperatureFor(hints)
  if (Option.isSome(temperature)) config = { ...config, temperature: temperature.value }
  const effort = Option.flatMap(reasoningHint(hints), (hint) =>
    effortFor(reasoningOptions(wire), hint),
  )
  if (Option.isSome(effort)) config = { ...config, reasoning_effort: effort.value }
  return config
}

/**
 * The reasoning a model wrote goes back to it on its assistant message, in the
 * field its catalog entry names (`interleaved.field`). DeepSeek needs the field
 * on every assistant message, empty when it wrote none (OpenCode's
 * `normalizeMessages`). The patched SDK writes the text as `reasoning_content`;
 * a model without the field gets none.
 */
const reasoningInField =
  (reasoningField: Option.Option<string>) =>
  (body: Schema.JsonObject): Schema.JsonObject =>
    Option.match(messagesOf(body), {
      onNone: () => body,
      onSome: (messages) => ({
        ...body,
        messages: messages.map((message): Schema.Json => {
          if (!isJsonObject(message) || message["role"] !== "assistant") return message
          const { reasoning_content: written, ...rest } = message
          if (Option.isNone(reasoningField)) return rest
          const text = Option.getOrElse(
            Option.filter(Option.fromUndefinedOr(written), isJsonString),
            () => "",
          )
          return { ...rest, [reasoningField.value]: text }
        }),
      }),
    })

// ── messages ────────────────────────────────────────────────────────────────

type MessagesConfig = NonNullable<Parameters<typeof AnthropicLanguageModel.layer>[0]["config"]>

/** What a Messages request carries for reasoning: the thinking object and `output_config.effort`. */
interface MessagesPlan {
  readonly thinking: Option.Option<Schema.JsonObject>
  readonly effort: Option.Option<Effort>
}

const NO_PLAN: MessagesPlan = { thinking: Option.none(), effort: Option.none() }

/** A Claude model id's version, as OpenCode reads it: `claude-opus-4-6`, `claude-4.7-opus`. */
const CLAUDE_VERSION = /claude-(?:[a-z]+-)?(\d+)(?:[.-](\d{1,2}))?(?:[.@-]|$)/i
const CLAUDE_4_6 = ["opus-4-6", "opus-4.6", "4-6-opus", "4.6-opus", "sonnet-4-6", "sonnet-4.6"]
const CLAUDE_OPUS_4_5 = ["opus-4-5", "opus-4.5"]
const ADAPTIVE_SUMMARIZED: Schema.JsonObject = { type: "adaptive", display: "summarized" }

/** Claude 4.7 and later (or a Claude id with no readable version) thinks adaptively, and omits the text unless asked. */
const modernClaude = (modelName: string): boolean => {
  const id = modelName.toLowerCase()
  if (!id.includes("claude-")) return false
  return Option.match(Option.fromNullishOr(CLAUDE_VERSION.exec(id)), {
    onNone: () => true,
    onSome: (version) => {
      const major = Number(version[1])
      const minor = Number(version[2] ?? 0)
      return major > 4 || (major === 4 && minor >= 7)
    },
  })
}

/**
 * The thinking that goes with an effort on Messages, by model family, as
 * OpenCode's `anthropicEffort` picks it: adaptive for the Claude families
 * that think between tool calls (summarized from 4.7, whose default omits
 * the text; Kimi omits it too), a manual budget for Opus 4.5, and nothing
 * beside the effort for any other model.
 */
const effortThinking = (
  modelName: string,
  maxTokens: Option.Option<number>,
): Option.Option<Schema.JsonObject> => {
  const id = modelName.toLowerCase()
  if (CLAUDE_OPUS_4_5.some((name) => id.includes(name))) {
    const budget = Option.match(maxTokens, {
      onNone: () => 16_000,
      onSome: (cap) => Math.min(16_000, Math.floor(cap / 2 - 1)),
    })
    return Option.some({ type: "enabled", budget_tokens: budget })
  }
  if (id.includes("kimi") || id.includes("moonshot")) return Option.some(ADAPTIVE_SUMMARIZED)
  if (modernClaude(id)) return Option.some(ADAPTIVE_SUMMARIZED)
  if (CLAUDE_4_6.some((name) => id.includes(name))) return Option.some({ type: "adaptive" })
  return Option.none()
}

/**
 * The Messages reasoning plan, from the catalog's controls in OpenCode's
 * order (`reasoningVariants`, `anthropicEffort`):
 *
 * - `none`: a toggle turns thinking off; else the lowest effort.
 * - a level with an effort list: that effort, with the thinking its model
 *   family takes (`effortThinking`). A budget the model also lists is unused.
 * - a level with a budget and no effort list: thinking `enabled` with the
 *   budget.
 * - a level with only a toggle (MiniMax M3, which thinks only when asked):
 *   adaptive thinking.
 */
const messagesPlan = (
  modelName: string,
  hints: Option.Option<ProviderHints>,
  wire: Option.Option<ModelWire>,
): MessagesPlan => {
  const hint = reasoningHint(hints)
  if (Option.isNone(hint)) return NO_PLAN
  const options = reasoningOptions(wire)
  const effort = effortFor(options, hint.value)
  if (hint.value === "none") {
    if (hasToggle(options))
      return { thinking: Option.some({ type: "disabled" }), effort: Option.none() }
    return { thinking: Option.none(), effort }
  }
  const maxTokens = Option.flatMap(hints, (value) => Option.fromNullishOr(value.maxTokens))
  if (Option.isSome(effort)) return { thinking: effortThinking(modelName, maxTokens), effort }
  const budget = thinkingBudget(options, hint.value, maxTokens)
  if (Option.isSome(budget)) {
    return {
      thinking: Option.some({ type: "enabled", budget_tokens: budget.value }),
      effort,
    }
  }
  if (hasToggle(options)) return { thinking: Option.some({ type: "adaptive" }), effort }
  return NO_PLAN
}

const messagesConfig = (
  hints: Option.Option<ProviderHints>,
  plan: MessagesPlan,
): MessagesConfig => {
  let config: MessagesConfig = {}
  const maxTokens = Option.flatMap(hints, (value) => Option.fromNullishOr(value.maxTokens))
  if (Option.isSome(maxTokens)) config = { ...config, max_tokens: maxTokens.value }
  // Thinking rejects a `temperature`.
  const temperature = temperatureFor(hints)
  if (Option.isSome(temperature) && Option.isNone(plan.thinking)) {
    config = { ...config, temperature: temperature.value }
  }
  return config
}

/** The body with the plan's thinking and effort; any `output_config` the SDK set is kept. */
const planApplied =
  (plan: MessagesPlan) =>
  (body: Schema.JsonObject): Schema.JsonObject => {
    let result = body
    if (Option.isSome(plan.thinking)) result = { ...result, thinking: plan.thinking.value }
    if (Option.isSome(plan.effort)) {
      const outputConfig = Option.getOrElse(
        Option.filter(field(result, "output_config"), isJsonObject),
        (): Schema.JsonObject => ({}),
      )
      result = { ...result, output_config: { ...outputConfig, effort: plan.effort.value } }
    }
    return result
  }

/**
 * Prompt caching as OpenCode asks the gateway for it on this format
 * (`applyCaching` in `provider/transform.ts`): an `ephemeral` marker on the
 * first two system blocks and on the last block of each of the last two
 * messages, four markers, the Messages API's limit. A thinking block takes
 * no marker, so the last block that can carry one does.
 */
const CACHE_MARKER: Schema.JsonObject = { type: "ephemeral" }
const UNMARKABLE_BLOCKS: ReadonlySet<Schema.Json> = new Set(["thinking", "redacted_thinking"])

const markBlocks = (
  content: Schema.Json,
  pick: (blocks: ReadonlyArray<Schema.Json>) => ReadonlyArray<number>,
): Schema.Json => {
  let blocks: ReadonlyArray<Schema.Json> = []
  if (isJsonString(content)) blocks = [{ type: "text", text: content }]
  else if (isJsonArray(content)) blocks = content
  else return content
  const marked = new Set(pick(blocks))
  return blocks.map((block, index) => {
    if (!marked.has(index) || !isJsonObject(block)) return block
    return { ...block, cache_control: CACHE_MARKER }
  })
}

const isMarkable = (block: Schema.Json): boolean =>
  isJsonObject(block) && !Option.exists(field(block, "type"), (type) => UNMARKABLE_BLOCKS.has(type))

const lastMarkable = (blocks: ReadonlyArray<Schema.Json>): ReadonlyArray<number> => {
  const index = blocks.findLastIndex(isMarkable)
  if (index < 0) return []
  return [index]
}

const firstTwo = (blocks: ReadonlyArray<Schema.Json>): ReadonlyArray<number> =>
  [0, 1].filter((index) => index < blocks.length)

const cacheMarked = (body: Schema.JsonObject): Schema.JsonObject => {
  let result = body
  const system = field(body, "system")
  if (Option.isSome(system)) result = { ...result, system: markBlocks(system.value, firstTwo) }
  const messages = messagesOf(body)
  if (Option.isNone(messages)) return result
  const firstMarked = messages.value.length - 2
  return {
    ...result,
    messages: messages.value.map((message, index) => {
      if (index < firstMarked || !isJsonObject(message)) return message
      return Option.match(field(message, "content"), {
        onNone: () => message,
        onSome: (content) => ({ ...message, content: markBlocks(content, lastMarkable) }),
      })
    }),
  }
}

// ── driver ──────────────────────────────────────────────────────────────────

interface Resolution {
  readonly gateway: Gateway
  readonly modelName: string
  readonly apiKey: string
  readonly sessionId: string
  readonly hints: Option.Option<ProviderHints>
  readonly wire: Option.Option<ModelWire>
}

const responsesModel = (resolution: Resolution) => {
  const client = OpenAiResponsesClient.layer({
    apiKey: Redacted.make(resolution.apiKey),
    apiUrl: `${resolution.gateway.origin}/v1`,
    transformClient: gatewayHeaders(resolution.sessionId),
  }).pipe(Layer.provide(FetchHttpClient.layer))
  return OpenAiResponsesLanguageModel.layer({
    model: resolution.modelName,
    config: responsesConfig(resolution.hints, resolution.wire, resolution.sessionId),
  }).pipe(Layer.provide(client))
}

const chatCompletionsModel = (resolution: Resolution) => {
  const reasoningField = Option.flatMap(resolution.wire, (value) =>
    Option.fromUndefinedOr(value.reasoningField),
  )
  const client = OpenAiChatClient.layer({
    apiKey: Redacted.make(resolution.apiKey),
    apiUrl: `${resolution.gateway.origin}/v1`,
    transformClient: (http) =>
      http.pipe(
        rewriteJsonBody(reasoningInField(reasoningField)),
        gatewayHeaders(resolution.sessionId),
      ),
  }).pipe(Layer.provide(FetchHttpClient.layer))
  return OpenAiChatLanguageModel.layer({
    model: resolution.modelName,
    config: chatConfig(resolution.hints, resolution.wire),
  }).pipe(Layer.provide(client))
}

const messagesModel = (resolution: Resolution) => {
  const plan = messagesPlan(resolution.modelName, resolution.hints, resolution.wire)
  const client = AnthropicClient.layer({
    apiKey: Redacted.make(resolution.apiKey),
    apiUrl: resolution.gateway.origin,
    transformClient: (http) =>
      http.pipe(
        rewriteJsonBody((body) => cacheMarked(planApplied(plan)(body))),
        gatewayHeaders(resolution.sessionId),
      ),
  }).pipe(Layer.provide(FetchHttpClient.layer))
  return AnthropicLanguageModel.layer({
    model: resolution.modelName,
    config: messagesConfig(resolution.hints, plan),
  }).pipe(Layer.provide(client))
}

/** The Effect AI model for the resolution's wire format. */
const modelLayer = (format: WireFormat, resolution: Resolution) => {
  switch (format) {
    case "responses":
      return responsesModel(resolution)
    case "messages":
      return messagesModel(resolution)
    case "chat-completions":
      return chatCompletionsModel(resolution)
  }
}

/**
 * The models the driver lists: the gateway's catalog entries in a wire format
 * it speaks, then its classifier models.
 */
const listGatewayModels = (gateway: Gateway, catalog: CatalogSource) =>
  driverListModels(catalog, gateway.id, PROMPT_CACHE_TTL)().pipe(
    Effect.flatMap((models) =>
      Effect.filter(models, (model) =>
        driverModelWire(catalog, model.id).pipe(
          Effect.map((wire) => Option.isSome(wireFormatOf(wire))),
        ),
      ),
    ),
    Effect.map((models) => [
      ...models,
      ...gateway.classifiers.map((entry) => classifierModel(gateway.id, entry)),
    ]),
  )

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
 * absent: the compaction summary) with an id of its own, since the gateway
 * refuses a request without one.
 */
export const buildOpenCodeModelDriver = (
  gateway: Gateway,
  envApiKey: Option.Option<string>,
  catalog: CatalogSource,
  crypto: Crypto.Crypto,
): ModelDriverContribution => {
  const driver: ModelDriverContribution = {
    id: gateway.id,
    name: gateway.signInName,
    ...Option.match(Option.fromUndefinedOr(gateway.credentialFrom), {
      onNone: () => ({}),
      onSome: (credentialFrom) => ({ credentialFrom }),
    }),
    envCredential: ENV_CREDENTIAL,
    retry: DEFAULT_RETRY_POLICY,
    resolveModel: (modelName, authInfo, hintsInput) =>
      Effect.gen(function* () {
        const apiKey = yield* gatewayApiKey(gateway, Option.fromNullishOr(authInfo), envApiKey)
        const wire = yield* driverModelWire(catalog, `${gateway.id}/${modelName}`)
        const format = wireFormatOf(wire)
        if (Option.isNone(format))
          return yield* Effect.die(unsupportedWireFormat(gateway, modelName, wire))
        const hints = Option.fromNullishOr(hintsInput)
        const sessionId = yield* Option.match(
          Option.flatMap(hints, (value) => Option.fromUndefinedOr(value.cacheKey)),
          {
            onNone: () => crypto.randomUUIDv4.pipe(Effect.orDie),
            onSome: Effect.succeed,
          },
        )
        const resolution: Resolution = {
          gateway,
          modelName,
          apiKey,
          sessionId,
          hints,
          wire,
        }
        return AiModel.make(gateway.id, modelName, modelLayer(format.value, resolution))
      }),
    listModels: () => listGatewayModels(gateway, catalog),
    auth: {
      methods: [AuthMethod.make({ type: "api", label: gateway.authLabel })],
    },
  }
  if (gateway.classifiers.length === 0) return driver
  return {
    ...driver,
    // A Jev model speaks TypeSafe's API under the gateway's `/v1`, with the
    // same key and session headers; each call is its own session.
    resolveDecisionModel: (modelName, authInfo) =>
      Effect.gen(function* () {
        const apiKey = yield* gatewayApiKey(gateway, Option.fromNullishOr(authInfo), envApiKey)
        const sessionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie)
        return typeSafeDecisionModel(modelName, {
          apiKey,
          apiUrl: `${gateway.origin}/v1`,
          transformClient: gatewayHeaders(sessionId),
        })
      }),
  }
}

export const OpenCodeExtension = defineExtension({
  id: "@gent/provider-opencode",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    const envApiKey = yield* readOptionalEnv(ENV_CREDENTIAL)
    const catalog = yield* catalogSource(host.home)
    // The host's Crypto, not one of the driver's own: a shipped provider is
    // never more privileged than a user extension.
    const crypto = yield* Crypto.Crypto
    yield* host.register(
      "modelDriver",
      buildOpenCodeModelDriver(OPENCODE_GATEWAYS.zen, envApiKey, catalog, crypto),
      buildOpenCodeModelDriver(OPENCODE_GATEWAYS.go, envApiKey, catalog, crypto),
    )
  }),
})
