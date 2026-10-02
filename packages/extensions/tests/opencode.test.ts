import { describe, expect, it } from "effect-bun-test"
import { Crypto, Effect, Layer, Option, Order, Path, Predicate, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http"
import {
  OpenAiClient as OpenAiChatClient,
  OpenAiLanguageModel as OpenAiChatLanguageModel,
} from "@effect/ai-openai-compat"
import { Prompt } from "effect/ai"
import { BunCrypto, BunFileSystem } from "@effect/platform-bun"
import {
  defineExtension,
  ExtensionHost,
  ModelId,
  ProviderAuthError,
  ProviderAuthInfo,
  type ProviderHints,
} from "@gent/core/extensions/api"
import {
  type CapturedRequest,
  createRpcHarness,
  type FakeFetchState,
  LanguageModelLayers,
  makeFakeFetchState,
  makeTempDirectoryScoped,
  oneGenerate,
  storedCredentialModel,
  textStep,
} from "@gent/core/test-utils"
import { buildOpenCodeModelDriver, OPENCODE_GATEWAYS, OpenCodeExtension } from "../src/opencode.js"
import { catalogSource, modelsDevCatalog } from "../src/providers.js"
import { encodeExternalJson, externalWireNull } from "./helpers/external-wire.js"
import { decideTicket, systemOneBody, TICKET, TICKET_QUESTIONS } from "./helpers/decision-wire.js"
import { BuiltinExtensions } from "../src/index.js"

/**
 * The OpenCode gateways, Zen and Go: one driver constructor, three wire
 * formats picked from the models.dev catalog, the gateway's session headers,
 * and the reasoning and cache fields each format carries. Every request goes
 * to a captured fake `fetch`; no test reaches the gateway.
 */

const platformLayer = Layer.merge(BunFileSystem.layer, Path.layer)

/** The Crypto a host provides; the driver captures it at setup. */
const hostCrypto = Effect.service(Crypto.Crypto).pipe(Effect.provide(BunCrypto.layer))

const API_KEY = "oc-test-key"
const apiAuth = ProviderAuthInfo.cases.Api.make({ key: API_KEY })

// ── catalog fixture ─────────────────────────────────────────────────────────

/** The models.dev entries the tests read, as models.dev writes them (2026-10-01). */
const remotePayload = {
  "opencode-go": {
    npm: "@ai-sdk/openai-compatible",
    models: {
      "glm-5.3": {
        name: "GLM-5.3",
        tool_call: true,
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
        interleaved: { field: "reasoning_content" },
      },
      "gpt-5.6-luna": {
        name: "GPT-5.6 Luna",
        tool_call: true,
        reasoning: true,
        provider: { npm: "@ai-sdk/openai" },
        reasoning_options: [
          { type: "effort", values: ["none", "low", "medium", "high", "xhigh", "max"] },
        ],
      },
      "minimax-m3": {
        name: "MiniMax M3",
        tool_call: true,
        reasoning: true,
        provider: { npm: "@ai-sdk/anthropic" },
        reasoning_options: [{ type: "toggle" }],
      },
      "kimi-k2.6": {
        name: "Kimi K2.6",
        tool_call: true,
        reasoning: true,
        status: "deprecated",
        interleaved: { field: "reasoning_content" },
      },
    },
  },
  opencode: {
    npm: "@ai-sdk/openai-compatible",
    models: {
      "qwen3.8-max": {
        name: "Qwen3.8 Max",
        tool_call: true,
        reasoning: true,
        reasoning_options: [{ type: "toggle" }],
      },
      "gpt-6-sol": {
        name: "GPT-6 Sol",
        tool_call: true,
        reasoning: true,
        provider: { npm: "@ai-sdk/openai" },
        reasoning_options: [
          { type: "effort", values: ["none", "low", "medium", "high", "xhigh", "max"] },
        ],
      },
      "gpt-5.4": {
        name: "GPT-5.4",
        tool_call: true,
        reasoning: true,
        provider: { npm: "@ai-sdk/openai" },
        reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
      },
      "claude-opus-4-6": {
        name: "Claude Opus 4.6",
        tool_call: true,
        reasoning: true,
        provider: { npm: "@ai-sdk/anthropic" },
        reasoning_options: [
          { type: "effort", values: ["low", "medium", "high", "max"] },
          { type: "budget_tokens", min: 1024 },
        ],
      },
      "claude-opus-4-5": {
        name: "Claude Opus 4.5",
        tool_call: true,
        reasoning: true,
        provider: { npm: "@ai-sdk/anthropic" },
        reasoning_options: [
          { type: "effort", values: ["low", "medium", "high"] },
          { type: "budget_tokens", min: 1024 },
        ],
      },
      "claude-sonnet-4": {
        name: "Claude Sonnet 4",
        tool_call: true,
        reasoning: true,
        provider: { npm: "@ai-sdk/anthropic" },
        reasoning_options: [{ type: "budget_tokens", min: 1024 }],
      },
      "qwen3.8-flash": {
        name: "Qwen3.8 Flash",
        tool_call: true,
        reasoning: true,
        provider: { npm: "@ai-sdk/anthropic" },
        reasoning_options: [
          { type: "toggle" },
          { type: "effort", values: ["low", "medium", "xhigh"] },
          { type: "budget_tokens" },
        ],
      },
      "claude-opus-5": {
        name: "Claude Opus 5",
        tool_call: true,
        reasoning: true,
        provider: { npm: "@ai-sdk/anthropic" },
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
      },
      "gemini-3.6-flash": {
        name: "Gemini 3.6 Flash",
        tool_call: true,
        reasoning: true,
        provider: { npm: "@ai-sdk/google" },
        reasoning_options: [{ type: "effort", values: ["minimal", "low", "medium", "high"] }],
      },
    },
  },
}

/** An HTTP client that answers the models.dev fetch with the fixture. */
const catalogHttpLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(encodeExternalJson(remotePayload), { status: 200 }),
      ),
    ),
  ),
)

/**
 * A home whose catalog holds the fixture. The catalog keeps one load per
 * home, so a driver pointed at this home reads the fixture from then on.
 */
const fixtureHome = Effect.gen(function* () {
  const home = yield* makeTempDirectoryScoped("opencode-catalog-")
  const models = yield* modelsDevCatalog(home).pipe(
    Effect.provide(Layer.merge(catalogHttpLayer, platformLayer)),
  )
  expect(models.length).toBeGreaterThan(0)
  return home
})

/** Both gateways' drivers; `envApiKey` stands for `OPENCODE_API_KEY`, which setup reads. */
const driversWithEnv = (envApiKey: Option.Option<string>) =>
  Effect.gen(function* () {
    const home = yield* fixtureHome
    const source = yield* catalogSource(home).pipe(Effect.provide(platformLayer))
    const crypto = yield* hostCrypto
    return {
      zen: buildOpenCodeModelDriver(OPENCODE_GATEWAYS.zen, envApiKey, source, crypto),
      go: buildOpenCodeModelDriver(OPENCODE_GATEWAYS.go, envApiKey, source, crypto),
    }
  })

const fixtureDrivers = driversWithEnv(Option.none())

// ── wire fixtures ───────────────────────────────────────────────────────────

const responsesBody = {
  id: "resp-1",
  object: "response",
  created_at: 1_700_000_000,
  model: "gpt",
  output: [
    {
      id: "msg-1",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "ok", annotations: [], logprobs: [] }],
    },
  ],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
}

const chatBody = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1_700_000_000,
  model: "chat",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "ok" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}

const messagesBody = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: externalWireNull,
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    cache_creation: externalWireNull,
    cache_creation_input_tokens: externalWireNull,
    cache_read_input_tokens: externalWireNull,
    inference_geo: externalWireNull,
    service_tier: externalWireNull,
  },
}

/** Each wire format's success reply, chosen by the request's path. */
const gatewayReply = (request: CapturedRequest) => {
  const path = new URL(request.url).pathname
  const reply = (body: typeof chatBody | typeof responsesBody | typeof messagesBody) => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: encodeExternalJson(body),
  })
  if (path.endsWith("/responses")) return reply(responsesBody)
  if (path.endsWith("/messages")) return reply(messagesBody)
  return reply(chatBody)
}

type Driver = ReturnType<typeof buildOpenCodeModelDriver>

/** One generate through the driver's model, captured into `state`. */
const generate = (
  driver: Driver,
  modelName: string,
  state: FakeFetchState,
  hints: ProviderHints = {},
  prompt: Prompt.RawInput = "hi",
) =>
  driver
    .resolveModel(modelName, apiAuth, hints)
    .pipe(Effect.flatMap((model) => oneGenerate(model, state, gatewayReply, prompt)))

const RequestBody = Schema.fromJsonString(Schema.JsonObject)

const bodyOf = (request: CapturedRequest) =>
  Schema.decodeEffect(RequestBody)(Option.getOrThrow(Option.fromUndefinedOr(request.body)))

const MessagesBody = Schema.fromJsonString(
  Schema.Struct({ messages: Schema.Array(Schema.JsonObject) }),
)

/** The request's assistant messages, as the wire carries them. */
const assistantMessages = (request: CapturedRequest) =>
  Schema.decodeEffect(MessagesBody)(Option.getOrThrow(Option.fromUndefinedOr(request.body))).pipe(
    Effect.map((body) => body.messages.filter((message) => message["role"] === "assistant")),
  )

/** A field of a request body; none when the body leaves it out. */
const field = (body: Schema.JsonObject, key: string) => Option.fromUndefinedOr(body[key])

const lastRequest = (state: FakeFetchState) =>
  Option.getOrThrow(Option.fromUndefinedOr(state.captured.at(-1)))

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// ── request wiring ──────────────────────────────────────────────────────────

/** One model per supported wire format on each gateway, with its URL and auth header. */
const routes = [
  {
    gateway: "go",
    model: "glm-5.3",
    url: "https://opencode.ai/zen/go/v1/chat/completions",
    auth: ["authorization", `Bearer ${API_KEY}`],
  },
  {
    gateway: "go",
    model: "gpt-5.6-luna",
    url: "https://opencode.ai/zen/go/v1/responses",
    auth: ["authorization", `Bearer ${API_KEY}`],
  },
  // The Go gateway's default is Chat Completions; the catalog entry of
  // minimax-m3 names @ai-sdk/anthropic, so it posts to Messages.
  {
    gateway: "go",
    model: "minimax-m3",
    url: "https://opencode.ai/zen/go/v1/messages?beta=true",
    auth: ["x-api-key", API_KEY],
  },
  {
    gateway: "zen",
    model: "qwen3.8-max",
    url: "https://opencode.ai/zen/v1/chat/completions",
    auth: ["authorization", `Bearer ${API_KEY}`],
  },
  {
    gateway: "zen",
    model: "gpt-5.4",
    url: "https://opencode.ai/zen/v1/responses",
    auth: ["authorization", `Bearer ${API_KEY}`],
  },
  {
    gateway: "zen",
    model: "claude-opus-4-6",
    url: "https://opencode.ai/zen/v1/messages?beta=true",
    auth: ["x-api-key", API_KEY],
  },
] as const

describe("OpenCode request wiring", () => {
  it.live(
    "each wire format posts to its gateway path with the key, and names the session, the client and gent",
    () =>
      Effect.gen(function* () {
        const drivers = yield* fixtureDrivers
        for (const route of routes) {
          const state = makeFakeFetchState()
          const driver = drivers[route.gateway]
          yield* generate(driver, route.model, state, { cacheKey: "session-a" })
          yield* generate(driver, route.model, state, { cacheKey: "session-a" })
          yield* generate(driver, route.model, state, { cacheKey: "session-b" })
          expect(state.captured.map((request) => request.url)).toEqual([
            route.url,
            route.url,
            route.url,
          ])
          for (const request of state.captured) {
            const [authHeader, authValue] = route.auth
            expect(request.headers[authHeader]).toBe(authValue)
            expect(request.headers["x-opencode-client"]).toBe("gent")
            expect(request.headers["user-agent"]).toBe("gent")
            // The key travels in the auth header only.
            const others = Object.entries(request.headers).filter(([name]) => name !== authHeader)
            expect(others.filter(([, value]) => value.includes(API_KEY))).toEqual([])
          }
          expect(state.captured.map((request) => request.headers["x-opencode-session"])).toEqual([
            "session-a",
            "session-a",
            "session-b",
          ])
        }
      }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
  )

  it.live("a call without a conversation names a session of its own", () =>
    Effect.gen(function* () {
      const { go } = yield* fixtureDrivers
      const state = makeFakeFetchState()
      yield* generate(go, "glm-5.3", state)
      yield* generate(go, "glm-5.3", state)
      const sessions = state.captured.map((request) => request.headers["x-opencode-session"] ?? "")
      expect(sessions.every((session) => UUID.test(session))).toBe(true)
      expect(new Set(sessions).size).toBe(2)
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  it.live("without a stored key or OPENCODE_API_KEY, resolving fails and names the variable", () =>
    Effect.gen(function* () {
      const drivers = yield* fixtureDrivers
      for (const driver of [drivers.zen, drivers.go]) {
        const error = yield* Effect.flip(driver.resolveModel("glm-5.3"))
        expect(error).toBeInstanceOf(ProviderAuthError)
        expect(error.message).toContain("OPENCODE_API_KEY")
      }
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )
})

// ── reasoning ───────────────────────────────────────────────────────────────

describe("OpenCode reasoning", () => {
  it.live("Chat Completions sends the lowest catalog effort at or above the hint", () =>
    Effect.gen(function* () {
      const { go } = yield* fixtureDrivers
      const state = makeFakeFetchState()
      yield* generate(go, "glm-5.3", state, { cacheKey: "s", reasoning: "medium" })
      const body = yield* bodyOf(lastRequest(state))
      expect(body["reasoning_effort"]).toBe("high")
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  it.live(
    "Responses sends the effort with a summary, the session as the cache key, and low verbosity",
    () =>
      Effect.gen(function* () {
        const { go } = yield* fixtureDrivers
        const state = makeFakeFetchState()
        yield* generate(go, "gpt-5.6-luna", state, { cacheKey: "s", reasoning: "high" })
        const body = yield* bodyOf(lastRequest(state))
        expect(body["reasoning"]).toEqual({ effort: "high", summary: "auto" })
        expect(body["prompt_cache_key"]).toBe("s")
        expect(body["store"]).toBe(false)
        expect(body["text"]).toMatchObject({ verbosity: "low" })
      }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  // `@effect/ai-openai` asks for the encrypted reasoning only for the model
  // prefixes it knows; GPT-6 is not one of them.
  it.live("Responses asks for encrypted reasoning whenever it reasons without store", () =>
    Effect.gen(function* () {
      const { zen } = yield* fixtureDrivers
      const state = makeFakeFetchState()
      yield* generate(zen, "gpt-6-sol", state, { cacheKey: "s", reasoning: "high" })
      expect((yield* bodyOf(lastRequest(state)))["include"]).toEqual([
        "reasoning.encrypted_content",
      ])
      // With no effort named the model still reasons, at its default effort.
      yield* generate(zen, "gpt-6-sol", state, { cacheKey: "s", supportsReasoning: true })
      expect((yield* bodyOf(lastRequest(state)))["include"]).toEqual([
        "reasoning.encrypted_content",
      ])
      yield* generate(zen, "gpt-6-sol", state, {
        cacheKey: "s",
        reasoning: "high",
        supportsReasoning: false,
      })
      expect(field(yield* bodyOf(lastRequest(state)), "include")).not.toEqual(
        Option.some(["reasoning.encrypted_content"]),
      )
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  it.live("Messages maps a toggle, a budget and an effort list as OpenCode does", () =>
    Effect.gen(function* () {
      const { go, zen } = yield* fixtureDrivers
      const state = makeFakeFetchState()

      yield* generate(go, "minimax-m3", state, { cacheKey: "s", reasoning: "high" })
      const toggle = yield* bodyOf(lastRequest(state))
      expect(toggle["thinking"]).toEqual({ type: "adaptive" })
      expect(toggle["output_config"]).toBeUndefined()

      yield* generate(go, "minimax-m3", state, { cacheKey: "s", reasoning: "none" })
      expect((yield* bodyOf(lastRequest(state)))["thinking"]).toEqual({ type: "disabled" })

      yield* generate(zen, "claude-opus-5", state, { cacheKey: "s", reasoning: "xhigh" })
      const adaptive = yield* bodyOf(lastRequest(state))
      expect(adaptive["thinking"]).toEqual({ type: "adaptive", display: "summarized" })
      expect(adaptive["output_config"]).toEqual({ effort: "xhigh" })
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  // OpenCode's `reasoningVariants`: an effort list wins over a budget, and
  // `anthropicEffort` picks the thinking mode by Claude family. A manual budget
  // cannot think between tool calls on the adaptive families.
  it.live("Messages prefers the effort list, and sends a budget only to a model with none", () =>
    Effect.gen(function* () {
      const { zen } = yield* fixtureDrivers
      const state = makeFakeFetchState()
      const sent = (modelName: string, reasoning: ProviderHints["reasoning"]) =>
        generate(zen, modelName, state, { cacheKey: "s", reasoning, maxTokens: 8192 }).pipe(
          Effect.andThen(Effect.suspend(() => bodyOf(lastRequest(state)))),
          Effect.map((body) => ({
            thinking: field(body, "thinking"),
            output: field(body, "output_config"),
          })),
        )

      expect(yield* sent("claude-opus-4-6", "high")).toEqual({
        thinking: Option.some({ type: "adaptive" }),
        output: Option.some({ effort: "high" }),
      })
      expect(yield* sent("claude-opus-4-5", "high")).toEqual({
        thinking: Option.some({ type: "enabled", budget_tokens: 4095 }),
        output: Option.some({ effort: "high" }),
      })
      expect(yield* sent("qwen3.8-flash", "high")).toEqual({
        thinking: Option.none(),
        output: Option.some({ effort: "xhigh" }),
      })
      expect(yield* sent("claude-sonnet-4", "high")).toEqual({
        thinking: Option.some({ type: "enabled", budget_tokens: 4096 }),
        output: Option.none(),
      })
      expect(yield* sent("claude-sonnet-4", "max")).toEqual({
        thinking: Option.some({ type: "enabled", budget_tokens: 8191 }),
        output: Option.none(),
      })
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  it.live("a model the catalog says does not reason gets no reasoning field", () =>
    Effect.gen(function* () {
      const { go, zen } = yield* fixtureDrivers
      const state = makeFakeFetchState()
      const hints: ProviderHints = { cacheKey: "s", reasoning: "high", supportsReasoning: false }
      yield* generate(go, "glm-5.3", state, hints)
      yield* generate(go, "gpt-5.6-luna", state, hints)
      yield* generate(zen, "claude-opus-4-6", state, hints)
      const bodies = yield* Effect.forEach(state.captured, bodyOf)
      for (const body of bodies) {
        expect(body["reasoning_effort"]).toBeUndefined()
        expect(body["reasoning"]).toBeUndefined()
        expect(body["thinking"]).toBeUndefined()
        expect(body["output_config"]).toBeUndefined()
      }
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  it.live(
    "Chat Completions returns the model's reasoning in its catalog field, and none where it names no field",
    () =>
      Effect.gen(function* () {
        const { go, zen } = yield* fixtureDrivers
        const conversation = Prompt.make([
          { role: "user", content: "first" },
          {
            role: "assistant",
            content: [
              Prompt.makePart("reasoning", { text: "thought it through" }),
              Prompt.makePart("text", { text: "answer" }),
            ],
          },
          { role: "assistant", content: [Prompt.makePart("text", { text: "no thinking" })] },
          { role: "user", content: "second" },
        ])
        const state = makeFakeFetchState()
        yield* generate(go, "glm-5.3", state, { cacheKey: "s" }, conversation)
        const withField = yield* assistantMessages(lastRequest(state))
        expect(withField.map((message) => message["reasoning_content"])).toEqual([
          "thought it through",
          "",
        ])

        yield* generate(zen, "qwen3.8-max", state, { cacheKey: "s" }, conversation)
        const withoutField = yield* assistantMessages(lastRequest(state))
        expect(withoutField.map((message) => "reasoning_content" in message)).toEqual([
          false,
          false,
        ])
      }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  it.live(
    "a step that reasoned, wrote and called a tool goes back as one assistant message with its reasoning",
    () =>
      Effect.gen(function* () {
        const { go } = yield* fixtureDrivers
        const state = makeFakeFetchState()
        yield* generate(go, "glm-5.3", state, { cacheKey: "s" }, reasonedToolStep)
        const assistants = yield* assistantMessages(lastRequest(state))
        expect(assistants.length).toBe(1)
        expect(assistants[0]?.["reasoning_content"]).toBe("need the file")
        expect(assistants[0]?.["content"]).toBe("Reading it.")
        const calls = yield* Schema.decodeUnknownEffect(ToolCalls)(assistants[0]?.["tool_calls"])
        expect(calls.map((call) => call.id)).toEqual(["call_read"])
      }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  // The replay is OpenCode's opt-in (`replayReasoning`); every other user of
  // the compat SDK sends what the unpatched SDK sends.
  it.live("a compat client without the opt-in sends no reasoning and keeps upstream messages", () =>
    Effect.gen(function* () {
      const client = OpenAiChatClient.layer({
        apiKey: Redacted.make(API_KEY),
        apiUrl: "https://compat.example/v1",
      }).pipe(Layer.provide(FetchHttpClient.layer))
      const model = OpenAiChatLanguageModel.layer({ model: "plain" }).pipe(Layer.provide(client))
      const state = makeFakeFetchState()
      yield* oneGenerate(model, state, gatewayReply, reasonedToolStep)
      const assistants = yield* assistantMessages(lastRequest(state))
      expect(assistants.map((message) => "reasoning_content" in message)).toEqual([false, false])
      expect(assistants.map((message) => message["content"])).toEqual([
        "Reading it.",
        externalWireNull,
      ])
      const calls = yield* Schema.decodeUnknownEffect(ToolCalls)(assistants[1]?.["tool_calls"])
      expect(calls.map((call) => call.id)).toEqual(["call_read"])
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  // A reply cut off after its reasoning leaves an assistant message with no
  // text; that reasoning belongs to it alone, not to a later reply.
  it.live("reasoning stays with its own assistant message, not the messages after it", () =>
    Effect.gen(function* () {
      const { go } = yield* fixtureDrivers
      const conversation = Prompt.make([
        { role: "user", content: "first question" },
        {
          role: "assistant",
          content: [Prompt.makePart("reasoning", { text: "cut off mid thought" })],
        },
        { role: "user", content: "new question" },
        { role: "assistant", content: [Prompt.makePart("text", { text: "unrelated answer" })] },
        {
          role: "assistant",
          content: [
            Prompt.makePart("tool-call", {
              id: "call_read",
              name: "read",
              params: { path: "a.txt" },
              providerExecuted: false,
            }),
          ],
        },
        {
          role: "tool",
          content: [
            Prompt.makePart("tool-result", {
              id: "call_read",
              name: "read",
              result: "alpha",
              isFailure: false,
              providerExecuted: false,
            }),
          ],
        },
      ])
      const state = makeFakeFetchState()
      yield* generate(go, "glm-5.3", state, { cacheKey: "s" }, conversation)
      const assistants = yield* assistantMessages(lastRequest(state))
      expect(
        assistants.map((message) => ({
          content: message["content"],
          reasoning: message["reasoning_content"],
          calls: "tool_calls" in message,
        })),
      ).toEqual([
        { content: "unrelated answer", reasoning: "", calls: false },
        { content: externalWireNull, reasoning: "", calls: true },
      ])
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )
})

const ToolCalls = Schema.Array(Schema.Struct({ id: Schema.String }))

/** A step that reasoned, wrote, and called a tool, then the tool's result. */
const reasonedToolStep = Prompt.make([
  { role: "user", content: "Read a.txt." },
  {
    role: "assistant",
    content: [
      Prompt.makePart("reasoning", { text: "need the file" }),
      Prompt.makePart("text", { text: "Reading it." }),
      Prompt.makePart("tool-call", {
        id: "call_read",
        name: "read",
        params: { path: "a.txt" },
        providerExecuted: false,
      }),
    ],
  },
  {
    role: "tool",
    content: [
      Prompt.makePart("tool-result", {
        id: "call_read",
        name: "read",
        result: "alpha",
        isFailure: false,
        providerExecuted: false,
      }),
    ],
  },
])

// ── prompt caching ──────────────────────────────────────────────────────────

describe("OpenCode prompt caching", () => {
  /** Which blocks of each message and of the system prompt carry a cache marker. */
  const markers = (state: FakeFetchState) =>
    Effect.gen(function* () {
      const body = yield* bodyOf(lastRequest(state))
      const Blocks = Schema.Array(Schema.JsonObject)
      const messages = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ role: Schema.String, content: Blocks })),
      )(body["messages"])
      const system = yield* Schema.decodeUnknownEffect(Blocks)(body["system"])
      const marked = (block: Schema.JsonObject) => Predicate.isObject(block["cache_control"])
      return {
        messages: messages.map((message) => message.content.map(marked)),
        system: system.map(marked),
      }
    })

  it.live("Messages marks the first system block and the last block of the last two messages", () =>
    Effect.gen(function* () {
      const { zen } = yield* fixtureDrivers
      const state = makeFakeFetchState()
      const conversation = Prompt.make([
        { role: "system", content: "be brief" },
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three" },
      ])
      yield* generate(zen, "claude-opus-5", state, { cacheKey: "s" }, conversation)
      expect(yield* markers(state)).toEqual({ messages: [[false], [true], [true]], system: [true] })
      expect((yield* bodyOf(lastRequest(state)))["system"]).toMatchObject([
        { cache_control: { type: "ephemeral" } },
      ])
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  // The patched SDK sends a system message after the conversation (a turn
  // notice) as a user message of its own; caching it would spend a marker on
  // text the next turn does not repeat.
  it.live("Messages keeps the markers off a turn notice and on the conversation", () =>
    Effect.gen(function* () {
      const { zen } = yield* fixtureDrivers
      const state = makeFakeFetchState()
      const conversation = Prompt.make([
        { role: "system", content: "be brief" },
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three" },
        { role: "system", content: "the cache is cold" },
      ])
      yield* generate(zen, "claude-opus-5", state, { cacheKey: "s" }, conversation)
      expect((yield* markers(state)).messages).toEqual([[false], [true], [true], [false]])
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  it.live("Messages puts no marker on an empty text block", () =>
    Effect.gen(function* () {
      const { zen } = yield* fixtureDrivers
      const state = makeFakeFetchState()
      const conversation = Prompt.make([
        { role: "system", content: "be brief" },
        { role: "user", content: "one" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "two" },
            { type: "text", text: "" },
          ],
        },
        { role: "user", content: "three" },
      ])
      yield* generate(zen, "claude-opus-5", state, { cacheKey: "s" }, conversation)
      expect((yield* markers(state)).messages).toEqual([[false], [true, false], [true]])
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  // The compaction summary names no conversation: nothing reads its cache back.
  it.live("Messages marks nothing on a request without a conversation", () =>
    Effect.gen(function* () {
      const { zen } = yield* fixtureDrivers
      const state = makeFakeFetchState()
      const conversation = Prompt.make([
        { role: "system", content: "summarize" },
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three" },
      ])
      yield* generate(zen, "claude-opus-5", state, {}, conversation)
      expect(yield* markers(state)).toEqual({
        messages: [[false], [false], [false]],
        system: [false],
      })
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )
})

// ── classifiers ─────────────────────────────────────────────────────────────

describe("OpenCode Zen classifiers", () => {
  it.live("a Jev decide posts to Zen's System One with the key and a session of its own", () =>
    Effect.gen(function* () {
      const { zen } = yield* fixtureDrivers
      const resolve = Option.getOrThrow(Option.fromUndefinedOr(zen.resolveDecisionModel))
      const state = makeFakeFetchState()
      const response = yield* decideTicket(yield* resolve("jev-1.13", apiAuth), state)
      yield* decideTicket(yield* resolve("jev-1.13-free", apiAuth), state)
      expect(state.captured.map((request) => request.url)).toEqual([
        "https://opencode.ai/zen/v1/systemone",
        "https://opencode.ai/zen/v1/systemone",
      ])
      for (const request of state.captured) {
        expect(request.headers["authorization"]).toBe(`Bearer ${API_KEY}`)
        expect(request.headers["x-opencode-client"]).toBe("gent")
        expect(request.headers["user-agent"]).toBe("gent")
      }
      const sessions = state.captured.map((request) => request.headers["x-opencode-session"] ?? "")
      expect(sessions.every((session) => UUID.test(session))).toBe(true)
      expect(new Set(sessions).size).toBe(2)
      const bodies = yield* Effect.forEach(state.captured, systemOneBody)
      expect(bodies).toEqual([
        { model: "jev-1.13", state: TICKET, questions: TICKET_QUESTIONS },
        { model: "jev-1.13-free", state: TICKET, questions: TICKET_QUESTIONS },
      ])
      expect(response.answers.topic.label).toBe("billing")
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  it.live("Zen lists its Jev models as classifiers; Go serves none", () =>
    Effect.gen(function* () {
      const { zen, go } = yield* fixtureDrivers
      const zenModels = yield* Option.getOrThrow(Option.fromUndefinedOr(zen.listModels))()
      const classifiers = zenModels.filter((model) => model.kind === "classifier")
      expect(classifiers.map((model) => model.id)).toEqual([
        ModelId.make("opencode/jev-1.13"),
        ModelId.make("opencode/jev-1.13-free"),
      ])
      const goModels = yield* Option.getOrThrow(Option.fromUndefinedOr(go.listModels))()
      expect(goModels.some((model) => model.kind === "classifier")).toBe(false)
      expect(go.resolveDecisionModel).toBeUndefined()
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  it.live(
    "without a stored key or OPENCODE_API_KEY, resolving a Jev model names the variable",
    () =>
      Effect.gen(function* () {
        const { zen } = yield* fixtureDrivers
        const resolve = Option.getOrThrow(Option.fromUndefinedOr(zen.resolveDecisionModel))
        const error = yield* Effect.flip(resolve("jev-1.13"))
        expect(error).toBeInstanceOf(ProviderAuthError)
        expect(error.message).toContain("OPENCODE_API_KEY")
      }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  it.live("the shipped extensions list both routes' Jev models as classifiers over RPC", () =>
    Effect.gen(function* () {
      const home = yield* fixtureHome
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
      const { client, sessionId } = yield* createRpcHarness({
        agents: [],
        home,
        extensionInputs: BuiltinExtensions,
        providerLayer,
      })
      const classifiers = (yield* client.model.list({ sessionId }))
        .filter((model) => model.kind === "classifier")
        .map((model) => model.id)
      expect(classifiers.toSorted()).toEqual([
        ModelId.make("opencode/jev-1.13"),
        ModelId.make("opencode/jev-1.13-free"),
        ModelId.make("typesafe/jev-1.13.0"),
        ModelId.make("typesafe/jev-latest"),
        ModelId.make("typesafe/jev-preview"),
      ])
    }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
  )
})

// ── catalog ─────────────────────────────────────────────────────────────────

describe("OpenCode catalog", () => {
  // A model with no cache lifetime never goes cold: Chat Completions caches
  // implicitly, with no write price, so a cold handoff would only lose detail.
  it.live(
    "each gateway lists its own models, deprecated ones too, with the cache lifetime of their wire format",
    () =>
      Effect.gen(function* () {
        const { go } = yield* fixtureDrivers
        const listModels = Option.getOrThrow(Option.fromUndefinedOr(go.listModels))
        const models = yield* listModels()
        expect(
          models
            .map((model) => [model.id, Option.fromUndefinedOr(model.promptCacheTtlMs)] as const)
            .toSorted(([left], [right]) => Order.String(left, right)),
        ).toEqual([
          [ModelId.make("opencode-go/glm-5.3"), Option.none()],
          [ModelId.make("opencode-go/gpt-5.6-luna"), Option.some(1_800_000)],
          [ModelId.make("opencode-go/kimi-k2.6"), Option.none()],
          [ModelId.make("opencode-go/minimax-m3"), Option.some(300_000)],
        ])
      }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  it.live("a Zen model on the Google format is not listed, and resolving it names the format", () =>
    Effect.gen(function* () {
      const { zen } = yield* fixtureDrivers
      const listModels = Option.getOrThrow(Option.fromUndefinedOr(zen.listModels))
      const ids = (yield* listModels()).map((model) => model.id)
      expect(ids).toContain(ModelId.make("opencode/claude-opus-5"))
      expect(ids).not.toContain(ModelId.make("opencode/gemini-3.6-flash"))
      // An expected failure: a typed driver error, not a defect.
      const error = yield* Effect.flip(zen.resolveModel("gemini-3.6-flash", apiAuth))
      expect(error).toMatchObject({
        _tag: "DriverError",
        driver: "opencode",
        reason:
          'OpenCode Zen model "gemini-3.6-flash" speaks the @ai-sdk/google wire format, which gent does not support',
      })
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  it.live("the shipped extension lists both gateways' models over RPC", () =>
    Effect.gen(function* () {
      const home = yield* fixtureHome
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
      const { client, sessionId } = yield* createRpcHarness({
        agents: [],
        home,
        extensionInputs: [OpenCodeExtension],
        providerLayer,
      })
      const ids = (yield* client.model.list({ sessionId })).map((model) => model.id)
      expect(ids).toContain(ModelId.make("opencode-go/minimax-m3"))
      expect(ids).toContain(ModelId.make("opencode/gpt-5.4"))
      expect(ids).not.toContain(ModelId.make("opencode/gemini-3.6-flash"))
    }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
  )
})

// ── sign-in ─────────────────────────────────────────────────────────────────

const ZEN_URL = "https://opencode.ai/zen/v1/chat/completions"
const GO_URL = "https://opencode.ai/zen/go/v1/chat/completions"

/**
 * One request to Zen and one to Go, each resolved as a turn resolves it from
 * an auth store holding `stored`; the URL and `Authorization` of each.
 */
const requestsWithStored = (
  stored: Record<string, string>,
  envApiKey: Option.Option<string> = Option.none(),
) =>
  Effect.gen(function* () {
    const { zen, go } = yield* driversWithEnv(envApiKey)
    const state = makeFakeFetchState()
    for (const modelId of ["opencode/qwen3.8-max", "opencode-go/glm-5.3"]) {
      const model = storedCredentialModel({ modelDrivers: [zen, go], stored, modelId })
      yield* oneGenerate(model, state, gatewayReply)
    }
    return state.captured.map((request) => [request.url, request.headers["authorization"]])
  })

/** An RPC harness whose profile registers `extension`; the `/auth` rows and methods it lists. */
const signInHarness = (extension: Parameters<typeof createRpcHarness>[0]["extensionInputs"]) =>
  Effect.gen(function* () {
    const home = yield* fixtureHome
    const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
    const { client, sessionId } = yield* createRpcHarness({
      agents: [],
      home,
      extensionInputs: extension ?? [],
      providerLayer,
    })
    const rows = client.auth
      .listProviders({ sessionId })
      .pipe(
        Effect.map((providers) =>
          providers.map((row) => [String(row.provider), row.name, row.source ?? "none"]),
        ),
      )
    const methods = client.auth
      .listMethods({ sessionId })
      .pipe(
        Effect.map((listed) =>
          Object.entries(listed).map(([id, entries]) => [id, entries.map((entry) => entry.label)]),
        ),
      )
    return { client, rows, methods, sessionId }
  })

describe("OpenCode sign-in", () => {
  it.live("one stored OpenCode key serves a Zen request and a Go request", () =>
    Effect.gen(function* () {
      expect(yield* requestsWithStored({ opencode: API_KEY })).toEqual([
        [ZEN_URL, `Bearer ${API_KEY}`],
        [GO_URL, `Bearer ${API_KEY}`],
      ])
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  it.live("a key stored for Go before the two shared serves both, until an OpenCode key is", () =>
    Effect.gen(function* () {
      expect(yield* requestsWithStored({ "opencode-go": "oc-go-key" })).toEqual([
        [ZEN_URL, "Bearer oc-go-key"],
        [GO_URL, "Bearer oc-go-key"],
      ])
      expect(yield* requestsWithStored({ opencode: API_KEY, "opencode-go": "oc-go-key" })).toEqual([
        [ZEN_URL, `Bearer ${API_KEY}`],
        [GO_URL, `Bearer ${API_KEY}`],
      ])
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  it.live("with nothing stored, both gateways send OPENCODE_API_KEY", () =>
    Effect.gen(function* () {
      expect(yield* requestsWithStored({}, Option.some("oc-env-key"))).toEqual([
        [ZEN_URL, "Bearer oc-env-key"],
        [GO_URL, "Bearer oc-env-key"],
      ])
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  it.live("/auth lists one OpenCode sign-in, and signing out removes the key it shows", () =>
    Effect.gen(function* () {
      const { client, rows, methods, sessionId } = yield* signInHarness([OpenCodeExtension])
      expect(yield* rows).toEqual([["opencode", "OpenCode", "none"]])
      expect(yield* methods).toEqual([["opencode", ["OpenCode API key — Zen, Go and Go Plus"]]])

      // A key typed for Go is the OpenCode key.
      yield* client.auth.setKey({ provider: "opencode-go", key: "oc-go-key", sessionId })
      expect(yield* rows).toEqual([["opencode", "OpenCode", "stored"]])
      yield* client.auth.deleteKey({ provider: "opencode", sessionId })
      expect(yield* rows).toEqual([["opencode", "OpenCode", "none"]])

      yield* client.auth.setKey({ provider: "opencode", key: API_KEY, sessionId })
      expect(yield* rows).toEqual([["opencode", "OpenCode", "stored"]])
      yield* client.auth.deleteKey({ provider: "opencode", sessionId })
      expect(yield* rows).toEqual([["opencode", "OpenCode", "none"]])
    }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
  )

  it.live("a profile with Go but no Zen signs in to Go with its own key", () =>
    Effect.gen(function* () {
      const { go } = yield* fixtureDrivers
      const goOnly = defineExtension({
        id: "@gent/test/opencode-go-only",
        setup: Effect.gen(function* () {
          yield* (yield* ExtensionHost).register("modelDriver", go)
        }),
      })
      const { client, rows, methods, sessionId } = yield* signInHarness([goOnly])
      expect(yield* rows).toEqual([["opencode-go", "OpenCode Go", "none"]])
      expect(yield* methods).toEqual([["opencode-go", ["OpenCode Go / Go Plus API key"]]])
      yield* client.auth.setKey({ provider: "opencode-go", key: "oc-go-key", sessionId })
      expect(yield* rows).toEqual([["opencode-go", "OpenCode Go", "stored"]])
      const state = makeFakeFetchState()
      const model = storedCredentialModel({
        modelDrivers: [go],
        stored: { "opencode-go": "oc-go-key" },
        modelId: "opencode-go/glm-5.3",
      })
      yield* oneGenerate(model, state, gatewayReply)
      expect(lastRequest(state).headers["authorization"]).toBe("Bearer oc-go-key")
    }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
  )
})
