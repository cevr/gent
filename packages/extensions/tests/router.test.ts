/**
 * @gent/router: virtual models from the config files. The classifier is a
 * scripted decision model behind a test driver, and the chat model is
 * scripted or the real Anthropic driver over a fake fetch: no test reaches a
 * provider.
 */
import { describe, expect, it } from "effect-bun-test"
import {
  Context,
  type Crypto,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Ref,
  Schema,
  Stream,
  SynchronizedRef,
} from "effect"
import { BunServices } from "@effect/platform-bun"
import { DecisionModel, LanguageModel, type Prompt } from "effect/ai"
import type { ChildProcessSpawner } from "effect/process"
import {
  type BranchId,
  defineExtension,
  ExtensionHost,
  Model,
  ModelId,
  type ModelDriverContribution,
  ProviderAuthInfo,
  ProviderId,
  type ProviderHints,
  ReasoningEffort,
  type SessionId,
} from "@gent/core/extensions/api"
import type { AgentEvent } from "@gent/core/protocol"
import {
  collectTestContributions,
  createRpcHarness,
  fixtureModelCatalog,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  type SequenceStep,
  textStep,
  waitFor,
} from "@gent/core/test-utils"
import {
  AnthropicPlatform,
  buildAnthropicModelDriver,
  type ClaudeCredentials,
} from "../src/anthropic.js"
import { type CredentialCacheCell, EMPTY_CREDENTIAL_CELL } from "../src/providers.js"
import { RouterExtension } from "../src/router.js"
import { encodeExternalJson, externalWireNull } from "./helpers/external-wire.js"
import { fakeFetchLayer, makeFakeFetchState } from "./helpers/fake-http-client.js"
import { e2ePreset } from "./helpers/test-preset.js"

const LIGHT = ModelId.make("anthropic/claude-haiku-4-5")
const STRONG = ModelId.make("anthropic/claude-sonnet-5")
const AUTO = ModelId.make("router/auto")

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

// ── classifier ──────────────────────────────────────────────────────────────

interface JudgeAnswer {
  readonly label: string
  readonly confidence: number
}

/** What the judge was asked: the classifier model, the encoded input and the labels offered. */
interface JudgeCall {
  readonly model: string
  readonly state: string
  readonly labels: ReadonlyArray<string>
}

/**
 * A classifier driver, `route-judge`, with a cheap and a dear model. Call
 * `n` answers `answers[n]` (the last answer after the list), at 21 input
 * tokens; `calls` records each one.
 */
const judgeExtension = (answers: ReadonlyArray<JudgeAnswer>, calls: Array<JudgeCall>) => {
  const classifier = (name: string, price: number) =>
    Model.make({
      id: ModelId.make(`route-judge/${name}`),
      name,
      provider: ProviderId.make("route-judge"),
      kind: "classifier",
      pricing: { input: price, output: price },
    })
  const driver: ModelDriverContribution = {
    id: "route-judge",
    name: "Route judge",
    envCredential: "GENT_TEST_ROUTE_JUDGE_KEY_NEVER_SET",
    resolveModel: () => Effect.die("the route judge serves classifiers only"),
    listModels: () => Effect.succeed([classifier("jev-dear", 2), classifier("jev-cheap", 0.1)]),
    resolveDecisionModel: (modelName) =>
      Effect.succeed(
        Layer.effect(
          DecisionModel.DecisionModel,
          DecisionModel.make({
            decide: (options) =>
              Effect.sync(() => {
                const answer = answers[calls.length] ?? answers.at(-1)
                const decision = options.decisions["choice"]
                let labels: ReadonlyArray<string> = []
                if (decision?._tag === "Classify") labels = Object.keys(decision.criteria)
                calls.push({ model: modelName, state: encodeJson(options.state), labels })
                const label = answer?.label ?? ""
                return {
                  answers: {
                    choice: {
                      _tag: "Classify" as const,
                      label,
                      probabilities: Object.fromEntries(
                        labels.map((entry) => [entry, Number(entry === label)]),
                      ),
                      confidence: answer?.confidence ?? 0,
                    },
                  },
                  usage: { inputTokens: 21, outputTokens: 0 },
                }
              }),
          }),
        ),
      ),
  }
  return defineExtension({
    id: "route-judge",
    setup: Effect.gen(function* () {
      yield* (yield* ExtensionHost).register("modelDriver", driver)
    }),
  })
}

// ── fixtures ────────────────────────────────────────────────────────────────

/** A `routers` entry as a config file holds it. */
interface RouterJson {
  readonly label?: string
  readonly classifier?: string
  readonly choices: ReadonlyArray<{
    readonly model?: string
    readonly reason: string
    readonly effort?: string
    readonly default?: boolean
  }>
}

/** The config file keys these tests write. */
interface ConfigJson {
  readonly routers?: Readonly<Record<string, RouterJson>>
  readonly trustedProjects?: ReadonlyArray<string>
}

/** A home whose `~/.gent/config.json` holds `config`, and a project directory. */
const writeHome = Effect.fn("test.writeHome")(function* (config: ConfigJson) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = yield* makeTempDirectoryScoped("gent-router-home-")
  const cwd = yield* makeTempDirectoryScoped("gent-router-cwd-")
  yield* fs.makeDirectory(path.join(home, ".gent"), { recursive: true })
  yield* fs.writeFileString(path.join(home, ".gent", "config.json"), encodeExternalJson(config))
  return { home, cwd }
})

/** `router/auto`: light (the default) for light work, strong for hard work. */
const autoRouter = (classifier: Option.Option<string>): ConfigJson => ({
  routers: {
    auto: {
      label: "Auto",
      choices: [
        { model: LIGHT, reason: "light work: quick questions", default: true },
        { model: STRONG, reason: "hard work: design and debugging" },
      ],
      ...Option.match(classifier, { onNone: () => ({}), onSome: (id) => ({ classifier: id }) }),
    },
  },
})

/** Catalog entries for the two chat models, at Anthropic-shaped prices. */
const pricedModels = [
  Model.make({
    id: LIGHT,
    name: "Haiku",
    provider: ProviderId.make("anthropic"),
    contextLength: 200_000,
    pricing: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  }),
  Model.make({
    id: STRONG,
    name: "Sonnet 5",
    provider: ProviderId.make("anthropic"),
    contextLength: 200_000,
    pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  }),
]

type ModelRouted = Extract<AgentEvent, { readonly _tag: "ModelRouted" }>

const routedEvents = (events: ReadonlyArray<AgentEvent>): ReadonlyArray<ModelRouted> =>
  events.flatMap((event) => {
    if (event._tag !== "ModelRouted") return []
    return [event]
  })

const stepModels = (events: ReadonlyArray<AgentEvent>) =>
  events.flatMap((event) => {
    if (event._tag !== "StreamEnded") return []
    return [event.model]
  })

type RouterClient = Effect.Success<ReturnType<typeof createRpcHarness>>["client"]

/** Every event of the branch from its first; read once `turns` turns ended. */
const recordBranchEvents = Effect.fn("test.recordBranchEvents")(function* (
  client: RouterClient,
  run: { readonly sessionId: SessionId; readonly branchId: BranchId },
) {
  const seen = yield* Ref.make<ReadonlyArray<AgentEvent>>([])
  yield* client.session.events({ ...run, after: 0 }).pipe(
    Stream.runForEach(({ event }) => Ref.update(seen, (all) => [...all, event])),
    Effect.forkScoped,
  )
  return (turns: number) =>
    waitFor(
      Ref.get(seen),
      (events) => events.filter((event) => event._tag === "TurnCompleted").length >= turns,
      12_000,
      `${turns} completed turn(s)`,
    )
})

/** A session in `home`/`cwd` with the shipped extensions, the judge, and the scripted model. */
const routedSession = Effect.fn("test.routedSession")(function* (params: {
  readonly home: string
  readonly cwd: string
  readonly answers: ReadonlyArray<JudgeAnswer>
  readonly calls: Array<JudgeCall>
  readonly replies: number
  readonly models?: ReadonlyArray<Model>
}) {
  const { layer: providerLayer } = yield* LanguageModelLayers.sequence(
    Array.from({ length: params.replies }, (_, index) => textStep(`reply ${index + 1}`)),
  )
  const harness = yield* createRpcHarness({
    ...e2ePreset,
    providerLayer,
    home: params.home,
    cwd: params.cwd,
    extensionInputs: [...e2ePreset.extensionInputs, judgeExtension(params.answers, params.calls)],
    ...Option.match(Option.fromUndefinedOr(params.models), {
      onNone: () => ({}),
      onSome: (models) => ({ models }),
    }),
  })
  yield* harness.client.auth.setKey({
    provider: "route-judge",
    key: "test-key",
    sessionId: harness.sessionId,
  })
  yield* harness.client.session.updateSettings({
    sessionId: harness.sessionId,
    modelId: Option.some(AUTO),
    reasoningLevel: Option.none(),
  })
  const afterTurns = yield* recordBranchEvents(harness.client, harness)
  const send = (content: string) =>
    harness.client.message.send({
      sessionId: harness.sessionId,
      branchId: harness.branchId,
      content,
    })
  return { ...harness, afterTurns, send }
})

// ── config ──────────────────────────────────────────────────────────────────

describe("router config", () => {
  it.scopedLive(
    "a config router is a model the catalog lists by its label; a turn on it runs the classifier's pick",
    () =>
      Effect.gen(function* () {
        const { home, cwd } = yield* writeHome(autoRouter(Option.none()))
        const calls: Array<JudgeCall> = []
        const session = yield* routedSession({
          home,
          cwd,
          answers: [{ label: "choice2", confidence: 0.9 }],
          calls,
          replies: 1,
        })
        const models = yield* session.client.model.list({ sessionId: session.sessionId })
        expect(models.find((model) => model.id === AUTO)).toMatchObject({
          name: "Auto",
          kind: "virtual",
        })
        // A long request reaches the classifier head and tail, within its bound.
        const request = `please redesign the parser ${"x".repeat(10_000)} and debug the lexer`
        yield* session.send(request)
        const events = yield* session.afterTurns(1)
        const [routed] = routedEvents(events)
        // No classifier named: the cheapest one with a credential.
        expect(routed).toMatchObject({
          selected: AUTO,
          model: STRONG,
          choice: 1,
          classifier: "route-judge/jev-cheap",
        })
        expect(routed?.reason).toContain("hard work")
        expect(routed?.costUsd).toBeCloseTo((21 * 0.1) / 1_000_000, 12)
        expect(stepModels(events)).toEqual([STRONG])
        expect(calls.map((call) => call.model)).toEqual(["jev-cheap"])
        const state = calls[0]?.state ?? ""
        expect(state.length).toBeLessThan(4_200)
        expect(state).toContain("please redesign the parser")
        expect(state).toContain("debug the lexer")
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(BunServices.layer)),
    20_000,
  )

  it.scopedLive(
    "a router with two default choices is refused: the catalog omits it, health and a turn on it say why",
    () =>
      Effect.gen(function* () {
        const { home, cwd } = yield* writeHome({
          routers: {
            auto: {
              choices: [
                { model: LIGHT, reason: "light", default: true },
                { model: STRONG, reason: "hard", default: true },
              ],
            },
          },
        })
        const session = yield* routedSession({
          home,
          cwd,
          answers: [{ label: "choice1", confidence: 0.9 }],
          calls: [],
          replies: 0,
        })
        const models = yield* session.client.model.list({ sessionId: session.sessionId })
        expect(models.some((model) => model.id === AUTO)).toBe(false)
        // Health names the bad entry under the router's extension, as it does a failed catalog.
        const status = yield* session.client.extension.listStatus({
          scope: { _tag: "Session", id: session.sessionId },
        })
        expect(status._tag).toBe("Degraded")
        if (status._tag !== "Degraded") return
        expect(
          status.degradedExtensions
            .filter((extension) => extension.manifest.id === "@gent/router")
            .flatMap((extension) => extension.issues),
        ).toEqual([
          {
            _tag: "ModelCatalogFailed",
            driverId: "router",
            error: `${AUTO}: choices 1 and 2 are each marked "default": true; mark one`,
          },
        ])
        yield* session.send("route me")
        const events = yield* session.afterTurns(1)
        expect(
          events.flatMap((event) => {
            if (event._tag !== "ErrorOccurred") return []
            return [event.error]
          }),
        ).toEqual([
          `Model router "${AUTO}": choices 1 and 2 are each marked "default": true; mark one`,
        ])
        expect(routedEvents(events)).toEqual([])
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(BunServices.layer)),
    20_000,
  )

  it.scopedLive(
    "a project's routers count only in a trusted project, and shadow the user's by name",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const { home, cwd } = yield* writeHome(autoRouter(Option.none()))
        yield* fs.makeDirectory(path.join(cwd, ".gent"), { recursive: true })
        yield* fs.writeFileString(
          path.join(cwd, ".gent", "config.json"),
          encodeJson({
            routers: { auto: { label: "Project", choices: [{ model: STRONG, reason: "all" }] } },
          }),
        )
        const labels = Effect.map(
          collectTestContributions(RouterExtension.setup, { home, cwd }),
          (contributions) =>
            (contributions.modelRouters ?? []).flatMap((router) =>
              router.models.map((model) => model.label),
            ),
        )
        expect(yield* labels).toEqual(["Auto"])
        const userConfig = path.join(home, ".gent", "config.json")
        yield* fs.writeFileString(
          userConfig,
          encodeExternalJson({
            ...autoRouter(Option.none()),
            trustedProjects: [yield* fs.realPath(cwd)],
          }),
        )
        expect(yield* labels).toEqual(["Project"])
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(BunServices.layer)),
    20_000,
  )
})

// ── stickiness ──────────────────────────────────────────────────────────────

describe("router stickiness", () => {
  it.scopedLive(
    "a warm model holds against a stronger pick the classifier is unsure of, and moves when it is sure",
    () =>
      Effect.gen(function* () {
        const { home, cwd } = yield* writeHome(autoRouter(Option.some("route-judge/jev-cheap")))
        const session = yield* routedSession({
          home,
          cwd,
          answers: [
            { label: "choice1", confidence: 0.9 },
            { label: "choice2", confidence: 0.5 },
            { label: "choice2", confidence: 0.8 },
          ],
          calls: [],
          replies: 3,
          models: pricedModels,
        })
        yield* session.send("a quick question")
        yield* session.afterTurns(1)
        yield* session.send("maybe something harder")
        yield* session.afterTurns(2)
        yield* session.send("now a real design problem")
        const events = yield* session.afterTurns(3)
        expect(routedEvents(events).map((event) => event.model)).toEqual([LIGHT, LIGHT, STRONG])
        expect(routedEvents(events)[1]?.reason).toContain("held anthropic/claude-haiku-4-5")
        expect(stepModels(events)).toEqual([LIGHT, LIGHT, STRONG])
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(BunServices.layer)),
    20_000,
  )

  it.scopedLive(
    "a cheaper pick moves off a warm model only while the history it rewrites costs less than it saves",
    () =>
      Effect.gen(function* () {
        const { home, cwd } = yield* writeHome(autoRouter(Option.some("route-judge/jev-cheap")))
        const answers = [
          { label: "choice2", confidence: 0.9 },
          { label: "choice1", confidence: 0.9 },
        ]
        // A short history: rewriting it on the cheap model pays at once.
        const short = yield* routedSession({
          home,
          cwd,
          answers,
          calls: [],
          replies: 2,
          models: pricedModels,
        })
        yield* short.send("design the parser")
        yield* short.afterTurns(1)
        yield* short.send("thanks")
        const moved = yield* short.afterTurns(2)
        expect(routedEvents(moved).map((event) => event.model)).toEqual([STRONG, LIGHT])

        // 60,000 history tokens: the rewrite costs more than the turn saves.
        const long = yield* routedSession({
          home,
          cwd,
          answers,
          calls: [],
          replies: 2,
          models: pricedModels,
        })
        yield* long.send(`design the parser for this grammar: ${"rule ".repeat(48_000)}`)
        yield* long.afterTurns(1)
        yield* long.send("thanks")
        const held = yield* long.afterTurns(2)
        expect(routedEvents(held).map((event) => event.model)).toEqual([STRONG, STRONG])
        expect(routedEvents(held)[1]?.reason).toContain("costs more than the switch saves")
      }).pipe(Effect.timeout("20 seconds"), Effect.provide(BunServices.layer)),
    25_000,
  )

  it.scopedLive(
    "a choice that differs only in effort is no switch: the model and its notice stay",
    () =>
      Effect.gen(function* () {
        const { home, cwd } = yield* writeHome({
          routers: {
            auto: {
              classifier: "route-judge/jev-cheap",
              choices: [
                { model: STRONG, effort: "high", reason: "hard work", default: true },
                { effort: "low", reason: "quick follow-ups" },
              ],
            },
          },
        })
        const session = yield* routedSession({
          home,
          cwd,
          answers: [
            { label: "choice1", confidence: 0.9 },
            { label: "choice2", confidence: 0.3 },
          ],
          calls: [],
          replies: 2,
          models: pricedModels,
        })
        yield* session.send("design the parser")
        yield* session.afterTurns(1)
        yield* session.send("and rename it")
        const events = yield* session.afterTurns(2)
        expect(
          routedEvents(events).map((event) => [event.model, event.choice, event.effort]),
        ).toEqual([
          [STRONG, 0, "high"],
          [STRONG, 1, "low"],
        ])
        const messages = yield* session.client.message.list({ branchId: session.branchId })
        expect(messages.some((message) => message.metadata?.customType === "model-change")).toBe(
          false,
        )
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(BunServices.layer)),
    20_000,
  )
})

// ── effort auto ─────────────────────────────────────────────────────────────

const EFFORT = ModelId.make("router/effort")

/** The default model as a reasoning model of `efforts` that carries an effort change. */
const thinkerOf = (efforts: ReadonlyArray<ReasoningEffort>) =>
  Model.make({
    id: STRONG,
    name: "Sonnet 5",
    provider: ProviderId.make("anthropic"),
    contextLength: 200_000,
    reasoning: true,
    efforts,
    carriesEffort: true,
  })

/** A session on `/effort auto` with the shipped extensions, the judge, and the scripted model. */
const autoEffortSession = Effect.fn("test.autoEffortSession")(function* (params: {
  readonly home: string
  readonly cwd: string
  readonly answers: ReadonlyArray<JudgeAnswer>
  readonly calls: Array<JudgeCall>
  readonly model: Model
}) {
  const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("reply")])
  const harness = yield* createRpcHarness({
    ...e2ePreset,
    providerLayer,
    home: params.home,
    cwd: params.cwd,
    models: [params.model],
    extensionInputs: [...e2ePreset.extensionInputs, judgeExtension(params.answers, params.calls)],
  })
  yield* harness.client.auth.setKey({
    provider: "route-judge",
    key: "test-key",
    sessionId: harness.sessionId,
  })
  yield* harness.client.session.updateSettings({
    sessionId: harness.sessionId,
    reasoningLevel: Option.some("auto"),
  })
  const afterTurns = yield* recordBranchEvents(harness.client, harness)
  yield* harness.client.message.send({
    sessionId: harness.sessionId,
    branchId: harness.branchId,
    content: "debug the flaky scheduler",
  })
  return { ...harness, events: yield* afterTurns(1) }
})

const stepLevels = (events: ReadonlyArray<AgentEvent>) =>
  events.flatMap((event) => {
    if (event._tag !== "StreamEnded") return []
    return [event.reasoningLevel]
  })

describe("effort auto", () => {
  it.scopedLive(
    "with no effort entry, /effort auto asks the cheapest classifier between the built-in levels the model takes",
    () =>
      Effect.gen(function* () {
        const { home, cwd } = yield* writeHome({})
        const calls: Array<JudgeCall> = []
        const session = yield* autoEffortSession({
          home,
          cwd,
          answers: [{ label: "choice3", confidence: 0.9 }],
          calls,
          // No xhigh: the built-in xhigh choice is not offered.
          model: thinkerOf(["low", "medium", "high"]),
        })
        expect(calls.map((call) => [call.model, call.labels])).toEqual([
          ["jev-cheap", ["choice1", "choice2", "choice3"]],
        ])
        const [routed] = routedEvents(session.events)
        expect(routed).toMatchObject({
          selected: EFFORT,
          model: STRONG,
          effort: "high",
          choice: 2,
          effortOnly: true,
          classifier: "route-judge/jev-cheap",
        })
        expect(routed?.reason).toContain("hard work")
        expect(stepLevels(session.events)).toEqual(["high"])
        // The effort router is not a model: the catalog does not list it.
        const models = yield* session.client.model.list({ sessionId: session.sessionId })
        expect(models.some((model) => model.id === EFFORT)).toBe(false)
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(BunServices.layer)),
    20_000,
  )

  it.scopedLive(
    "an effort entry replaces the built-in levels; one that names a model is refused, health says why, and auto runs at the agent's level",
    () =>
      Effect.gen(function* () {
        const configured = yield* writeHome({
          routers: {
            effort: {
              classifier: "route-judge/jev-dear",
              choices: [
                { effort: "low", reason: "chat" },
                { effort: "max", reason: "deep work", default: true },
              ],
            },
          },
        })
        const calls: Array<JudgeCall> = []
        const session = yield* autoEffortSession({
          ...configured,
          answers: [{ label: "choice2", confidence: 0.9 }],
          calls,
          model: thinkerOf(["low", "medium", "high", "xhigh", "max"]),
        })
        expect(calls.map((call) => [call.model, call.labels])).toEqual([
          ["jev-dear", ["choice1", "choice2"]],
        ])
        expect(routedEvents(session.events).map((event) => event.effort)).toEqual(["max"])
        expect(stepLevels(session.events)).toEqual(["max"])

        const refused = yield* writeHome({
          routers: {
            effort: { choices: [{ model: STRONG, effort: "low", reason: "chat" }] },
          },
        })
        const unrouted = yield* autoEffortSession({
          ...refused,
          answers: [{ label: "choice1", confidence: 0.9 }],
          calls: [],
          model: thinkerOf(["low", "medium", "high"]),
        })
        const status = yield* unrouted.client.extension.listStatus({
          scope: { _tag: "Session", id: unrouted.sessionId },
        })
        expect(status._tag).toBe("Degraded")
        if (status._tag !== "Degraded") return
        expect(
          status.degradedExtensions
            .filter((extension) => extension.manifest.id === "@gent/router")
            .flatMap((extension) => extension.issues),
        ).toEqual([
          {
            _tag: "ModelCatalogFailed",
            driverId: "router",
            error: `${EFFORT}: choice 1 names a model; an effort choice sets only an effort`,
          },
        ])
        expect(routedEvents(unrouted.events)).toEqual([])
        // The main agent's own level.
        expect(stepLevels(unrouted.events)).toEqual(["high"])
      }).pipe(Effect.timeout("20 seconds"), Effect.provide(BunServices.layer)),
    25_000,
  )
})

// ── the wire ────────────────────────────────────────────────────────────────

/** One server-sent event of the Messages stream: its type, and its fields as the wire has them. */
type WireEvent = Schema.JsonObject & { readonly type: string }

const sse = (events: ReadonlyArray<WireEvent>) => ({
  status: 200,
  headers: { "content-type": "text/event-stream" },
  body: events
    .map((event) => `event: ${event.type}\ndata: ${encodeExternalJson(event)}\n\n`)
    .join(""),
})

/** One Anthropic message stream of one content block, then its stop. */
const anthropicReply = (
  block: Schema.JsonObject,
  delta: Schema.JsonObject,
  stopReason: "end_turn" | "tool_use",
) =>
  sse([
    {
      type: "message_start",
      message: {
        id: "msg_route",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
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
    { type: "content_block_start", index: 0, content_block: block },
    { type: "content_block_delta", index: 0, delta },
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
  ])

const textReply = (text: string) =>
  anthropicReply({ type: "text", text: "" }, { type: "text_delta", text }, "end_turn")

const toolReply = (name: string) =>
  anthropicReply(
    { type: "tool_use", id: "toolu_route", name, input: {} },
    { type: "input_json_delta", partial_json: "{}" },
    "tool_use",
  )

/**
 * The real Anthropic driver on an API key, for a 4.6-or-later model, with
 * the hints a turn resolves it with, read against the fixture catalog.
 */
const anthropicModelNamed = Effect.fn("test.anthropicModelNamed")(function* (
  modelName: string,
  hints: Option.Option<ProviderHints> = Option.none(),
) {
  const credentialCellRef =
    yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL)
  const services = Context.add(
    yield* Effect.context<
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
    >(),
    AnthropicPlatform,
    AnthropicPlatform.of({ platform: "darwin", home: "/nonexistent/gent-test-home", env: {} }),
  )
  const driver = buildAnthropicModelDriver(credentialCellRef, Option.none(), services, "1h")
  return yield* driver.resolveModel(
    modelName,
    ProviderAuthInfo.cases.Api.make({ key: "route-test-key" }),
    Option.getOrUndefined(hints),
    fixtureModelCatalog(),
  )
}, Effect.provide(BunServices.layer))

const anthropicModel = anthropicModelNamed("claude-sonnet-5")

const WireMessage = Schema.Struct({
  role: Schema.String,
  content: Schema.Union([Schema.String, Schema.Array(Schema.Struct({ type: Schema.String }))]),
})
const decodeMessages = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ messages: Schema.Array(WireMessage) })),
)

const OPUS = ModelId.make("anthropic/claude-opus-5")
const MID_CONVERSATION_BETA = "mid-conversation-output-config-2026-07-01"

const isReasoningEffort = Schema.is(ReasoningEffort)

/** What one step of a turn sent: the hints it resolved its model with, and its prompt. */
interface SentStep {
  readonly reasoning: Option.Option<ReasoningEffort>
  readonly maxTokens: Option.Option<number>
  readonly reasoningHistory: ReadonlyArray<Option.Option<ReasoningEffort>>
  readonly prompt: Option.Option<Prompt.Prompt>
}

const decodeJsonBody = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))
const isJsonObject = Schema.is(Schema.Record(Schema.String, Schema.Json))
const isJsonList = Schema.is(Schema.Array(Schema.Json))

/** A request's JSON body; a body that is not an object fails the test. */
const decodeWireBody = (body: string): Schema.JsonObject =>
  Option.getOrThrow(Option.filter(Option.some(decodeJsonBody(body)), isJsonObject))

/** The value without its `cache_control` fields: the cache matches the content, and the tail marker moves. */
const withoutCacheControl = (value: Schema.Json): Schema.Json => {
  if (isJsonList(value)) return value.map(withoutCacheControl)
  if (!isJsonObject(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "cache_control")
      .map(([key, item]) => [key, withoutCacheControl(item)] as const),
  )
}

const withoutMessages = (body: Schema.JsonObject): Schema.Json =>
  Object.fromEntries(Object.entries(body).filter(([key]) => key !== "messages"))

/** The body's messages, without cache markers. */
const wireMessages = (body: Schema.JsonObject): Array<Schema.Json> => {
  const messages = body["messages"]
  if (!isJsonList(messages)) return []
  return messages.map(withoutCacheControl)
}

/** A message by its role; an effort marker as `effort:<level>`. */
const messageKind = (message: Schema.Json): string => {
  if (!isJsonObject(message)) return "?"
  const config = message["output_config"]
  if (isJsonObject(config) && Predicate.isString(config["effort"]))
    return `effort:${config["effort"]}`
  const role = message["role"]
  if (Predicate.isString(role)) return role
  return "?"
}

/** The effort the body's top level names. */
const topLevelEffort = (body: Schema.JsonObject): string => {
  const config = body["output_config"]
  if (isJsonObject(config) && Predicate.isString(config["effort"])) return config["effort"]
  return "-"
}

/** Each step's hints and prompt, kept from the scripted model for the real driver. */
const keepSentSteps = () => {
  const sent: Array<SentStep> = []
  const keep = (reply: string): SequenceStep => ({
    ...textStep(reply),
    assertRequest: (request) => {
      sent.push({
        reasoning: Option.filter(Option.fromUndefinedOr(request.reasoning), isReasoningEffort),
        maxTokens: Option.fromUndefinedOr(request.maxTokens),
        reasoningHistory: request.reasoningHistory.map(Option.filter(isReasoningEffort)),
        prompt: Option.none(),
      })
    },
    assertOptions: (options) => {
      const step = sent.at(-1)
      if (Predicate.isNotUndefined(step))
        sent[sent.length - 1] = { ...step, prompt: Option.some(options.prompt) }
    },
  })
  return { sent, keep }
}

/** What the real Anthropic driver sends on Opus 5 for each kept step, with the hints the turn resolved. */
const replayOnOpus = Effect.fn("test.replayOnOpus")(function* (
  sent: ReadonlyArray<SentStep>,
  cacheKey: string,
) {
  const state = makeFakeFetchState()
  for (const step of sent) {
    const hints: ProviderHints = {
      cacheKey,
      supportsReasoning: true,
      reasoningHistory: step.reasoningHistory,
      ...Option.match(step.reasoning, {
        onNone: () => ({}),
        onSome: (reasoning) => ({ reasoning }),
      }),
      ...Option.match(step.maxTokens, {
        onNone: () => ({}),
        onSome: (maxTokens) => ({ maxTokens }),
      }),
    }
    const model = yield* anthropicModelNamed("claude-opus-5", Option.some(hints))
    yield* LanguageModel.streamText({ prompt: Option.getOrThrow(step.prompt) }).pipe(
      Stream.runDrain,
      Effect.provide(
        Layer.provideMerge(
          model,
          fakeFetchLayer(state, () => textReply("answer")),
        ),
      ),
    )
  }
  return state.captured
})

/**
 * The bytes a cache keeps across an effort change carried inside the
 * conversation: the second request's top level and earlier messages are the
 * first's, and the change rides as a marker after the run before it.
 */
const expectEffortRidesInside = (
  captured: ReadonlyArray<{
    readonly body?: string
    readonly headers: Readonly<Record<string, string>>
  }>,
  first: string,
  then: string,
) => {
  expect(captured).toHaveLength(2)
  const bodies = captured.map((request) => decodeWireBody(request.body ?? ""))
  const at = (index: number) => Option.getOrThrow(Option.fromUndefinedOr(bodies[index]))
  const opening = at(0)
  const next = at(1)
  // The top level keeps the conversation's first effort: the cache holds.
  expect(topLevelEffort(next)).toBe(first)
  expect(withoutCacheControl(withoutMessages(next))).toEqual(
    withoutCacheControl(withoutMessages(opening)),
  )
  const earlier = wireMessages(opening)
  expect(wireMessages(next).slice(0, earlier.length)).toEqual(earlier)
  expect(wireMessages(next).map(messageKind)).toEqual([
    "user",
    "assistant",
    `effort:${then}`,
    "user",
  ])
  expect(
    captured.map((request) =>
      (request.headers["anthropic-beta"] ?? "").split(",").includes(MID_CONVERSATION_BETA),
    ),
  ).toEqual([false, true])
  // No prefill: each request ends on the user's message.
  expect(captured.map((request) => lastInput(request.body ?? ""))).toEqual([
    "user:text",
    "user:text",
  ])
}

/** The type of the last block of the last message a request sent, with its role. */
const lastInput = (body: string) => {
  const last = decodeMessages(body).messages.at(-1)
  let block = "text"
  if (Array.isArray(last?.content)) block = last.content.at(-1)?.type ?? "none"
  return `${last?.role ?? "none"}:${block}`
}

describe("router on the wire", () => {
  it.scopedLive(
    "a routed turn sends the bytes the same turn sends on the model picked by hand, each ending on user input",
    () =>
      Effect.gen(function* () {
        const { home, cwd } = yield* writeHome(autoRouter(Option.some("route-judge/jev-cheap")))
        const model = yield* anthropicModel
        // Turn 1 on light; turn 2 on strong, by hand or by the router: a
        // tool call, then the answer after its result.
        const secondTurn = Effect.fn("test.secondTurn")(function* (selection: ModelId) {
          const state = makeFakeFetchState()
          const providerLayer = Layer.provide(
            model,
            fakeFetchLayer(state, (_request, call) => {
              if (call === 1) return toolReply("delegate__list")
              return textReply(`answer ${call}`)
            }),
          )
          const harness = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            home,
            cwd,
            extensionInputs: [
              ...e2ePreset.extensionInputs,
              judgeExtension([{ label: "choice2", confidence: 0.9 }], []),
            ],
          })
          const { client, sessionId, branchId } = harness
          yield* client.auth.setKey({ provider: "route-judge", key: "test-key", sessionId })
          const afterTurns = yield* recordBranchEvents(client, harness)
          const select = (modelId: ModelId) =>
            client.session.updateSettings({
              sessionId,
              modelId: Option.some(modelId),
              reasoningLevel: Option.none(),
            })
          yield* select(LIGHT)
          yield* client.message.send({ sessionId, branchId, content: "hello" })
          yield* afterTurns(1)
          yield* select(selection)
          yield* client.message.send({ sessionId, branchId, content: "list the delegates" })
          const events = yield* afterTurns(2)
          return {
            models: stepModels(events),
            bodies: state.captured.map((request) => request.body ?? ""),
          }
        })
        const byHand = yield* secondTurn(STRONG)
        const routed = yield* secondTurn(AUTO)
        expect(routed.models).toEqual([LIGHT, STRONG, STRONG])
        expect(routed.bodies).toHaveLength(3)
        // The router writes nothing the model reads: byte for byte the hand switch.
        expect(routed.bodies).toEqual(byHand.bodies)
        // No prefill: each request ends on the user's message or a tool result.
        expect(routed.bodies.map(lastInput)).toEqual(["user:text", "user:text", "user:tool_result"])
      }).pipe(Effect.timeout("25 seconds"), Effect.provide(BunServices.layer)),
    30_000,
  )

  it.scopedLive(
    "a route that changes only the effort rides inside the conversation: the earlier bytes hold and the receipt names the level sent",
    () =>
      Effect.gen(function* () {
        const { home, cwd } = yield* writeHome({
          routers: {
            auto: {
              label: "Auto",
              classifier: "route-judge/jev-cheap",
              choices: [
                { model: OPUS, effort: "low", reason: "light work", default: true },
                { effort: "high", reason: "hard work on the same model" },
              ],
            },
          },
        })
        // The turn runs on the scripted model; each step keeps the hints it
        // resolved its model with and the prompt it sent, for the real driver.
        const { sent, keep } = keepSentSteps()
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          keep("answer 1"),
          keep("answer 2"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          home,
          cwd,
          models: [
            Model.make({
              id: OPUS,
              name: "Opus 5",
              provider: ProviderId.make("anthropic"),
              contextLength: 1_000_000,
              reasoning: true,
              efforts: ["low", "medium", "high", "xhigh", "max"],
              pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
            }),
          ],
          extensionInputs: [
            ...e2ePreset.extensionInputs,
            judgeExtension(
              [
                { label: "choice1", confidence: 0.9 },
                { label: "choice2", confidence: 0.9 },
              ],
              [],
            ),
          ],
        })
        yield* client.auth.setKey({ provider: "route-judge", key: "test-key", sessionId })
        yield* client.session.updateSettings({
          sessionId,
          modelId: Option.some(AUTO),
          reasoningLevel: Option.none(),
        })
        const afterTurns = yield* recordBranchEvents(client, { sessionId, branchId })
        yield* client.message.send({ sessionId, branchId, content: "hello" })
        yield* afterTurns(1)
        yield* client.message.send({ sessionId, branchId, content: "now the hard part" })
        const events = yield* afterTurns(2)
        yield* controls.assertDone

        // One model, two routes: the second changes the effort only.
        expect(routedEvents(events).map((event) => [event.model, event.effort])).toEqual([
          [OPUS, "low"],
          [OPUS, "high"],
        ])
        const receipts = events.flatMap((event) => {
          if (event._tag !== "StreamEnded") return []
          return [[event.model, event.reasoningLevel]]
        })
        expect(receipts).toEqual([
          [OPUS, "low"],
          [OPUS, "high"],
        ])
        // The turn asks for the route's level and names the level the run before was sent at.
        expect(sent.map((step) => [step.reasoning, step.reasoningHistory])).toEqual([
          [Option.some("low"), []],
          [Option.some("high"), [Option.some("low")]],
        ])

        // The real driver sends each step's prompt with the hints the turn
        // resolved; the change rides as a marker ahead of the turn it applies to.
        expectEffortRidesInside(yield* replayOnOpus(sent, sessionId), "low", "high")
      }).pipe(Effect.timeout("25 seconds"), Effect.provide(BunServices.layer)),
    30_000,
  )

  it.scopedLive(
    "/effort auto changes the level between turns on Opus 5 inside the conversation: the cached prefix holds",
    () =>
      Effect.gen(function* () {
        const { home, cwd } = yield* writeHome({})
        const { sent, keep } = keepSentSteps()
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          keep("answer 1"),
          keep("answer 2"),
        ])
        const calls: Array<JudgeCall> = []
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          home,
          cwd,
          models: [
            Model.make({
              id: OPUS,
              name: "Opus 5",
              provider: ProviderId.make("anthropic"),
              contextLength: 1_000_000,
              reasoning: true,
              efforts: ["low", "medium", "high", "xhigh", "max"],
              carriesEffort: true,
              pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
            }),
          ],
          extensionInputs: [
            ...e2ePreset.extensionInputs,
            judgeExtension(
              [
                { label: "choice1", confidence: 0.9 },
                { label: "choice3", confidence: 0.9 },
              ],
              calls,
            ),
          ],
        })
        yield* client.auth.setKey({ provider: "route-judge", key: "test-key", sessionId })
        yield* client.session.updateSettings({
          sessionId,
          modelId: Option.some(OPUS),
          reasoningLevel: Option.some("auto"),
        })
        const afterTurns = yield* recordBranchEvents(client, { sessionId, branchId })
        yield* client.message.send({ sessionId, branchId, content: "hello" })
        yield* afterTurns(1)
        yield* client.message.send({ sessionId, branchId, content: "now the hard part" })
        const events = yield* afterTurns(2)
        yield* controls.assertDone

        // One classification per user turn; the model stays, the level moves.
        expect(calls).toHaveLength(2)
        expect(routedEvents(events).map((event) => [event.model, event.effort])).toEqual([
          [OPUS, "low"],
          [OPUS, "high"],
        ])
        expect(sent.map((step) => [step.reasoning, step.reasoningHistory])).toEqual([
          [Option.some("low"), []],
          [Option.some("high"), [Option.some("low")]],
        ])
        expectEffortRidesInside(yield* replayOnOpus(sent, sessionId), "low", "high")
      }).pipe(Effect.timeout("25 seconds"), Effect.provide(BunServices.layer)),
    30_000,
  )
})
