import { describe, expect, it } from "effect-bun-test"
import { ConfigProvider, Effect, Layer, Option, Path, Predicate, Schema, Stream } from "effect"
import { LanguageModel } from "effect/ai"
import { BunFileSystem } from "@effect/platform-bun"
import {
  ModelId,
  ProviderAuthError,
  ProviderAuthInfo,
  type ProviderHints,
  ProviderId,
} from "@gent/core/extensions/api"
import {
  createE2ELayer,
  createRpcClient,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  textStep,
} from "@gent/core/test-utils"
import {
  buildCloudflareModelDriver,
  type CloudflareEnv,
  CloudflareExtension,
} from "../src/cloudflare.js"
import { catalogSource } from "../src/providers.js"
import { seedCatalog } from "./helpers/catalog-source.js"
import { encodeExternalJson, externalWireNull } from "./helpers/external-wire.js"
import {
  decideTicket,
  jsonReply,
  systemOneBody,
  TICKET,
  TICKET_ANSWER,
  TICKET_QUESTIONS,
} from "./helpers/decision-wire.js"
import {
  type CapturedRequest,
  fakeFetchLayer,
  type FakeFetchState,
  makeFakeFetchState,
  oneGenerate,
} from "./helpers/fake-http-client.js"

/**
 * The Cloudflare driver: Workers AI and AI Gateway models over Cloudflare's
 * REST API, signed with one API token, sent to the account the sign-in
 * names and through its gateway when it names one. Every request goes to a
 * captured fake `fetch`; no test reaches Cloudflare.
 */

const platformLayer = Layer.merge(BunFileSystem.layer, Path.layer)

const TOKEN = "cf-test-token"
const NO_ENV: CloudflareEnv = {
  token: Option.none(),
  accountId: Option.none(),
  gatewayId: Option.none(),
}
const signedIn = (metadata: Record<string, string>) =>
  ProviderAuthInfo.cases.Api.make({ key: TOKEN, metadata })

// ── catalog fixture ─────────────────────────────────────────────────────────

/** The models.dev entries the tests read, as models.dev writes them (2026-10-02). */
const remotePayload = {
  "cloudflare-workers-ai": {
    id: "cloudflare-workers-ai",
    npm: "@ai-sdk/openai-compatible",
    api: "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1",
    models: {
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast": {
        name: "Llama 3.3 70B Instruct fp8 Fast",
        tool_call: true,
        reasoning: false,
        limit: { context: 24000, output: 24000 },
        cost: { input: 0.293, output: 2.253 },
      },
      "@cf/meta/llama-guard-3-8b": {
        name: "Llama Guard 3 8B",
        tool_call: false,
        reasoning: false,
        limit: { context: 131072, output: 131072 },
        cost: { input: 0.484, output: 0.03 },
      },
    },
  },
  "cloudflare-ai-gateway": {
    id: "cloudflare-ai-gateway",
    npm: "ai-gateway-provider",
    models: {
      "openai/gpt-5-mini": {
        name: "GPT-5 Mini",
        tool_call: true,
        reasoning: true,
        cost: { input: 0.25, output: 2 },
      },
    },
  },
}

/** A home whose catalog holds the fixture; a driver pointed at it reads the fixture. */
const fixtureHome = Effect.gen(function* () {
  const home = yield* makeTempDirectoryScoped("cloudflare-catalog-")
  yield* seedCatalog(home, remotePayload)
  return home
})

const fixtureDriver = (env: CloudflareEnv = NO_ENV) =>
  Effect.gen(function* () {
    const home = yield* fixtureHome
    const source = yield* catalogSource(home).pipe(Effect.provide(platformLayer))
    return buildCloudflareModelDriver(env, source)
  })

// ── wire fixtures ───────────────────────────────────────────────────────────

const chatBody = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1_700_000_000,
  model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}

const chatReply = () => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: encodeExternalJson(chatBody),
})

type Driver = ReturnType<typeof buildCloudflareModelDriver>

/** One generate through the driver's model, captured into `state`. */
const generate = (
  driver: Driver,
  modelName: string,
  state: FakeFetchState,
  authInfo?: ProviderAuthInfo,
  hints: ProviderHints = {},
) =>
  driver
    .resolveModel(modelName, authInfo, hints)
    .pipe(Effect.flatMap((model) => oneGenerate(model, state, chatReply)))

const RequestBody = Schema.fromJsonString(Schema.JsonObject)

const bodyOf = (request: CapturedRequest) =>
  Schema.decodeEffect(RequestBody)(Option.getOrThrow(Option.fromUndefinedOr(request.body)))

const onlyRequest = (state: FakeFetchState) => {
  expect(state.captured).toHaveLength(1)
  return Option.getOrThrow(Option.fromUndefinedOr(state.captured[0]))
}

const LLAMA = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
const CHAT_URL = "https://api.cloudflare.com/client/v4/accounts/acct-1/ai/v1/chat/completions"

// ── chat ────────────────────────────────────────────────────────────────────

describe("Cloudflare chat", () => {
  it.live(
    "a Workers AI model posts to the account's Chat Completions with the token and no gateway header",
    () =>
      Effect.gen(function* () {
        const driver = yield* fixtureDriver()
        const state = makeFakeFetchState()
        yield* generate(driver, LLAMA, state, signedIn({ accountId: "acct-1" }), {
          maxTokens: 512,
          temperature: 0.2,
          supportsReasoning: false,
        })
        const request = onlyRequest(state)
        expect(request.url).toBe(CHAT_URL)
        expect(request.method).toBe("POST")
        expect(request.headers["authorization"]).toBe(`Bearer ${TOKEN}`)
        expect(request.headers["cf-aig-gateway-id"]).toBeUndefined()
        const body = yield* bodyOf(request)
        expect(body["model"]).toBe(LLAMA)
        expect(body["messages"]).toEqual([{ role: "user", content: "hi" }])
        expect(body["max_tokens"]).toBe(512)
        expect(body["temperature"]).toBe(0.2)
      }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  it.live("with a gateway id every request names the gateway; a third-party id goes as given", () =>
    Effect.gen(function* () {
      const driver = yield* fixtureDriver()
      const state = makeFakeFetchState()
      const auth = signedIn({ accountId: "acct-1", gatewayId: "gw-main" })
      yield* generate(driver, LLAMA, state, auth)
      yield* generate(driver, "openai/gpt-5-mini", state, auth)
      expect(state.captured.map((request) => request.url)).toEqual([CHAT_URL, CHAT_URL])
      for (const request of state.captured) {
        expect(request.headers["cf-aig-gateway-id"]).toBe("gw-main")
        expect(request.headers["authorization"]).toBe(`Bearer ${TOKEN}`)
      }
      const models = yield* Effect.forEach(state.captured, (request) =>
        Effect.map(bodyOf(request), (body) => body["model"]),
      )
      expect(models).toEqual([LLAMA, "openai/gpt-5-mini"])
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  it.live(
    "without stored answers the variables serve; a stored answer wins over its variable",
    () =>
      Effect.gen(function* () {
        const driver = yield* fixtureDriver({
          token: Option.some("cf-env-token"),
          accountId: Option.some("acct-env"),
          gatewayId: Option.some("gw-env"),
        })
        const state = makeFakeFetchState()
        yield* generate(driver, LLAMA, state)
        yield* generate(driver, LLAMA, state, signedIn({ accountId: "acct-1" }))
        expect(
          state.captured.map((request) => [
            request.url,
            request.headers["authorization"],
            request.headers["cf-aig-gateway-id"],
          ]),
        ).toEqual([
          [
            "https://api.cloudflare.com/client/v4/accounts/acct-env/ai/v1/chat/completions",
            "Bearer cf-env-token",
            "gw-env",
          ],
          [CHAT_URL, `Bearer ${TOKEN}`, "gw-env"],
        ])
      }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  it.live("a missing account id fails before any request and names the variable and /auth", () =>
    Effect.gen(function* () {
      const driver = yield* fixtureDriver({ ...NO_ENV, token: Option.some("cf-env-token") })
      // A key stored before the sign-in asked for the account has no answer.
      const unanswered = ProviderAuthInfo.cases.Api.make({ key: TOKEN })
      for (const resolving of [
        driver.resolveModel(LLAMA),
        driver.resolveModel(LLAMA, unanswered),
      ]) {
        const error = yield* Effect.flip(resolving)
        expect(error).toBeInstanceOf(ProviderAuthError)
        expect(error.message).toContain("CLOUDFLARE_ACCOUNT_ID")
        expect(error.message).toContain("/auth")
      }
      const noToken = yield* Effect.flip((yield* fixtureDriver()).resolveModel(LLAMA))
      expect(noToken.message).toContain("CLOUDFLARE_API_TOKEN")
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  it.live("a stream whose connection drops mid-reply fails as a retryable lost connection", () =>
    Effect.gen(function* () {
      const driver = yield* fixtureDriver()
      const model = yield* driver.resolveModel(LLAMA, signedIn({ accountId: "acct-1" }))
      const firstChunk = `data: ${encodeExternalJson({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1_700_000_000,
        model: LLAMA,
        choices: [
          { index: 0, delta: { role: "assistant", content: "o" }, finish_reason: externalWireNull },
        ],
      })}\n\n`
      // The server sends the first chunk, then the socket closes under the read.
      const dropped = () => ({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.enqueue(new TextEncoder().encode(firstChunk))
            controller.error("socket closed")
          },
        }),
      })
      const error = yield* LanguageModel.streamText({ prompt: "hi" }).pipe(
        Stream.runDrain,
        Effect.provide(Layer.provideMerge(model, fakeFetchLayer(makeFakeFetchState(), dropped))),
        Effect.scoped,
        Effect.flip,
      )
      expect(error.reason).toMatchObject({
        _tag: "NetworkError",
        reason: "TransportError",
        description: "connection lost while reading the response",
      })
      expect(error.isRetryable).toBe(true)
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )
})

// ── catalog ─────────────────────────────────────────────────────────────────

describe("Cloudflare catalog", () => {
  it.live(
    "lists the Workers AI models that call tools under the cloudflare id, then the Clef classifiers",
    () =>
      Effect.gen(function* () {
        const driver = yield* fixtureDriver()
        const models = yield* Option.getOrThrow(Option.fromUndefinedOr(driver.listModels))()
        expect(
          models.map((model) => ({
            id: model.id,
            provider: model.provider,
            kind: Option.fromUndefinedOr(model.kind),
            pricing: model.pricing,
          })),
        ).toEqual([
          {
            id: ModelId.make(`cloudflare/${LLAMA}`),
            provider: ProviderId.make("cloudflare"),
            kind: Option.none(),
            pricing: { input: 0.293, output: 2.253 },
          },
          {
            id: ModelId.make("cloudflare/clef"),
            provider: ProviderId.make("cloudflare"),
            kind: Option.some("classifier"),
            pricing: { input: 0.24, output: 0 },
          },
          {
            id: ModelId.make("cloudflare/clef-flash"),
            provider: ProviderId.make("cloudflare"),
            kind: Option.some("classifier"),
            pricing: { input: 0.09, output: 0 },
          },
        ])
        // Chat Completions caches implicitly: no model goes cold.
        expect(models.some((model) => Predicate.isNotUndefined(model.promptCacheTtlMs))).toBe(false)
      }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )
})

// ── clef decisions ──────────────────────────────────────────────────────────

const resolveDecision = (driver: Driver, modelName: string, authInfo?: ProviderAuthInfo) =>
  Option.getOrThrow(Option.fromUndefinedOr(driver.resolveDecisionModel))(modelName, authInfo)

const RUN_URL = "https://api.cloudflare.com/client/v4/accounts/acct-1/ai/run/@cf/cloudflare"

/** The Workers AI REST envelope around a model's own answer. */
const envelope = (result: Schema.Json) => ({
  result,
  success: true,
  errors: [],
  messages: [],
})

describe("Cloudflare Clef decisions", () => {
  it.live(
    "a decide posts the System One body to the account's Workers AI run path of each Clef model",
    () =>
      Effect.gen(function* () {
        const driver = yield* fixtureDriver()
        const state = makeFakeFetchState()
        const auth = signedIn({ accountId: "acct-1" })
        const response = yield* decideTicket(yield* resolveDecision(driver, "clef", auth), state)
        yield* decideTicket(yield* resolveDecision(driver, "clef-flash", auth), state)
        expect(state.captured.map((request) => request.url)).toEqual([
          `${RUN_URL}/clef`,
          `${RUN_URL}/clef-flash`,
        ])
        for (const request of state.captured) {
          expect(request.headers["authorization"]).toBe(`Bearer ${TOKEN}`)
          expect(request.headers["cf-aig-gateway-id"]).toBeUndefined()
        }
        // The body names the model as Clef's schema spells it, not the `@cf/` path.
        expect(yield* Effect.forEach(state.captured, systemOneBody)).toEqual([
          { model: "clef", state: TICKET, questions: TICKET_QUESTIONS },
          { model: "clef-flash", state: TICKET, questions: TICKET_QUESTIONS },
        ])
        expect(response.answers.topic.label).toBe("billing")
        expect(response.usage.inputTokens).toBe(30)
      }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  it.live("with a gateway id the decide names the gateway", () =>
    Effect.gen(function* () {
      const driver = yield* fixtureDriver()
      const state = makeFakeFetchState()
      const auth = signedIn({ accountId: "acct-1", gatewayId: "gw-main" })
      yield* decideTicket(yield* resolveDecision(driver, "clef-flash", auth), state)
      expect(onlyRequest(state).headers["cf-aig-gateway-id"]).toBe("gw-main")
      expect(onlyRequest(state).url).toBe(`${RUN_URL}/clef-flash`)
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  it.live("an answer inside the Workers AI envelope decodes as the bare answer does", () =>
    Effect.gen(function* () {
      const driver = yield* fixtureDriver()
      const auth = signedIn({ accountId: "acct-1" })
      const bare = yield* decideTicket(
        yield* resolveDecision(driver, "clef", auth),
        makeFakeFetchState(),
      )
      const wrapped = yield* decideTicket(
        yield* resolveDecision(driver, "clef", auth),
        makeFakeFetchState(),
        () => jsonReply(envelope(TICKET_ANSWER)),
      )
      expect(wrapped).toEqual(bare)
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  it.live("an envelope that reports failure fails with its first error's message", () =>
    Effect.gen(function* () {
      const driver = yield* fixtureDriver()
      const auth = signedIn({ accountId: "acct-1" })
      const failure = (message: string) => ({
        result: externalWireNull,
        success: false,
        errors: [{ code: 5007, message }],
        messages: [],
      })
      const replies = [
        () => jsonReply(failure("No such model @cf/cloudflare/clef")),
        () => jsonReply(failure("Authentication error"), 401),
      ]
      const messages = yield* Effect.forEach(replies, (reply) =>
        Effect.gen(function* () {
          const model = yield* resolveDecision(driver, "clef", auth)
          const error = yield* Effect.flip(decideTicket(model, makeFakeFetchState(), reply))
          return error.message
        }),
      )
      expect(messages[0]).toContain("No such model @cf/cloudflare/clef")
      expect(messages[1]).toContain("Authentication error")
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  it.live("a decide without an account id fails before any request and names the variable", () =>
    Effect.gen(function* () {
      const driver = yield* fixtureDriver()
      const error = yield* Effect.flip(
        resolveDecision(driver, "clef", ProviderAuthInfo.cases.Api.make({ key: TOKEN })),
      )
      expect(error).toBeInstanceOf(ProviderAuthError)
      expect(error.message).toContain("CLOUDFLARE_ACCOUNT_ID")
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  it.live("a Clef model is not a chat model: resolving it for chat fails and names it", () =>
    Effect.gen(function* () {
      const driver = yield* fixtureDriver()
      const error = yield* Effect.flip(driver.resolveModel("clef", signedIn({ accountId: "a" })))
      expect(error).toMatchObject({ _tag: "DriverError", reason: expect.stringContaining("clef") })
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )
})

// ── sign-in ─────────────────────────────────────────────────────────────────

/** An RPC client whose profile registers the shipped extension, with `env` as the process env. */
const signInClient = (env: Record<string, string>) =>
  Effect.gen(function* () {
    const home = yield* fixtureHome
    const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
    const { client } = yield* createRpcClient(
      createE2ELayer({
        agents: [],
        home,
        extensionInputs: [CloudflareExtension],
        providerLayer,
      }).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))),
    )
    const { sessionId } = yield* client.session.create({})
    return { client, sessionId }
  })

describe("Cloudflare sign-in", () => {
  it.live(
    "/auth asks the token, the account and the gateway, and the stored sign-in lists the models",
    () =>
      Effect.gen(function* () {
        const { client, sessionId } = yield* signInClient({})
        const methods = yield* client.auth.listMethods({ sessionId })
        expect(
          methods["cloudflare"]?.map((method) => [
            method.type,
            (method.prompts ?? []).map((prompt) => [prompt.key, prompt.env]),
          ]),
        ).toEqual([
          [
            "api",
            [
              ["accountId", "CLOUDFLARE_ACCOUNT_ID"],
              ["gatewayId", "CLOUDFLARE_GATEWAY_ID"],
            ],
          ],
        ])
        yield* client.auth.setKey({
          provider: "cloudflare",
          key: TOKEN,
          metadata: { accountId: "acct-1" },
          sessionId,
        })
        const rows = yield* client.auth.listProviders({ sessionId })
        expect(rows.map((row) => [row.provider, row.name, row.source])).toEqual([
          ["cloudflare", "Cloudflare", "stored"],
        ])
        const ids = (yield* client.model.list({ sessionId })).map((model) => model.id)
        expect(ids).toContain(ModelId.make(`cloudflare/${LLAMA}`))
      }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
  )

  it.live("a prompt whose variable is set is not asked", () =>
    Effect.gen(function* () {
      const { client, sessionId } = yield* signInClient({ CLOUDFLARE_ACCOUNT_ID: "acct-env" })
      const methods = yield* client.auth.listMethods({ sessionId })
      expect(
        methods["cloudflare"]?.map((method) => (method.prompts ?? []).map((prompt) => prompt.key)),
      ).toEqual([["gatewayId"]])
    }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
  )

  it.live(
    "a token with no account id is not ready and names the Account ID; the variable or the answer makes it ready",
    () =>
      Effect.gen(function* () {
        const status = (env: Record<string, string>, metadata?: Record<string, string>) =>
          Effect.gen(function* () {
            const { client, sessionId } = yield* signInClient(env)
            if (Predicate.isNotUndefined(metadata))
              yield* client.auth.setKey({ provider: "cloudflare", key: TOKEN, metadata, sessionId })
            const [row] = yield* client.auth.listProviders({ sessionId })
            return [row?.hasKey, row?.source, Option.fromNullishOr(row?.missing)]
          })
        const needsAccount = Option.some(["Account ID"])
        // A sign-in that left the account empty, and a token from the variable alone.
        expect(yield* status({}, {})).toEqual([false, "stored", needsAccount])
        expect(yield* status({ CLOUDFLARE_API_TOKEN: TOKEN })).toEqual([false, "env", needsAccount])
        // The optional gateway is never missing.
        expect(yield* status({}, { accountId: "acct-1" })).toEqual([true, "stored", Option.none()])
        expect(yield* status({ CLOUDFLARE_ACCOUNT_ID: "acct-env" }, {})).toEqual([
          true,
          "stored",
          Option.none(),
        ])
        expect(
          yield* status({ CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: "acct-env" }),
        ).toEqual([true, "env", Option.none()])
      }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
  )
})
