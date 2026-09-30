/**
 * Tool names on the wire. Gent tool ids hold dots (`session.send`,
 * `delegate.start`); Anthropic and OpenAI take only `[a-zA-Z0-9_-]` names.
 * A direct turn (no cell) through each real driver sends wire names in its
 * tool declarations and history, and the call it reads back runs the gent tool.
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
import { type CredentialCacheCell, EMPTY_CREDENTIAL_CELL } from "../src/providers.js"
import { type ProviderAuthError, ProviderAuthInfo } from "@gent/core/extensions/api"
import {
  createRpcHarness,
  fakeFetchLayer,
  makeFakeFetchState,
  makeTempDirectoryScoped,
} from "@gent/core/test-utils"
import type { AgentEvent } from "@gent/core/protocol"
import { e2ePreset } from "./helpers/test-preset.js"
import { encodeExternalJson, externalWireNull } from "./helpers/external-wire.js"
import { testCatalogSource } from "./helpers/catalog-source.js"

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
  const driver = buildAnthropicModelDriver(
    credentialCellRef,
    Option.none(),
    services,
    testCatalogSource(),
    "1h",
  )
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

const openaiToolCall = (name: string) => {
  const item = {
    type: "function_call",
    id: "fc-wire",
    call_id: "call-wire",
    name,
    arguments: "{}",
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
    testCatalogSource(),
    yield* Crypto.Crypto,
  )
  return yield* driver.resolveModel("gpt-5.4", apiKey)
}).pipe(Effect.provide(BunServices.layer))

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
  readonly model: Effect.Effect<Layer.Layer<LanguageModel.LanguageModel>, ProviderAuthError>
  readonly toolCall: (name: string) => FakeReply
  readonly text: (text: string) => FakeReply
  /** The tool names one request body's history calls. */
  readonly called: (body: Body) => ReadonlyArray<string>
}

const cases: ReadonlyArray<WireCase> = [
  {
    provider: "anthropic",
    model: anthropicModel,
    toolCall: (name) =>
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
            delta: { type: "input_json_delta", partial_json: "{}" },
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
