/**
 * Tools on the wire. Gent tool ids hold dots (`session.send`,
 * `delegate.start`); Anthropic and OpenAI take only `[a-zA-Z0-9_-]` names.
 * A direct turn (no cell) through each real driver sends wire names in its
 * tool declarations and history, and the call it reads back runs the gent tool.
 * Each driver's tool declarations are pinned byte for byte, and a call the
 * tool runner refuses comes back to the model as a failed result.
 */
import { describe, expect, it } from "effect-bun-test"
import {
  Context,
  Crypto,
  Effect,
  Fiber,
  type FileSystem,
  Layer,
  Match,
  Option,
  type Path,
  Predicate,
  Schema,
  Stream,
  SynchronizedRef,
} from "effect"
import { BunServices } from "@effect/platform-bun"
import type { ChildProcessSpawner } from "effect/process"
import type { LanguageModel } from "effect/ai"
import {
  AnthropicPlatform,
  buildAnthropicModelDriver,
  type ClaudeCredentials,
} from "../src/anthropic.js"
import { buildOpenAIModelDriver, type OpenAICredentials } from "../src/openai.js"
import { buildCloudflareModelDriver } from "../src/cloudflare.js"
import { type CredentialCacheCell, EMPTY_CREDENTIAL_CELL } from "../src/providers.js"
import {
  AgentDefinition,
  defineExtension,
  type DriverError,
  ExtensionHost,
  type GentExtension,
  type ProviderAuthError,
  ProviderAuthInfo,
  tool,
} from "@gent/core/extensions/api"
import {
  createRpcHarness,
  makeTempDirectoryScoped,
  modelCatalogFromBodies,
  testAgent,
  testTurnExtension,
} from "@gent/core/test-utils"
import { resolveShipped } from "./helpers/api-classes.js"
import {
  type CapturedRequest,
  fakeFetchLayer,
  makeFakeFetchState,
} from "./helpers/fake-http-client.js"
import type { AgentEvent } from "@gent/core/protocol"
import { e2ePreset } from "./helpers/test-preset.js"
import { encodeExternalJson, externalWireNull } from "./helpers/external-wire.js"

/** The name pattern both providers accept (OpenAI's 64-character bound). */
const WIRE_NAME = /^[a-zA-Z0-9_-]{1,64}$/

const apiKey = ProviderAuthInfo.cases.Api.make({ key: "wire-test-key" })

interface FakeReply {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: string
}

const eventStream = (frames: ReadonlyArray<string>): FakeReply => ({
  status: 200,
  headers: { "content-type": "text/event-stream" },
  body: frames.join(""),
})

// ── anthropic ───────────────────────────────────────────────────────────────

/** An event of the content block: its start or its delta. */
interface ContentBlockEvent {
  readonly type: "content_block_start" | "content_block_delta"
  readonly index: number
  readonly content_block?: object
  readonly delta?: object
}

/** One Anthropic message stream: one content block's events, then a stop for `stopReason`. */
const anthropicReply = (content: ReadonlyArray<ContentBlockEvent>, stopReason: string) => {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_wire",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [],
        stop_reason: externalWireNull,
        stop_sequence: externalWireNull,
        usage: {
          input_tokens: 1,
          output_tokens: 0,
          cache_creation: externalWireNull,
          cache_creation_input_tokens: externalWireNull,
          cache_read_input_tokens: externalWireNull,
          inference_geo: externalWireNull,
          service_tier: externalWireNull,
        },
      },
    },
    ...content,
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: externalWireNull },
      usage: {
        output_tokens: 1,
        input_tokens: 1,
        cache_creation_input_tokens: externalWireNull,
        cache_read_input_tokens: externalWireNull,
      },
    },
    { type: "message_stop" },
  ]
  return eventStream(
    events.map((event) => `event: ${event.type}\ndata: ${encodeExternalJson(event)}\n\n`),
  )
}

const anthropicModel = Effect.gen(function* () {
  const credentialCellRef =
    yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL)
  const services = Context.add(
    yield* Effect.context<
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
    >(),
    AnthropicPlatform,
    AnthropicPlatform.of({
      platform: "darwin",
      home: "/nonexistent/gent-test-home",
      env: {},
    }),
  )
  const driver = buildAnthropicModelDriver(credentialCellRef, Option.none(), services, "1h")
  return yield* driver.resolveModel("claude-sonnet-4-5", apiKey)
}).pipe(Effect.provide(BunServices.layer))

// ── openai ──────────────────────────────────────────────────────────────────

const openaiEvents = (events: ReadonlyArray<object>) =>
  eventStream(events.map((event) => `data: ${encodeExternalJson(event)}\n\n`))

const openaiResponse = <O extends { readonly type: string }>(output: O) => ({
  id: "resp-wire",
  object: "response",
  created_at: 1700000000,
  model: "gpt-5.4",
  output: [output],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
})

const openaiToolCall = (name: string, input: Schema.Json = {}) => {
  const item = {
    type: "function_call",
    id: "fc-wire",
    call_id: "call-wire",
    name,
    arguments: encodeExternalJson(input),
    status: "completed",
  }
  return openaiEvents([
    {
      type: "response.output_item.done",
      sequence_number: 0,
      output_index: 0,
      item,
    },
    {
      type: "response.completed",
      sequence_number: 1,
      response: openaiResponse(item),
    },
  ])
}

const openaiText = (text: string) =>
  openaiEvents([
    {
      type: "response.output_text.delta",
      sequence_number: 0,
      item_id: "msg-wire",
      output_index: 0,
      content_index: 0,
      delta: text,
      logprobs: [],
    },
    {
      type: "response.completed",
      sequence_number: 1,
      response: openaiResponse({
        id: "msg-wire",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
      }),
    },
  ])

const openaiModel = Effect.gen(function* () {
  const credentialCellRef =
    yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL)
  const driver = buildOpenAIModelDriver(
    credentialCellRef,
    new Map(),
    Option.none(),
    yield* Crypto.Crypto,
  )
  return yield* driver.resolveModel("gpt-5.4", apiKey)
}).pipe(Effect.provide(BunServices.layer))

// ── chat completions ────────────────────────────────────────────────────────

const CHAT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"

/** One Chat Completions stream: each chunk's choice delta and finish reason, then `[DONE]`. */
const chatReply = (
  choices: ReadonlyArray<{ readonly delta: object; readonly finish_reason: Schema.Json }>,
) =>
  eventStream([
    ...choices.map(
      (choice) =>
        `data: ${encodeExternalJson({
          id: "chatcmpl-wire",
          object: "chat.completion.chunk",
          created: 1700000000,
          model: CHAT_MODEL,
          choices: [{ index: 0, ...choice }],
        })}\n\n`,
    ),
    "data: [DONE]\n\n",
  ])

const chatToolCall = (name: string, input: Schema.Json = {}) =>
  chatReply([
    {
      delta: {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call-wire",
            type: "function",
            function: { name, arguments: encodeExternalJson(input) },
          },
        ],
      },
      finish_reason: externalWireNull,
    },
    { delta: {}, finish_reason: "tool_calls" },
  ])

const chatText = (text: string) =>
  chatReply([
    { delta: { role: "assistant", content: text }, finish_reason: externalWireNull },
    { delta: {}, finish_reason: "stop" },
  ])

/** A Workers AI model: the shipped Chat Completions class, as models.dev lists it. */
const chatModel = resolveShipped(
  buildCloudflareModelDriver({
    token: Option.none(),
    accountId: Option.none(),
    gatewayId: Option.none(),
  }),
  modelCatalogFromBodies({
    chat: encodeExternalJson({
      "cloudflare-workers-ai": {
        npm: "@ai-sdk/openai-compatible",
        api: "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1",
        models: {
          [CHAT_MODEL]: {
            name: "Llama 3.3 70B Instruct fp8 Fast",
            reasoning: false,
            tool_call: true,
            temperature: true,
            limit: { context: 24000, output: 24000 },
          },
        },
      },
    }),
    decision: "{}",
  }),
  CHAT_MODEL,
  Option.some(
    ProviderAuthInfo.cases.Api.make({ key: "wire-test-key", metadata: { accountId: "acct-1" } }),
  ),
)

// ── the turn ────────────────────────────────────────────────────────────────

const Named = Schema.Struct({
  type: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
})
const Body = Schema.Struct({
  tools: Schema.optional(Schema.Array(Named)),
  messages: Schema.optional(
    Schema.Array(
      Schema.Struct({
        content: Schema.Union([Schema.String, Schema.Array(Named)]),
      }),
    ),
  ),
  input: Schema.optional(Schema.Array(Named)),
})
type Body = typeof Body.Type
const decodeBody = Schema.decodeUnknownSync(Schema.fromJsonString(Body))

const namesOf = (items: ReadonlyArray<typeof Named.Type>) =>
  items.flatMap((item) => Option.toArray(Option.fromUndefinedOr(item.name)))

const namesOfType = (items: ReadonlyArray<typeof Named.Type>, type: string) =>
  namesOf(items.filter((item) => item.type === type))

/** A tool call's start or success, as `<tag>:<tool id>`. */
const toolRun = (event: AgentEvent): ReadonlyArray<string> =>
  Match.value(event).pipe(
    Match.tags({
      ToolCallStarted: (started) => [`${started._tag}:${started.toolName}`],
      ToolCallSucceeded: (succeeded) => [`${succeeded._tag}:${succeeded.toolName}`],
    }),
    Match.orElse(() => []),
  )

interface WireCase {
  readonly provider: string
  readonly model: Effect.Effect<
    Layer.Layer<LanguageModel.LanguageModel>,
    ProviderAuthError | DriverError
  >
  /** A reply that calls the tool `name` with `input` (no input: `{}`). */
  readonly toolCall: (name: string, input?: Schema.Json) => FakeReply
  readonly text: (text: string) => FakeReply
  /** The tool names one request body's history calls. */
  readonly called: (body: Body) => ReadonlyArray<string>
}

const cases: ReadonlyArray<WireCase> = [
  {
    provider: "anthropic",
    model: anthropicModel,
    toolCall: (name, input = {}) =>
      anthropicReply(
        [
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "toolu_wire", name, input: {} },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: encodeExternalJson(input) },
          },
        ],
        "tool_use",
      ),
    text: (text) =>
      anthropicReply(
        [
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
        ],
        "end_turn",
      ),
    called: (body) =>
      (body.messages ?? []).flatMap((message) =>
        Match.value(message.content).pipe(
          Match.when(Predicate.isString, () => []),
          Match.orElse((blocks) => namesOfType(blocks, "tool_use")),
        ),
      ),
  },
  {
    provider: "openai",
    model: openaiModel,
    toolCall: openaiToolCall,
    text: openaiText,
    called: (body) => namesOfType(body.input ?? [], "function_call"),
  },
]

describe("tool names on the wire", () => {
  for (const wire of cases) {
    it.live(`${wire.provider}: a direct turn sends wire names and runs the gent tool`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const model = yield* wire.model
          const state = makeFakeFetchState()
          const providerLayer = Layer.provide(
            model,
            fakeFetchLayer(state, () => {
              // The first request's reply calls `delegate.list`; the next one ends the turn.
              if (state.captured.length === 1) return wire.toolCall("delegate__list")
              return wire.text("done")
            }),
          )
          const home = yield* makeTempDirectoryScoped("wire-names-")
          const cwd = yield* makeTempDirectoryScoped("wire-names-cwd-")
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            cwd,
            home,
          })
          const turn = yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.map((envelope) => envelope.event),
            Stream.takeUntil(Predicate.isTagged("TurnCompleted")),
            Stream.runCollect,
            Effect.forkScoped,
          )
          yield* client.message.send({
            sessionId,
            branchId,
            content: "list the delegates",
          })
          const events = Array.from(yield* Fiber.join(turn))

          const bodies = state.captured.map((request) => decodeBody(request.body ?? "{}"))
          expect(bodies).toHaveLength(2)
          for (const body of bodies) {
            const declared = namesOf(body.tools ?? [])
            expect(declared).toContain("session__send")
            expect(declared).toContain("delegate__start")
            expect(declared.filter((name) => !WIRE_NAME.test(name))).toEqual([])
          }
          // The second request replays the first call under its wire name.
          expect(wire.called(bodies[1] ?? {})).toEqual(["delegate__list"])
          // The stored events keep the gent id, and the call ran that tool.
          expect(events.flatMap(toolRun)).toEqual([
            "ToolCallStarted:delegate.list",
            "ToolCallSucceeded:delegate.list",
          ])
        }).pipe(Effect.timeout("20 seconds")),
      ),
    )
  }
})

// ── declarations and refused calls ──────────────────────────────────────────

/** Each shipped driver: one per SDK that writes tool declarations. */
const drivers: ReadonlyArray<Pick<WireCase, "provider" | "model" | "toolCall" | "text">> = [
  ...cases,
  { provider: "chat-completions", model: chatModel, toolCall: chatToolCall, text: chatText },
]

const Todo = Schema.Struct({ todo: Schema.String, done: Schema.Boolean })

/**
 * Tools whose parameters hold each schema shape a provider's declaration
 * codec rewrites: optional and nullable keys, literals, arrays, a nested
 * struct, a record, descriptions, and a dotted id.
 */
const declarationsExtension = (ran: Array<typeof Todo.Type>) =>
  defineExtension({
    id: "@gent/test/declarations",
    setup: Effect.gen(function* () {
      const host = yield* ExtensionHost
      yield* host.register(
        "tool",
        tool({
          id: "shapes",
          description: "Every shape",
          params: Schema.Struct({
            text: Schema.String.annotate({ description: "Free text" }),
            count: Schema.optional(Schema.Finite),
            mode: Schema.Literals(["fast", "slow"]),
            tags: Schema.Array(Schema.String),
            nested: Schema.Struct({ flag: Schema.Boolean }),
            note: Schema.optional(Schema.NullOr(Schema.String)),
            limits: Schema.Record(Schema.String, Schema.Finite),
          }),
          output: Schema.String,
          execute: () => Effect.succeed("shaped"),
        }),
        tool({
          id: "plain.note",
          description: "A dotted id",
          params: Schema.Struct({ text: Schema.String }),
          output: Schema.String,
          execute: () => Effect.succeed("noted"),
        }),
        tool({
          id: "todo",
          description: "Add a todo",
          params: Todo,
          output: Schema.String,
          execute: (input) => Effect.sync(() => ran.push(input)).pipe(Effect.as("added")),
        }),
      )
    }),
  })

const decodeJsonBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
)

/** The request body's fields as JSON. */
const jsonBody = (request: CapturedRequest) => decodeJsonBody(request.body ?? "{}")

/** A request body's `tools` and `tool_choice`, as sent. */
const declarationsOf = (body: Record<string, Schema.Json> = {}) =>
  encodeExternalJson({ tools: body["tools"], tool_choice: body["tool_choice"] })

/** What one turn runs with, beside the driver and `testTurnExtension`. */
interface TurnSetup {
  /** The agent; `testAgent` when absent. */
  readonly agent?: AgentDefinition
  /** The extensions that register tools; `declarationsExtension` when absent. */
  readonly extensions?: ReadonlyArray<GentExtension>
  /** The home directory; a new temporary one when absent. */
  readonly home?: string
  /** Receives each input the `todo` tool runs with. */
  readonly ran?: Array<typeof Todo.Type>
}

/** One turn through `wire`'s driver: the replies answer each request in order. */
const runTurn = (
  wire: (typeof drivers)[number],
  replies: ReadonlyArray<FakeReply>,
  setup: TurnSetup = {},
) =>
  Effect.gen(function* () {
    const model = yield* wire.model
    const state = makeFakeFetchState()
    const providerLayer = Layer.provide(
      model,
      fakeFetchLayer(state, (_request, call) => replies[call] ?? wire.text("unexpected")),
    )
    const cwd = yield* makeTempDirectoryScoped("wire-tools-cwd-")
    const home = yield* Option.match(Option.fromUndefinedOr(setup.home), {
      onNone: () => makeTempDirectoryScoped("wire-tools-home-"),
      onSome: Effect.succeed,
    })
    const { client, sessionId, branchId } = yield* createRpcHarness({
      agents: [setup.agent ?? testAgent],
      extensionInputs: [
        testTurnExtension,
        ...(setup.extensions ?? [declarationsExtension(setup.ran ?? [])]),
      ],
      providerLayer,
      cwd,
      home,
    })
    const turn = yield* client.session.events({ sessionId, branchId }).pipe(
      Stream.map((envelope) => envelope.event),
      Stream.takeUntil(Predicate.isTagged("TurnCompleted")),
      Stream.runCollect,
      Effect.forkScoped,
    )
    yield* client.message.send({ sessionId, branchId, content: "add a todo" })
    const events = Array.from(yield* Fiber.join(turn))
    return { bodies: state.captured.map(jsonBody), events }
  })

/**
 * The `tools` and `tool_choice` each driver sends for the tools above, as
 * sent. A change to how the turn builds its toolkit, or to a driver's
 * declaration codec, changes these bytes and the cached prefix with them.
 */
const PINNED_DECLARATIONS = new Map([
  [
    "anthropic",
    '{"tools":[{"name":"shapes","input_schema":{"type":"object","properties":{"text":{"type":"string","description":"Free text"},"count":{"anyOf":[{"anyOf":[{"type":"number"},{"type":"null"}]},{"type":"null"}]},"mode":{"type":"string","enum":["fast","slow"]},"tags":{"type":"array","items":{"type":"string"}},"nested":{"type":"object","properties":{"flag":{"type":"boolean"}},"required":["flag"],"additionalProperties":false},"note":{"anyOf":[{"anyOf":[{"anyOf":[{"type":"string"},{"type":"null"}]},{"type":"null"}]},{"type":"null"}]},"limits":{"type":"array","items":{"type":"object","properties":{"0":{"type":"string"},"1":{"type":"number"}},"required":["0","1"],"additionalProperties":false,"description":"Tuple encoded as an object with numeric string keys (\'0\', \'1\', ...). If present, \'__rest__\' contains remaining elements"},"description":"Object encoded as array of [key, value] pairs. Apply object constraints to the decoded object"}},"required":["text","count","mode","tags","nested","note","limits"],"additionalProperties":false},"description":"Every shape","strict":true},{"name":"plain__note","input_schema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false},"description":"A dotted id","strict":true},{"name":"todo","input_schema":{"type":"object","properties":{"todo":{"type":"string"},"done":{"type":"boolean"}},"required":["todo","done"],"additionalProperties":false},"description":"Add a todo","strict":true}],"tool_choice":{"type":"auto"}}',
  ],
  [
    "openai",
    '{"tools":[{"type":"function","name":"shapes","parameters":{"type":"object","properties":{"text":{"type":"string","description":"Free text"},"count":{"anyOf":[{"anyOf":[{"type":"number"},{"type":"null"}]},{"type":"null"}]},"mode":{"type":"string","enum":["fast","slow"]},"tags":{"type":"array","items":{"type":"string"}},"nested":{"type":"object","properties":{"flag":{"type":"boolean"}},"required":["flag"],"additionalProperties":false},"note":{"anyOf":[{"anyOf":[{"anyOf":[{"type":"string"},{"type":"null"}]},{"type":"null"}]},{"type":"null"}]},"limits":{"type":"array","items":{"type":"object","properties":{"0":{"type":"string"},"1":{"type":"number"}},"required":["0","1"],"additionalProperties":false,"description":"Tuple encoded as an object with numeric string keys (\'0\', \'1\', ...). If present, \'__rest__\' contains remaining elements"},"description":"Object encoded as array of [key, value] pairs. Apply object constraints to the decoded object"}},"required":["text","count","mode","tags","nested","note","limits"],"additionalProperties":false},"strict":true,"description":"Every shape"},{"type":"function","name":"plain__note","parameters":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false},"strict":true,"description":"A dotted id"},{"type":"function","name":"todo","parameters":{"type":"object","properties":{"todo":{"type":"string"},"done":{"type":"boolean"}},"required":["todo","done"],"additionalProperties":false},"strict":true,"description":"Add a todo"}],"tool_choice":"auto"}',
  ],
  [
    "chat-completions",
    '{"tools":[{"type":"function","function":{"name":"shapes","description":"Every shape","parameters":{"type":"object","properties":{"text":{"type":"string","description":"Free text"},"count":{"anyOf":[{"anyOf":[{"type":"number"},{"type":"null"}]},{"type":"null"}]},"mode":{"type":"string","enum":["fast","slow"]},"tags":{"type":"array","items":{"type":"string"}},"nested":{"type":"object","properties":{"flag":{"type":"boolean"}},"required":["flag"],"additionalProperties":false},"note":{"anyOf":[{"anyOf":[{"anyOf":[{"type":"string"},{"type":"null"}]},{"type":"null"}]},{"type":"null"}]},"limits":{"type":"array","items":{"type":"object","properties":{"0":{"type":"string"},"1":{"type":"number"}},"required":["0","1"],"additionalProperties":false,"description":"Tuple encoded as an object with numeric string keys (\'0\', \'1\', ...). If present, \'__rest__\' contains remaining elements"},"description":"Object encoded as array of [key, value] pairs. Apply object constraints to the decoded object"}},"required":["text","count","mode","tags","nested","note","limits"],"additionalProperties":false},"strict":false}},{"type":"function","function":{"name":"plain__note","description":"A dotted id","parameters":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false},"strict":false}},{"type":"function","function":{"name":"todo","description":"Add a todo","parameters":{"type":"object","properties":{"todo":{"type":"string"},"done":{"type":"boolean"}},"required":["todo","done"],"additionalProperties":false},"strict":false}}],"tool_choice":"auto"}',
  ],
])

describe("tool declarations on the wire", () => {
  for (const wire of drivers) {
    it.live(`${wire.provider}: a turn sends the pinned tool declarations`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { bodies } = yield* runTurn(wire, [wire.text("done")])
          expect(Option.some(declarationsOf(bodies[0]))).toEqual(
            Option.fromUndefinedOr(PINNED_DECLARATIONS.get(wire.provider)),
          )
        }).pipe(Effect.timeout("20 seconds")),
      ),
    )
  }
})

/** The agent whose first step is its last: that step runs with `toolChoice: "none"`. */
const oneStepAgent = AgentDefinition.make({
  name: testAgent.name,
  description: testAgent.description,
  maxSteps: 1,
})

/**
 * The `tools` and `tool_choice` each driver sends on a turn's last step for
 * the tools above. The OpenAI SDKs send the pinned declarations byte for
 * byte with `"none"`; the Anthropic SDK sends no tools.
 */
const withChoiceNone = (provider: string) =>
  PINNED_DECLARATIONS.get(provider)?.replace('"tool_choice":"auto"', '"tool_choice":"none"')
const PINNED_FINAL_STEP = new Map([
  ["anthropic", "{}"],
  ["openai", withChoiceNone("openai")],
  ["chat-completions", withChoiceNone("chat-completions")],
])

describe("final step declarations on the wire", () => {
  for (const wire of drivers) {
    it.live(`${wire.provider}: a turn's last step sends the pinned declarations`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { bodies } = yield* runTurn(wire, [wire.text("done")], { agent: oneStepAgent })
          expect(Option.some(declarationsOf(bodies[0]))).toEqual(
            Option.fromUndefinedOr(PINNED_FINAL_STEP.get(wire.provider)),
          )
        }).pipe(Effect.timeout("20 seconds")),
      ),
    )
  }
})

/** Each refused call: the input or name the model sent, and what its failed result names. */
const REFUSED: ReadonlyArray<{
  readonly label: string
  readonly name: string
  readonly input: Schema.Json
  readonly names: ReadonlyArray<string>
}> = [
  {
    label: "a wrong-typed input",
    name: "todo",
    input: { todo: 42, done: false },
    names: ["Tool 'todo' input failed", "todo"],
  },
  {
    label: "a missing required key",
    name: "todo",
    input: { todo: "milk" },
    names: ["Tool 'todo' input failed", "done"],
  },
  {
    label: "a tool no extension registers",
    name: "nowhere",
    input: { todo: "milk" },
    names: ["Unknown tool: nowhere"],
  },
]

describe("refused tool calls on the wire", () => {
  for (const wire of drivers) {
    for (const refused of REFUSED) {
      it.live(`${wire.provider}: ${refused.label} fails as its result and the turn goes on`, () =>
        Effect.scoped(
          Effect.gen(function* () {
            const ran: Array<typeof Todo.Type> = []
            const { bodies, events } = yield* runTurn(
              wire,
              [wire.toolCall(refused.name, refused.input), wire.text("done")],
              { ran },
            )
            // The failed result went back to the model in the next request.
            expect(bodies).toHaveLength(2)
            const failed = events.flatMap((event) =>
              Match.value(event).pipe(
                Match.tags({ ToolCallFailed: (call) => [call] }),
                Match.orElse(() => []),
              ),
            )
            expect(failed.map((event) => event.toolName)).toEqual([refused.name])
            for (const text of refused.names) {
              expect(failed[0]?.output ?? "").toContain(text)
              expect(encodeExternalJson(bodies[1] ?? {})).toContain(text)
            }
            expect(ran).toEqual([])
            expect(events.filter(Predicate.isTagged("ProviderRetrying"))).toEqual([])
            expect(events.filter(Predicate.isTagged("TurnCompleted"))).toMatchObject([
              { streamFailed: false },
            ])
          }).pipe(Effect.timeout("20 seconds")),
        ),
      )
    }
  }
})
