import { describe, expect, it, test } from "effect-bun-test"
import {
  Clock,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Match,
  Option,
  Path,
  Predicate,
  Ref,
  Schema,
  Stream,
} from "effect"
import { GentPlatform, MessageStorage } from "@gent/core/host"
import {
  type LoadedExtension,
  captureTurnTools,
  collectTestContributions,
  createE2ELayer,
  plantInFlightTurn,
  plantToolCallBinding,
  runtimeHostContext,
  createRpcHarness,
  ensureStorageParents,
  runToolWithCtx,
  finishPart,
  LanguageModelLayers,
  multiToolCallStep,
  type SequenceStep,
  textDeltaPart,
  textStep,
  toolCallPart,
  toolCallStep,
  waitFor,
  RuntimeEnvironment,
  CurrentWorkspaceId,
  WorkspaceId,
  createRpcClient,
  toolResultMessageIdForTurn,
  testSqliteStorage,
  ApprovalService,
  turnRequestText,
  systemTextOf,
} from "@gent/core/test-utils"
import { BunServices } from "@effect/platform-bun"
import * as Prompt from "effect/ai/Prompt"
import { type Decision, DecisionModel } from "effect/ai"
import {
  BranchId,
  MessageId,
  SessionId,
  ToolCallId,
  assistantMessageIdForTurn,
  dateFromMillis,
  Message,
  SteerCommand,
  AgentDefinition,
  AgentName,
  DEFAULT_AGENT_NAME,
  messagePartsText,
} from "@gent/core/protocol"
import {
  ExtensionId,
  RequestId,
  defineExtension,
  ExtensionContext,
  ExtensionHost,
  getToolId,
  tool,
  type ToolCapability,
  LoadedArtifactIdentity,
  Model,
  ModelId,
  ProviderId,
  type ProviderAuthInfo,
} from "@gent/core/extensions/api"
import {
  InteractionStorage,
  CurrentToolCall,
  ModelContextLedger,
  getToolMetadata,
} from "@gent/core/extensions/branch-tools"
import {
  CellBranchTools,
  CellStorage,
  CellExtension,
  CellTool,
  dispatchCell,
  handleContextCall,
  makeCellToolHost,
  pageText,
  renderHostToolCatalog,
  HOST_TOOL_CATALOG_BUDGET,
  renderToolSignature,
} from "../src/cell.js"
import { BashTool } from "../src/exec-tools.js"
import { BuiltinExtensions } from "../src/index.js"
import { OpenCodeExtension } from "../src/opencode.js"
import { TypeSafeExtension } from "../src/typesafe.js"
import { EditTool, GrepTool, ReadTool, WriteTool } from "../src/fs-tools.js"
import { GoalTool } from "../src/goal.js"
import { AskUserTool, HandoffTool, PromptTool } from "../src/interaction-tools.js"
import { WebSearchTool } from "../src/network-tools.js"
import { ReadSessionTool } from "../src/session-tools.js"
import { CancelTool, MonitorTool, WakeTool } from "../src/wake.js"
import { CellResponse } from "../src/cell-protocol.js"
import { shippedPreset } from "./helpers/test-preset.js"
import {
  ChildAgentHandle,
  CancelChild,
  DelegateEntry,
  DelegateExtension,
  ListChildren,
  StartChild,
} from "../src/delegate.js"
import { SqlClient } from "effect/sql"
import { platform, askThenLoseWorker } from "./helpers/cell-kernel.js"

// The cell's model surface: the context host, the shipped surface, child
// cells, branch lifetime, RPC recovery, guidelines, signatures and the catalog.

// ── cell context host ───────────────────────────────────────────────────────

const sessionIdContextHost = SessionId.make("context-host-session")
const branchIdContextHost = BranchId.make("context-host-branch")
const decodeReply = Schema.decodeUnknownSync(
  Schema.Struct({
    id: Schema.optional(Schema.String),
    kind: Schema.optional(Schema.String),
    text: Schema.optional(Schema.String),
    totalChars: Schema.optional(Schema.Finite),
    nextOffset: Schema.optional(Schema.Finite),
    done: Schema.optional(Schema.Boolean),
    projected: Schema.optional(Schema.Boolean),
    percent: Schema.optional(Schema.Finite),
    scheduled: Schema.optional(Schema.String),
    total: Schema.optional(Schema.Finite),
    entries: Schema.optional(
      Schema.Array(
        Schema.Struct({
          id: Schema.String,
          role: Schema.String,
          chars: Schema.Finite,
          preview: Schema.String,
          kind: Schema.optional(Schema.String),
        }),
      ),
    ),
  }),
)

const layer = Layer.mergeAll(
  testSqliteStorage(CellBranchTools.storage, CellBranchTools.migrations),
  GentPlatform.Test(),
  ModelContextLedger.Branch,
)

const seedTranscript = Effect.gen(function* () {
  yield* ensureStorageParents({ sessionId: sessionIdContextHost, branchId: branchIdContextHost })
  const storage = yield* MessageStorage
  const plain = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n")
  // The 120-character preview cut falls between the emoji's two halves.
  const lines = `${plain.slice(0, 119)}😀${plain.slice(119)}`
  yield* storage.createMessage(
    Message.cases.regular.make({
      id: MessageId.make("m-long"),
      sessionId: sessionIdContextHost,
      branchId: branchIdContextHost,
      role: "assistant",
      parts: [Prompt.textPart({ text: lines })],
      createdAt: dateFromMillis(1_000),
    }),
  )
  yield* storage.createMessage(
    Message.cases.regular.make({
      id: MessageId.make("m-tool"),
      sessionId: sessionIdContextHost,
      branchId: branchIdContextHost,
      role: "tool",
      parts: [
        Prompt.toolResultPart({
          id: ToolCallId.make("call-1"),
          name: "read",
          result: { content: "full file body" },
          isFailure: false,
          providerExecuted: false,
        }),
      ],
      createdAt: dateFromMillis(2_000),
    }),
  )
})

describe("cell context host", () => {
  it.live("status reports the last projection or that none exists yet", () =>
    Effect.gen(function* () {
      const before = decodeReply(
        yield* handleContextCall({
          branchId: branchIdContextHost,
          name: "context:status",
          input: {},
        }),
      )
      expect(before.projected).toBe(false)
      const ledger = yield* ModelContextLedger
      yield* ledger.recordProjection({
        estimatedTokens: 42,
        availableInputTokens: 84,
        contextLimitTokens: 100,
        omittedMessages: 3,
      })
      const after = decodeReply(
        yield* handleContextCall({
          branchId: branchIdContextHost,
          name: "context:status",
          input: {},
        }),
      )
      expect(after.projected).toBe(true)
      // The share of the input the messages may take, not of the window.
      expect(after.percent).toBe(50)
    }).pipe(Effect.provide(layer)),
  )

  it.live("history lists the branch in order with previews and pages by offset", () =>
    Effect.gen(function* () {
      yield* seedTranscript
      const first = decodeReply(
        yield* handleContextCall({
          branchId: branchIdContextHost,
          name: "context:history",
          input: { limit: 1 },
        }),
      )
      expect(first.total).toBe(2)
      expect(first.nextOffset).toBe(1)
      expect(first.done).toBe(false)
      expect(first.entries?.map((entry) => entry.id)).toEqual(["m-long"])
      expect(first.entries?.[0]?.role).toBe("assistant")
      expect(first.entries?.[0]?.preview.startsWith("line 1 line 2")).toBe(true)
      expect(first.entries?.[0]?.preview.isWellFormed()).toBe(true)
      expect(first.entries?.[0]?.chars).toBeGreaterThan(200)
      const rest = decodeReply(
        yield* handleContextCall({
          branchId: branchIdContextHost,
          name: "context:history",
          input: { offset: 1 },
        }),
      )
      expect(rest.entries?.map((entry) => entry.id)).toEqual(["m-tool"])
      expect(rest.done).toBe(true)
    }).pipe(Effect.provide(layer)),
  )

  it.live("read pages a durable message by id and finds a tool result by call id", () =>
    Effect.gen(function* () {
      yield* seedTranscript
      const page = decodeReply(
        yield* handleContextCall({
          branchId: branchIdContextHost,
          name: "context:read",
          input: { id: "m-long", offset: 7, limit: 13 },
        }),
      )
      expect(page.kind).toBe("message")
      expect(page.text).toBe("line 2\nline 3")
      expect(page.totalChars).toBeGreaterThan(200)
      expect(page.nextOffset).toBe(20)
      expect(page.done).toBe(false)
      const result = decodeReply(
        yield* handleContextCall({
          branchId: branchIdContextHost,
          name: "context:read",
          input: { id: "call-1" },
        }),
      )
      expect(result.kind).toBe("tool-result")
      expect(result.text).toContain("full file body")
      const missing = yield* handleContextCall({
        branchId: branchIdContextHost,
        name: "context:read",
        input: { id: "nope" },
      }).pipe(Effect.flip)
      expect(missing.message).toContain("No stored message or result has id nope")
    }).pipe(Effect.provide(layer)),
  )

  it.live("compact and newWindow schedule directives the next projection takes", () =>
    Effect.gen(function* () {
      const ledger = yield* ModelContextLedger
      const compact = decodeReply(
        yield* handleContextCall({
          branchId: branchIdContextHost,
          name: "context:compact",
          input: { instructions: "keep file paths" },
        }),
      )
      expect(compact.scheduled).toBe("compact")
      const directive = Option.getOrThrow(yield* ledger.pendingDirective)
      expect(directive._tag).toBe("Compact")
      if (directive._tag === "Compact") expect(directive.instructions).toBe("keep file paths")
      yield* handleContextCall({
        branchId: branchIdContextHost,
        name: "context:newWindow",
        input: {},
      })
      expect(Option.map(yield* ledger.pendingDirective, (d) => d._tag)).toEqual(
        Option.some("NewWindow"),
      )
      const unknown = yield* handleContextCall({
        branchId: branchIdContextHost,
        name: "context:reset",
        input: {},
      }).pipe(Effect.flip)
      // The error names the call as the cell spells it, not its wire name.
      expect(unknown.message).toBe("Unknown operation context.reset")
    }).pipe(Effect.provide(layer)),
  )

  it.effect("a page clamps its window to the text and reports completion", () =>
    Effect.sync(() => {
      const page = pageText("abcdef", 2, 10)
      expect(page).toEqual({ text: "cdef", totalChars: 6, offset: 2, nextOffset: 6, done: true })
      expect(pageText("ab", 5, 1).text).toBe("")
    }),
  )

  it.effect("a large single-line result is read in full by continuing from nextOffset", () =>
    Effect.sync(() => {
      const text = "x".repeat(250_000)
      let offset = 0
      const pages: Array<string> = []
      for (let guard = 0; guard < 10; guard += 1) {
        const page = pageText(text, offset, 100_000)
        pages.push(page.text)
        offset = page.nextOffset
        if (page.done) break
      }
      expect(pages.map((page) => page.length)).toEqual([100_000, 100_000, 50_000])
      expect(pages.join("")).toBe(text)
    }),
  )
})

// ── cell models host ────────────────────────────────────────────────────────

/** A variable no test run sets, so the judge driver has a credential only when a test stores one. */
const JUDGE_ENV = "GENT_TEST_JUDGE_KEY_NEVER_SET"

/** One provider call the judge driver answered. */
interface JudgeCall {
  readonly model: string
  readonly key: Option.Option<string>
  readonly options: DecisionModel.ProviderOptions
}

/** The API key a stored credential carries; none for an OAuth sign-in. */
const storedApiKey = (info: ProviderAuthInfo): Option.Option<string> => {
  if (info._tag === "Api") return Option.some(info.key)
  return Option.none()
}

/** The judge's answer: the first label, the highest level, and 0.25. */
const judgeAnswer = Match.type<Decision.Any>().pipe(
  Match.tagsExhaustive({
    Classify: (decision): DecisionModel.ProviderAnswer => {
      const labels = Object.keys(decision.criteria)
      return {
        _tag: "Classify",
        label: labels[0] ?? "",
        probabilities: Object.fromEntries(
          labels.map((label, index) => [label, Number(index === 0)]),
        ),
        confidence: 0.9,
      }
    },
    Rate: (decision): DecisionModel.ProviderAnswer => {
      const last = decision.criteria.length - 1
      return {
        _tag: "Rate",
        rating: last,
        probabilities: Object.fromEntries(
          decision.criteria.map((level, index) => [level, Number(index === last)]),
        ),
      }
    },
    Probability: (): DecisionModel.ProviderAnswer => ({ _tag: "Probability", probability: 0.25 }),
  }),
)

/**
 * A model driver that serves two classifier models and no chat model. It
 * answers through Effect's own `DecisionModel.make`, so the answers the cell
 * sees passed the same validation a real provider's do.
 */
const judgeExtension = (calls: Ref.Ref<ReadonlyArray<JudgeCall>>) =>
  defineExtension({
    id: "@test/judge",
    setup: Effect.gen(function* () {
      const host = yield* ExtensionHost
      yield* host.register("modelDriver", {
        id: "judge",
        name: "Judge",
        envCredential: JUDGE_ENV,
        resolveModel: () => Effect.die("judge serves classifier models only"),
        listModels: () =>
          Effect.succeed(
            ["jev-test", "jev-other", "jev-latest", "jev-broken", "jev-stalled"].map((name) =>
              Model.make({
                id: ModelId.make(`judge/${name}`),
                name,
                provider: ProviderId.make("judge"),
                kind: "classifier",
              }),
            ),
          ),
        resolveDecisionModel: (model, authInfo) => {
          // A driver whose model throws while it is built.
          if (model === "jev-broken")
            return Effect.succeed(
              Layer.effect(DecisionModel.DecisionModel, Effect.die("judge model failed to build")),
            )
          // A provider that takes the request and never answers.
          if (model === "jev-stalled")
            return Effect.succeed(
              Layer.effect(
                DecisionModel.DecisionModel,
                DecisionModel.make({ decide: () => Effect.never }),
              ),
            )
          return Effect.succeed(
            Layer.effect(
              DecisionModel.DecisionModel,
              DecisionModel.make({
                decide: (options) =>
                  Ref.update(calls, (all) => [
                    ...all,
                    {
                      model,
                      key: Option.flatMap(Option.fromUndefinedOr(authInfo), storedApiKey),
                      options,
                    },
                  ]).pipe(
                    Effect.as({
                      answers: Object.fromEntries(
                        Object.entries(options.decisions).map(([name, decision]) => [
                          name,
                          judgeAnswer(decision),
                        ]),
                      ),
                      usage: { inputTokens: 21, outputTokens: 0 },
                    }),
                  ),
              }),
            ),
          )
        },
      })
    }),
  })

const SHIPPED_JEV_DRIVERS: ReadonlySet<string> = new Set([
  TypeSafeExtension.manifest.id,
  OpenCodeExtension.manifest.id,
])

/** Run `code` as one cell of a fresh session with the judge driver, and return its display. */
const runJudgeCell = Effect.fn("test.runJudgeCell")(function* (params: {
  readonly code: string
  readonly storeKey: boolean
  readonly calls: Ref.Ref<ReadonlyArray<JudgeCall>>
  readonly extensions?: ReadonlyArray<(typeof BuiltinExtensions)[number]>
}) {
  const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
    toolCallStep("cell", { code: params.code }),
    textStep("done"),
  ])
  const { client, sessionId, branchId } = yield* createRpcHarness({
    ...shippedPreset,
    // The shipped Jev drivers read the developer's keys and would reach a provider.
    extensionInputs: [
      ...BuiltinExtensions.filter((extension) => !SHIPPED_JEV_DRIVERS.has(extension.manifest.id)),
      judgeExtension(params.calls),
      ...Option.getOrElse(Option.fromUndefinedOr(params.extensions), () => []),
    ],
    providerLayer,
  })
  if (params.storeKey) yield* client.auth.setKey({ provider: "judge", key: "judge-key" })
  yield* client.message.send({ sessionId, branchId, content: "decide" })
  const messages = yield* waitFor(
    client.message.list({ branchId }),
    (all) =>
      all.some(
        (message) => message.role === "assistant" && messagePartsText(message.parts) === "done",
      ),
    10_000,
    "assistant reply done",
  )
  const results = messages
    .flatMap((message) => message.parts)
    .filter((part): part is Prompt.ToolResultPart => part.type === "tool-result")
  expect(results).toMatchObject([{ name: "cell", isFailure: false }])
  return yield* Schema.decodeUnknownEffect(Schema.Struct({ display: Schema.String }))(
    results[0]?.result,
  )
})

const decodeDecideJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

describe("cell models host", () => {
  it.scopedLive(
    "a cell asks classify, rate and probability in one provider call; a credentialed -latest alias wins over an earlier classifier",
    () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make<ReadonlyArray<JudgeCall>>([])
        const { display } = yield* runJudgeCell({
          calls,
          storeKey: true,
          code: [
            "const reply = await models.decide({ text: 'charged twice, fix it today' }, {",
            "  team: models.classify({ instructions: 'Which team', criteria: { billing: 'payments', technical: 'bugs' } }),",
            "  mood: models.rate({ instructions: 'How upset', criteria: ['calm', 'upset', 'angry'] }),",
            "  urgent: models.probability({ instructions: 'Needs action today' }),",
            "})",
            "JSON.stringify(reply)",
          ].join("\n"),
        })
        expect(yield* decodeDecideJson(display)).toEqual({
          model: "judge/jev-latest",
          answers: {
            team: {
              label: "billing",
              probabilities: { billing: 1, technical: 0 },
              confidence: 0.9,
            },
            mood: {
              rating: 2,
              label: "angry",
              probabilities: { calm: 0, upset: 0, angry: 1 },
            },
            urgent: { probability: 0.25 },
          },
          usage: { inputTokens: 21, outputTokens: 0 },
        })
        const made = yield* Ref.get(calls)
        expect(made).toHaveLength(1)
        expect(made[0]?.model).toBe("jev-latest")
        expect(made[0]?.key).toEqual(Option.some("judge-key"))
        expect(made[0]?.options.state).toEqual({ text: "charged twice, fix it today" })
        expect(made[0]?.options.decisions).toEqual({
          team: {
            _tag: "Classify",
            instructions: "Which team",
            criteria: { billing: "payments", technical: "bugs" },
          },
          mood: { _tag: "Rate", instructions: "How upset", criteria: ["calm", "upset", "angry"] },
          // A probability without criteria carries none.
          urgent: { _tag: "Probability", instructions: "Needs action today" },
        })
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platform)),
    20000,
  )

  it.scopedLive(
    "a named classifier answers; an unknown name or a one-label classify fails readably before any call",
    () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make<ReadonlyArray<JudgeCall>>([])
        const { display } = yield* runJudgeCell({
          calls,
          storeKey: true,
          code: [
            "const urgent = { urgent: models.probability({ instructions: 'Needs action today' }) }",
            "const named = await models.decide('late order', urgent, { model: 'judge/jev-other' })",
            "const unknown = await models.decide('late order', urgent, { model: 'judge/nope' }).catch((error) => error.message)",
            "const single = await models.decide('late order', { team: models.classify({ instructions: 'Which team', criteria: { billing: 'payments' } }) }).catch((error) => error.message)",
            "const broken = await models.decide('late order', urgent, { model: 'judge/jev-broken' }).catch((error) => error.message)",
            "const stalled = await models.decide('late order', urgent, { model: 'judge/jev-stalled', timeoutMs: 200 }).catch((error) => error.message)",
            "JSON.stringify({ model: named.model, unknown, single, broken, stalled })",
          ].join("\n"),
        })
        expect(yield* decodeDecideJson(display)).toEqual({
          model: "judge/jev-other",
          unknown:
            'models.decide: Unknown classifier model "judge/nope". Classifier models: judge/jev-test, judge/jev-other, judge/jev-latest, judge/jev-broken, judge/jev-stalled',
          single:
            "models.decide input is invalid: Error: Decision.classify: criteria must contain at least two labels",
          // A model that throws while it is built rejects this call, not the cell.
          broken: "models.decide: judge/jev-broken: judge model failed to build",
          // A provider that never answers is cut off at the deadline; the cell goes on.
          stalled: "models.decide (judge/jev-stalled) gave no answer within 200 ms",
        })
        expect((yield* Ref.get(calls)).map((call) => call.model)).toEqual(["jev-other"])
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platform)),
    20000,
  )

  it.scopedLive(
    "with no classifier credential the call fails naming the variables and /auth",
    () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make<ReadonlyArray<JudgeCall>>([])
        const { display } = yield* runJudgeCell({
          calls,
          storeKey: false,
          code: "await models.decide('late order', { urgent: models.probability({ instructions: 'Needs action today' }) }).catch((error) => error.message)",
        })
        expect(display).toBe(
          `models.decide: No classifier model has a credential: set ${JUDGE_ENV}, or sign in with /auth`,
        )
        expect(yield* Ref.get(calls)).toEqual([])
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platform)),
    20000,
  )

  // The namespaces share the host call channel with the tools; a tool id
  // can spell `models.x` or `context.x`, so it must still reach its tool.
  it.scopedLive(
    "a tool whose id starts with models or context runs from a cell",
    () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make<ReadonlyArray<JudgeCall>>([])
        const echo = (id: string) =>
          tool({
            id,
            description: "Echo the tool's id.",
            params: Schema.Struct({}),
            output: Schema.Struct({ echoed: Schema.String }),
            execute: () => Effect.succeed({ echoed: id }),
          })
        const namesake = defineExtension({
          id: "@test/namespace-namesake",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register("tool", echo("models.compare"))
            yield* host.register("tool", echo("context.pin"))
          }),
        })
        const { display } = yield* runJudgeCell({
          calls,
          storeKey: false,
          extensions: [namesake],
          code: "JSON.stringify([await tools.models.compare({}), await tools.context.pin({})])",
        })
        expect(yield* decodeDecideJson(display)).toEqual([
          { echoed: "models.compare" },
          { echoed: "context.pin" },
        ])
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platform)),
    20000,
  )

  it.scopedLive(
    "a classifier the call cannot resolve names each classifier catalog that failed",
    () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make<ReadonlyArray<JudgeCall>>([])
        const offline = defineExtension({
          id: "@test/offline-judge",
          setup: Effect.gen(function* () {
            yield* (yield* ExtensionHost).register("modelDriver", {
              id: "offline",
              name: "Offline",
              resolveModel: () => Effect.die("offline serves classifier models only"),
              listModels: () => Effect.die("catalog unreachable"),
              resolveDecisionModel: () => Effect.die("offline lists no model"),
            })
          }),
        })
        const { display } = yield* runJudgeCell({
          calls,
          storeKey: false,
          extensions: [offline],
          code: [
            "const urgent = { urgent: models.probability({ instructions: 'Needs action today' }) }",
            "const named = await models.decide('late order', urgent, { model: 'offline/jev-1' }).catch((error) => error.message)",
            "const unnamed = await models.decide('late order', urgent).catch((error) => error.message)",
            "JSON.stringify({ named, unnamed })",
          ].join("\n"),
        })
        expect(yield* decodeDecideJson(display)).toEqual({
          named:
            'models.decide: Unknown classifier model "offline/jev-1". Classifier models: judge/jev-test, judge/jev-other, judge/jev-latest, judge/jev-broken, judge/jev-stalled. Classifier catalogs that failed: offline (catalog unreachable)',
          unnamed: `models.decide: No classifier model has a credential: set ${JUDGE_ENV}, or sign in with /auth. Classifier catalogs that failed: offline (catalog unreachable)`,
        })
        expect(yield* Ref.get(calls)).toEqual([])
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platform)),
    20000,
  )
})

// ── shipped model surface ───────────────────────────────────────────────────

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

const isToolLifecycleEvent = Predicate.or(
  Predicate.isTagged("ToolCallStarted"),
  Predicate.isTagged("ToolCallSucceeded"),
)

const cellOnly = (step: SequenceStep): SequenceStep => ({
  ...step,
  assertOptions: (options) => {
    expect(options.tools.map((tool) => tool.name)).toEqual(["cell"])
    const system = systemTextOf(options.prompt)
    expect(system).toContain("## Host Tools")
    expect(system).toContain("- tools.read(input: { path: string")
    expect(system).toContain("`await tools(id)` returns its full input schema")
    expect(system).toContain("grant no permission to execute")
    // The Host Tools section alone explains the discovery calls.
    expect(system.split("tools.search(").length - 1).toBe(1)
    expect(system).not.toContain("tools.cell(")
  },
})

describe("shipped model surface", () => {
  it.scopedLive(
    "a cell starts in its session's working directory, not the host's",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const sessionCwd = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "gent-cell-session-" }),
        )
        // The host process runs elsewhere, so an inherited working directory shows.
        expect(yield* fs.realPath(path.resolve("."))).not.toBe(sessionCwd)
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          toolCallStep("cell", { code: "process.cwd()" }),
          textStep("done"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...shippedPreset,
          providerLayer,
          cwd: sessionCwd,
        })
        yield* client.message.send({ sessionId, branchId, content: "where does the cell run" })
        const messages = yield* waitFor(
          client.message.list({ branchId }),
          (all) =>
            all.some(
              (message) =>
                message.role === "assistant" && messagePartsText(message.parts) === "done",
            ),
          10_000,
          "assistant reply done",
        )
        const results = messages
          .flatMap((message) => message.parts)
          .filter((part): part is Prompt.ToolResultPart => part.type === "tool-result")
        expect(results).toMatchObject([
          { name: "cell", isFailure: false, result: { display: sessionCwd } },
        ])
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platform)),
    20000,
  )

  it.scopedLive(
    "advertises only cell and serves builtin host tools inside it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* fs.makeTempDirectoryScoped()
        const file = path.join(directory, "note.txt")
        yield* fs.writeFileString(file, "shipped surface")
        const readNote = `const note = (await tools.read({path: ${encodeJson(file)}})).content; note`
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          cellOnly(toolCallStep("cell", { code: readNote })),
          textStep("first"),
          cellOnly(toolCallStep("cell", { code: "note.includes('shipped surface')" })),
          textStep("second"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...shippedPreset,
          providerLayer,
        })
        const runTurn = Effect.fn("Test.runTurn")(function* (content: string, reply: string) {
          yield* client.message.send({ sessionId, branchId, content })
          const completed = yield* waitFor(
            client.message.list({ branchId }),
            (messages) =>
              messages.some(
                (message) =>
                  message.role === "assistant" && messagePartsText(message.parts) === reply,
              ),
            10_000,
            `assistant reply ${reply}`,
          )
          return completed
            .flatMap((message) => message.parts)
            .filter((part): part is Prompt.ToolResultPart => part.type === "tool-result")
            .filter((part) => part.name === "cell")
        })

        const first = yield* runTurn("read through the cell", "first")
        expect(first).toHaveLength(1)
        expect(first[0]).toMatchObject({
          isFailure: false,
          result: {
            display: expect.stringContaining("shipped surface"),
            // The saved result carries inner-operation receipts for the transcript,
            // summarized by the read tool itself.
            operations: [{ tool: "read", outcome: "succeeded", summary: `${file} · 1 line` }],
          },
        })
        const cellToolCallId = first[0]?.id
        // The inner call is published as an event nested under its cell.
        const innerEvents = yield* client.session.events({ sessionId, branchId, after: 0 }).pipe(
          Stream.filter(
            (envelope) =>
              isToolLifecycleEvent(envelope.event) && envelope.event.toolName === "read",
          ),
          Stream.take(2),
          Stream.runCollect,
        )
        const cellAssistant = (yield* client.message.list({ branchId })).find(
          (message) =>
            message.role === "assistant" &&
            message.parts.some((part) => part.type === "tool-call" && part.id === cellToolCallId),
        )
        expect(cellAssistant).toBeDefined()
        expect(innerEvents.map((envelope) => envelope.event)).toMatchObject([
          {
            _tag: "ToolCallStarted",
            parentToolCallId: cellToolCallId,
            assistantMessageId: cellAssistant?.id,
          },
          {
            _tag: "ToolCallSucceeded",
            parentToolCallId: cellToolCallId,
            assistantMessageId: cellAssistant?.id,
          },
        ])
        // A reload reads the inner call back from those events: the row's input, the
        // tool's own summary, and the bounded output its collapsed row draws.
        const snapshot = yield* client.session.getSnapshot({ sessionId, branchId })
        const cellInteraction = snapshot.messages
          .flatMap((message) => message.toolInteractions)
          .find((interaction) => interaction.id === cellToolCallId)
        expect(cellInteraction?.operations).toMatchObject([
          {
            toolName: "read",
            status: "completed",
            input: { path: file },
            summary: `${file} · 1 line`,
          },
        ])
        const readOutput = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({ content: Schema.String, lineCount: Schema.Finite }),
          ),
        )(cellInteraction?.operations?.[0]?.output)
        expect(readOutput).toMatchObject({ content: "1\tshipped surface", lineCount: 1 })

        // Working data from the first cell is still bound in the next turn.
        const second = yield* runTurn("use the note", "second")
        expect(second).toHaveLength(2)
        expect(second[1]).toMatchObject({ isFailure: false, result: { display: "true" } })
        yield* controls.assertDone
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platform)),
    18000,
  )

  it.scopedLive(
    "composes concurrent host calls inside one cell",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* fs.makeTempDirectoryScoped()
        const left = path.join(directory, "left.txt")
        const right = path.join(directory, "right.txt")
        yield* fs.writeFileString(left, "left half")
        yield* fs.writeFileString(right, "right half")
        // Parallel delegation is a cell recipe, not a tool mode.
        const code = [
          `const [a, b] = await Promise.all([`,
          `  tools.read({path: ${encodeJson(left)}}),`,
          `  tools.read({path: ${encodeJson(right)}}),`,
          `]); a.content + ' | ' + b.content`,
        ].join("\n")
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          cellOnly(toolCallStep("cell", { code })),
          textStep("joined"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...shippedPreset,
          providerLayer,
        })
        yield* client.message.send({ sessionId, branchId, content: "read both" })
        const messages = yield* waitFor(
          client.message.list({ branchId }),
          (list) =>
            list.some(
              (message) =>
                message.role === "assistant" && messagePartsText(message.parts) === "joined",
            ),
          10_000,
          "assistant reply joined",
        )
        const results = messages
          .flatMap((message) => message.parts)
          .filter((part): part is Prompt.ToolResultPart => part.type === "tool-result")
        expect(results).toHaveLength(1)
        expect(results[0]).toMatchObject({
          isFailure: false,
          result: {
            display: "1\tleft half | 1\tright half",
            operations: [
              { tool: "read", outcome: "succeeded" },
              { tool: "read", outcome: "succeeded" },
            ],
          },
        })
        yield* controls.assertDone
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platform)),
    18000,
  )

  it.scopedLive(
    "allowedTools scopes host tools inside the cell instead of replacing the surface",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* fs.makeTempDirectoryScoped()
        const file = path.join(directory, "note.txt")
        yield* fs.writeFileString(file, "scoped surface")
        // The agent allows `read` only and never names `cell`: the cell stays the model
        // surface and `grep` is unreachable from inside it.
        const scopedAgent = defineExtension({
          id: "@test/scoped-agent",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register(
              "agent",
              AgentDefinition.make({
                name: AgentName.make("scoped"),
                description: "reads only",
                allowedTools: ["read"],
              }),
            )
          }),
        })
        const code = [
          `let grep = 'reachable'`,
          `try { await tools.grep({pattern: 'scoped', path: ${encodeJson(directory)}}) } catch { grep = 'unreachable' }`,
          `(await tools.read({path: ${encodeJson(file)}})).content + ' | grep ' + grep`,
        ].join("\n")
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          cellOnly(toolCallStep("cell", { code })),
          textStep("scoped"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...shippedPreset,
          extensionInputs: [...shippedPreset.extensionInputs, scopedAgent],
          branchTools: CellBranchTools,
          providerLayer,
          admission: { agent: AgentName.make("scoped") },
        })
        yield* client.message.send({ sessionId, branchId, content: "read the note" })
        const messages = yield* waitFor(
          client.message.list({ branchId }),
          (list) =>
            list.some(
              (message) =>
                message.role === "assistant" && messagePartsText(message.parts) === "scoped",
            ),
          10_000,
          "assistant reply scoped",
        )
        const results = messages
          .flatMap((message) => message.parts)
          .filter((part): part is Prompt.ToolResultPart => part.type === "tool-result")
        expect(results).toHaveLength(1)
        expect(results[0]).toMatchObject({
          isFailure: false,
          result: { display: "1\tscoped surface | grep unreachable" },
        })
        yield* controls.assertDone
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platform)),
    18000,
  )
})

// ── child cell ──────────────────────────────────────────────────────────────

describe("child cell", () => {
  it.scopedLive(
    "a child delegated from a cell runs its own cell instead of refusing as a nested outer cell",
    () =>
      Effect.gen(function* () {
        // The parent starts the child from a cell and ends its turn; the
        // child runs its own cell. Each branch is told apart by its first
        // user text, so the two turns never race for one script.
        const childTask = "compute"
        const firstText = (prompt: Prompt.Prompt) =>
          prompt.content.flatMap((message) => {
            if (message.role !== "user") return []
            return message.content.flatMap((part) => {
              if (part.type !== "text") return []
              return [part.text]
            })
          })[0]
        const step = <A>(parts: ReadonlyArray<A>) => Effect.succeed(Stream.fromIterable(parts))
        let parentCalls = 0
        let childCalls = 0
        const providerLayer = LanguageModelLayers.testStream((options) => {
          if (firstText(options.prompt)?.endsWith(childTask) === true) {
            childCalls += 1
            if (childCalls === 1) {
              return step([
                toolCallPart("cell", { code: "1 + 1" }),
                finishPart({ finishReason: "tool-calls" }),
              ])
            }
            return step([textDeltaPart("child says 2"), finishPart({ finishReason: "stop" })])
          }
          parentCalls += 1
          if (parentCalls === 1) {
            return step([
              toolCallPart("cell", {
                code: "const h = await tools.delegate.start({ todo: 'compute' }); typeof h.requestId === 'string'",
              }),
              finishPart({ finishReason: "tool-calls" }),
            ])
          }
          // The turn that started the child ends here; "done" is the turn
          // the child's completion wakes.
          if (parentCalls === 2) {
            return step([textDeltaPart("started"), finishPart({ finishReason: "stop" })])
          }
          return step([textDeltaPart("done"), finishPart({ finishReason: "stop" })])
        })
        const fixture = defineExtension({
          id: "cell-child-foreground-fixture",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register("agent", new AgentDefinition({ name: DEFAULT_AGENT_NAME }))
            yield* host.register("tool", CellTool)
          }),
        })
        const { client, sessionId, branchId } = yield* createRpcHarness({
          providerLayer,
          agents: [],
          extensionInputs: [
            {
              ...fixture,
              artifactIdentity: LoadedArtifactIdentity.make("cell-child-foreground-source"),
            },
            {
              ...DelegateExtension,
              artifactIdentity: LoadedArtifactIdentity.make("delegate-source"),
            },
          ],
          branchTools: CellBranchTools,
        })
        const content = "delegate from a cell"
        yield* client.message.send({ sessionId, branchId, content })
        // The child's completion wakes the parent; the parent's reply to it
        // is the last thing to land.
        const parentMessages = yield* waitFor(
          client.message.list({ branchId }),
          (items) =>
            items.some(
              (item) => item.role === "assistant" && messagePartsText(item.parts) === "done",
            ),
          12_000,
          "the parent read the child's completion",
        )
        const startResults = parentMessages
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "tool-result" && part.name === "cell")
        expect(startResults).toHaveLength(1)
        expect(startResults[0]).toMatchObject({ isFailure: false, result: { display: "true" } })
        const completion = parentMessages.find(
          (item) => item.metadata?.customType === "child-completion",
        )
        expect(completion).toBeDefined()
        expect(messagePartsText(completion?.parts ?? [])).toContain("child says 2")

        const sessions = yield* client.session.list()
        const child = sessions.find((session) => session.parentSessionId === sessionId)
        if (Predicate.isUndefined(child?.activeBranchId)) {
          return yield* Effect.die("Missing child session")
        }
        const childResults = (yield* client.message.list({ branchId: child.activeBranchId }))
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "tool-result" && part.name === "cell")
        expect(childResults).toHaveLength(1)
        expect(childResults[0]).toMatchObject({ isFailure: false, result: { display: "2" } })
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platform)),
    20000,
  )
})

// ── branch cell lifetime ────────────────────────────────────────────────────

it.scopedLive("rejects cell dispatch without a branch owner", () =>
  Effect.gen(function* () {
    const error = yield* dispatchCell().pipe(Effect.flip)
    expect(error).toMatchObject({
      _tag: "AgentLoopError",
      message: "Cell execution requires a branch-owned runtime",
    })
  }).pipe(
    Effect.provide(
      createE2ELayer({
        agents: [],
        branchTools: CellBranchTools,
        extensions: [],
        providerLayer: LanguageModelLayers.debug(),
      }),
    ),
  ),
)

describe("branch cell lifetime", () => {
  it.scopedLive(
    "controls children across kernel reset and reads a completed child reply",
    () =>
      Effect.gen(function* () {
        const handle = yield* Ref.make(Option.none<typeof ChildAgentHandle.Type>())
        // A turn is either sent by the test or started by a child-completion message.
        const turns: ReadonlyArray<{
          readonly send: boolean
          readonly code: string
          readonly reset?: boolean
        }> = [
          {
            send: true,
            code: "const child = await tools.delegate.start({todo: 'Wait for cancellation'}); await tools['child-handle']({_tag: 'save', handle: child}); await tools['model-started']({call: 1}); true",
          },
          {
            send: true,
            code: "(await tools.delegate.list({})).find((kid) => kid.requestId === child.requestId).completed === false",
          },
          {
            send: true,
            reset: true,
            code: "const saved = await tools['child-handle']({_tag: 'get'}); typeof child === 'undefined' && (await tools.delegate.list({})).find((kid) => kid.requestId === saved.requestId).completed === false",
          },
          {
            send: true,
            code: "const id = (await tools['child-handle']({_tag: 'get'})).requestId; await tools.delegate.cancel({requestId: id}); true",
          },
          // The cancelled child's completion arrives as a message; no cell ever waited for it.
          {
            send: false,
            code: "const cancelled = await tools['child-handle']({_tag: 'get'}); (await tools.delegate.list({})).find((kid) => kid.requestId === cancelled.requestId).interrupted === true",
          },
          {
            send: true,
            code: "const finished = await tools.delegate.start({todo: 'Return the result', overrides: {modelId: 'custom/model', reasoningEffort: 'high', allowedTools: ['read_session'], deniedTools: ['delegate.start'], systemPromptAddendum: 'Report the verified result'}}); await tools['child-handle']({_tag: 'save', handle: finished}); await tools['model-started']({call: 12}); true",
          },
          {
            send: false,
            code: "const h = await tools['child-handle']({_tag: 'get'}); const reply = await tools.read_session({sessionId: h.sessionId, branchId: h.branchId}); const kids = await tools.delegate.list({}); kids.length === 2 && kids.every((kid) => kid.completed) && reply.messageCount > 0 && reply.content.includes('verified child result')",
          },
        ]
        const steps = turns.flatMap<SequenceStep>((turn, index) => [
          {
            ...toolCallStep("cell", { code: turn.code, reset: turn.reset === true }),
            assertOptions: (options) => {
              expect(options.tools.map((tool) => tool.name)).toEqual(["cell"])
            },
          },
          textStep(`done-${index}`),
        ])
        steps.splice(1, 0, { ...textStep("child reply"), gated: true })
        steps.splice(12, 0, {
          ...textStep("verified child result"),
          assertRequest: (request) => {
            expect(request.model).toBe("custom/model")
            expect(request.reasoning).toBe("high")
          },
          assertOptions: (options) => {
            // The allow list scopes the host tools inside the child's cell; the cell
            // stays the surface and the denied tool leaves the catalog.
            expect(options.tools.map((tool) => tool.name)).toEqual(["cell"])
            const system = systemTextOf(options.prompt)
            expect(system).toContain("Report the verified result")
            expect(system).toContain("- tools.read_session(input: { sessionId: string")
            expect(system).not.toContain("- tools.delegate.start(")
          },
        })
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence(steps)
        const fixture = defineExtension({
          id: "cell-child-fixture",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register(
              "agent",
              new AgentDefinition({ name: DEFAULT_AGENT_NAME }),
              new AgentDefinition({ name: AgentName.make("child") }),
            )
            yield* host.register(
              "tool",
              ReadSessionTool,
              tool({
                id: "model-started",
                description: "Wait for the model boundary",
                params: Schema.Struct({ call: Schema.Int }),
                output: Schema.Boolean,
                execute: (input) => controls.waitForCall(input.call).pipe(Effect.as(true)),
              }),
              tool({
                id: "child-handle",
                description: "Save or read the test child handle outside the kernel",
                params: Schema.TaggedUnion({ save: { handle: ChildAgentHandle }, get: {} }),
                output: ChildAgentHandle,
                execute: Effect.fn("test.childHandle")(function* (input) {
                  if (input._tag === "save") yield* Ref.set(handle, Option.some(input.handle))
                  return yield* Effect.fromOption(yield* Ref.get(handle))
                }),
              }),
            )
          }),
        })
        const { client, sessionId, branchId } = yield* createRpcHarness({
          providerLayer,
          agents: [],
          extensionInputs: [
            { ...CellExtension, artifactIdentity: LoadedArtifactIdentity.make("cell-source") },
            {
              ...fixture,
              artifactIdentity: LoadedArtifactIdentity.make("cell-child-fixture-source"),
            },
            {
              ...DelegateExtension,
              artifactIdentity: LoadedArtifactIdentity.make("delegate-source"),
            },
          ],
          branchTools: CellBranchTools,
        })
        let completions = 0
        for (const [index, turn] of turns.entries()) {
          const content = `cell-child-${index}`
          const isCompletion = (item: { metadata?: { customType?: string } }) =>
            item.metadata?.customType === "child-completion"
          if (turn.send) yield* client.message.send({ sessionId, branchId, content })
          else completions += 1
          const messages = yield* waitFor(client.message.list({ branchId }), (items) => {
            if (turn.send)
              return items.some(
                (item) => item.role === "user" && messagePartsText(item.parts) === content,
              )
            return items.filter(isCompletion).length >= completions
          })
          let user = messages.find(
            (item) => item.role === "user" && messagePartsText(item.parts) === content,
          )
          if (!turn.send) user = messages.filter(isCompletion).at(completions - 1)
          if (Predicate.isUndefined(user)) return yield* Effect.die("Missing parent message")
          yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.filter(
              (envelope) =>
                envelope.event._tag === "TurnCompleted" && envelope.event.messageId === user.id,
            ),
            Stream.take(1),
            Stream.runDrain,
          )
          const completed = yield* client.message.list({ branchId })
          const results = completed
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "tool-result" && part.name === "cell")
          expect(results.at(-1)).toMatchObject({ isFailure: false, result: { display: "true" } })
        }
        const parentMessages = yield* client.message.list({ branchId })
        const notices = parentMessages.filter(
          (item) => item.metadata?.customType === "child-completion",
        )
        expect(notices).toHaveLength(2)
        expect(messagePartsText(notices[0]?.parts ?? [])).toContain("interrupted")
        expect(messagePartsText(notices[1]?.parts ?? [])).toContain("verified child result")
        const saved = yield* Effect.fromOption(yield* Ref.get(handle))
        const childMessages = yield* client.message.list({ branchId: saved.branchId })
        expect(childMessages.filter((message) => message.role === "user")).toHaveLength(1)
        expect(yield* controls.callCount).toBe(16)
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platform)),
    20000,
  )

  it.scopedLive(
    "retains cells across RPC turns, isolates branches, and closes their workers",
    () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const pids = yield* Ref.make<ReadonlyArray<number>>([])
        const hiddenCalls = yield* Ref.make(0)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sources = [
              "const names = Object.keys(tools); if (names.includes('hidden') || names.includes('cell') || !names.includes('worker')) throw new Error('Wrong catalog'); const spec = await tools('worker'); if (spec.parameters.type !== 'number' || !spec.guidelines.includes('Supply the current worker PID')) throw new Error('Wrong tool description'); let kept = 21; await tools.worker(process.pid); kept",
              "if ((await tools('worker')).parameters.type !== 'number') throw new Error('Catalog was not retained'); kept += 1",
              "await tools.worker(process.pid); typeof kept",
              "let rejected = false; try { await tools.cell({code: 'kept = 0'}) } catch (error) { rejected = error.message.includes('tools.cell is not a host tool selected for this turn') }; let hiddenRejected = false; try { await tools.hidden({}) } catch { hiddenRejected = true }; rejected && hiddenRejected && kept === 23",
              "typeof kept",
              "await tools.worker(process.pid); while (true) {}",
            ]
            const { layer: providerLayer } = yield* LanguageModelLayers.sequence(
              sources.flatMap((code, index) => {
                let call = toolCallStep("cell", { code, reset: index === 4 })
                if (index === 1)
                  call = multiToolCallStep(
                    { toolName: "cell", input: { code } },
                    { toolName: "cell", input: { code } },
                  )
                const steps = [call]
                if (index !== 5) steps.push(textStep(`done-${index}`))
                return steps
              }),
            )
            const extensions: ReadonlyArray<LoadedExtension> = [
              {
                manifest: { id: ExtensionId.make("cell-lifetime") },
                scope: "builtin",
                sourcePath: "cell-lifetime",
                artifactIdentity: LoadedArtifactIdentity.make("cell-lifetime-source"),
                contributions: {
                  tools: [
                    tool({
                      id: "hidden",
                      description: "Registered but denied by agent policy",
                      params: Schema.Struct({}),
                      output: Schema.Finite,
                      execute: () => Ref.updateAndGet(hiddenCalls, (count) => count + 1),
                    }),
                    tool({
                      id: "worker",
                      description: "Record worker identity",
                      promptGuidelines: ["Supply the current worker PID"],
                      params: Schema.Finite,
                      output: Schema.Boolean,
                      execute: (pid) =>
                        Ref.update(pids, (values) => [...values, pid]).pipe(Effect.as(true)),
                    }),
                    CellTool,
                  ],
                },
              },
            ]
            const { client, sessionId, branchId } = yield* createRpcHarness({
              extensions,
              providerLayer,
              branchTools: CellBranchTools,
              agents: [new AgentDefinition({ name: DEFAULT_AGENT_NAME, deniedTools: ["hidden"] })],
            })
            expect(yield* Ref.get(pids)).toEqual([])
            const second = yield* client.branch.create({ sessionId })
            const branches = [branchId, branchId, second.branchId, branchId, branchId, branchId]
            const expected = ["21", "23", "undefined", "true", "undefined"]
            for (const [index, targetBranch] of branches.entries()) {
              const content = `run-${index}`
              yield* client.message.send({ sessionId, branchId: targetBranch, content })
              const messages = yield* waitFor(
                client.message.list({ branchId: targetBranch }),
                (messages) =>
                  messages.some(
                    (message) =>
                      message.role === "user" && messagePartsText(message.parts) === content,
                  ),
              )
              const user = messages.find(
                (message) => message.role === "user" && messagePartsText(message.parts) === content,
              )
              if (Predicate.isUndefined(user)) return yield* Effect.die("Missing submitted message")
              if (index === 5) {
                const workers = yield* waitFor(Ref.get(pids), (values) => values.length === 3)
                const pid = workers[2]
                if (Predicate.isUndefined(pid)) return yield* Effect.die("Missing active worker")
                yield* client.steer.command({
                  command: SteerCommand.make({
                    _tag: "Cancel",
                    sessionId,
                    branchId: targetBranch,
                    requestId: RequestId.make(yield* platform.randomId),
                  }),
                })
                const stopped = yield* waitFor(
                  platform.signal(pid, 0).pipe(Effect.exit),
                  Exit.isFailure,
                  2000,
                  "cancelled worker exit",
                )
                expect(Exit.isFailure(stopped)).toBe(true)
              }
              yield* client.session.events({ sessionId, branchId: targetBranch }).pipe(
                Stream.filter(
                  (envelope) =>
                    envelope.event._tag === "TurnCompleted" && envelope.event.messageId === user.id,
                ),
                Stream.take(1),
                Stream.runDrain,
              )
              const completed = yield* client.message.list({ branchId: targetBranch })
              const results = completed
                .flatMap((message) => message.parts)
                .filter((part) => part.type === "tool-result")
                .filter((part) => part.name === "cell")
              if (index === 1) {
                const repeated = results.slice(-2)
                expect(new Set(repeated.map((part) => part.id)).size).toBe(2)
                expect(repeated).toMatchObject([
                  { isFailure: false, result: { display: "22" } },
                  { isFailure: false, result: { display: "23" } },
                ])
              }
              if (index === 5)
                expect(results.at(-1)).toMatchObject({
                  isFailure: true,
                  result: { _tag: "CellKernelError", reason: "cancelled", stateLost: true },
                })
              else
                expect(results.at(-1)).toMatchObject({
                  isFailure: false,
                  result: { display: expected[index] },
                })
            }
            expect(new Set(yield* Ref.get(pids)).size).toBe(2)
            expect(yield* Ref.get(hiddenCalls)).toBe(0)
          }),
        )
        for (const pid of yield* Ref.get(pids)) {
          expect((yield* platform.signal(pid, 0).pipe(Effect.flip))._tag).toBe("SignalError")
        }
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platform)),
    18000,
  )
})

// ── cell recovery ───────────────────────────────────────────────────────────

/**
 * The delegate registry is one JSON array per parent branch under
 * `<home>/.gent/delegates`. Seeding it is how a test admits a durable child
 * the way a crashed process would have left one behind.
 */
const encodeRegistry = Schema.encodeSync(Schema.fromJsonString(Schema.Array(DelegateEntry)))

const seedDelegateRegistry = Effect.fn("test.seedDelegateRegistry")(function* (
  branchId: BranchId,
  entries: ReadonlyArray<DelegateEntry>,
) {
  const fs = yield* FileSystem.FileSystem
  const directory = `${(yield* RuntimeEnvironment).home}/.gent/delegates`
  yield* fs.makeDirectory(directory, { recursive: true })
  yield* fs.writeFileString(`${directory}/${branchId}.json`, encodeRegistry(entries))
})

/**
 * The leaf view `delegate.cancel` sees when the parent branch runs it. The real
 * host context carries the session facade the tool steers through, so the
 * cancellation reaches the child's loop exactly as it does in production.
 */
const delegateToolContext = Effect.fn("test.delegateToolContext")(function* (parent: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
}) {
  // Outside a loop the facade has no session control, so the cancellation the
  // tool steers would die. The runtime is the same door the loop opens.
  return {
    ...(yield* runtimeHostContext(parent)),
    extensionId: ExtensionId.make("cell-recovery"),
    toolCallId: ToolCallId.make("delegate-cancel-call"),
  }
})

/**
 * Starts the recovered child and cancels it once it holds a request at the
 * model. The first `delegate.list` is what starts it: its reconcile re-sends
 * the start the lost worker never sent, and admission returns before the
 * child's turn reaches the model. A cancel sent at once can stop that turn
 * first, and the parent's next turn then takes the model reply scripted for
 * the child. `childAtModel` ends that race.
 */
const cancelRecoveredChild = Effect.fn("test.cancelRecoveredChild")(function* (
  outer: Option.Option<Message["parts"][number]>,
  parent: { readonly sessionId: SessionId; readonly branchId: BranchId },
  childAtModel: Effect.Effect<void>,
) {
  if (Option.isNone(outer) || outer.value.type !== "tool-result")
    return yield* Effect.die("Missing recovered cell result")
  const recovered = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      operations: Schema.Array(
        Schema.Struct({
          tool: Schema.Literal("delegate.start"),
          outcome: Schema.Literal("incomplete"),
          toolCallId: ToolCallId,
        }),
      ),
    }),
  )(outer.value.result)
  const operation = recovered.operations[0]
  if (Predicate.isUndefined(operation)) return yield* Effect.die("Missing unknown child operation")
  const requestId = RequestId.make(operation.toolCallId)
  const ctx = yield* delegateToolContext(parent)
  const observe = runToolWithCtx(ListChildren, {}, ctx).pipe(
    Effect.map((children) => children.find((child) => child.requestId === requestId)),
  )
  expect((yield* observe)?.completed).toBe(false)
  yield* childAtModel
  yield* runToolWithCtx(CancelChild, { requestId }, ctx)
  const cancelled = yield* waitFor(
    observe,
    (observed) => observed?.completed === true,
    2000,
    "cancelled child completion",
  )
  expect(cancelled?.interrupted).toBe(true)
})

it.scopedLive(
  "recovers saved cells through RPC, and reports a call cut short as interrupted instead of running it again",
  () =>
    Effect.gen(function* () {
      for (const state of [
        "unadmitted",
        "revoked",
        "incomplete",
        "completed",
        "waiting",
        "unknown-child",
      ]) {
        const deniedTools: string[] = []
        if (state === "revoked") deniedTools.push("cell")
        const nativeCalls = yield* Ref.make(0)
        const cellCalls = yield* Ref.make(0)
        const approvalCalls = yield* Ref.make(0)
        const selectedNames = yield* Ref.make<ReadonlyArray<string>>([])
        const extensions: ReadonlyArray<LoadedExtension> = [
          {
            manifest: { id: ExtensionId.make("cell-recovery") },
            scope: "builtin",
            sourcePath: "cell-recovery",
            artifactIdentity: LoadedArtifactIdentity.make("cell-recovery-source"),
            contributions: {
              tools: [
                StartChild,
                CancelChild,
                tool({
                  id: "approve",
                  description: "Approve inner operation",
                  params: Schema.Struct({}),
                  output: Schema.Boolean,
                  execute: () =>
                    Effect.gen(function* () {
                      yield* Ref.update(approvalCalls, (n) => n + 1)
                      return (yield* (yield* ExtensionContext).Interaction.approve({
                        text: "Continue inner operation?",
                      })).approved
                    }),
                }),
                tool({
                  id: "cell",
                  description: "Must not replay",
                  // Stands in for the real cell, so it must declare the same
                  // property the loop keys recovery off.
                  dispatches: true,
                  params: Schema.Struct({ code: Schema.String }),
                  output: Schema.Finite,
                  execute: () =>
                    Effect.gen(function* () {
                      const call = yield* CurrentToolCall
                      yield* Ref.set(selectedNames, [...call.toolBindings.keys()].sort())
                      return yield* Ref.updateAndGet(cellCalls, (n) => n + 1)
                    }),
                }),
                tool({
                  id: "sibling",
                  description: "Native sibling",
                  params: Schema.Struct({}),
                  output: Schema.Finite,
                  execute: () => Ref.updateAndGet(nativeCalls, (n) => n + 1),
                }),
              ],
            },
          },
        ]
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          textStep("Recovered"),
          // The orphaned child's own turn, once `delegate.list` restarts it
          // after the recovery turn. It is gated and never released, so the
          // child is still at the model when the parent cancels it.
          { ...textStep("child"), gated: true },
          // The parent reads the cancelled child's completion message.
          textStep("Child cancelled"),
        ])
        // Keep the real server context to seed the crash gap before actor startup.
        const context = yield* Layer.build(
          createE2ELayer({
            extensions,
            providerLayer,
            agents: [new AgentDefinition({ name: DEFAULT_AGENT_NAME, deniedTools })],
            branchTools: CellBranchTools,
            approvalLayer: ApprovalService.Live,
          }),
        )
        const { client } = yield* createRpcClient(Layer.succeedContext(context))
        const { sessionId, branchId } = yield* client.session.create({})
        const workspaceId = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const rows = yield* sql<{
            readonly workspace_id: string
          }>`SELECT workspace_id FROM sessions WHERE id = ${sessionId}`
          return yield* Schema.decodeUnknownEffect(WorkspaceId)(rows[0]?.workspace_id)
        }).pipe(Effect.provideContext(context))
        const messageId = MessageId.make("cell-recovery-user")
        const assistantMessageId = assistantMessageIdForTurn(messageId, 1)
        const cell = {
          sessionId,
          branchId,
          assistantMessageId,
          toolCallId: ToolCallId.make("outer-cell"),
        }
        const savedResult = Prompt.toolResultPart({
          id: cell.toolCallId,
          name: "cell",
          result: { display: "Saved" },
          isFailure: false,
          providerExecuted: false,
        })
        yield* Effect.gen(function* () {
          const messages = yield* MessageStorage
          const user = Message.cases.regular.make({
            id: messageId,
            sessionId,
            branchId,
            role: "user",
            parts: [Prompt.textPart({ text: "Continue" })],
            createdAt: dateFromMillis(0),
          })
          yield* messages.createMessage(user)
          yield* messages.createMessage(
            Message.cases.regular.make({
              id: assistantMessageId,
              sessionId,
              branchId,
              role: "assistant",
              createdAt: dateFromMillis(1),
              parts: [
                Prompt.toolCallPart({
                  id: cell.toolCallId,
                  name: "cell",
                  params: { code: "sideEffect()" },
                  providerExecuted: false,
                }),
                Prompt.toolCallPart({
                  id: "native-sibling",
                  name: "sibling",
                  params: {},
                  providerExecuted: false,
                }),
              ],
            }),
          )
          const cells = (yield* CellStorage).executions
          if (state !== "unadmitted" && state !== "revoked") yield* cells.claim(cell)
          if (state === "completed") yield* cells.complete(cell, savedResult)
          const turn = yield* captureTurnTools(cell)
          const bindingOf = (name: string) => Option.fromUndefinedOr(turn.toolBindings.get(name))
          if (state === "unknown-child") {
            const selected = bindingOf("delegate.start")
            const identity = Option.flatMap(selected, (entry) =>
              Option.fromUndefinedOr(entry.binding),
            )
            if (Option.isNone(identity)) return yield* Effect.die("Missing child start binding")
            const prompt = "Admitted before the worker was lost"
            const admitted = yield* (yield* CellStorage).operations.admit({
              cell,
              operationId: "unknown-child-start",
              binding: identity.value,
              input: { agent: DEFAULT_AGENT_NAME, prompt },
            })
            const toolCallId = admitted.operation.toolCallId
            const child = yield* client.session.create({
              parentSessionId: sessionId,
              parentBranchId: branchId,
            })
            yield* seedDelegateRegistry(branchId, [
              {
                requestId: RequestId.make(toolCallId),
                sessionId: child.sessionId,
                branchId: child.branchId,
                agentName: DEFAULT_AGENT_NAME,
                prompt,
                toolCallId,
                private: false,
                submitted: false,
                delivered: false,
              },
            ])
          }
          if (state === "unadmitted" || state === "revoked") {
            const captured = bindingOf("cell")
            const identity = Option.flatMap(captured, (entry) =>
              Option.fromUndefinedOr(entry.binding),
            )
            if (Option.isNone(identity)) return yield* Effect.die("Missing outer cell binding")
            yield* plantToolCallBinding({ ...cell, binding: identity.value })
          }
          if (state === "waiting") {
            const selected = bindingOf("approve")
            if (Option.isNone(selected)) return yield* Effect.die("Missing approval binding")
            const suspendedHost = yield* makeCellToolHost({
              cell,
              ledger: yield* ModelContextLedger.make,
              toolBindings: new Map([["approve", selected.value]]),
              profile: turn.profile,
            })
            yield* askThenLoseWorker(
              suspendedHost,
              CellResponse.cases.HostCall.make({
                cellId: "1",
                operationId: "1",
                name: "approve",
                input: {},
              }),
              cell,
            )
          }
          const binding = bindingOf("sibling")
          const identity = Option.flatMap(binding, (entry) => Option.fromUndefinedOr(entry.binding))
          if (Option.isNone(identity)) return yield* Effect.die("Missing sibling binding")
          yield* plantToolCallBinding({
            sessionId,
            branchId,
            assistantMessageId,
            toolCallId: ToolCallId.make("native-sibling"),
            binding: identity.value,
          })
          yield* plantInFlightTurn({ sessionId, branchId, message: user })
        }).pipe(
          Effect.provideContext(context),
          Effect.provideService(CurrentWorkspaceId, workspaceId),
        )
        const finished = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.filter((envelope) => envelope.event._tag === "TurnCompleted"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        )
        yield* client.session.getSnapshot({ sessionId, branchId })
        if (state === "waiting") {
          yield* client.session.watchRuntime({ sessionId, branchId }).pipe(
            Stream.filter((runtime) => runtime._tag === "WaitingForInteraction"),
            Stream.take(1),
            Stream.runDrain,
          )
          expect(yield* Ref.get(approvalCalls)).toBe(1)
          expect(yield* Ref.get(nativeCalls)).toBe(0)
          const pending = yield* Effect.gen(function* () {
            return yield* (yield* InteractionStorage).listOpen({ sessionId, branchId })
          }).pipe(
            Effect.provideContext(context),
            Effect.provideService(CurrentWorkspaceId, workspaceId),
          )
          const request = pending[0]
          if (Predicate.isUndefined(request)) return yield* Effect.die("Missing approval")
          yield* client.interaction.respondInteraction({
            sessionId,
            branchId,
            requestId: request.requestId,
            approved: true,
          })
        }
        yield* Fiber.join(finished)
        const messages = yield* client.message.list({ branchId })
        expect(
          messages.some(
            (message) =>
              message.role === "assistant" && messagePartsText(message.parts) === "Recovered",
          ),
        ).toBe(true)
        const results = messages.find(
          (message) => message.id === toolResultMessageIdForTurn(messageId, 1),
        )?.parts
        expect(results).toHaveLength(2)
        const outer = results?.find(
          (part) => part.type === "tool-result" && part.id === cell.toolCallId,
        )
        if (state === "unknown-child") {
          yield* cancelRecoveredChild(
            Option.fromUndefinedOr(outer),
            { sessionId, branchId },
            controls.waitForCall(1),
          ).pipe(
            Effect.provideContext(context),
            Effect.provideService(CurrentWorkspaceId, workspaceId),
          )
          // The cancelled child reports back, so the parent reads it in one
          // more turn. Three model calls in all: the recovery turn, the
          // child's gated turn, and the parent reading the completion. The
          // recovered cell itself never replayed — that is the two results
          // asserted above, not a fourth call.
          const settled = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              current.messages.some(
                (message) => message.metadata?.customType === "child-completion",
              ),
            5000,
            "the cancelled child reported to the parent",
          )
          expect(
            settled.messages.filter(
              (message) => message.metadata?.customType === "child-completion",
            ),
          ).toHaveLength(1)
          expect(yield* controls.callCount).toBe(3)
        }
        // A cell with no receipt was in flight too: it is not run again.
        if (state === "completed") expect(outer).toEqual(savedResult)
        else if (state === "unadmitted" || state === "revoked")
          expect(outer).toMatchObject({ isFailure: true, result: { reason: "Interrupted" } })
        else
          expect(outer).toMatchObject({
            isFailure: true,
            result: { stateLost: true },
          })
        if (state === "waiting") {
          expect(yield* Ref.get(approvalCalls)).toBe(2)
          expect(outer).toMatchObject({
            result: {
              operations: [{ tool: "approve", outcome: "succeeded", summary: "true" }],
            },
          })
        }
        // The native sibling was in flight when the process died: the model
        // reads that it was interrupted, and it does not run again.
        expect(
          results?.find((part) => part.type === "tool-result" && part.id === "native-sibling"),
        ).toMatchObject({ isFailure: true, result: { reason: "Interrupted" } })
        expect(yield* Ref.get(cellCalls)).toBe(0)
        expect(yield* Ref.get(nativeCalls)).toBe(0)
      }
    }).pipe(Effect.timeout("12 seconds")),
  15000,
)

// ── cell prompt guidelines ──────────────────────────────────────────────────

describe("cell prompt guidelines", () => {
  it.effect("tells the model what the cell runtime exposes so it does not guess at imports", () =>
    Effect.sync(() => {
      const guidelines = (getToolMetadata(CellTool).promptGuidelines ?? []).join("\n")
      expect(guidelines).toContain(
        "The cell is a full Bun process in the working directory with your user's privileges; nothing is sandboxed. Bun (Bun.file, Bun.write, Bun.$, Bun.spawn), bun:sqlite, fetch, process (cwd, env), node builtins through await import('node:fs/promises') or require('node:path'), and packages resolved from the working directory are all available.",
      )
      expect(guidelines).toContain(
        "Shell that changes state (git, installs, deletes, network writes) goes through tools.bash({ command })",
      )
      expect(guidelines).toContain("Return a summary, not the data.")
      expect(guidelines).toContain(
        "console output, process.stdout and process.stderr writes, and inherited output of spawned processes return with the cell result",
      )
    }),
  )

  it.effect(
    "names the compute deadline and sends builds and tests to bash, which stops that clock",
    () =>
      Effect.sync(() => {
        const guidelines = (getToolMetadata(CellTool).promptGuidelines ?? []).join("\n")
        expect(guidelines).toContain("A cell gets 30 seconds of its own compute")
        expect(guidelines).toContain(
          "run builds, test suites, and other long commands through tools.bash({ command, timeout })",
        )
        expect(guidelines).not.toContain("Bun.$ and Bun.spawn are for reading: builds, tests")
      }),
  )

  it.scopedLive(
    "with a classifier credential the prompt names models.decide, its three decision kinds, and composing it in code, but no model and no price",
    () =>
      Effect.gen(function* () {
        const prompt = yield* cellSystemPrompt({ storeKey: true })
        expect(prompt).toContain("models.decide(input, decisions, { model, timeoutMs })")
        expect(prompt).toContain("within timeoutMs (at most and by default 60000) rejects")
        expect(prompt).toContain("models.classify(")
        expect(prompt).toContain("models.rate(")
        expect(prompt).toContain("models.probability(")
        expect(prompt).toContain("compose it in code with other tools")
        const guide = prompt.split("# Classifier models in the cell")[1]?.split("\n# ")[0] ?? ""
        expect(guide).toContain("models.decide")
        expect(guide).not.toMatch(/jev-|judge\/|cent\b|\$/)
      }).pipe(Effect.timeout("10 seconds")),
    12_000,
  )

  it.scopedLive(
    "without a classifier credential the prompt does not name models.decide",
    () =>
      Effect.gen(function* () {
        const prompt = yield* cellSystemPrompt({ storeKey: false })
        expect(prompt).toContain("# Working in the cell")
        expect(prompt).not.toContain("models.decide")
        expect((getToolMetadata(CellTool).promptGuidelines ?? []).join("\n")).not.toContain(
          "models.decide",
        )
      }).pipe(Effect.timeout("10 seconds")),
    12_000,
  )
})

/** The system prompt of the first model request, with the judge driver and optionally its key. */
const cellSystemPrompt = Effect.fn("test.cellSystemPrompt")(function* (params: {
  readonly storeKey: boolean
}) {
  const prompts = yield* Ref.make<ReadonlyArray<string>>([])
  const providerLayer = LanguageModelLayers.testStream((options) =>
    Ref.update(prompts, (seen) => [...seen, turnRequestText(options.prompt).systemPrompt]).pipe(
      Effect.as(Stream.fromIterable([textDeltaPart("done"), finishPart({ finishReason: "stop" })])),
    ),
  )
  const calls = yield* Ref.make<ReadonlyArray<JudgeCall>>([])
  const { client, sessionId, branchId } = yield* createRpcHarness({
    ...shippedPreset,
    // The shipped Jev drivers read the developer's keys.
    extensionInputs: [
      ...BuiltinExtensions.filter((extension) => !SHIPPED_JEV_DRIVERS.has(extension.manifest.id)),
      judgeExtension(calls),
    ],
    providerLayer,
  })
  if (params.storeKey) yield* client.auth.setKey({ provider: "judge", key: "judge-key" })
  yield* client.message.send({ sessionId, branchId, content: "hello" })
  const seen = yield* waitFor(
    Ref.get(prompts),
    (all) => all.length > 0,
    8_000,
    "the first model request",
  )
  expect(yield* Ref.get(calls)).toEqual([])
  return seen[0] ?? ""
})

// ── tool signatures ─────────────────────────────────────────────────────────

const bracketed = tool({
  id: "must-not-run",
  description: "First line.\nSecond line.",
  params: Schema.Struct({
    items: Schema.Array(Schema.Union([Schema.String, Schema.Finite])),
    node: Schema.optional(Schema.Struct({ id: Schema.String })),
  }),
  output: Schema.Boolean,
  execute: () => Effect.succeed(true),
})

const shippedSignatures: ReadonlyArray<readonly [ToolCapability, string]> = [
  [
    StartChild,
    '- tools.delegate.start(input: { todo: string; context?: "fresh" | "fork"; overrides?: object }): Promise<{ requestId: string; sessionId: string; branchId: string }> // Start a child agent on a task',
  ],
  [
    CancelChild,
    '- tools.delegate.cancel(input: { requestId: string }): Promise<{ _tag: "Pending"; requestId: string; sessionId: string; branchId: string } | { _tag: "Completed"; requestId: string; sessionId: string; branchId: string; interrupted?: boolean; streamFailed?: boolean; unanswered?: boolean }> // Cancel a running child on this branch. Its turn ends as interrupted; a finished child is left as it is.',
  ],
  [
    ListChildren,
    "- tools.delegate.list(input?: { completed?: boolean }): Promise<{ requestId: string; sessionId: string; branchId: string; agentName: string; completed: boolean; interrupted?: boolean; streamFailed?: boolean; unanswered?: boolean }[]> // List every child this branch owns, from the registry. The registry survives restarts; completed is a turn receipt, no...",
  ],
  [
    BashTool,
    '- tools.bash(input: { command: string; timeout?: number; cwd?: string; run_in_background?: boolean }): Promise<{ stdout: string; stderr: string; exitCode: number; status?: "background"; outputFile?: string; outputChars?: number }> // Execute shell commands',
  ],
  [
    ReadTool,
    "- tools.read(input: { path: string; offset?: number; limit?: number }): Promise<{ content: string; path: string; lineCount: number; truncated: boolean; nextOffset?: number; lossy?: true }> // Read file contents with line numbers",
  ],
  [
    WriteTool,
    "- tools.write(input: { atomic?: boolean; path: string; content: string }): Promise<{ path: string; bytesWritten: number }> // Create or overwrite files",
  ],
  [
    EditTool,
    "- tools.edit(input: { path: string; oldString: string; newString: string; replaceAll?: boolean }): Promise<{ path: string; replacements: number }> // Apply targeted edits to existing files",
  ],
  [
    GrepTool,
    "- tools.grep(input: { pattern: string; path?: string; glob?: string; caseSensitive?: boolean; context?: number; limit?: number }): Promise<{ matches: { file: string; line: number; content: string; context?: object }[]; truncated: boolean; unreadable?: number; oversized?: number; undecided?: number }> // Search file contents with regex",
  ],
  [
    GoalTool,
    '- tools.goal(input: { action: "get" | "create" | "complete"; objective?: string; tokenBudget?: number }): Promise<{ goal?: object; remainingTokens?: number; report?: string }> // Persistent goal state',
  ],
  [
    AskUserTool,
    "- tools.ask_user(input: { questions: object[] }): Promise<{ answers: string[][]; cancelled?: boolean }> // Ask the user questions with optional predefined options",
  ],
  [
    PromptTool,
    '- tools.prompt(input: { mode: "present" | "confirm" | "review"; content: string; title?: string }): Promise<{ mode: "present"; status: "shown" } | { mode: "confirm"; decision: "yes" | "no" } | { mode: "review"; decision: "yes" | "no" | "edit"; path: string; content?: string }> // Present content to the user for review, confirmation, or informational display. Use mode=present for informational co...',
  ],
  [
    HandoffTool,
    "- tools.handoff(input: { context: string; reason?: string }): Promise<{ handoff: boolean; reason?: string; summary?: string; parentSessionId?: string }> // Transfer context to a new session",
  ],
  [
    WebSearchTool,
    '- tools.websearch(input: { query: string; numResults?: number; type?: "auto" | "fast" }): Promise<{ output: string; query: string }> // Search the web for information',
  ],
  [
    ReadSessionTool,
    "- tools.read_session(input: { sessionId: string; branchId?: string }): Promise<{ sessionId: string; content: string; messageCount?: number; branchCount?: number }> // Read a past session's conversation as markdown. A long transcript keeps its head and tail.",
  ],
  [
    WakeTool,
    '- tools.wake(input: { afterSeconds?: number; at?: string; everySeconds?: number; mode?: "wake" | "notify"; note: string }): Promise<{ wakeId: string; dueAt: string; everySeconds?: number; mode: "wake" | "notify"; note: string }> // Schedule a wake-up alarm',
  ],
  [
    MonitorTool,
    '- tools.monitor(input: { command: string; cwd?: string; everySeconds?: number; until?: string; timeoutSeconds?: number; mode?: "wake" | "notify"; note: string }): Promise<{ wakeId: string; everySeconds: number; deadline: string; mode: "wake" | "notify"; note: string }> // Poll a command until it succeeds, then wake',
  ],
  [
    CancelTool,
    "- tools.wake.cancel(input?: { wakeId?: string }): Promise<{ cancelled: string[] }> // Cancel a pending alarm or monitor",
  ],
  [
    bracketed,
    '- tools["must-not-run"](input: { items: (string | number)[]; node?: { id: string } }): Promise<boolean> // First line.',
  ],
]

const numberInput = tool({
  id: "worker",
  description: "Supply the current worker PID.",
  params: Schema.Finite,
  output: Schema.Boolean,
  execute: () => Effect.succeed(true),
})

const eitherInput = tool({
  id: "either",
  description: "Takes one of two shapes.",
  params: Schema.Union([
    Schema.Struct({ left: Schema.String }),
    Schema.Struct({ right: Schema.String }),
  ]),
  output: Schema.Boolean,
  execute: () => Effect.succeed(true),
})

const emptyInput = tool({
  id: "ping",
  description: "Takes nothing.",
  params: Schema.Struct({}),
  output: Schema.Boolean,
  execute: () => Effect.succeed(true),
})

const hugeEnum = tool({
  id: "huge",
  description: "Picks one of many kinds.",
  params: Schema.Struct({
    kind: Schema.Literals(Array.from({ length: 10_000 }, (_, index) => `kind-${index}`)),
  }),
  output: Schema.Boolean,
  execute: () => Effect.succeed(true),
})

const wideInput = tool({
  id: "wide",
  description: "Takes many fields.",
  params: Schema.Struct(
    Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`field${index}`, Schema.String])),
  ),
  output: Schema.Boolean,
  execute: () => Effect.succeed(true),
})

const collidingId = tool({
  id: "read.then",
  description: "A segment JavaScript probes.",
  params: Schema.Struct({ path: Schema.String }),
  output: Schema.Boolean,
  execute: () => Effect.succeed(true),
})

const discoveryId = tool({
  id: "search.issues",
  description: "A namespace named like a discovery key.",
  params: Schema.Struct({ query: Schema.String }),
  output: Schema.Boolean,
  execute: () => Effect.succeed(true),
})

class ClassResult extends Schema.Class<ClassResult>("ClassResult")({
  ok: Schema.Boolean,
  items: Schema.Array(Schema.String),
}) {}

interface TreeNode {
  readonly name: string
  readonly children: ReadonlyArray<TreeNode>
}
const TreeNode: Schema.Codec<TreeNode> = Schema.Struct({
  name: Schema.String,
  children: Schema.Array(Schema.suspend(() => TreeNode)),
}).annotate({ identifier: "TreeNode" })

const classResult = tool({
  id: "class-result",
  description: "Returns a class.",
  params: Schema.Struct({ nested: Schema.optional(ClassResult) }),
  output: ClassResult,
  execute: () => Effect.succeed(new ClassResult({ ok: true, items: [] })),
})

const nullableMiddle = tool({
  id: "nullable-middle",
  description: "Takes an optional field with a nested nullable union.",
  params: Schema.Struct({
    box: Schema.optional(
      Schema.NullOr(
        Schema.Struct({ a: Schema.Union([Schema.String, Schema.Null, Schema.Finite]) }),
      ),
    ),
  }),
  output: Schema.Boolean,
  execute: () => Effect.succeed(true),
})

const treeResult = tool({
  id: "tree",
  description: "Returns a tree.",
  params: Schema.Struct({}),
  output: TreeNode,
  execute: () => Effect.succeed({ name: "root", children: [] }),
})

const longLiterals = Array.from({ length: 8 }, (_, index) => `${"long-literal-".repeat(4)}${index}`)

const longLiteralResult = tool({
  id: "long-literal",
  description: "Returns one of a few long names.",
  params: Schema.Struct({}),
  output: Schema.Literals(longLiterals),
  execute: () => Effect.succeed(longLiterals[0] ?? ""),
})

const wideOrList = tool({
  id: "wide-or-list",
  description: "Returns a wide object or a list.",
  params: Schema.Struct({}),
  output: Schema.Union([
    Schema.Struct(
      Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [`field${index}`, Schema.String]),
      ),
    ),
    Schema.Array(Schema.String),
  ]),
  execute: () => Effect.succeed([]),
})

const recordResult = tool({
  id: "record",
  description: "Returns a map.",
  params: Schema.Struct({}),
  output: Schema.Record(Schema.String, Schema.Boolean),
  execute: () => Effect.succeed({}),
})

const edgeSignatures: ReadonlyArray<readonly [ToolCapability, string]> = [
  [
    numberInput,
    "- tools.worker(input: number): Promise<boolean> // Supply the current worker PID.",
  ],
  [
    eitherInput,
    "- tools.either(input: { left: string } | { right: string }): Promise<boolean> // Takes one of two shapes.",
  ],
  [emptyInput, "- tools.ping(input?: unknown): Promise<boolean> // Takes nothing."],
  [hugeEnum, "- tools.huge(input: { kind: string }): Promise<boolean> // Picks one of many kinds."],
  [wideInput, "- tools.wide(input: object): Promise<boolean> // Takes many fields."],
  [
    collidingId,
    '- tools("read.then")(input: { path: string }): Promise<boolean> // A segment JavaScript probes.',
  ],
  [
    discoveryId,
    '- tools("search.issues")(input: { query: string }): Promise<boolean> // A namespace named like a discovery key.',
  ],
  [
    classResult,
    '- tools["class-result"](input?: { nested?: { ok: boolean; items: string[] } }): Promise<{ ok: boolean; items: string[] }> // Returns a class.',
  ],
  [
    nullableMiddle,
    '- tools["nullable-middle"](input?: { box?: { a: string | null | number } }): Promise<boolean> // Takes an optional field with a nested nullable union.',
  ],
  [
    treeResult,
    "- tools.tree(input?: unknown): Promise<{ name: string; children: object[] }> // Returns a tree.",
  ],
  [
    longLiteralResult,
    '- tools["long-literal"](input?: unknown): Promise<string> // Returns one of a few long names.',
  ],
  [
    wideOrList,
    '- tools["wide-or-list"](input?: unknown): Promise<object | string[]> // Returns a wide object or a list.',
  ],
  [
    recordResult,
    "- tools.record(input?: unknown): Promise<Record<string, boolean>> // Returns a map.",
  ],
]

// Each level names a union of the one below and a list of it, so a renderer
// that expands a shared definition at every reach doubles per level.
const sharedUnion = Array.from({ length: 22 }).reduce<Schema.Codec<unknown>>(
  (below, _, index) =>
    Schema.Union([below, Schema.Array(below)]).annotate({ identifier: `Level${index + 1}` }),
  Schema.Union([Schema.Boolean, Schema.Null]).annotate({ identifier: "Level0" }),
)
// Anonymous unions nested with no definition to share.
const nestedUnion = Array.from({ length: 14 }).reduce<Schema.Codec<unknown>>(
  (below) => Schema.Union([Schema.Boolean, Schema.Null, Schema.Array(below)]),
  Schema.Union([Schema.Boolean, Schema.Null]),
)
const deepUnionTools = [
  tool({
    id: "shared-union",
    description: "Returns a shared union.",
    params: Schema.Struct({ value: sharedUnion }),
    output: sharedUnion,
    execute: () => Effect.succeed(true),
  }),
  tool({
    id: "nested-union",
    description: "Returns a nested union.",
    params: Schema.Struct({ value: nestedUnion }),
    output: nestedUnion,
    execute: () => Effect.succeed(true),
  }),
]

describe("tool signature bound", () => {
  for (const capability of deepUnionTools) {
    it.live(
      `${getToolId(capability)} renders within the type limit, in one pass over its definitions`,
      () =>
        Effect.gen(function* () {
          const started = yield* Clock.currentTimeMillis
          const line = yield* renderToolSignature(capability)
          const elapsed = (yield* Clock.currentTimeMillis) - started
          const [, input = "", result = ""] =
            /^- tools\["[^"]+"\]\(input: (.*)\): Promise<(.*)> \/\/ /.exec(line) ?? []
          expect(input).toBe("object")
          expect(result).toBe("boolean | null | unknown[]")
          // Expanding a shared definition at every reach doubles the work per level.
          expect(elapsed).toBeLessThan(1000)
        }),
    )
  }
})

describe("tool signature edges", () => {
  for (const [capability, expected] of edgeSignatures) {
    it.effect(`${getToolId(capability)} keeps its argument contract and a bounded line`, () =>
      Effect.gen(function* () {
        expect(yield* renderToolSignature(capability)).toBe(expected)
      }),
    )
  }
})

// ── host tool catalog budget ────────────────────────────────────────────────

/** A server-sized namespace: 100 tools under `mcp.fixture`. */
const fixtureNamespaceTools = Array.from({ length: 100 }, (_, index) => {
  const name = `tool_${String(index).padStart(3, "0")}`
  return tool({
    id: `mcp.fixture.${name}`,
    description: `Fixture operation ${name} that returns its own name for the catalog budget test.`,
    params: Schema.Struct({ query: Schema.String, limit: Schema.optional(Schema.Finite) }),
    output: Schema.Struct({ echoed: Schema.String }),
    execute: () => Effect.succeed({ echoed: name }),
  })
})

const fixtureNamespace = defineExtension({
  id: "@test/fixture-namespace",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* Effect.forEach(fixtureNamespaceTools, (capability) => host.register("tool", capability))
  }),
})

const catalogLine = (id: string, length: number) => ({
  id,
  line: `- ${`tools.${id}`.padEnd(length - 2, "x")}`,
})

describe("host tool catalog budget", () => {
  test("a catalog over budget collapses a namespace and keeps the top-level tools whole", () => {
    const big = Array.from({ length: 40 }, (_, index) =>
      catalogLine(`mcp.big.op_${String(index).padStart(2, "0")}`, 300),
    )
    const rendered = renderHostToolCatalog([
      catalogLine("read", 200),
      catalogLine("bash", 200),
      catalogLine("wake.cancel", 100),
      ...big,
    ])
    const lines = rendered.split("\n")
    expect(lines.map((line) => line.slice(0, 22))).toEqual([
      "- tools.bashxxxxxxxxxx",
      "- tools.mcp.big.*: 40 ",
      "- tools.readxxxxxxxxxx",
      "- tools.wake.cancelxxx",
    ])
    expect(lines[1]).toContain("(op_00, op_01, op_02")
    expect(lines[1]?.endsWith("…)")).toBe(true)
    expect(rendered.length).toBeLessThanOrEqual(HOST_TOOL_CATALOG_BUDGET)
    // Under the budget every line lists, and the order is by id.
    expect(renderHostToolCatalog(big.slice(0, 3)).split("\n")).toEqual(
      big.slice(0, 3).map((entry) => entry.line),
    )
  })

  test("the listing orders ids by code unit, whatever the locale or registration order", () => {
    // Under a locale order `ä` sorts beside `a`, and a composed and a
    // decomposed `é` compare equal, so their order would follow registration.
    const ids = ["z.x", "café.x", "ä.x", "a.x", "café.x"]
    const listed = (order: ReadonlyArray<string>) =>
      renderHostToolCatalog(order.map((id) => ({ id, line: `- tools.${id}` })))
    expect(listed(ids).split("\n")).toEqual(
      ["a.x", "café.x", "café.x", "z.x", "ä.x"].map((id) => `- tools.${id}`),
    )
    expect(listed(ids.toReversed())).toBe(listed(ids))
  })

  test("collapsed lines count against the budget, and namespaces past it share one line", () => {
    const many = Array.from({ length: 400 }, (_, server) =>
      Array.from({ length: 20 }, (_, index) =>
        catalogLine(`mcp.server_${String(server).padStart(3, "0")}.op_${index}`, 120),
      ),
    ).flat()
    const rendered = renderHostToolCatalog(many)
    expect(rendered.length).toBeLessThanOrEqual(HOST_TOOL_CATALOG_BUDGET)
    const lines = rendered.split("\n")
    // The first namespaces list whole, the next collapse, the rest are counted.
    expect(lines[0]?.startsWith("- tools.mcp.server_000.op_0x")).toBe(true)
    expect(lines.some((line) => /^- tools\.mcp\.server_\d{3}\.\*: 20 tools/.test(line))).toBe(true)
    expect(lines.at(-1)).toMatch(
      /^- \d+ more namespaces \(\d+ tools\), listed by tools\.search\(query\)$/,
    )
  })

  test("top-level tools past the budget share one line", () => {
    const many = Array.from({ length: 50 }, (_, index) =>
      catalogLine(`t${String(index).padStart(2, "0")}`, 200),
    )
    const lines = renderHostToolCatalog(many).split("\n")
    expect(lines.at(-1)).toMatch(/^- more tools: t\d\d, /)
    expect(lines.length).toBeLessThan(many.length)
  })

  it.scopedLive(
    "a 100-tool namespace collapses in a stable prompt, and the cell searches, signs, and calls its tools",
    () =>
      Effect.gen(function* () {
        const systems: Array<string> = []
        const recordSystem = (step: SequenceStep): SequenceStep => ({
          ...step,
          assertOptions: (options) => {
            systems.push(systemTextOf(options.prompt))
          },
        })
        const code = [
          "const found = tools.search('tool_042').items.map((entry) => entry.id)",
          "const signature = tools('mcp.fixture.tool_007').signature",
          "const called = await tools.mcp.fixture.tool_003({ query: 'x' })",
          "JSON.stringify({ found, signature, called })",
        ].join("; ")
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          recordSystem(toolCallStep("cell", { code })),
          recordSystem(textStep("done")),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...shippedPreset,
          extensionInputs: [...shippedPreset.extensionInputs, fixtureNamespace],
          providerLayer,
        })
        yield* client.message.send({ sessionId, branchId, content: "use the fixture" })
        const messages = yield* waitFor(
          client.message.list({ branchId }),
          (all) =>
            all.some(
              (message) =>
                message.role === "assistant" && messagePartsText(message.parts) === "done",
            ),
          10_000,
          "assistant reply done",
        )
        const result = messages
          .flatMap((message) => message.parts)
          .find((part): part is Prompt.ToolResultPart => part.type === "tool-result")
        expect(result).toMatchObject({
          name: "cell",
          isFailure: false,
          result: {
            display: encodeJson({
              found: ["mcp.fixture.tool_042"],
              signature:
                "tools.mcp.fixture.tool_007(input: { query: string; limit?: number }): Promise<{ echoed: string }> // Fixture operation tool_007 that returns its own name for the catalog budget test.",
              called: { echoed: "tool_003" },
            }),
          },
        })
        // The listing collapses the namespace, keeps the shipped tools, and
        // is the same text on every step of the turn.
        expect(systems).toHaveLength(2)
        expect(systems[1]).toBe(systems[0])
        const system = systems[0] ?? ""
        expect(system).toContain("- tools.mcp.fixture.*: 100 tools (tool_000, tool_001")
        expect(system).not.toContain("tools.mcp.fixture.tool_003(")
        expect(system).toContain("- tools.read(input: { path: string")
        expect(system).toContain("`tools.search(query)`")
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platform)),
    20000,
  )
})

describe("tool signatures", () => {
  // The cell code reads a result by its type, so no shipped tool's result
  // collapses to its outer shape.
  it.effect("every shipped tool's result renders whole, never as a bare object", () =>
    Effect.gen(function* () {
      const tools = yield* Effect.forEach(BuiltinExtensions, (extension) =>
        collectTestContributions(extension.setup).pipe(
          Effect.map((contributions) => contributions.tools ?? []),
        ),
      )
      const signatures = yield* Effect.forEach(tools.flat(), renderToolSignature)
      expect(signatures.length).toBeGreaterThan(shippedSignatures.length)
      expect(signatures.filter((line) => /: Promise<object(\[\])?>/.test(line))).toEqual([])
    }).pipe(Effect.provide(BunServices.layer)),
  )

  for (const [capability, expected] of shippedSignatures) {
    it.effect(`${getToolId(capability)} renders its callable path and types`, () =>
      Effect.gen(function* () {
        expect(yield* renderToolSignature(capability)).toBe(expected)
      }),
    )
  }
})
