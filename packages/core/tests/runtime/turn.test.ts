import { BunServices } from "@effect/platform-bun"
import { describe, expect, it, test } from "effect-bun-test"
import {
  Clock,
  Effect,
  Layer,
  Option,
  Ref,
  Schema,
  Scope,
  Stream,
  Cause,
  Context,
  Deferred,
  Exit,
  Fiber,
  Predicate,
} from "effect"
import {
  assistantMessageIdForTurn,
  dateFromMillis,
  Message,
  responseUsage,
  toolResultMessageIdForTurn,
  encodeToolOutput,
  isRuntimeUserMessage,
  messagePartsText,
  type SessionAdmission,
} from "../../src/domain/message"
import * as Response from "effect/ai/Response"
import {
  type ActiveStreamHandle,
  classifyStep,
  type CollectedTurnResponse,
  collectFailedModelTurnResponse,
  collectModelTurnResponse,
  collectNormalizedResponse,
  makeActiveStreamHandle,
  persistMessageReceived,
  recordToolOutcome,
  resolveSessionRoute,
  signalActiveStreamInterrupt,
  findPersistedToolResults,
  persistAssistantPartsWithBindings,
  ToolResultReplayError,
  makeTurnLedger,
} from "../../src/runtime/turn"
import {
  BranchId,
  MessageId,
  SessionId,
  ToolCallId,
  ExtensionId,
  RequestId,
  ToolId,
} from "../../src/domain/ids"
import {
  AgentDefinition,
  AgentName,
  DriverRef,
  ModelId,
  Model,
  ProviderId,
} from "../../src/domain/agent"
import { ProviderError } from "../../src/domain/errors"
import {
  finishPart,
  textDeltaPart,
  toolCallPart,
  type LanguageModelStreamPart,
  Auth,
  ModelResolver,
} from "../../src/runtime/provider"
import {
  type AgentEvent,
  EventEnvelope,
  EventId,
  EventStore,
  MessageReceived,
  ToolCallSucceeded,
  UsageSchema,
  TurnCompleted,
} from "../../src/domain/event"
import * as Prompt from "effect/ai/Prompt"
import {
  EventStorage,
  MessageStorage,
  makeStorageTransaction,
  ToolCallBindingStorage,
} from "../../src/storage/storage"
import { EventStoreLive } from "../../src/runtime/session"
import {
  noBranchTools,
  captureCurrentToolBinding,
  innerOperationBindingIdentity,
  processLocalReplayBindingKey,
  ProcessLocalToolReplay,
  type ResolvedToolCapability,
  resolveReplayToolBinding,
  resolveStoredToolBinding,
  ToolRunner,
} from "../../src/runtime/tools"
import {
  ensureStorageParents,
  testSqliteStorage,
  createE2ELayer,
  createRpcClient,
  createRpcHarness,
  recordingEventStore,
} from "../../src/test-utils/harness"
import {
  LanguageModelLayers,
  makeTempDirectoryScoped,
  multiToolCallStep,
  textStep,
  toolCallStep,
  waitFor,
} from "../../src/test-utils/language-model"
import {
  defineExtension,
  defineResource,
  ExtensionContext,
  ExtensionHost,
  tool,
  type ToolCapability,
} from "@gent/core/extensions/api"
import {
  actorTestRoot,
  helperAgent,
  makeAgentLoopService,
  makeLayer,
  makeLayerWithEvents,
  makeMessage,
  runAgentLoop,
  steerAgentLoop,
  stopAgentLoopMessage,
  submitAgentLoop,
  waitFor as waitForOption,
  waitForPhase,
} from "../helpers/agent-loop"
import { windowDetails } from "../../src/runtime/model-context"
import { e2ePreset, rangeCompactorLayer, testAgents } from "../helpers/test-preset"
import * as AiModel from "effect/ai/Model"
import { type ModelDriverContribution, type ProviderHints } from "../../src/domain/driver"
import { RuntimeEnvironment } from "../../src/runtime/config"
import { GentPlatform } from "../../src/runtime/gent-platform"
import {
  ApprovalService,
  ExtensionRegistry,
  resolveExtensions,
  SessionProfileCache,
} from "../../src/runtime/extension-host"
import { interjectionMessageId } from "../../src/domain/agent-loop"
import * as AiError from "effect/ai/AiError"
import { Database } from "bun:sqlite"
import type { LanguageModel } from "effect/ai"
import { LoadedArtifactIdentity, type LoadedExtension } from "../../src/domain/extension"
import {
  ToolBindingIdentity,
  ToolBindingSource,
  ToolSchemaRevision,
  ToolSourceRevision,
} from "../../src/domain/capability"

// ── turn response collectors ────────────────────────────────────────────────

const sessionId = SessionId.make("collector-session")
const branchId = BranchId.make("collector-branch")
const streamAddress = {
  messageId: MessageId.make("collector-turn"),
  assistantMessageId: MessageId.make("collector-turn:assistant:1"),
  step: 1,
}

const makeActiveStream = (
  interrupted: boolean,
): Effect.Effect<ActiveStreamHandle, never, Scope.Scope> =>
  Effect.gen(function* () {
    const handle = yield* makeActiveStreamHandle
    if (interrupted) yield* signalActiveStreamInterrupt(handle)
    return handle
  })

const captureEvents = () =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<AgentEvent>>([])
    const layer = Layer.succeed(
      EventStore,
      EventStore.of({
        subscribe: () => Stream.empty,
        removeSession: () => Effect.void,
        append: () => Effect.die("append not exercised in turn response tests"),
        deliver: () => Effect.void,
        publish: (event) => Ref.update(events, (items) => [...items, event]),
      }),
    )
    return { events, layer }
  })

describe("agent turn response collectors", () => {
  test("missing or invalid token totals stay unknown while explicit zero stays known", () => {
    const usage = Schema.decodeUnknownSync(Response.FinishPart)(
      finishPart({ finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0 } }),
    ).usage
    expect(responseUsage(usage)).toEqual(Option.some({ inputTokens: 0, outputTokens: 0 }))
    // oxlint-disable-next-line effect/noNullish -- A provider can leave the count out.
    for (const total of [undefined, -1, 1.5, Number.NaN]) {
      expect(responseUsage({ ...usage, inputTokens: { ...usage.inputTokens, total } })).toEqual(
        Option.none(),
      )
      expect(responseUsage({ ...usage, outputTokens: { ...usage.outputTokens, total } })).toEqual(
        Option.none(),
      )
    }
  })

  test("normalized response projects finish usage into message usage", () => {
    const collected = collectNormalizedResponse({
      responseParts: [
        Response.makePart("text", { text: "done" }),
        finishPart({ finishReason: "stop", usage: { inputTokens: 3, outputTokens: 5 } }),
      ],
      streamFailed: false,
      interrupted: false,
    })

    expect(collected.messageProjection.assistant.map((part) => part.type)).toEqual(["text"])
    expect(collected.messageProjection.usage).toEqual({ inputTokens: 3, outputTokens: 5 })
  })

  test("cache counts survive response projection and durable usage encoding", () => {
    const finish = Schema.decodeUnknownSync(Response.FinishPart)(
      finishPart({ finishReason: "stop", usage: { inputTokens: 100, outputTokens: 5 } }),
    )
    const collected = collectNormalizedResponse({
      responseParts: [
        Response.makePart("finish", {
          ...finish,
          usage: new Response.Usage({
            ...finish.usage,
            inputTokens: { ...finish.usage.inputTokens, cacheRead: 80, cacheWrite: 0 },
          }),
        }),
      ],
      streamFailed: false,
      interrupted: false,
    })
    const codec = Schema.fromJsonString(UsageSchema)
    const encoded = Schema.encodeSync(codec)(
      Option.getOrThrow(Option.fromUndefinedOr(collected.messageProjection.usage)),
    )
    expect(Schema.decodeSync(codec)(encoded)).toEqual({
      inputTokens: 100,
      outputTokens: 5,
      cacheReadTokens: 80,
      cacheWriteTokens: 0,
    })
  })

  test("invalid cache counts stay unknown without discarding valid token totals", () => {
    const usage = Schema.decodeUnknownSync(Response.FinishPart)(
      finishPart({ finishReason: "stop", usage: { inputTokens: 100, outputTokens: 5 } }),
    ).usage
    // oxlint-disable-next-line effect/noNullish -- A provider can leave the count out.
    for (const count of [undefined, -1, 1.5, Number.NaN]) {
      expect(
        responseUsage({
          ...usage,
          inputTokens: { ...usage.inputTokens, cacheRead: count, cacheWrite: count },
        }),
      ).toEqual(Option.some({ inputTokens: 100, outputTokens: 5 }))
    }
    expect(Schema.decodeSync(UsageSchema)({ inputTokens: 100, outputTokens: 5 })).toEqual({
      inputTokens: 100,
      outputTokens: 5,
    })
  })

  it.scopedLive("model collector retries pre-output provider failures by re-raising them", () =>
    Effect.gen(function* () {
      const activeStream = yield* makeActiveStream(false)
      const { layer } = yield* captureEvents()
      const error = yield* collectModelTurnResponse({
        ...streamAddress,
        turnStream: Stream.fail(new ProviderError({ message: "boom", model: "test/model" })),
        sessionId,
        branchId,
        modelId: ModelId.make("test/model"),
        activeStream,
        formatStreamError: (error) => error.message,
      }).pipe(Effect.flip, Effect.provide(layer))

      expect(error._tag).toBe("ProviderError")
      expect(error.message).toBe("boom")
    }),
  )

  it.scopedLive("failed model collector treats interrupted failures as non-stream failures", () =>
    Effect.gen(function* () {
      const activeStream = yield* makeActiveStream(true)
      const { events, layer } = yield* captureEvents()
      const collected = yield* collectFailedModelTurnResponse({
        ...streamAddress,
        streamError: new ProviderError({ message: "interrupted boom", model: "test/model" }),
        modelId: ModelId.make("test/model"),
        sessionId,
        branchId,
        activeStream,
        formatStreamError: (error) => error.message,
        contextOverflow: false,
      }).pipe(Effect.provide(layer))

      expect(collected.interrupted).toBe(true)
      expect(collected.streamFailed).toBe(false)
      expect(yield* Ref.get(events)).toEqual([])
    }),
  )

  it.scopedLive("model collector keeps partial output when post-output stream fails", () =>
    Effect.gen(function* () {
      const activeStream = yield* makeActiveStream(false)
      const { events, layer } = yield* captureEvents()

      const collected = yield* collectModelTurnResponse({
        ...streamAddress,
        turnStream: Stream.concat(
          Stream.fromIterable([textDeltaPart("partial")]),
          Stream.fail(new ProviderError({ message: "late boom", model: "test/model" })),
        ),
        sessionId,
        branchId,
        modelId: ModelId.make("test/model"),
        activeStream,
        formatStreamError: (error) => error.message,
      }).pipe(Effect.provide(layer))

      expect(collected.streamFailed).toBe(true)
      expect(collected.messageProjection.assistant.map((part) => part.type)).toEqual(["text"])
      expect((yield* Ref.get(events)).map((event) => event._tag)).toContain("ErrorOccurred")
    }),
  )
})

// ── session route ───────────────────────────────────────────────────────────

describe("session route driver", () => {
  const modelId = ModelId.make("anthropic/claude-sonnet-5")
  const routeOf = (agent: AgentDefinition, driverOverrides?: Readonly<Record<string, DriverRef>>) =>
    resolveSessionRoute({
      agents: [agent],
      admission: Option.some({ agent: agent.name }),
      config: { driverOverrides },
      session: { modelId },
    })

  test("the agent's own driver wins over a config override", () => {
    const agent = AgentDefinition.make({
      name: AgentName.make("special"),
      driver: DriverRef.make({ id: "anthropic-proxy" }),
    })
    const route = routeOf(agent, { special: DriverRef.make({ id: "openai-proxy" }) })
    expect(route.modelDriver.driverId).toEqual(Option.some("anthropic-proxy"))
    expect(route.modelDriver.contextModelId).toBe(ModelId.make("anthropic-proxy/claude-sonnet-5"))
  })

  test("a config override routes an agent that names no driver", () => {
    const agent = AgentDefinition.make({ name: AgentName.make("primary") })
    const route = routeOf(agent, { primary: DriverRef.make({ id: "openai" }) })
    expect(route.modelDriver.driverId).toEqual(Option.some("openai"))
    expect(route.modelDriver.contextModelId).toBe(ModelId.make("openai/claude-sonnet-5"))
  })

  test("no driver and no override route through the model id's provider", () => {
    const agent = AgentDefinition.make({ name: AgentName.make("primary") })
    for (const route of [routeOf(agent), routeOf(agent, {})]) {
      expect(route.modelDriver.driverId).toEqual(Option.some("anthropic"))
      expect(route.modelDriver.contextModelId).toBe(modelId)
    }
  })

  test("an override for another agent does not route this one", () => {
    const agent = AgentDefinition.make({ name: AgentName.make("primary") })
    const route = routeOf(agent, { secondary: DriverRef.make({ id: "openai" }) })
    expect(route.modelDriver.driverId).toEqual(Option.some("anthropic"))
  })
})

// ── step outcome ────────────────────────────────────────────────────────────

const collected = (
  responseParts: ReadonlyArray<Response.AnyPart>,
  flags: Partial<
    Pick<CollectedTurnResponse, "interrupted" | "streamFailed" | "contextOverflow" | "windowFull">
  > = {},
): CollectedTurnResponse => ({
  responseParts,
  messageProjection: { assistant: [], tool: [] },
  interrupted: false,
  streamFailed: false,
  contextOverflow: false,
  windowFull: false,
  ...flags,
})

describe("classifyStep", () => {
  test("an interrupt wins over everything else the step produced", () => {
    const outcome = classifyStep(
      collected([textDeltaPart("partial"), toolCallPart("echo", {})], { interrupted: true }),
    )
    expect(outcome._tag).toBe("Interrupted")
  })

  test("a failed stream records whether observable output arrived first", () => {
    expect(classifyStep(collected([], { streamFailed: true }))).toEqual({
      _tag: "Failed",
      partialOutput: false,
      contextOverflow: false,
    })
    expect(classifyStep(collected([textDeltaPart("some")], { streamFailed: true }))).toEqual({
      _tag: "Failed",
      partialOutput: true,
      contextOverflow: false,
    })
    expect(classifyStep(collected([], { streamFailed: true, contextOverflow: true }))).toEqual({
      _tag: "Failed",
      partialOutput: false,
      contextOverflow: true,
    })
  })

  test("tool calls are counted", () => {
    const outcome = classifyStep(
      collected([textDeltaPart("thinking"), toolCallPart("a", {}), toolCallPart("b", {})]),
    )
    expect(outcome).toEqual({ _tag: "ToolCalls", count: 2, contextOverflow: false })
  })

  test("a plain reply is Answered with neither flag", () => {
    const outcome = classifyStep(
      collected([textDeltaPart("done"), finishPart({ finishReason: "stop" })]),
    )
    expect(outcome).toEqual({
      _tag: "Answered",
      empty: false,
      truncated: false,
      contextOverflow: false,
    })
  })

  test("no observable output is an empty answer", () => {
    const outcome = classifyStep(collected([finishPart({ finishReason: "stop" })]))
    expect(outcome).toEqual({
      _tag: "Answered",
      empty: true,
      truncated: false,
      contextOverflow: false,
    })
  })

  test("a length finish marks the answer truncated", () => {
    const outcome = classifyStep(
      collected([textDeltaPart("cut off"), finishPart({ finishReason: "length" })]),
    )
    expect(outcome).toEqual({
      _tag: "Answered",
      empty: false,
      truncated: true,
      contextOverflow: false,
    })
  })

  test("an unknown finish alone is a finished answer", () => {
    const outcome = classifyStep(
      collected([textDeltaPart("done"), finishPart({ finishReason: "unknown" })]),
    )
    expect(outcome).toEqual({
      _tag: "Answered",
      empty: false,
      truncated: false,
      contextOverflow: false,
    })
  })

  test("a full window marks the answer truncated and hands off when the turn may", () => {
    const parts = [textDeltaPart("cut off"), finishPart({ finishReason: "unknown" })]
    expect(classifyStep(collected(parts, { windowFull: true, contextOverflow: true }))).toEqual({
      _tag: "Answered",
      empty: false,
      truncated: true,
      contextOverflow: true,
    })
    // A window already handed off this turn is only continued.
    expect(classifyStep(collected(parts, { windowFull: true }))).toEqual({
      _tag: "Answered",
      empty: false,
      truncated: true,
      contextOverflow: false,
    })
  })
})

// ── tool outcome recording ──────────────────────────────────────────────────

const FIXED_NOW = dateFromMillis(1_767_225_600_000)

const storage = testSqliteStorage(noBranchTools.storage, noBranchTools.migrations)
const layer = Layer.provideMerge(Layer.provide(EventStoreLive, storage), storage)

const assistantWithCall = (params: {
  readonly id: MessageId
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly toolCallId: ToolCallId
}) =>
  Message.cases.regular.make({
    id: params.id,
    sessionId: params.sessionId,
    branchId: params.branchId,
    role: "assistant",
    parts: [
      Prompt.toolCallPart({
        id: params.toolCallId,
        name: "echo",
        params: { text: "hi" },
        providerExecuted: false,
      }),
    ],
    createdAt: FIXED_NOW,
  })

const resultPart = (toolCallId: ToolCallId) =>
  Prompt.toolResultPart({
    id: toolCallId,
    name: "echo",
    isFailure: false,
    providerExecuted: false,
    result: { text: "hi" },
  })

describe("tool outcome recording", () => {
  it.live("closes a result the transcript never gave a terminal event", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("outcome-open-session")
      const branchId = BranchId.make("outcome-open-branch")
      const turnId = MessageId.make("outcome-open-turn")
      const toolCallId = ToolCallId.make("outcome-open-call")
      const assistantMessageId = assistantMessageIdForTurn(turnId, 1)
      yield* ensureStorageParents({ sessionId, branchId })
      const eventStorage = yield* EventStorage
      yield* eventStorage.appendEvent(
        MessageReceived.make({
          message: assistantWithCall({ id: assistantMessageId, sessionId, branchId, toolCallId }),
        }),
      )

      yield* recordToolOutcome({
        sessionId,
        branchId,
        toolResultMessageId: toolResultMessageIdForTurn(turnId, 1),
        assistantMessageId,
        parts: [resultPart(toolCallId)],
      })

      const events = yield* eventStorage.listEvents({ sessionId, branchId })
      const terminal = events.flatMap((envelope) => {
        if (envelope.event._tag !== "ToolCallSucceeded") return []
        return [envelope.event]
      })
      expect(terminal).toMatchObject([{ toolCallId, toolName: "echo", assistantMessageId }])
      const messageStorage = yield* MessageStorage
      const stored = yield* messageStorage.getMessage(toolResultMessageIdForTurn(turnId, 1))
      expect(stored?.parts).toMatchObject([{ type: "tool-result", id: toolCallId }])
    }).pipe(Effect.timeout("5 seconds"), Effect.provide(layer)),
  )

  it.live("leaves a result the transcript already closed alone", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("outcome-closed-session")
      const branchId = BranchId.make("outcome-closed-branch")
      const turnId = MessageId.make("outcome-closed-turn")
      const toolCallId = ToolCallId.make("outcome-closed-call")
      const assistantMessageId = assistantMessageIdForTurn(turnId, 1)
      yield* ensureStorageParents({ sessionId, branchId })
      const eventStorage = yield* EventStorage
      yield* eventStorage.appendEvent(
        MessageReceived.make({
          message: assistantWithCall({ id: assistantMessageId, sessionId, branchId, toolCallId }),
        }),
      )
      yield* eventStorage.appendEvent(
        ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId,
          toolName: "echo",
          output: "already closed",
          assistantMessageId,
        }),
      )

      yield* recordToolOutcome({
        sessionId,
        branchId,
        toolResultMessageId: toolResultMessageIdForTurn(turnId, 1),
        assistantMessageId,
        parts: [resultPart(toolCallId)],
      })

      const events = yield* eventStorage.listEvents({ sessionId, branchId })
      const outputs = events.flatMap((envelope) => {
        if (envelope.event._tag !== "ToolCallSucceeded") return []
        return [envelope.event.output]
      })
      expect(outputs).toEqual(["already closed"])
    }).pipe(Effect.timeout("5 seconds"), Effect.provide(layer)),
  )

  /**
   * The window is anchored on the step being reconciled. A terminal event that
   * belongs to a later step names the same call id but sits past the next
   * assistant message, so it must not count as closing this step's call.
   */
  it.live("does not let the next step's terminal event close this step's call", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("outcome-boundary-session")
      const branchId = BranchId.make("outcome-boundary-branch")
      const turnId = MessageId.make("outcome-boundary-turn")
      const toolCallId = ToolCallId.make("outcome-boundary-call")
      const firstAssistantId = assistantMessageIdForTurn(turnId, 1)
      const secondAssistantId = assistantMessageIdForTurn(turnId, 2)
      yield* ensureStorageParents({ sessionId, branchId })
      const eventStorage = yield* EventStorage
      yield* eventStorage.appendEvent(
        MessageReceived.make({
          message: assistantWithCall({ id: firstAssistantId, sessionId, branchId, toolCallId }),
        }),
      )
      // Step 2 reissued the same call and settled it. Step 1 stays open.
      yield* eventStorage.appendEvent(
        MessageReceived.make({
          message: assistantWithCall({ id: secondAssistantId, sessionId, branchId, toolCallId }),
        }),
      )
      yield* eventStorage.appendEvent(
        ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId,
          toolName: "echo",
          output: "second step",
          assistantMessageId: secondAssistantId,
        }),
      )

      yield* recordToolOutcome({
        sessionId,
        branchId,
        toolResultMessageId: toolResultMessageIdForTurn(turnId, 1),
        assistantMessageId: firstAssistantId,
        parts: [resultPart(toolCallId)],
      })

      const events = yield* eventStorage.listEvents({ sessionId, branchId })
      const anchors = events.flatMap((envelope) => {
        if (envelope.event._tag !== "ToolCallSucceeded") return []
        return [envelope.event.assistantMessageId]
      })
      expect(anchors).toEqual([secondAssistantId, firstAssistantId])
    }).pipe(Effect.timeout("5 seconds"), Effect.provide(layer)),
  )
})

// ── turn persistence ────────────────────────────────────────────────────────

/**
 * Durable message persistence. Summaries, window markers and turn messages
 * all reach storage through `persistMessageReceived`, so the once-only
 * guarantee is proved once, here.
 */

const sessionIdTurnPersistence = SessionId.make("durable-persist-session")
const branchIdTurnPersistence = BranchId.make("durable-persist-branch")
const createdAt = dateFromMillis(1_767_225_600_000)

/** Keeps every appended and delivered event so a test can count them. */
const recordingPublisher = Effect.map(
  Ref.make<{ appended: ReadonlyArray<AgentEvent>; delivered: number }>({
    appended: [],
    delivered: 0,
  }),
  (state) => ({
    state,
    layer: Layer.succeed(
      EventStore,
      EventStore.of({
        subscribe: () => Stream.empty,
        removeSession: () => Effect.void,
        append: (event) =>
          Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis
            const next = yield* Ref.updateAndGet(state, (current) => ({
              ...current,
              appended: [...current.appended, event],
            }))
            return EventEnvelope.make({
              id: EventId.make(next.appended.length),
              event,
              createdAt: at,
            })
          }),
        deliver: () => Ref.update(state, (c) => ({ ...c, delivered: c.delivered + 1 })),
        publish: (event) => Ref.update(state, (c) => ({ ...c, appended: [...c.appended, event] })),
      }),
    ),
  }),
)

const summaryMessage = Message.cases.regular.make({
  id: MessageId.make("durable-persist-summary"),
  sessionId: sessionIdTurnPersistence,
  branchId: branchIdTurnPersistence,
  role: "user",
  parts: [Prompt.textPart({ text: "window summary" })],
  createdAt,
  metadata: { customType: "context-window" },
})

describe("durable message persistence", () => {
  it.live("a repeated persist of the same durable message stores and appends it once", () =>
    Effect.gen(function* () {
      const publisher = yield* recordingPublisher
      yield* Effect.gen(function* () {
        yield* ensureStorageParents({
          sessionId: sessionIdTurnPersistence,
          branchId: branchIdTurnPersistence,
        })
        const first = yield* persistMessageReceived({ message: summaryMessage })
        const second = yield* persistMessageReceived({ message: summaryMessage })
        expect(first.id).toBe(summaryMessage.id)
        expect(second.id).toBe(summaryMessage.id)

        const stored = yield* (yield* MessageStorage).listMessages(branchIdTurnPersistence)
        expect(stored.filter((message) => message.id === summaryMessage.id)).toHaveLength(1)

        const recorded = yield* Ref.get(publisher.state)
        const received = recorded.appended.filter(
          (event) => event._tag === "MessageReceived" && event.message.id === summaryMessage.id,
        )
        expect(received).toHaveLength(1)
      }).pipe(Effect.provide(Layer.mergeAll(testSqliteStorage(Layer.empty, {}), publisher.layer)))
    }),
  )
})

// ── turn fixtures ───────────────────────────────────────────────────────────

const hasAssistantText = (messages: ReadonlyArray<Message>, text: string) =>
  messages.some(
    (message) => message.role === "assistant" && messagePartsText(message.parts) === text,
  )

// ── continuation ────────────────────────────────────────────────────────────

describe("continuation", () => {
  const contSessionId = SessionId.make("cont-test-session")
  const contBranchId = BranchId.make("cont-test-branch")
  let messageSequence = 0
  const makeContMessage = (text: string) =>
    Message.cases.regular.make({
      id: MessageId.make(`msg-${messageSequence++}`),
      sessionId: contSessionId,
      branchId: contBranchId,
      role: "user",
      parts: [Prompt.textPart({ text })],
      createdAt: dateFromMillis(1_767_225_600_000),
    })
  const echoTool = tool({
    id: "echo",
    description: "Echoes input",
    params: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
    execute: (_params) => Effect.succeed({ text: _params.text }),
  })
  it.live("tool call auto-continues to next LLM call", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        toolCallStep("echo", { text: "hello" }),
        textStep("Done with tools."),
      ])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* runAgentLoop(agentLoop, makeContMessage("test auto-continue"))
        expect(yield* controls.callCount).toBe(2)
        yield* controls.assertDone
      }).pipe(Effect.provide(makeLayer(providerLayer, [echoTool])))
    }),
  )
  it.live("text-only response does not trigger continuation", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        textStep("Just text, no tools."),
      ])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* runAgentLoop(agentLoop, makeContMessage("text only"))
        expect(yield* controls.callCount).toBe(1)
        yield* controls.assertDone
      }).pipe(Effect.provide(makeLayer(providerLayer, [echoTool])))
    }),
  )
  it.live("multi-hop tool calls chain until text response", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        toolCallStep("echo", { text: "step 1" }),
        toolCallStep("echo", { text: "step 2" }),
        toolCallStep("echo", { text: "step 3" }),
        textStep("Finally done."),
      ])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* runAgentLoop(agentLoop, makeContMessage("multi-hop"))
        expect(yield* controls.callCount).toBe(4)
        yield* controls.assertDone
      }).pipe(Effect.provide(makeLayer(providerLayer, [echoTool])))
    }),
  )
  it.live("TurnCompleted fires once per turn, not per step", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        toolCallStep("echo", { text: "step 1" }),
        toolCallStep("echo", { text: "step 2" }),
        textStep("Done."),
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* runAgentLoop(agentLoop, makeContMessage("turn-events"))
        expect(yield* controls.callCount).toBe(3)
        const events = yield* Ref.get(eventsRef)
        const turnCompleted = events.filter((e) => e._tag === "TurnCompleted")
        expect(turnCompleted.length).toBe(1)
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }),
  )
  it.live("an interjection during a tool step joins the same turn at the next step boundary", () =>
    Effect.gen(function* () {
      const latestUserText = (request: { readonly prompt: Prompt.RawInput }) => {
        const latest = [...Prompt.make(request.prompt).content]
          .reverse()
          .find((message) => message.role === "user")
        if (Predicate.isUndefined(latest)) return ""
        return latest.content
          .filter((part): part is Prompt.TextPart => part.type === "text")
          .map((part) => part.text)
          .join("\n")
      }
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        { ...toolCallStep("echo", { text: "step 1" }), gated: true },
        {
          ...textStep("Done after steering."),
          assertOptions: (options) => {
            expect(latestUserText(options)).toBe("steer now")
          },
        },
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const messageStorage = yield* MessageStorage
        const turn = makeContMessage("steer at step boundary")
        const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, turn))
        yield* controls.waitForCall(0)
        yield* steerAgentLoop({
          _tag: "Interject",
          sessionId: contSessionId,
          branchId: contBranchId,
          requestId: "req-interject-step-boundary",
          message: "steer now",
        })
        yield* controls.emitAll(0)
        yield* Fiber.join(fiber)
        // One turn, two model calls: the steering did not interrupt the stream.
        expect(yield* controls.callCount).toBe(2)
        const events = yield* Ref.get(eventsRef)
        expect(events.filter((event) => event._tag === "TurnCompleted")).toHaveLength(1)
        expect(
          events.some((event) => event._tag === "TurnCompleted" && event.interrupted === true),
        ).toBe(false)
        const messages = yield* messageStorage.listMessages(contBranchId)
        expect(messages.filter((message) => message._tag === "interjection")).toHaveLength(1)
        // The interjection sorts after the tool result it waited for, never between
        // the call and its result.
        const resultIndex = messages.findIndex((message) =>
          message.parts.some((part) => part.type === "tool-result"),
        )
        const interjectionIndex = messages.findIndex((message) => message._tag === "interjection")
        expect(resultIndex).toBeGreaterThanOrEqual(0)
        expect(interjectionIndex).toBeGreaterThan(resultIndex)
        yield* controls.assertDone
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }),
  )
  it.live("a joined interjection keeps its sender's custom type and never recovers as a turn", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        { ...toolCallStep("echo", { text: "step 1" }), gated: true },
        textStep("Done after the sender's message."),
      ])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const messageStorage = yield* MessageStorage
        const turn = makeContMessage("a sender steers this turn")
        const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, turn))
        yield* controls.waitForCall(0)
        yield* steerAgentLoop({
          _tag: "Interject",
          sessionId: contSessionId,
          branchId: contBranchId,
          requestId: "req-interject-keeps-custom-type",
          message: "from another session",
          metadata: { customType: "session-message", details: { from: "sender" } },
        })
        yield* controls.emitAll(0)
        yield* Fiber.join(fiber)
        const messages = yield* messageStorage.listMessages(contBranchId)
        const joined = messages.find(
          (message) =>
            message._tag === "interjection" &&
            message.parts.some(
              (part) => part.type === "text" && part.text === "from another session",
            ),
        )
        // The TUI draws the sender row from the custom type; the join must not erase it.
        expect(joined?.metadata?.customType).toBe("session-message")
        expect(joined?.metadata?.details).toEqual({ from: "sender" })
        // The turn it joined answered it, so a restart must not answer it again.
        expect(Predicate.isNotUndefined(joined) && isRuntimeUserMessage(joined)).toBe(true)
      }).pipe(Effect.provide(makeLayer(providerLayer, [echoTool])))
    }).pipe(Effect.timeout("4 seconds")),
  )
  // A sender that takes its message back (its own turn was interrupted) must
  // not have it read by the turn the receiver is running.
  it.live("a stop that names a waiting interjection takes it back before the turn reads it", () =>
    Effect.gen(function* () {
      const requestId = RequestId.make("req-interject-taken-back")
      const promptTexts: Array<string> = []
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        { ...toolCallStep("echo", { text: "step 1" }), gated: true },
        {
          ...textStep("Done without the message."),
          assertOptions: (options) => {
            for (const message of Prompt.make(options.prompt).content) {
              if (message.role !== "user") continue
              for (const part of message.content) {
                if (part.type === "text") promptTexts.push(part.text)
              }
            }
          },
        },
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const messageStorage = yield* MessageStorage
        const fiber = yield* Effect.forkChild(
          runAgentLoop(agentLoop, makeContMessage("a turn the sender does not own")),
        )
        yield* controls.waitForCall(0)
        yield* steerAgentLoop({
          _tag: "Interject",
          sessionId: contSessionId,
          branchId: contBranchId,
          requestId,
          message: "TAKEN-BACK",
          wake: true,
        })
        const stop = {
          sessionId: contSessionId,
          branchId: contBranchId,
          messageId: interjectionMessageId(requestId),
        }
        // The stop reports that it reached the message: it took the steer back.
        expect(yield* stopAgentLoopMessage({ ...stop, requestId: "req-take-back" })).toBe(true)
        yield* controls.emitAll(0)
        yield* Fiber.join(fiber)
        // Once taken back, the loop holds nothing of it: a later stop reaches nothing.
        expect(yield* stopAgentLoopMessage({ ...stop, requestId: "req-take-back-again" })).toBe(
          false,
        )
        // The running turn is not the one the stop named: it runs to its end.
        expect(yield* controls.callCount).toBe(2)
        const completed = (yield* Ref.get(eventsRef)).filter(Schema.is(TurnCompleted))
        expect(completed).toHaveLength(1)
        expect(completed[0]?.interrupted).not.toBe(true)
        expect(promptTexts).not.toContain("TAKEN-BACK")
        const messages = yield* messageStorage.listMessages(contBranchId)
        expect(messages.filter((message) => message._tag === "interjection")).toHaveLength(0)
        yield* waitForPhase(agentLoop, { sessionId: contSessionId, branchId: contBranchId }, "Idle")
        expect(yield* controls.callCount).toBe(2)
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }).pipe(Effect.timeout("4 seconds")),
  )
  // The actor runs its handlers concurrently, so a sender's stop can run
  // before the handler of a steer the sender sent first. The steer's handler
  // then admits it after the stop found nothing to take back.
  it.live("a steer admitted after a stop that names it never runs", () =>
    Effect.gen(function* () {
      const requestId = RequestId.make("req-interject-after-stop")
      const parent = { sessionId: SessionId.make("parent"), branchId: BranchId.make("parent") }
      const promptTexts: Array<string> = []
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        { ...toolCallStep("echo", { text: "step 1" }), gated: true },
        {
          ...textStep("Done without the correction."),
          assertOptions: (options) => {
            for (const message of Prompt.make(options.prompt).content) {
              if (message.role !== "user") continue
              for (const part of message.content) {
                if (part.type === "text") promptTexts.push(part.text)
              }
            }
          },
        },
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const messageStorage = yield* MessageStorage
        const fiber = yield* Effect.forkChild(
          runAgentLoop(agentLoop, makeContMessage("a turn the steer would join")),
        )
        yield* controls.waitForCall(0)
        // The stop's handler runs first; the steer it names is not admitted yet.
        expect(
          yield* stopAgentLoopMessage({
            sessionId: contSessionId,
            branchId: contBranchId,
            messageId: interjectionMessageId(requestId),
            requestId: "req-stop-before-admission",
            requester: parent,
          }),
        ).toBe(false)
        yield* steerAgentLoop(
          {
            _tag: "Interject",
            sessionId: contSessionId,
            branchId: contBranchId,
            requestId,
            message: "LATE-CORRECTION",
            wake: true,
          },
          parent,
        )
        yield* controls.emitAll(0)
        yield* Fiber.join(fiber)
        yield* waitForPhase(agentLoop, { sessionId: contSessionId, branchId: contBranchId }, "Idle")
        // The running turn reached its next step without the correction, and
        // the correction opened no turn of its own.
        expect(yield* controls.callCount).toBe(2)
        expect(promptTexts).not.toContain("LATE-CORRECTION")
        expect((yield* Ref.get(eventsRef)).filter(Schema.is(TurnCompleted))).toHaveLength(1)
        const messages = yield* messageStorage.listMessages(contBranchId)
        expect(messages.filter((message) => message._tag === "interjection")).toHaveLength(0)
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }).pipe(Effect.timeout("4 seconds")),
  )
  it.live("a stop that names the running turn's message reports that it stopped the turn", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        { ...toolCallStep("echo", { text: "step 1" }), gated: true },
        textStep("Never reached."),
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const message = makeContMessage("a turn a stop names")
        const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, message))
        yield* controls.waitForCall(0)
        const stop = { sessionId: contSessionId, branchId: contBranchId, messageId: message.id }
        expect(yield* stopAgentLoopMessage({ ...stop, requestId: "req-stop-running" })).toBe(true)
        yield* controls.emitAll(0)
        yield* Fiber.join(fiber)
        const completed = (yield* Ref.get(eventsRef)).filter(Schema.is(TurnCompleted))
        expect(completed.map((event) => event.interrupted)).toEqual([true])
        yield* waitForPhase(agentLoop, { sessionId: contSessionId, branchId: contBranchId }, "Idle")
        // The turn ended: a later stop of the same message reaches nothing.
        expect(yield* stopAgentLoopMessage({ ...stop, requestId: "req-stop-ended" })).toBe(false)
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }).pipe(Effect.timeout("4 seconds")),
  )
  it.live("a branch's stop takes its own waiting steers with the turn it stops", () =>
    Effect.gen(function* () {
      const promptTexts: Array<string> = []
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        { ...toolCallStep("echo", { text: "step 1" }), gated: true },
        {
          ...textStep("Answered the other sender."),
          assertOptions: (options) => {
            for (const message of Prompt.make(options.prompt).content) {
              if (message.role !== "user") continue
              for (const part of message.content) {
                if (part.type === "text") promptTexts.push(part.text)
              }
            }
          },
        },
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const messageStorage = yield* MessageStorage
        const parent = { sessionId: SessionId.make("parent"), branchId: BranchId.make("parent") }
        const sibling = { sessionId: SessionId.make("sibling"), branchId: BranchId.make("sibling") }
        const message = makeContMessage("a turn the parent stops")
        const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, message))
        yield* controls.waitForCall(0)
        const steer = (requestId: string, text: string, sender: typeof parent) =>
          steerAgentLoop(
            {
              _tag: "Interject",
              sessionId: contSessionId,
              branchId: contBranchId,
              requestId,
              message: text,
              wake: true,
            },
            sender,
          )
        yield* steer("req-parent-correction", "PARENT-CORRECTION", parent)
        yield* steer("req-sibling-fact", "SIBLING-FACT", sibling)
        const target = { sessionId: contSessionId, branchId: contBranchId }
        expect(
          yield* stopAgentLoopMessage({
            ...target,
            messageId: message.id,
            requestId: "req-parent-stops-turn",
            requester: parent,
          }),
        ).toBe(true)
        yield* controls.emitAll(0)
        yield* Fiber.join(fiber)
        // The sibling's steer outlives the stopped turn and wakes the next one.
        yield* waitFor(
          Ref.get(eventsRef),
          (events) => events.filter(Schema.is(TurnCompleted)).length === 2,
          3_000,
          "the sibling's steer ran its own turn",
        )
        yield* waitForPhase(agentLoop, target, "Idle")
        // The parent's correction went with the turn: a later stop of it reaches nothing.
        expect(
          yield* stopAgentLoopMessage({
            ...target,
            messageId: interjectionMessageId(RequestId.make("req-parent-correction")),
            requestId: "req-parent-stops-correction",
            requester: parent,
          }),
        ).toBe(false)
        expect(promptTexts).toContain("SIBLING-FACT")
        expect(promptTexts).not.toContain("PARENT-CORRECTION")
        const interjections = (yield* messageStorage.listMessages(contBranchId)).filter(
          (stored) => stored._tag === "interjection",
        )
        expect(interjections.map((stored) => stored.id)).toEqual([
          interjectionMessageId(RequestId.make("req-sibling-fact")),
        ])
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }).pipe(Effect.timeout("4 seconds")),
  )
  it.live("an interjection that asks to wake starts a turn on an idle branch", () =>
    Effect.gen(function* () {
      const idleSessionId = SessionId.make("cont-idle-session")
      const idleBranchId = BranchId.make("cont-idle-branch")
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        textStep("Answered the idle steer."),
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const messageStorage = yield* MessageStorage
        // No turn is running: nothing for the steering to join. The queue would
        // hold it forever if the actor did not start a turn on an idle branch.
        yield* steerAgentLoop({
          _tag: "Interject",
          sessionId: idleSessionId,
          branchId: idleBranchId,
          requestId: "req-interject-idle-start",
          message: "answer me",
          wake: true,
        })
        yield* waitForPhase(agentLoop, { sessionId: idleSessionId, branchId: idleBranchId }, "Idle")
        expect(yield* controls.callCount).toBe(1)
        const events = yield* Ref.get(eventsRef)
        expect(events.filter((event) => event._tag === "TurnCompleted")).toHaveLength(1)
        const messages = yield* messageStorage.listMessages(idleBranchId)
        expect(messages.filter((message) => message._tag === "interjection")).toHaveLength(1)
        yield* controls.assertDone
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }),
  )
  it.live("a cancel during the continuation step ends the turn interrupted", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        toolCallStep("echo", { text: "step 1" }),
        { ...textStep("Continuation response."), gated: true },
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const fiber = yield* Effect.forkChild(
          runAgentLoop(agentLoop, makeContMessage("interrupt test")),
        )
        yield* controls.waitForCall(1)
        yield* steerAgentLoop({
          _tag: "Cancel",
          sessionId: contSessionId,
          branchId: contBranchId,
          requestId: "req-continuation-interrupt-first",
        })
        yield* controls.emitAll(1)
        yield* Fiber.join(fiber)
        expect(yield* controls.callCount).toBe(2)
        const events = yield* Ref.get(eventsRef)
        const turnCompleted = events.filter(Schema.is(TurnCompleted))
        expect(turnCompleted.length).toBe(1)
        const tc = turnCompleted[0]
        expect(tc).toBeDefined()
        if (Predicate.isUndefined(tc)) return
        expect(tc.interrupted).toBe(true)
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }),
  )
  it.live("GUARD: ToolsFinished without interrupt routes to Resolving", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        toolCallStep("echo", { text: "tool" }),
        textStep("Continuation reached."),
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* runAgentLoop(agentLoop, makeContMessage("structural guard"))
        expect(yield* controls.callCount).toBe(2)
        yield* controls.assertDone
        const events = yield* Ref.get(eventsRef)
        expect(events.filter((e) => e._tag === "TurnCompleted").length).toBe(1)
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }),
  )
  it.live("each step of a multi-hop turn persists its own message", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        toolCallStep("echo", { text: "step 1" }),
        toolCallStep("echo", { text: "step 2" }),
        textStep("Final answer."),
      ])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const messageStorage = yield* MessageStorage
        const msg = makeContMessage("multi-hop persistence")
        yield* runAgentLoop(agentLoop, msg)
        const a1 = yield* messageStorage.getMessage(assistantMessageIdForTurn(msg.id, 1))
        const t1 = yield* messageStorage.getMessage(toolResultMessageIdForTurn(msg.id, 1))
        expect(a1?.role).toBe("assistant")
        expect(t1?.role).toBe("tool")
        const a2 = yield* messageStorage.getMessage(assistantMessageIdForTurn(msg.id, 2))
        const t2 = yield* messageStorage.getMessage(toolResultMessageIdForTurn(msg.id, 2))
        expect(a2?.role).toBe("assistant")
        expect(t2?.role).toBe("tool")
        const a3 = yield* messageStorage.getMessage(assistantMessageIdForTurn(msg.id, 3))
        const t3 = yield* messageStorage.getMessage(toolResultMessageIdForTurn(msg.id, 3))
        expect(a3?.role).toBe("assistant")
        expect(t3).toBeUndefined()
        expect(new Set([a1?.id, a2?.id, a3?.id]).size).toBe(3)
        expect(new Set([t1?.id, t2?.id]).size).toBe(2)
      }).pipe(Effect.provide(makeLayer(providerLayer, [echoTool])))
    }),
  )
  it.live("queued follow-up executes normally after interrupt", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        toolCallStep("echo", { text: "step 1" }),
        { ...textStep("gated response"), gated: true },
        textStep("follow-up response"),
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const first = makeContMessage("first message")
        const followUp = makeContMessage("follow-up after interrupt")
        // Start first turn — tool call auto-continues to gated step
        yield* Effect.forkChild(runAgentLoop(agentLoop, first))
        // Wait for the gated step (second stream call) to start
        yield* controls.waitForCall(1)
        // Queue a follow-up while step 1 is gated
        yield* submitAgentLoop(agentLoop, followUp)
        // Interrupt the current turn. `agentLoop.steer` issues
        // `actor.call(Interrupt)` which is serialized request-reply — by the
        // time it returns, the actor has already set `interruptedRef = true`
        // and signalled the active stream. No additional wait needed.
        yield* steerAgentLoop({
          _tag: "Cancel",
          sessionId: contSessionId,
          branchId: contBranchId,
          requestId: "req-continuation-interrupt-second",
        })
        // Release the gated step so the interrupted turn can finalize
        yield* controls.emitAll(1)
        // Wait for the follow-up to complete: the second TurnCompleted, which
        // is what the assertions read. The loop is idle for a moment between
        // the two turns, so the phase alone does not say the follow-up ran.
        const turnCompleted = yield* waitForOption(
          () =>
            Ref.get(eventsRef).pipe(
              Effect.map((events) => {
                const completed = events.filter(Schema.is(TurnCompleted))
                return Option.some(completed).pipe(Option.filter((all) => all.length >= 2))
              }),
            ),
          "two completed turns",
        )
        // Both turns should have completed
        expect(turnCompleted.length).toBe(2)
        const interruptedTurns = turnCompleted.filter((e) => e.interrupted === true)
        // First turn was interrupted, second (follow-up) was not
        expect(interruptedTurns.length).toBe(1)
        // Follow-up used the third provider step
        expect(yield* controls.callCount).toBe(3)
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.live(
    "persists a continuation instruction after partial output and finishes the same turn",
    () =>
      Effect.gen(function* () {
        const eventsRef = yield* Ref.make<AgentEvent[]>([])
        const latestUserTexts: string[] = []
        let streamCalls = 0
        const providerLayer = LanguageModelLayers.testStream((options) => {
          latestUserTexts.push(
            [...Prompt.make(options.prompt).content]
              .reverse()
              .find((message) => message.role === "user")
              ?.content.filter((part): part is Prompt.TextPart => part.type === "text")
              .map((part) => part.text)
              .join("\n") ?? "",
          )
          streamCalls += 1
          if (streamCalls === 1) {
            return Effect.succeed(
              Stream.concat(
                Stream.fromIterable([textDeltaPart("partial ")]),
                Stream.fail(
                  AiError.make({
                    module: "Test",
                    method: "streamText",
                    reason: new AiError.UnknownError({ description: "connection reset" }),
                  }),
                ),
              ),
            )
          }
          return Effect.succeed(
            Stream.fromIterable([
              textDeltaPart("rest"),
              finishPart({ finishReason: "stop", usage: { inputTokens: 7, outputTokens: 11 } }),
            ]),
          )
        })
        yield* Effect.scoped(
          Effect.gen(function* () {
            const agentLoop = yield* makeAgentLoopService
            const messageStorage = yield* MessageStorage
            const message = makeMessage(SessionId.make("s1"), BranchId.make("b1"), "write it")
            yield* runAgentLoop(agentLoop, message)
            expect(streamCalls).toBe(2)
            expect(latestUserTexts[1]).toContain("Continue from where you stopped")
            const messages = yield* messageStorage.listMessages(BranchId.make("b1"))
            expect(
              messages
                .filter((item) => item.role === "assistant")
                .map((item) => item.parts.find((part) => part.type === "text")?.text),
            ).toEqual(["partial ", "rest"])
            const continuation = messages.find(
              (item) => item.metadata?.customType === "continuation",
            )
            expect(continuation).toMatchObject({
              id: `${message.id}:continuation:1`,
              role: "user",
              metadata: { customType: "continuation", details: { step: 1 } },
            })
            const events = yield* Ref.get(eventsRef)
            const completed = events.filter((event) => event._tag === "TurnCompleted")
            expect(completed).toHaveLength(1)
            expect(completed[0]).not.toMatchObject({ streamFailed: true })
            // The broken step spent tokens nobody reported: the receipt names no
            // total rather than the second step's alone.
            expect(completed[0]?._tag === "TurnCompleted" && completed[0].usage).toBeUndefined()
          }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef))),
        )
      }),
  )
  it.live("bounds continuation instructions per turn and then reports the stream failure", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      let streamCalls = 0
      const providerLayer = LanguageModelLayers.testStream(() => {
        streamCalls += 1
        return Effect.succeed(
          Stream.concat(
            Stream.fromIterable([textDeltaPart(`part ${streamCalls}`)]),
            Stream.fail(
              AiError.make({
                module: "Test",
                method: "streamText",
                reason: new AiError.UnknownError({ description: "connection reset" }),
              }),
            ),
          ),
        )
      })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const messageStorage = yield* MessageStorage
          const message = makeMessage(SessionId.make("s1"), BranchId.make("b1"), "write it")
          yield* runAgentLoop(agentLoop, message)
          // Two continuations, then the third partial failure ends the turn.
          expect(streamCalls).toBe(3)
          const messages = yield* messageStorage.listMessages(BranchId.make("b1"))
          expect(
            messages.filter((item) => item.metadata?.customType === "continuation"),
          ).toHaveLength(2)
          const events = yield* Ref.get(eventsRef)
          expect(events.filter((event) => event._tag === "TurnCompleted")).toMatchObject([
            { streamFailed: true },
          ])
        }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef))),
      )
    }),
  )
})

// ── empty final step ────────────────────────────────────────────────────────

/**
 * A turn whose last model step yields nothing must not report success.
 *
 * Observed in production against a real workspace: a multi-tool turn ran its
 * tools, the model then returned a step with no text and no tool calls, and
 * the loop finalized the turn as Done. No assistant message was ever stored
 * (`persistAssistantParts` skips an empty parts list), so the caller saw an
 * empty answer and exit 0 — a turn that silently produced nothing.
 */
describe("empty final step", () => {
  const sessionId = SessionId.make("empty-step-session")
  const branchId = BranchId.make("empty-step-branch")

  const userMessage = (text: string) =>
    Message.cases.regular.make({
      id: MessageId.make("empty-step-msg-0"),
      sessionId,
      branchId,
      role: "user",
      parts: [Prompt.textPart({ text })],
      createdAt: dateFromMillis(1_767_225_600_000),
    })

  const echoTool = tool({
    id: "echo",
    description: "Echoes input",
    params: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
    execute: (params) => Effect.succeed({ text: params.text }),
  })

  /** A model step that finishes with neither text nor tool calls. */
  const emptyStep = () => ({
    parts: [finishPart({ finishReason: "stop", usage: { inputTokens: 10, outputTokens: 0 } })],
  })

  it.live("stores an assistant message even when the last step is empty", () =>
    Effect.gen(function* () {
      // Third step answers the re-prompt the loop should issue after the
      // empty one. A loop that does not re-prompt never reads it.
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        toolCallStep("echo", { text: "hello" }),
        emptyStep(),
        textStep("Here is the answer."),
      ])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* runAgentLoop(agentLoop, userMessage("do the thing"))

        const messageStorage = yield* MessageStorage
        const stored = yield* messageStorage.listMessages(branchId)
        const assistantTexts = stored
          .filter((message) => message.role === "assistant")
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "text")

        // The turn ran tools and then produced nothing. Reporting Done with no
        // assistant text at all is the failure: the caller cannot tell an empty
        // answer from a successful one.
        expect(assistantTexts.length).toBeGreaterThan(0)
      }).pipe(Effect.provide(makeLayer(providerLayer, [echoTool])))
    }),
  )

  it.live("a step cut off at the output limit is retried in a smaller step", () =>
    Effect.gen(function* () {
      // Observed in the gamut testbed: the orchestrator wrote one giant tool
      // call, hit the output limit, and the loop reported the leading text
      // as the answer. The third step answers the re-prompt the loop should
      // issue after the truncated one.
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        toolCallStep("echo", { text: "hello" }),
        {
          parts: [
            textDeltaPart("Let me delegate."),
            finishPart({ finishReason: "length", usage: { inputTokens: 10, outputTokens: 4096 } }),
          ],
        },
        textStep("Here is the answer."),
      ])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* runAgentLoop(agentLoop, userMessage("do the thing"))

        const messageStorage = yield* MessageStorage
        const stored = yield* messageStorage.listMessages(branchId)
        const assistantTexts = stored
          .filter((message) => message.role === "assistant")
          .flatMap((message) => message.parts)
          .flatMap((part) => {
            if (part.type === "text") return [part.text]
            return []
          })
        expect(assistantTexts).toContain("Here is the answer.")
        const continuation = stored.find(
          (message) => message.metadata?.customType === "continuation",
        )
        expect(continuation?.role).toBe("user")
      }).pipe(Effect.provide(makeLayer(providerLayer, [echoTool])))
    }),
  )

  it.live("marks the turn unanswered once every continuation is spent", () =>
    Effect.gen(function* () {
      // Three empty steps: the first two burn both continuations, the third
      // still says nothing. The loop has no move left, so the receipt must
      // record that it gave up rather than reporting an ordinary reply.
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        emptyStep(),
        emptyStep(),
        emptyStep(),
      ])
      const events = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          yield* runAgentLoop(agentLoop, userMessage("do the thing"))

          const turnCompleted = (yield* Ref.get(events)).filter(
            (event) => event._tag === "TurnCompleted",
          )

          expect(turnCompleted.length).toBeGreaterThan(0)
          // Without the flag every field here reads exactly like a successful
          // turn, and the caller cannot tell "gave up" from "replied".
          expect(turnCompleted.every((event) => event.unanswered === true)).toBe(true)
        }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, events))),
      )
    }),
  )

  it.live("spends every continuation before giving up", () =>
    Effect.gen(function* () {
      // `LanguageModelLayers.empty` is the layer `gent --mock-empty` runs on,
      // so this pins the same path the CLI exercises: the loop must re-prompt
      // MAX_CONTINUATIONS_PER_TURN times rather than stopping at the first
      // empty step, and it must stop rather than looping forever.
      const providerLayer = LanguageModelLayers.empty
      const events = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          yield* runAgentLoop(agentLoop, userMessage("do the thing"))

          const turnCompleted = (yield* Ref.get(events)).filter(
            (event) => event._tag === "TurnCompleted",
          )
          expect(turnCompleted.length).toBeGreaterThan(0)
          expect(turnCompleted.every((event) => event.unanswered === true)).toBe(true)
        }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, events))),
      )
    }),
  )
})

// ── max turn steps ──────────────────────────────────────────────────────────

const promptText = (prompt: Prompt.Prompt): string =>
  prompt.content
    .flatMap((message) => {
      if (Predicate.isString(message.content)) return [message.content]
      return message.content
        .filter((part): part is Prompt.TextPart => part.type === "text")
        .map((part) => part.text)
    })
    .join("\n")

/**
 * A turn that spends the whole step budget must not report success.
 *
 * `runTurn` bounds a turn at `MAX_TURN_STEPS` so a model that asks for tools
 * forever cannot run without end. That exit left `interrupted`, `streamFailed`
 * and `unanswered` all false, so the turn published a `TurnCompleted` that
 * reads exactly like an ordinary reply. `apps/tui/src/headless.ts` picks its exit
 * code from `event.unanswered !== true`, so `gent -H` against a looping model
 * exited 0 having printed no answer at all.
 *
 * Same failure as the `empty final step` tests guard, at the other
 * exit from the same loop: a turn that gave up must say so.
 */
describe("max turn steps", () => {
  const sessionId = SessionId.make("max-steps-session")
  const branchId = BranchId.make("max-steps-branch")

  const userMessage = (text: string) =>
    Message.cases.regular.make({
      id: MessageId.make("max-steps-msg-0"),
      sessionId,
      branchId,
      role: "user",
      parts: [Prompt.textPart({ text })],
      createdAt: dateFromMillis(1_767_225_600_000),
    })

  const echoTool = tool({
    id: "echo",
    description: "Echoes input",
    params: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
    execute: (params) => Effect.succeed({ text: params.text }),
  })

  /**
   * A model that asks for the same tool on every step and never answers. Real
   * providers stop on their own; this one does not, which is the case the step
   * bound exists for.
   */
  const alwaysToolCalls = LanguageModelLayers.testStream(() =>
    Effect.succeed(
      Stream.make(
        toolCallPart("echo", { text: "again" }),
        finishPart({ finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1 } }),
      ),
    ),
  )

  it.live("a turn that spends the whole step budget is marked unanswered", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        // The budget is the agent's to lower; three steps prove the same exit
        // the default two hundred do.
        yield* runAgentLoop(agentLoop, userMessage("loop forever"), {
          runSpec: { overrides: { maxSteps: 3 } },
        })

        const events = yield* Ref.get(eventsRef)
        expect(events.filter((event) => event._tag === "StreamStarted")).toHaveLength(3)
        const turnCompleted = events.filter((event) => event._tag === "TurnCompleted")
        expect(turnCompleted.length).toBeGreaterThan(0)
        // Without the flag this reads as a successful turn with an empty
        // transcript, and headless mode exits 0 on it.
        expect(turnCompleted.every((event) => event.unanswered === true)).toBe(true)
      }).pipe(Effect.provide(makeLayerWithEvents(alwaysToolCalls, eventsRef, [echoTool])))
    }),
  )

  /**
   * The last budgeted step asks the model for no tools. A call it makes anyway
   * must not run: the step has no successor to read the result, and a tool
   * with side effects would act after the budget said stop.
   */
  it.live("a tool call on the last budgeted step is refused, not run", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        toolCallStep("echo", { text: "first" }),
        toolCallStep("echo", { text: "past the limit" }),
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* runAgentLoop(agentLoop, userMessage("two steps at most"), {
          runSpec: { overrides: { maxSteps: 2 } },
        })
        const events = yield* Ref.get(eventsRef)
        expect(events.filter((event) => event._tag === "ToolCallStarted")).toHaveLength(1)
        const messageStorage = yield* MessageStorage
        const stored = yield* messageStorage.listMessages(branchId)
        const refused = stored
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "tool-result" && part.isFailure)
        expect(refused).toHaveLength(1)
        const turnCompleted = events.filter((event) => event._tag === "TurnCompleted")
        expect(turnCompleted.every((event) => event.unanswered === true)).toBe(true)
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }).pipe(Effect.timeout("4 seconds")),
  )

  /**
   * The last budgeted step tells the model its tools are gone. The line is
   * written at that step's boundary, after the step resolved its messages, so
   * the step itself must read it: no later step exists to show it.
   */
  it.live("the last budgeted step reads the step-limit instruction", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        toolCallStep("echo", { text: "first" }),
        {
          ...textStep("stopped at the limit"),
          assertOptions: (options) => {
            expect(promptText(options.prompt)).toContain("maximum number of steps")
          },
        },
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* runAgentLoop(agentLoop, userMessage("two steps at most"), {
          runSpec: { overrides: { maxSteps: 2 } },
        })
        yield* controls.assertDone
        const events = yield* Ref.get(eventsRef)
        expect(events.some((event) => event._tag === "ErrorOccurred")).toBe(false)
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }).pipe(Effect.timeout("4 seconds")),
  )

  /**
   * A continuation asks the model for one more step. On the last step of the
   * budget no step follows, so the instruction would stay in the transcript
   * with no answer after it.
   */
  it.live("the last budgeted step writes no continuation it cannot answer", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        {
          parts: [
            finishPart({ finishReason: "stop", usage: { inputTokens: 10, outputTokens: 0 } }),
          ],
        },
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* runAgentLoop(agentLoop, userMessage("answer once"), {
          runSpec: { overrides: { maxSteps: 1 } },
        })

        const messageStorage = yield* MessageStorage
        const stored = yield* messageStorage.listMessages(branchId)
        expect(stored.some((message) => message.metadata?.customType === "continuation")).toBe(
          false,
        )
        const events = yield* Ref.get(eventsRef)
        const turnCompleted = events.filter((event) => event._tag === "TurnCompleted")
        expect(turnCompleted.length).toBeGreaterThan(0)
        expect(turnCompleted.every((event) => event.unanswered === true)).toBe(true)
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }).pipe(Effect.timeout("4 seconds")),
  )

  /**
   * Steering joins a turn at a step boundary by leaving the queue. On the last
   * step of the budget there is no next step, so a message delivered there
   * would leave the queue and never reach a prompt.
   */
  it.live("steering that arrives during the last budgeted step opens the next turn", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        { ...textStep("the budget's only answer"), gated: true },
        {
          ...textStep("read the steering"),
          assertOptions: (options) => {
            const texts = Prompt.make(options.prompt).content.flatMap((message) => {
              if (message.role !== "user") return []
              return message.content.flatMap((part) => {
                if (part.type !== "text") return []
                return [part.text]
              })
            })
            expect(texts).toContain("steer late")
          },
        },
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const fiber = yield* Effect.forkChild(
          runAgentLoop(agentLoop, userMessage("answer once"), {
            runSpec: { overrides: { maxSteps: 1 } },
          }),
        )
        yield* controls.waitForCall(0)
        yield* steerAgentLoop({
          _tag: "Interject",
          sessionId,
          branchId,
          requestId: "req-interject-last-step",
          message: "steer late",
        })
        yield* controls.emitAll(0)
        yield* Fiber.join(fiber)
        yield* controls.waitForCall(1)
        yield* controls.assertDone
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }).pipe(Effect.timeout("4 seconds")),
  )

  /**
   * The same failure at the loop's other give-up exit.
   *
   * `resolveTurnContext` publishes `ErrorOccurred` and returns undefined for an
   * agent no extension defines (`turn.ts`). The turn must then mark its
   * `TurnCompleted` unanswered, so it never reads as a reply.
   */
  it.live("a turn for an unknown agent is marked unanswered", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* runAgentLoop(agentLoop, userMessage("who are you"), {
          agent: AgentName.make("no-such-agent"),
        })

        const events = yield* Ref.get(eventsRef)
        expect(
          events.some(
            (event) =>
              event._tag === "ErrorOccurred" && event.error === "Unknown agent: no-such-agent",
          ),
        ).toBe(true)
        const turnCompleted = events.filter((event) => event._tag === "TurnCompleted")
        expect(turnCompleted).toHaveLength(1)
        expect(turnCompleted.every((event) => event.unanswered === true)).toBe(true)
      }).pipe(Effect.provide(makeLayerWithEvents(alwaysToolCalls, eventsRef, [echoTool])))
    }),
  )
})

// ── native model compaction ─────────────────────────────────────────────────

describe("native model compaction integration", () => {
  it.live("hands off the history before the turn and keeps every message durable", () => {
    const sessionId = SessionId.make("native-compaction-session")
    const branchId = BranchId.make("native-compaction-branch")
    const oldMessages = Array.from({ length: 12 }, (_, index) =>
      Message.cases.regular.make({
        id: MessageId.make(`native-old-${index + 1}`),
        sessionId,
        branchId,
        role: "assistant",
        parts: [Prompt.textPart({ text: `native-old-${index + 1} ${"x".repeat(50_000)}` })],
        createdAt: dateFromMillis(1_000 + index),
      }),
    )
    let providerCalls = 0
    let mainPrompt = Option.none<Prompt.Prompt>()
    const providerLayer = LanguageModelLayers.testStream((options) => {
      providerCalls += 1
      if (providerCalls === 2) mainPrompt = Option.some(Prompt.make(options.prompt))
      let text = "native response"
      if (providerCalls === 1) text = "native bounded summary"
      return Effect.succeed(
        Stream.fromIterable([textDeltaPart(text), finishPart({ finishReason: "stop" })]),
      )
    })

    return Effect.scoped(
      Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* ensureStorageParents({ sessionId, branchId })
        const storage = yield* MessageStorage
        yield* Effect.forEach(oldMessages, (message) => storage.createMessage(message), {
          discard: true,
        })
        yield* runAgentLoop(agentLoop, makeMessage(sessionId, branchId, "native current turn"))

        expect(providerCalls).toBe(2)
        expect(Option.isSome(mainPrompt)).toBe(true)
        if (Option.isNone(mainPrompt)) return yield* Effect.die("main prompt missing")
        const main = promptText(mainPrompt.value)
        expect(main).toContain("native bounded summary")
        expect(main).toContain("native current turn")
        // The handoff replaced the old messages in the model view.
        expect(main).not.toContain("native-old-1 xxxx")

        const durable = yield* storage.listMessages(branchId)
        const markers = durable.filter(
          (message) => message.metadata?.customType === "context-window",
        )
        expect(markers).toHaveLength(1)
        const marker = markers[0]
        if (Predicate.isUndefined(marker)) return yield* Effect.die("marker missing")
        const details = Option.getOrThrow(windowDetails(marker))
        expect(details.summarized).toMatchObject({
          firstMessageId: "native-old-1",
          lastMessageId: "native-old-12",
          count: 12,
        })
        expect(main).toContain("native-old-1 … native-old-12")
        expect(durable.some((message) => message.id === oldMessages[0]?.id)).toBe(true)
      }),
    ).pipe(
      Effect.provide(makeLayer(providerLayer).pipe(Layer.provideMerge(rangeCompactorLayer))),
      Effect.timeout("15 seconds"),
    )
  })

  it.live("the summary request asks for no reasoning and names no cache key", () => {
    const sessionId = SessionId.make("summary-reasoning-session")
    const branchId = BranchId.make("summary-reasoning-branch")
    const modelId = ModelId.make("summary-driver/model")
    const observedHints: Array<ProviderHints> = []
    const providerLayer = LanguageModelLayers.testStream(() =>
      Effect.succeed(
        Stream.fromIterable([textDeltaPart("ok"), finishPart({ finishReason: "stop" })]),
      ),
    )
    const driver: ModelDriverContribution = {
      id: "summary-driver",
      name: "Summary driver",
      resolveModel: (_modelName, _authInfo, hints) =>
        Effect.sync(() => {
          if (Predicate.isNotUndefined(hints)) observedHints.push(hints)
          return AiModel.make("summary-driver", "model", providerLayer)
        }),
    }
    const oldMessages = Array.from({ length: 12 }, (_, index) =>
      Message.cases.regular.make({
        id: MessageId.make(`summary-old-${index + 1}`),
        sessionId,
        branchId,
        role: "assistant",
        parts: [Prompt.textPart({ text: `summary-old-${index + 1} ${"x".repeat(50_000)}` })],
        createdAt: dateFromMillis(1_000 + index),
      }),
    )
    const layer = actorTestRoot({
      resolver: ModelResolver.Live.pipe(Layer.provide(Auth.Test())),
      registry: ExtensionRegistry.fromResolved(
        resolveExtensions([
          {
            manifest: { id: ExtensionId.make("summary-driver") },
            scope: "builtin",
            sourcePath: "test",
            contributions: { agents: testAgents, modelDrivers: [driver] },
          },
        ]),
      ),
      models: [
        Model.make({
          id: modelId,
          name: "Summary model",
          provider: ProviderId.make("summary-driver"),
          contextLength: 128_000,
        }),
      ],
    }).pipe(Layer.provideMerge(rangeCompactorLayer))

    return Effect.scoped(
      Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const admission: SessionAdmission = {
          runSpec: { overrides: { modelId, reasoningEffort: "high" } },
        }
        yield* ensureStorageParents({ sessionId, branchId, admission })
        const storage = yield* MessageStorage
        yield* Effect.forEach(oldMessages, (message) => storage.createMessage(message), {
          discard: true,
        })
        yield* runAgentLoop(
          agentLoop,
          makeMessage(sessionId, branchId, "summarize then answer"),
          admission,
        )
        // A turn step asks for the output its 128k window reserves; the summary
        // asks for its own small cap.
        const turnOutput = 32_000
        const summary = observedHints.filter((hints) => hints.maxTokens !== turnOutput)
        expect(summary).toHaveLength(1)
        expect(summary[0]?.reasoning).toBe("none")
        // Nothing reads a summary prompt back, so it writes no cache entry.
        expect(summary[0]?.cacheKey).toBeUndefined()
        // The turn itself keeps its own effort.
        expect(
          observedHints.filter((hints) => hints.maxTokens === turnOutput).at(-1)?.reasoning,
        ).toBe("high")
        expect(
          observedHints.filter((hints) => hints.maxTokens === turnOutput).at(-1)?.cacheKey,
        ).toBe(sessionId)
      }),
    ).pipe(Effect.provide(layer), Effect.timeout("15 seconds"))
  })

  it.live("the driver learns from the catalog whether the model reasons", () => {
    const sessionId = SessionId.make("catalog-reasoning-session")
    const branchId = BranchId.make("catalog-reasoning-branch")
    const observedHints: Array<ProviderHints> = []
    const providerLayer = LanguageModelLayers.testStream(() =>
      Effect.succeed(
        Stream.fromIterable([textDeltaPart("ok"), finishPart({ finishReason: "stop" })]),
      ),
    )
    const driver: ModelDriverContribution = {
      id: "catalog-driver",
      name: "Catalog driver",
      resolveModel: (_modelName, _authInfo, hints) =>
        Effect.sync(() => {
          if (Predicate.isNotUndefined(hints)) observedHints.push(hints)
          return AiModel.make("catalog-driver", "model", providerLayer)
        }),
    }
    const layer = actorTestRoot({
      resolver: ModelResolver.Live.pipe(Layer.provide(Auth.Test())),
      registry: ExtensionRegistry.fromResolved(
        resolveExtensions([
          {
            manifest: { id: ExtensionId.make("catalog-driver") },
            scope: "builtin",
            sourcePath: "test",
            contributions: { agents: testAgents, modelDrivers: [driver] },
          },
        ]),
      ),
      models: [
        Model.make({
          id: ModelId.make("catalog-driver/plain"),
          name: "Plain model",
          provider: ProviderId.make("catalog-driver"),
          contextLength: 128_000,
          reasoning: false,
        }),
        Model.make({
          id: ModelId.make("catalog-driver/unlisted"),
          name: "Model the catalog says nothing about",
          provider: ProviderId.make("catalog-driver"),
          contextLength: 128_000,
        }),
      ],
    })

    return Effect.scoped(
      Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        for (const modelId of ["catalog-driver/plain", "catalog-driver/unlisted"]) {
          const admission: SessionAdmission = {
            runSpec: { overrides: { modelId: ModelId.make(modelId), reasoningEffort: "high" } },
          }
          const name = modelId.split("/")[1]
          const session = SessionId.make(`${sessionId}-${name}`)
          const branch = BranchId.make(`${branchId}-${name}`)
          yield* ensureStorageParents({ sessionId: session, branchId: branch, admission })
          yield* runAgentLoop(agentLoop, makeMessage(session, branch, "hello"), admission)
        }
        expect(
          observedHints.map((hints) => Option.fromUndefinedOr(hints.supportsReasoning)),
        ).toEqual([Option.some(false), Option.none()])
      }),
    ).pipe(Effect.provide(layer), Effect.timeout("15 seconds"))
  })

  it.live("a step's cache writes cost the rate of the lifetime each one lives", () => {
    const sessionId = SessionId.make("lifetime-cost-session")
    const branchId = BranchId.make("lifetime-cost-branch")
    const modelId = ModelId.make("lifetime-driver/model")
    // The driver's own usage detail: 6,000 tokens written for 5 minutes, 4,000 for 1 hour.
    const providerLayer = LanguageModelLayers.testStream(() =>
      Effect.succeed(
        Stream.fromIterable([
          textDeltaPart("ok"),
          finishPart({
            finishReason: "stop",
            usage: { inputTokens: 10_000, outputTokens: 0, cacheWriteTokens: 10_000 },
            metadata: { "lifetime-driver": { fiveMinutes: 6_000, oneHour: 4_000 } },
          }),
        ]),
      ),
    )
    const LifetimeWrites = Schema.Struct({
      "lifetime-driver": Schema.Struct({ fiveMinutes: Schema.Finite, oneHour: Schema.Finite }),
    })
    const driver: ModelDriverContribution = {
      id: "lifetime-driver",
      name: "Lifetime driver",
      resolveModel: () => Effect.succeed(AiModel.make("lifetime-driver", "model", providerLayer)),
      cacheWritesByLifetime: (metadata) =>
        Option.match(Schema.decodeUnknownOption(LifetimeWrites)(metadata), {
          onNone: () => [],
          onSome: ({ "lifetime-driver": writes }) => [
            { ttlMs: 300_000, tokens: writes.fiveMinutes },
            { ttlMs: 3_600_000, tokens: writes.oneHour },
          ],
        }),
    }
    const events = Ref.makeUnsafe<Array<AgentEvent>>([])
    const layer = actorTestRoot({
      resolver: ModelResolver.Live.pipe(Layer.provide(Auth.Test())),
      eventStore: recordingEventStore(events),
      registry: ExtensionRegistry.fromResolved(
        resolveExtensions([
          {
            manifest: { id: ExtensionId.make("lifetime-driver") },
            scope: "builtin",
            sourcePath: "test",
            contributions: { agents: testAgents, modelDrivers: [driver] },
          },
        ]),
      ),
      models: [
        Model.make({
          id: modelId,
          name: "Lifetime model",
          provider: ProviderId.make("lifetime-driver"),
          contextLength: 128_000,
          // Dollars per million tokens: a 1-hour write costs 2x input, a 5-minute one 1.25x.
          pricing: {
            input: 5,
            output: 25,
            cacheWrite: 10,
            cacheWriteByLifetime: [
              { ttlMs: 300_000, price: 6.25 },
              { ttlMs: 3_600_000, price: 10 },
            ],
          },
        }),
      ],
    })

    return Effect.scoped(
      Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const admission: SessionAdmission = { runSpec: { overrides: { modelId } } }
        yield* ensureStorageParents({ sessionId, branchId, admission })
        yield* runAgentLoop(agentLoop, makeMessage(sessionId, branchId, "hello"), admission)
        const ended = (yield* Ref.get(events)).filter((event) => event._tag === "StreamEnded")
        const costs = ended.map((event) => event.costUsd)
        // 6,000 x $6.25 + 4,000 x $10 per million, not 10,000 x $10.
        expect(costs).toHaveLength(1)
        expect(costs[0]).toBeCloseTo((6_000 * 6.25 + 4_000 * 10) / 1_000_000, 12)
        // The step's end carries the split, so a client prices a miss by it too.
        expect(ended[0]?.cacheWritesByLifetime).toEqual([
          { ttlMs: 300_000, tokens: 6_000 },
          { ttlMs: 3_600_000, tokens: 4_000 },
        ])
      }),
    ).pipe(Effect.provide(layer), Effect.timeout("15 seconds"))
  })

  it.live("a smaller agent context window hands off history the catalog window would keep", () => {
    const sessionId = SessionId.make("small-window-session")
    const branchId = BranchId.make("small-window-branch")
    // ~6,000 tokens: far under the 128k test catalog limit, over a 6k window minus reserves.
    const oldMessages = Array.from({ length: 12 }, (_, index) =>
      Message.cases.regular.make({
        id: MessageId.make(`small-old-${index + 1}`),
        sessionId,
        branchId,
        role: "assistant",
        parts: [Prompt.textPart({ text: `small-old-${index + 1} ${"x".repeat(2_000)}` })],
        createdAt: dateFromMillis(1_000 + index),
      }),
    )
    let providerCalls = 0
    const providerLayer = LanguageModelLayers.testStream(() => {
      providerCalls += 1
      let text = "small response"
      if (providerCalls === 1) text = "small bounded summary"
      return Effect.succeed(
        Stream.fromIterable([textDeltaPart(text), finishPart({ finishReason: "stop" })]),
      )
    })

    return Effect.scoped(
      Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const admission = { runSpec: { overrides: { contextLength: 6_000 } } }
        yield* ensureStorageParents({ sessionId, branchId, admission })
        const storage = yield* MessageStorage
        yield* Effect.forEach(oldMessages, (message) => storage.createMessage(message), {
          discard: true,
        })
        yield* runAgentLoop(
          agentLoop,
          makeMessage(sessionId, branchId, "small current turn"),
          admission,
        )

        expect(providerCalls).toBe(2)
        const durable = yield* storage.listMessages(branchId)
        const markers = durable.filter(
          (message) => message.metadata?.customType === "context-window",
        )
        expect(markers).toHaveLength(1)
      }),
    ).pipe(
      Effect.provide(makeLayer(providerLayer).pipe(Layer.provideMerge(rangeCompactorLayer))),
      Effect.timeout("15 seconds"),
    )
  })
})

// ── native model context projection ─────────────────────────────────────────

const promptTextModelContext = (prompt: Prompt.Prompt): string =>
  prompt.content
    .flatMap((message) => {
      if (Predicate.isString(message.content)) return [message.content]
      return message.content.filter(Schema.is(Prompt.TextPart)).map((part) => part.text)
    })
    .join("\n")

describe("native model context projection", () => {
  it.live("truncates the provider prompt while preserving durable history", () => {
    const oldMarker = "old-context-marker"
    let capturedPrompt: Option.Option<Prompt.Prompt> = Option.none()
    const providerLayer = LanguageModelLayers.testStream((options) => {
      capturedPrompt = Option.some(Prompt.make(options.prompt))
      return Effect.succeed(
        Stream.fromIterable([textDeltaPart("ok"), finishPart({ finishReason: "stop" })]),
      )
    })
    const sessionId = SessionId.make("model-context-session")
    const branchId = BranchId.make("model-context-branch")

    return Effect.scoped(
      Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* ensureStorageParents({ sessionId, branchId })
        const messageStorage = yield* MessageStorage
        yield* messageStorage.createMessage(
          Message.cases.regular.make({
            id: MessageId.make("old-context-message"),
            sessionId,
            branchId,
            role: "user",
            parts: [Prompt.textPart({ text: `${oldMarker} ${"x".repeat(520_000)}` })],
            createdAt: dateFromMillis(1),
          }),
        )

        yield* runAgentLoop(agentLoop, makeMessage(sessionId, branchId, "fresh request"))

        expect(Option.isSome(capturedPrompt)).toBe(true)
        if (Option.isNone(capturedPrompt)) return yield* Effect.die("provider did not run")
        const submittedText = promptTextModelContext(capturedPrompt.value)
        expect(submittedText).toContain("fresh request")
        expect(submittedText).not.toContain(oldMarker)

        const durableMessages = yield* messageStorage.listMessages(branchId)
        expect(
          durableMessages.some((message) =>
            message.parts.some((part) => part.type === "text" && part.text.includes(oldMarker)),
          ),
        ).toBe(true)
      }),
    ).pipe(Effect.provide(makeLayer(providerLayer)), Effect.timeout("5 seconds"))
  })

  it.live("keeps parallel native tool calls and results paired", () => {
    const readTool = tool({
      id: "read",
      description: "Read a test path.",
      params: Schema.Struct({ path: Schema.String }),
      output: Schema.String,
      execute: (input) => Effect.succeed(input.path),
    })
    let capturedPrompt: Option.Option<Prompt.Prompt> = Option.none()

    return Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        multiToolCallStep(
          { toolName: "read", input: { path: "first.txt" }, toolCallId: ToolCallId.make("pair-1") },
          {
            toolName: "read",
            input: { path: "second.txt" },
            toolCallId: ToolCallId.make("pair-2"),
          },
        ),
        {
          ...textStep("done"),
          assertOptions: (options) => {
            capturedPrompt = Option.some(Prompt.make(options.prompt))
          },
        },
      ])
      const run = Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const sessionId = SessionId.make("model-context-tool-session")
        const branchId = BranchId.make("model-context-tool-branch")
        yield* runAgentLoop(agentLoop, makeMessage(sessionId, branchId, "run parallel tools"))
        yield* controls.assertDone

        expect(Option.isSome(capturedPrompt)).toBe(true)
        if (Option.isNone(capturedPrompt)) return yield* Effect.die("second provider call missing")
        const messages = capturedPrompt.value.content
        const callIds = messages.flatMap((message) => {
          if (message.role !== "assistant" || Predicate.isString(message.content)) return []
          return message.content.filter(Schema.is(Prompt.ToolCallPart)).map((part) => part.id)
        })
        const resultIds = messages.flatMap((message) => {
          if (message.role !== "tool" || Predicate.isString(message.content)) return []
          return message.content.filter(Schema.is(Prompt.ToolResultPart)).map((part) => part.id)
        })
        expect(callIds).toEqual([ToolCallId.make("pair-1"), ToolCallId.make("pair-2")])
        expect(resultIds).toEqual([ToolCallId.make("pair-1"), ToolCallId.make("pair-2")])
      }).pipe(Effect.provide(makeLayer(providerLayer, [readTool])))
      yield* run
    }).pipe(Effect.timeout("5 seconds"))
  })

  it.live("asks for the output the budget reserves and passes the stable session cache key", () => {
    const modelId = ModelId.make("context-driver/model")
    let observedMaxTokens = Option.none<number>()
    const observedCacheKeys: Array<Option.Option<string>> = []
    const providerLayer = LanguageModelLayers.testStream(() =>
      Effect.succeed(
        Stream.fromIterable([textDeltaPart("ok"), finishPart({ finishReason: "stop" })]),
      ),
    )
    const driver: ModelDriverContribution = {
      id: "context-driver",
      name: "Context driver",
      resolveModel: (_modelName, _authInfo, hints) =>
        Effect.sync(() => {
          const maxTokens = Option.fromUndefinedOr(hints).pipe(
            Option.flatMap((value) => Option.fromUndefinedOr(value.maxTokens)),
          )
          if (Option.isSome(maxTokens)) observedMaxTokens = maxTokens
          observedCacheKeys.push(Option.fromUndefinedOr(hints?.cacheKey))
          return AiModel.make("context-driver", "model", providerLayer)
        }),
    }
    const resolved = resolveExtensions([
      {
        manifest: { id: ExtensionId.make("model-context-driver") },
        scope: "builtin",
        sourcePath: "test",
        contributions: { agents: testAgents, modelDrivers: [driver] },
      },
    ])
    const extensionRegistry = ExtensionRegistry.fromResolved(resolved)
    const modelResolver = ModelResolver.Live.pipe(Layer.provide(Auth.Test()))
    const layer = actorTestRoot({
      registry: extensionRegistry,
      models: [
        Model.make({
          id: modelId,
          name: "Context model",
          provider: ProviderId.make("context-driver"),
          contextLength: 128_000,
          outputLimit: 16_000,
        }),
      ],
      resolver: modelResolver,
    })

    return Effect.scoped(
      Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* runAgentLoop(
          agentLoop,
          makeMessage(
            SessionId.make("model-context-driver-session"),
            BranchId.make("model-context-driver-branch"),
            "request provider budget",
          ),
          { runSpec: { overrides: { modelId } } },
        )
        // The catalog cap is under 32k, so the request asks for all of it.
        expect(observedMaxTokens).toEqual(Option.some(16_000))
        yield* runAgentLoop(
          agentLoop,
          makeMessage(
            SessionId.make("model-context-driver-session"),
            BranchId.make("model-context-driver-branch"),
            "continue with the same cache key",
          ),
          { runSpec: { overrides: { modelId } } },
        )
        expect(observedCacheKeys).toEqual([
          Option.some("model-context-driver-session"),
          Option.some("model-context-driver-session"),
        ])
      }),
    ).pipe(Effect.provide(layer), Effect.timeout("5 seconds"))
  })
})

// ── model-change notice ─────────────────────────────────────────────────────

const TurnRecordRow = Schema.Struct({
  step: Schema.Finite,
  continuations: Schema.Finite,
  pending_tool_calls_json: Schema.String,
})

const decodePendingJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }))),
)

/**
 * Read the turn row straight from the database file. The test asserts what a
 * restarting process would see, so it must not read through a live layer.
 */
const readTurnRecordRow = Effect.fn("test.readTurnRecordRow")(function* (params: {
  readonly dbPath: string
  readonly sessionId: string
  readonly branchId: string
  readonly messageId: string
}) {
  const raw = yield* Effect.sync(() => {
    const db = new Database(params.dbPath, { readonly: true })
    const rows = db
      .query(
        "SELECT step, continuations, pending_tool_calls_json FROM turn_records WHERE session_id = ? AND branch_id = ? AND message_id = ?",
      )
      .all(params.sessionId, params.branchId, params.messageId)
    db.close()
    return rows[0]
  })
  const row = yield* Schema.decodeUnknownEffect(TurnRecordRow)(raw)
  const pendingToolCalls = yield* decodePendingJson(row.pending_tool_calls_json)
  return { step: row.step, continuations: row.continuations, pendingToolCalls }
})

/**
 * What the probe tool did, across both processes; two layer graphs, one box.
 * `gate` holds one labelled call open so a step can be cut in half: the other
 * call's terminal event commits, the step's tool-result message does not.
 */
interface ProbeGate {
  readonly label: string
  readonly entered: Deferred.Deferred<void>
  readonly release: Deferred.Deferred<void>
}

interface ProbeBox {
  runs: number
  byLabel: Map<string, number>
  gate: Option.Option<ProbeGate>
}

const probe: ProbeBox = { runs: 0, byLabel: new Map(), gate: Option.none() }

const resetProbe = () => {
  probe.runs = 0
  probe.byLabel = new Map()
  probe.gate = Option.none()
}

const probeRunsFor = (label: string) =>
  Option.getOrElse(Option.fromUndefinedOr(probe.byLabel.get(label)), () => 0)

const ResumeProbeExtension: LoadedExtension = {
  manifest: { id: ExtensionId.make("@test/turn-resume-probe") },
  scope: "builtin",
  sourcePath: "test",
  artifactIdentity: LoadedArtifactIdentity.make("@test/turn-resume-probe@artifact-1"),
  contributions: {
    tools: [
      tool({
        id: "resume_probe",
        description: "Record one execution and echo the label",
        params: Schema.Struct({ label: Schema.String }),
        output: Schema.Struct({ label: Schema.String, run: Schema.Finite }),
        execute: Effect.fn("resume_probe")(function* (params) {
          yield* ExtensionContext
          probe.runs += 1
          probe.byLabel.set(params.label, probeRunsFor(params.label) + 1)
          const gate = probe.gate
          if (Option.isSome(gate) && gate.value.label === params.label) {
            yield* Deferred.succeed(gate.value.entered, void 0)
            yield* Deferred.await(gate.value.release)
          }
          return { label: params.label, run: probe.runs }
        }),
      }),
    ],
  },
}

/** The probe as a dispatching tool: recovery rebuilds host bindings for it from the agent. */
const DispatchProbeExtension: LoadedExtension = {
  manifest: { id: ExtensionId.make("@test/turn-dispatch-probe") },
  scope: "builtin",
  sourcePath: "test",
  artifactIdentity: LoadedArtifactIdentity.make("@test/turn-dispatch-probe@artifact-1"),
  contributions: {
    tools: [
      tool({
        id: "dispatch_probe",
        description: "Record one execution; declared as running other tools",
        params: Schema.Struct({ label: Schema.String }),
        output: Schema.Struct({ label: Schema.String }),
        dispatches: true,
        execute: Effect.fn("dispatch_probe")(function* (params) {
          yield* ExtensionContext
          probe.runs += 1
          const gate = probe.gate
          if (Option.isSome(gate) && gate.value.label === params.label) {
            yield* Deferred.succeed(gate.value.entered, void 0)
            yield* Deferred.await(gate.value.release)
          }
          return { label: params.label }
        }),
      }),
    ],
  },
}

/** The user message id that opened the branch's only turn. */
const openingTurnMessageId = (messages: ReadonlyArray<{ readonly id: string }>) =>
  Option.fromUndefinedOr(messages.map((message) => message.id).find((id) => !id.includes(":")))

interface HoldGate {
  readonly entered: Deferred.Deferred<void>
  readonly release: Deferred.Deferred<void>
}

const holdToolExtension = (gate: HoldGate): LoadedExtension => ({
  manifest: { id: ExtensionId.make("@test/hold-tool") },
  scope: "builtin",
  sourcePath: "test",
  artifactIdentity: LoadedArtifactIdentity.make("@test/hold-tool@artifact-1"),
  contributions: {
    tools: [
      tool({
        id: "hold",
        description: "Hold until the test releases it",
        params: Schema.Struct({}),
        output: Schema.Struct({ held: Schema.Boolean }),
        execute: Effect.fn("hold")(function* () {
          yield* ExtensionContext
          yield* Deferred.succeed(gate.entered, void 0)
          yield* Deferred.await(gate.release)
          return { held: true }
        }),
      }),
    ],
  },
})

describe("model-change notice", () => {
  it.scopedLive(
    "a model switch while a tool runs is noticed at the next step, after the tool result",
    () =>
      Effect.gen(function* () {
        const gate: HoldGate = {
          entered: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        }
        const nextModel = ModelId.make("custom/next-model")
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          toolCallStep("hold", {}),
          {
            ...textStep("after the switch"),
            assertOptions: (options) => {
              expect(promptText(options.prompt)).toContain(`continues with ${nextModel}]`)
            },
          },
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: e2ePreset.agents,
          providerLayer,
          extensions: [holdToolExtension(gate)],
        })
        yield* client.message
          .send({ sessionId, branchId, content: "hold, then answer" })
          .pipe(Effect.forkScoped)
        yield* Deferred.await(gate.entered)
        // `/model` lands while the tool call has no result yet.
        yield* client.session.updateSettings({
          sessionId,
          modelId: Option.some(nextModel),
          reasoningLevel: Option.none(),
        })
        yield* Deferred.succeed(gate.release, void 0)
        const messages = yield* waitFor(
          client.message.list({ branchId }),
          (current) =>
            current.some((message) =>
              message.parts.some(
                (part) => part.type === "text" && part.text === "after the switch",
              ),
            ),
          10_000,
          "the step after the switch answered",
        )
        const resultIndex = messages.findIndex((message) =>
          message.parts.some((part) => part.type === "tool-result"),
        )
        const noticeIndex = messages.findIndex(
          (message) => message.metadata?.customType === "model-change",
        )
        expect(resultIndex).toBeGreaterThanOrEqual(0)
        // The notice never splits a tool call from its result.
        expect(noticeIndex).toBeGreaterThan(resultIndex)
        yield* controls.assertDone
      }).pipe(Effect.timeout("15 seconds")),
    20_000,
  )

  it.scopedLive(
    "a model switch while the model streams is noticed at the next step",
    () =>
      Effect.gen(function* () {
        const gate: HoldGate = {
          entered: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        }
        yield* Deferred.succeed(gate.release, void 0)
        const nextModel = ModelId.make("custom/next-model")
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          { ...toolCallStep("hold", {}), gated: true },
          {
            ...textStep("after the stream switch"),
            assertOptions: (options) => {
              expect(promptText(options.prompt)).toContain(`continues with ${nextModel}]`)
            },
          },
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: e2ePreset.agents,
          providerLayer,
          extensions: [holdToolExtension(gate)],
        })
        yield* client.message
          .send({ sessionId, branchId, content: "switch while you stream" })
          .pipe(Effect.forkScoped)
        yield* controls.waitForCall(0)
        // The settings event lands before this step's `StreamEnded`.
        yield* client.session.updateSettings({
          sessionId,
          modelId: Option.some(nextModel),
          reasoningLevel: Option.none(),
        })
        yield* controls.emitAll(0)
        yield* waitFor(
          client.message.list({ branchId }),
          (current) =>
            current.some((message) =>
              message.parts.some(
                (part) => part.type === "text" && part.text === "after the stream switch",
              ),
            ),
          10_000,
          "the step after the stream switch answered",
        )
        yield* controls.assertDone
      }).pipe(Effect.timeout("15 seconds")),
    20_000,
  )

  it.scopedLive(
    "a replayed step after a second switch reads a notice naming the final model",
    () =>
      Effect.gen(function* () {
        resetProbe()
        const tempDir = yield* makeTempDirectoryScoped("gent-notice-replay-")
        const dbPath = `${tempDir}/gent.db`
        const secondModel = ModelId.make("custom/next-model")
        const finalModel = ModelId.make("custom/final-model")
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        probe.gate = Option.some({ label: "switch", entered, release })

        // First process: during the tool the model switches; step 2 writes
        // its notice, calls the model, and the process dies there.
        const firstProvider = yield* LanguageModelLayers.sequence([
          toolCallStep("resume_probe", { label: "switch" }),
          { ...textStep("never emitted"), gated: true },
        ])
        const started = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(
              createE2ELayer({
                agents: e2ePreset.agents,
                providerLayer: firstProvider.layer,
                extensions: [ResumeProbeExtension],
                storagePath: dbPath,
              }),
            )
            const { sessionId, branchId } = yield* client.session.create({})
            yield* client.message
              .send({ sessionId, branchId, content: "switch twice" })
              .pipe(Effect.forkScoped)
            yield* Deferred.await(entered)
            yield* client.session.updateSettings({
              sessionId,
              modelId: Option.some(secondModel),
              reasoningLevel: Option.none(),
            })
            yield* Deferred.succeed(release, void 0)
            yield* firstProvider.controls.waitForCall(1)
            return { sessionId, branchId }
          }).pipe(Effect.timeout("10 seconds")),
        )
        probe.gate = Option.none()

        // Second process: switch again, then the turn replays step 2.
        const finalReply = "READ-THE-FINAL-NOTICE"
        const secondProvider = yield* LanguageModelLayers.sequence([
          {
            ...textStep(finalReply),
            assertOptions: (options) => {
              expect(promptText(options.prompt)).toContain(`continues with ${finalModel}]`)
            },
          },
        ])
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(
              createE2ELayer({
                agents: e2ePreset.agents,
                providerLayer: secondProvider.layer,
                extensions: [ResumeProbeExtension],
                storagePath: dbPath,
              }),
            )
            yield* client.session.updateSettings({
              sessionId: started.sessionId,
              modelId: Option.some(finalModel),
              reasoningLevel: Option.none(),
            })
            yield* client.session.getSnapshot({
              sessionId: started.sessionId,
              branchId: started.branchId,
            })
            yield* client.message.send({
              sessionId: started.sessionId,
              branchId: started.branchId,
              content: "continue",
            })
            yield* waitFor(
              client.message.list({ branchId: started.branchId }),
              (messages) =>
                messages.some((message) =>
                  message.parts.some(
                    (part) => part.type === "text" && part.text.includes(finalReply),
                  ),
                ),
              15_000,
              "the replayed step answered",
            )
          }).pipe(Effect.timeout("20 seconds")),
        )
      }).pipe(Effect.timeout("40 seconds")),
    60_000,
  )

  it.scopedLive(
    "a step on the new model that breaks does not make the next step announce the switch again",
    () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make(0)
        const providerLayer = LanguageModelLayers.testStream(() =>
          Effect.gen(function* () {
            const call = yield* Ref.updateAndGet(calls, (count) => count + 1)
            // The first step on the new model breaks after partial output.
            if (call === 2) {
              return Stream.concat(
                Stream.fromIterable([textDeltaPart("partial")] satisfies LanguageModelStreamPart[]),
                Stream.fail(
                  AiError.make({
                    module: "Test",
                    method: "streamText",
                    reason: new AiError.UnknownError({ description: "connection reset" }),
                  }),
                ),
              )
            }
            return Stream.fromIterable([
              textDeltaPart(`reply ${call}`),
              finishPart({ finishReason: "stop" }),
            ] satisfies LanguageModelStreamPart[])
          }),
        )
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
        })
        const answered = (reply: string) =>
          waitFor(
            client.message.list({ branchId }),
            (current) =>
              current.some((message) =>
                message.parts.some((part) => part.type === "text" && part.text === reply),
              ),
            10_000,
            reply,
          )
        yield* client.message.send({ sessionId, branchId, content: "first" })
        yield* answered("reply 1")
        yield* client.session.updateSettings({
          sessionId,
          modelId: Option.some(ModelId.make("custom/next-model")),
          reasoningLevel: Option.none(),
        })
        yield* client.message.send({ sessionId, branchId, content: "second" })
        const messages = yield* answered("reply 3")
        expect(
          messages.filter((message) => message.metadata?.customType === "model-change"),
        ).toHaveLength(1)
      }).pipe(Effect.timeout("15 seconds")),
    20_000,
  )

  it.scopedLive(
    "a model switch that overflows the window keeps the user's new prompt, not only the notice",
    () =>
      Effect.gen(function* () {
        const prompts = yield* Ref.make<ReadonlyArray<string>>([])
        const providerLayer = LanguageModelLayers.testStream((options) =>
          Effect.gen(function* () {
            const seen = yield* Ref.updateAndGet(prompts, (all) => [
              ...all,
              promptText(options.prompt),
            ])
            // The first reply fills the window so the next turn must hand off.
            const text = [`big ${"x".repeat(600_000)}`][seen.length - 1] ?? `reply ${seen.length}`
            return Stream.fromIterable([
              textDeltaPart(text),
              finishPart({ finishReason: "stop" }),
            ] satisfies LanguageModelStreamPart[])
          }),
        )
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
        })
        yield* client.message.send({ sessionId, branchId, content: "first turn" })
        yield* waitFor(
          client.message.list({ branchId }),
          (current) => current.some((message) => message.role === "assistant"),
          10_000,
          "the first turn answered",
        )
        yield* client.session.updateSettings({
          sessionId,
          modelId: Option.some(ModelId.make("custom/next-model")),
          reasoningLevel: Option.none(),
        })
        const newPrompt = "SECOND-USER-PROMPT"
        yield* client.message.send({ sessionId, branchId, content: newPrompt })
        const messages = yield* waitFor(
          client.message.list({ branchId }),
          (current) => current.filter((message) => message.role === "assistant").length >= 2,
          15_000,
          "the second turn answered",
        )
        const prompt = messages.find((message) =>
          message.parts.some((part) => part.type === "text" && part.text === newPrompt),
        )
        const marker = messages.findLast(
          (message) => message.metadata?.customType === "context-window",
        )
        expect(Predicate.isNotUndefined(prompt)).toBe(true)
        expect(marker?.metadata?.details).toMatchObject({ keepFromMessageId: prompt?.id })
        const last = (yield* Ref.get(prompts)).at(-1) ?? ""
        // The prompt reaches the model as the user's words, not folded into the summary.
        expect(last).toContain(newPrompt)
      }).pipe(Effect.timeout("30 seconds")),
    40_000,
  )
})

// ── turn record ─────────────────────────────────────────────────────────────

/**
 * Resume from the durable turn record.
 *
 * A turn's position is one row: the step whose messages committed, the
 * continuations it has spent, and the tool calls the current step has not
 * settled. These tests drive the loop through a real step boundary and
 * assert the row that boundary wrote, then restart the whole process over
 * the same database and assert the turn finishes without re-running a tool
 * whose result already committed.
 */
describe("turn record", () => {
  it.scopedLive(
    "a child-shaped turn recovered after a restart keeps its agent, denied tools and run spec",
    () =>
      Effect.gen(function* () {
        resetProbe()
        const tempDir = yield* makeTempDirectoryScoped("gent-turn-admission-")
        const dbPath = `${tempDir}/gent.db`
        const sessionId = SessionId.make("admission-recovery-session")
        const branchId = BranchId.make("admission-recovery-branch")
        const addendum = "CHILD-ADDENDUM-SURVIVES-RESTART"
        const runSpec = {
          overrides: { deniedTools: ["resume_probe"], systemPromptAddendum: addendum },
        }
        type SeenRequest = { readonly tools: ReadonlyArray<string>; readonly prompt: string }
        const seenRequest = (options: LanguageModel.ProviderOptions): SeenRequest => ({
          tools: options.tools.map((entry) => entry.name),
          prompt: promptText(options.prompt),
        })
        const layerFor = (providerLayer: Layer.Layer<LanguageModel.LanguageModel>) =>
          createE2ELayer({
            agents: [...testAgents, helperAgent],
            providerLayer,
            extensions: [ResumeProbeExtension],
            storagePath: dbPath,
          })

        // First process: the child turn is admitted and its first model call
        // hangs. The process dies there, before the turn completes.
        const firstRequests = yield* Ref.make<ReadonlyArray<SeenRequest>>([])
        const firstCalled = yield* Deferred.make<void>()
        const firstProvider = LanguageModelLayers.testStream((options) =>
          Effect.gen(function* () {
            yield* Ref.update(firstRequests, (seen) => [...seen, seenRequest(options)])
            yield* Deferred.succeed(firstCalled, void 0)
            return Stream.never
          }),
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            const agentLoop = yield* makeAgentLoopService
            yield* submitAgentLoop(
              agentLoop,
              makeMessage(sessionId, branchId, "child task before restart"),
              { agent: helperAgent.name, runSpec },
            )
            yield* Deferred.await(firstCalled)
          }).pipe(Effect.provide(layerFor(firstProvider)), Effect.timeout("10 seconds")),
        )

        // Second process: opening the branch resumes the cut turn. It must run
        // under the same admission, not as the default agent.
        const secondRequests = yield* Ref.make<ReadonlyArray<SeenRequest>>([])
        const secondProvider = LanguageModelLayers.testStream((options) =>
          Ref.update(secondRequests, (seen) => [...seen, seenRequest(options)]).pipe(
            Effect.as(
              Stream.fromIterable([
                textDeltaPart("resumed child answer"),
                finishPart({ finishReason: "stop" }),
              ] satisfies LanguageModelStreamPart[]),
            ),
          ),
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            const agentLoop = yield* makeAgentLoopService
            yield* agentLoop.getState({ sessionId, branchId })
            yield* waitForOption(
              () =>
                Ref.get(secondRequests).pipe(
                  Effect.map((seen) => Option.liftPredicate(seen, (all) => all.length > 0)),
                ),
              "the recovered turn called the model",
            )
            // The agent picks the model: the child's agent, not the default one.
            const eventStorage = yield* EventStorage
            const streamModel = yield* waitForOption(
              () =>
                eventStorage
                  .listEvents({ sessionId, branchId })
                  .pipe(
                    Effect.map((envelopes) =>
                      Option.fromUndefinedOr(
                        envelopes
                          .map(({ event }) => event)
                          .find(
                            (event) =>
                              event._tag === "StreamEnded" && Predicate.isNotUndefined(event.model),
                          ),
                      ),
                    ),
                  ),
              "the recovered step ended",
            )
            expect(streamModel._tag === "StreamEnded" && streamModel.model).toBe(helperAgent.model)
          }).pipe(Effect.provide(layerFor(secondProvider)), Effect.timeout("10 seconds")),
        )

        const [before] = yield* Ref.get(firstRequests)
        const [after] = yield* Ref.get(secondRequests)
        // The first process ran the child as admitted: the control case.
        expect(before?.tools).not.toContain("resume_probe")
        expect(before?.prompt).toContain(addendum)
        // The recovered turn keeps the child's run spec: the denied tool stays
        // denied, and the child's prompt addendum is still there.
        expect(after?.tools).not.toContain("resume_probe")
        expect(after?.prompt).toContain(addendum)
      }),
    40_000,
  )

  it.scopedLive(
    "a recovered turn whose agent was removed settles with an error that names the agent",
    () =>
      Effect.gen(function* () {
        resetProbe()
        const tempDir = yield* makeTempDirectoryScoped("gent-turn-removed-agent-")
        const dbPath = `${tempDir}/gent.db`
        const sessionId = SessionId.make("removed-agent-session")
        const branchId = BranchId.make("removed-agent-branch")
        const layerFor = (
          providerLayer: Layer.Layer<LanguageModel.LanguageModel>,
          agents: ReadonlyArray<AgentDefinition>,
        ) =>
          createE2ELayer({
            agents,
            providerLayer,
            extensions: [ResumeProbeExtension],
            storagePath: dbPath,
          })

        // First process: a turn under the helper agent is cut mid-call.
        const firstCalled = yield* Deferred.make<void>()
        const firstProvider = LanguageModelLayers.testStream(() =>
          Deferred.succeed(firstCalled, void 0).pipe(Effect.as(Stream.never)),
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            const agentLoop = yield* makeAgentLoopService
            yield* submitAgentLoop(
              agentLoop,
              makeMessage(sessionId, branchId, "work under the helper"),
              { agent: helperAgent.name },
            )
            yield* Deferred.await(firstCalled)
          }).pipe(
            Effect.provide(layerFor(firstProvider, [...testAgents, helperAgent])),
            Effect.timeout("10 seconds"),
          ),
        )

        // Second process: the helper definition is gone. The turn must end,
        // and say why, instead of staying unanswered.
        const secondProvider = LanguageModelLayers.testStream(() =>
          Effect.succeed(
            Stream.fromIterable([
              textDeltaPart("should not run"),
              finishPart({ finishReason: "stop" }),
            ] satisfies LanguageModelStreamPart[]),
          ),
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            const agentLoop = yield* makeAgentLoopService
            yield* agentLoop.getState({ sessionId, branchId })
            const eventStorage = yield* EventStorage
            const events = yield* waitForOption(
              () =>
                eventStorage.listEvents({ sessionId, branchId }).pipe(
                  Effect.map((envelopes) =>
                    Option.liftPredicate(
                      envelopes.map(({ event }) => event),
                      (all) => all.some((event) => event._tag === "TurnCompleted"),
                    ),
                  ),
                ),
              "the recovered turn settled",
            )
            const errors = events.flatMap((event) => {
              if (event._tag !== "ErrorOccurred") return []
              return [event.error]
            })
            expect(errors.some((error) => error.includes(helperAgent.name))).toBe(true)
            const completed = events.filter((event) => event._tag === "TurnCompleted")
            expect(completed.every((event) => event.unanswered === true)).toBe(true)
          }).pipe(
            Effect.provide(layerFor(secondProvider, testAgents)),
            Effect.timeout("10 seconds"),
          ),
        )
      }),
    40_000,
  )

  it.scopedLive(
    "a recovered dispatching call whose agent was removed settles the turn with that error",
    () =>
      Effect.gen(function* () {
        resetProbe()
        const tempDir = yield* makeTempDirectoryScoped("gent-turn-removed-agent-tool-")
        const dbPath = `${tempDir}/gent.db`
        const sessionId = SessionId.make("removed-agent-tool-session")
        const branchId = BranchId.make("removed-agent-tool-branch")
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        probe.gate = Option.some({ label: "held", entered, release })
        const layerFor = (
          providerLayer: Layer.Layer<LanguageModel.LanguageModel>,
          agents: ReadonlyArray<AgentDefinition>,
        ) =>
          createE2ELayer({
            agents,
            providerLayer,
            extensions: [DispatchProbeExtension],
            storagePath: dbPath,
          })

        // First process: the helper's step calls the dispatching tool, which
        // holds. The process dies with the call pending.
        const firstProvider = yield* LanguageModelLayers.sequence([
          toolCallStep("dispatch_probe", { label: "held" }),
        ])
        yield* Effect.scoped(
          Effect.gen(function* () {
            const agentLoop = yield* makeAgentLoopService
            yield* submitAgentLoop(
              agentLoop,
              makeMessage(sessionId, branchId, "dispatch under the helper"),
              { agent: helperAgent.name },
            )
            yield* Deferred.await(entered)
          }).pipe(
            Effect.provide(layerFor(firstProvider.layer, [...testAgents, helperAgent])),
            Effect.timeout("10 seconds"),
          ),
        )
        probe.gate = Option.none()

        // Second process: the helper is gone. Recovery must still end the
        // turn, name the agent, and leave no call without a result.
        const secondProvider = yield* LanguageModelLayers.sequence([])
        yield* Effect.scoped(
          Effect.gen(function* () {
            const agentLoop = yield* makeAgentLoopService
            yield* agentLoop.getState({ sessionId, branchId })
            const eventStorage = yield* EventStorage
            const events = yield* waitForOption(
              () =>
                eventStorage.listEvents({ sessionId, branchId }).pipe(
                  Effect.map((envelopes) =>
                    Option.liftPredicate(
                      envelopes.map(({ event }) => event),
                      (all) => all.some((event) => event._tag === "TurnCompleted"),
                    ),
                  ),
                ),
              "the recovered turn settled",
            )
            const errors = events.flatMap((event) => {
              if (event._tag !== "ErrorOccurred") return []
              return [event.error]
            })
            expect(errors.some((error) => error.includes(helperAgent.name))).toBe(true)
            const messageStorage = yield* MessageStorage
            const results = (yield* messageStorage.listMessages(branchId))
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "tool-result")
            expect(results).toHaveLength(1)
          }).pipe(
            Effect.provide(layerFor(secondProvider.layer, testAgents)),
            Effect.timeout("10 seconds"),
          ),
        )
      }),
    40_000,
  )

  it.scopedLive(
    "records the completed step for a turn that answered after a tool call",
    () =>
      Effect.gen(function* () {
        resetProbe()
        const tempDir = yield* makeTempDirectoryScoped("gent-turn-record-")
        const dbPath = `${tempDir}/gent.db`
        const provider = yield* LanguageModelLayers.sequence([
          toolCallStep("resume_probe", { label: "one" }),
          textStep("DONE-AFTER-TOOL"),
        ])
        const { client } = yield* createRpcClient(
          createE2ELayer({
            agents: e2ePreset.agents,
            providerLayer: provider.layer,
            extensions: [ResumeProbeExtension],
            storagePath: dbPath,
          }),
        )
        const { sessionId, branchId } = yield* client.session.create({})
        // The turn is done only when `TurnCompleted` lands: the reply text is
        // durable before the final step boundary writes the record.
        const completed = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.filter(({ event }) => event._tag === "TurnCompleted"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        )
        yield* client.message.send({ sessionId, branchId, content: "run the probe" })
        yield* Fiber.join(completed)
        const messages = yield* client.message.list({ branchId })
        const messageId = openingTurnMessageId(messages)
        expect(Option.isSome(messageId)).toBe(true)

        const record = yield* readTurnRecordRow({
          dbPath,
          sessionId,
          branchId,
          messageId: Option.getOrElse(messageId, () => ""),
        })
        // Two steps ran: the tool call and the answer. Both closed.
        expect(record.step).toBe(2)
        expect(record.pendingToolCalls).toEqual([])
        expect(record.continuations).toBe(0)
        expect(probe.runs).toBe(1)
      }).pipe(Effect.timeout("20 seconds")),
    40_000,
  )

  it.scopedLive(
    "a row behind its messages never moves the turn below a step with no assistant message",
    () =>
      Effect.gen(function* () {
        resetProbe()
        const tempDir = yield* makeTempDirectoryScoped("gent-turn-position-")
        const dbPath = `${tempDir}/gent.db`
        const finalReply = "RESUMED-AFTER-GAP"
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        probe.gate = Option.some({ label: "late", entered, release })

        // First process: step 1 writes nothing (no assistant message) and is
        // re-prompted; step 2 calls the probe, which holds. The process dies.
        const firstProvider = yield* LanguageModelLayers.sequence([
          {
            parts: [
              finishPart({ finishReason: "stop", usage: { inputTokens: 10, outputTokens: 0 } }),
            ],
          },
          toolCallStep("resume_probe", { label: "late" }),
        ])
        const started = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(
              createE2ELayer({
                agents: e2ePreset.agents,
                providerLayer: firstProvider.layer,
                extensions: [ResumeProbeExtension],
                storagePath: dbPath,
              }),
            )
            const { sessionId, branchId } = yield* client.session.create({})
            yield* client.message
              .send({ sessionId, branchId, content: "gap then probe" })
              .pipe(Effect.forkScoped)
            yield* Deferred.await(entered)
            return { sessionId, branchId }
          }).pipe(Effect.timeout("10 seconds")),
        )
        probe.gate = Option.none()

        // The crash window: step 2's messages are durable, the row still
        // names step 1 with nothing pending.
        yield* Effect.sync(() => {
          const db = new Database(dbPath)
          db.run(
            "UPDATE turn_records SET step = 1, pending_tool_calls_json = '[]' WHERE session_id = ? AND branch_id = ?",
            [started.sessionId, started.branchId],
          )
          db.close()
        })

        // Second process: the turn resumes at step 2's pending call, not at a
        // position below the row.
        const secondProvider = yield* LanguageModelLayers.sequence([textStep(finalReply)])
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(
              createE2ELayer({
                agents: e2ePreset.agents,
                providerLayer: secondProvider.layer,
                extensions: [ResumeProbeExtension],
                storagePath: dbPath,
              }),
            )
            yield* client.session.getSnapshot({
              sessionId: started.sessionId,
              branchId: started.branchId,
            })
            yield* client.message.send({
              sessionId: started.sessionId,
              branchId: started.branchId,
              content: "continue",
            })
            yield* waitFor(
              client.message.list({ branchId: started.branchId }),
              (messages) =>
                messages.some((message) =>
                  message.parts.some(
                    (part) => part.type === "text" && part.text.includes(finalReply),
                  ),
                ),
              15_000,
              "resumed turn produced its reply",
            )
            yield* secondProvider.controls.assertDone
          }).pipe(Effect.timeout("20 seconds")),
        )
      }).pipe(Effect.timeout("40 seconds")),
    60_000,
  )

  it.scopedLive(
    "finishes an interrupted turn from the record without re-running a settled tool",
    () =>
      Effect.gen(function* () {
        resetProbe()
        const tempDir = yield* makeTempDirectoryScoped("gent-turn-resume-")
        const dbPath = `${tempDir}/gent.db`
        const finalReply = "RESUMED-REPLY"

        // First process: the tool call settles, then the model is asked
        // again. The scope closes while that second call is gated, so the
        // turn never finalizes.
        const firstProvider = yield* LanguageModelLayers.sequence([
          toolCallStep("resume_probe", { label: "first" }),
          { ...textStep("never emitted"), gated: true },
        ])
        const started = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(
              createE2ELayer({
                agents: e2ePreset.agents,
                providerLayer: firstProvider.layer,
                extensions: [ResumeProbeExtension],
                storagePath: dbPath,
              }),
            )
            const { sessionId, branchId } = yield* client.session.create({})
            yield* client.message
              .send({ sessionId, branchId, content: "run the resume probe" })
              .pipe(Effect.forkScoped)
            yield* firstProvider.controls.waitForCall(1)
            return { sessionId, branchId }
          }).pipe(Effect.timeout("10 seconds")),
        )
        expect(probe.runs).toBe(1)

        // Second process: the same database, a model that only answers. The
        // settled tool call must not run a second time.
        const secondProvider = yield* LanguageModelLayers.sequence([textStep(finalReply)])
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(
              createE2ELayer({
                agents: e2ePreset.agents,
                providerLayer: secondProvider.layer,
                extensions: [ResumeProbeExtension],
                storagePath: dbPath,
              }),
            )
            yield* client.message.send({
              sessionId: started.sessionId,
              branchId: started.branchId,
              content: "continue",
            })
            yield* waitFor(
              client.message.list({ branchId: started.branchId }),
              (messages) =>
                messages.some((message) =>
                  message.parts.some(
                    (part) => part.type === "text" && part.text.includes(finalReply),
                  ),
                ),
              15_000,
              "resumed turn produced its reply",
            )
          }).pipe(Effect.timeout("20 seconds")),
        )

        expect(probe.runs).toBe(1)
      }),
    60_000,
  )

  it.scopedLive(
    "replays the settled half of a cut step instead of running that tool again",
    () =>
      Effect.gen(function* () {
        resetProbe()
        const tempDir = yield* makeTempDirectoryScoped("gent-turn-partial-")
        const dbPath = `${tempDir}/gent.db`
        const finalReply = "PARTIAL-RESUMED"

        // One step, two calls. "slow" blocks, so the step's tool-result
        // message never commits; "fast" finishes and its terminal event does.
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        probe.gate = Option.some({ label: "slow", entered, release })

        const firstProvider = yield* LanguageModelLayers.sequence([
          multiToolCallStep(
            { toolName: "resume_probe", input: { label: "fast" } },
            { toolName: "resume_probe", input: { label: "slow" } },
          ),
        ])
        const started = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(
              createE2ELayer({
                agents: e2ePreset.agents,
                providerLayer: firstProvider.layer,
                extensions: [ResumeProbeExtension],
                storagePath: dbPath,
              }),
            )
            const { sessionId, branchId } = yield* client.session.create({})
            yield* client.message
              .send({ sessionId, branchId, content: "run both probes" })
              .pipe(Effect.forkScoped)
            yield* Deferred.await(entered)
            // "fast" settled; wait for its terminal event to be durable.
            yield* waitFor(
              client.session.getSnapshot({ sessionId, branchId }),
              () => probeRunsFor("fast") >= 1,
              10_000,
              "the fast probe settled",
            )
            return { sessionId, branchId }
          }).pipe(Effect.timeout("15 seconds")),
        )

        // Release the blocked call and restart: the loop must replay "fast".
        probe.gate = Option.none()
        yield* Deferred.succeed(release, void 0)

        const secondProvider = yield* LanguageModelLayers.sequence([textStep(finalReply)])
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(
              createE2ELayer({
                agents: e2ePreset.agents,
                providerLayer: secondProvider.layer,
                extensions: [ResumeProbeExtension],
                storagePath: dbPath,
              }),
            )
            yield* client.message.send({
              sessionId: started.sessionId,
              branchId: started.branchId,
              content: "continue",
            })
            yield* waitFor(
              client.message.list({ branchId: started.branchId }),
              (messages) =>
                messages.some((message) =>
                  message.parts.some(
                    (part) => part.type === "text" && part.text.includes(finalReply),
                  ),
                ),
              15_000,
              "resumed turn produced its reply",
            )
          }).pipe(Effect.timeout("20 seconds")),
        )

        // "fast" settled durably in the first process; it must not run twice.
        expect(probeRunsFor("fast")).toBe(1)
      }),
    60_000,
  )

  it.scopedLive(
    "trusts the messages over a record left behind by a crash mid-step",
    () =>
      Effect.gen(function* () {
        resetProbe()
        const tempDir = yield* makeTempDirectoryScoped("gent-turn-stale-")
        const dbPath = `${tempDir}/gent.db`
        const finalReply = "STALE-RECORD-RESUMED"

        // First process: step 1 completes a tool call and closes. Step 2 issues
        // a second call whose messages commit before the gate holds it open.
        const firstProvider = yield* LanguageModelLayers.sequence([
          toolCallStep("resume_probe", { label: "first" }),
          toolCallStep("resume_probe", { label: "settled" }),
          { ...textStep("never emitted"), gated: true },
        ])
        const started = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(
              createE2ELayer({
                agents: e2ePreset.agents,
                providerLayer: firstProvider.layer,
                extensions: [ResumeProbeExtension],
                storagePath: dbPath,
              }),
            )
            const { sessionId, branchId } = yield* client.session.create({})
            yield* client.message
              .send({ sessionId, branchId, content: "run the probe" })
              .pipe(Effect.forkScoped)
            yield* firstProvider.controls.waitForCall(2)
            yield* waitFor(
              client.session.getSnapshot({ sessionId, branchId }),
              () => probeRunsFor("settled") >= 1,
              10_000,
              "the second step's tool call settled",
            )
            return { sessionId, branchId }
          }).pipe(Effect.timeout("15 seconds")),
        )
        expect(probeRunsFor("settled")).toBe(1)

        // Stage the crash window. The record is written after the step's
        // messages, in its own transaction, so a crash in between leaves step
        // 2's assistant message durable while the row still names step 1 with
        // nothing pending. Rewind the row to exactly that state.
        yield* Effect.sync(() => {
          const db = new Database(dbPath)
          db.query(
            "UPDATE turn_records SET step = 1, pending_tool_calls_json = '[]' WHERE session_id = ? AND branch_id = ?",
          ).run(started.sessionId, started.branchId)
          db.close()
        })

        // Second process: the stale row says step 1 with nothing pending. If
        // the resolver believes it, the turn re-issues the step whose tool call
        // already ran, and the probe fires a second time.
        const secondProvider = yield* LanguageModelLayers.sequence([textStep(finalReply)])
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(
              createE2ELayer({
                agents: e2ePreset.agents,
                providerLayer: secondProvider.layer,
                extensions: [ResumeProbeExtension],
                storagePath: dbPath,
              }),
            )
            yield* client.message.send({
              sessionId: started.sessionId,
              branchId: started.branchId,
              content: "continue",
            })
            yield* waitFor(
              client.message.list({ branchId: started.branchId }),
              (messages) =>
                messages.some((message) =>
                  message.parts.some(
                    (part) => part.type === "text" && part.text.includes(finalReply),
                  ),
                ),
              15_000,
              "resumed turn produced its reply",
            )
          }).pipe(Effect.timeout("20 seconds")),
        )

        expect(probeRunsFor("settled")).toBe(1)
      }),
    60_000,
  )
})

// ── tool binding replay ─────────────────────────────────────────────────────

class ReplayResource extends Context.Service<ReplayResource, { readonly value: string }>()(
  "@gent/core/tests/runtime/turn.test/ReplayResource",
) {}

const replayCases = [
  {
    name: "same-process capability",
    durable: false,
    saved: false,
    local: true,
    changed: false,
    reason: "",
  },
  {
    name: "missing process binding",
    durable: false,
    saved: false,
    local: false,
    changed: false,
    reason: "MissingBinding",
  },
  {
    name: "matching durable identity",
    durable: true,
    saved: true,
    local: false,
    changed: false,
    reason: "",
  },
  {
    name: "absent durable row with local identity",
    durable: true,
    saved: false,
    local: true,
    changed: false,
    reason: "MissingBinding",
  },
  {
    name: "changed durable source",
    durable: true,
    saved: true,
    local: true,
    changed: true,
    reason: "SourceMismatch",
  },
]

const makeTool = (reply = "ok"): ToolCapability =>
  tool({
    id: "replay_tool",
    description: "Replay test tool",
    params: Schema.Struct({ value: Schema.String }),
    output: Schema.String,
    execute: (_params: { readonly value: string }) =>
      Effect.gen(function* () {
        yield* ExtensionContext
        return reply
      }),
  })

const makeExtension = (toolCapability: ToolCapability): LoadedExtension => ({
  manifest: { id: ExtensionId.make("@test/replay-extension") },
  scope: "builtin",
  sourcePath: "/test/replay-extension",
  artifactIdentity: LoadedArtifactIdentity.make("replay-artifact-1"),
  contributions: { tools: [toolCapability] },
})

const makeBinding = () =>
  ToolBindingIdentity.make({
    toolId: ToolId.make("replay_tool"),
    extensionId: ExtensionId.make("@test/replay-extension"),
    source: ToolBindingSource.cases.Static.make({
      sourceRevision: ToolSourceRevision.make("source/legacy"),
    }),
    schemaRevision: ToolSchemaRevision.make("schema/legacy"),
  })

describe("tool binding replay", () => {
  const bindingLayerFor = (extensions: ReadonlyArray<LoadedExtension>) =>
    Layer.mergeAll(
      ExtensionRegistry.fromResolved(resolveExtensions(extensions)),
      ToolRunner.Live.pipe(Layer.provide(BunServices.layer)),
      GentPlatform.Test(),
    )

  it.scopedLive("a same-id project tool cannot replay a builtin artifact's binding", () =>
    Effect.gen(function* () {
      const builtin = makeExtension(makeTool())
      const projectTool = makeTool("changed project implementation")
      const project: LoadedExtension = {
        manifest: builtin.manifest,
        scope: "project",
        sourcePath: "/project/.gent/extensions/replay.ts",
        contributions: { tools: [projectTool] },
      }
      const original = yield* captureCurrentToolBinding("replay_tool").pipe(
        Effect.provide(bindingLayerFor([builtin])),
      )
      if (Option.isNone(original) || Predicate.isUndefined(original.value.binding))
        return yield* Effect.die("Missing builtin fixture identity")
      const binding = original.value.binding
      yield* Effect.gen(function* () {
        const selected = yield* captureCurrentToolBinding("replay_tool")
        if (Option.isNone(selected)) return yield* Effect.die("Missing selected project tool")
        expect(selected.value.capability).toBe(projectTool)
        const refused = yield* resolveStoredToolBinding({
          sessionId: SessionId.make("same-id-project-replay"),
          assistantMessageId: MessageId.make("same-id-project-outer"),
          toolCallId: ToolCallId.make("same-id-project-operation"),
          binding,
        }).pipe(Effect.exit)
        expect(Exit.isFailure(refused)).toBe(true)
        if (Exit.isFailure(refused)) {
          expect(Cause.squash(refused.cause)).toMatchObject({
            _tag: "ToolBindingReplayError",
            reason: "MissingSourceIdentity",
          })
        }
        expect(selected.value.binding).toBeUndefined()
      }).pipe(Effect.provide(bindingLayerFor([builtin, project])))
    }).pipe(Effect.timeout("5 seconds")),
  )

  it.scopedLive("a same-id extension with another tool preserves the builtin tool's identity", () =>
    Effect.gen(function* () {
      const builtinTool = makeTool()
      const builtin = makeExtension(builtinTool)
      const other = tool({
        id: "another_replay_tool",
        description: "A different project tool",
        params: Schema.Struct({}),
        output: Schema.String,
        execute: () => Effect.succeed("project"),
      })
      const project: LoadedExtension = {
        manifest: builtin.manifest,
        scope: "project",
        sourcePath: "/project/.gent/extensions/another.ts",
        contributions: { tools: [other] },
      }
      const original = yield* captureCurrentToolBinding("replay_tool").pipe(
        Effect.provide(bindingLayerFor([builtin])),
      )
      if (Option.isNone(original) || Predicate.isUndefined(original.value.binding))
        return yield* Effect.die("Missing builtin fixture identity")
      const binding = original.value.binding
      const selected = yield* resolveStoredToolBinding({
        sessionId: SessionId.make("same-id-other-replay"),
        assistantMessageId: MessageId.make("same-id-other-outer"),
        toolCallId: ToolCallId.make("same-id-other-operation"),
        binding,
      }).pipe(Effect.provide(bindingLayerFor([builtin, project])))
      expect(selected.capability).toBe(builtinTool)
      expect(selected.binding).toEqual(binding)
    }).pipe(Effect.timeout("5 seconds")),
  )

  it.scopedLive(
    "validates an inner operation binding without an assistant tool-call storage row",
    () =>
      Effect.gen(function* () {
        const capability = makeTool()
        const layer = Layer.mergeAll(
          ExtensionRegistry.fromResolved(resolveExtensions([makeExtension(capability)])),
          ToolRunner.Live.pipe(Layer.provide(BunServices.layer)),
          GentPlatform.Test(),
        )
        const context = yield* Layer.build(layer)
        yield* Effect.gen(function* () {
          const sessionId = SessionId.make("inner-operation-session")
          const current = yield* captureCurrentToolBinding("replay_tool")
          if (Option.isNone(current) || Predicate.isUndefined(current.value.binding))
            return yield* Effect.die("Missing fixture binding")
          const binding = current.value.binding
          const address = {
            sessionId,
            assistantMessageId: MessageId.make("outer-cell-message"),
            toolCallId: ToolCallId.make("inner-operation-call"),
          }
          const resolved = yield* resolveStoredToolBinding({ ...address, binding })
          expect(resolved.capability).toBe(capability)
          const changed = yield* resolveStoredToolBinding({
            ...address,
            binding: ToolBindingIdentity.make({
              ...binding,
              source: ToolBindingSource.cases.Static.make({
                sourceRevision: ToolSourceRevision.make("changed-source"),
              }),
            }),
          }).pipe(Effect.flip)
          expect(changed.reason).toBe("SourceMismatch")
          expect(changed.toolCallId).toBe(address.toolCallId)
        }).pipe(Effect.provideContext(context))
      }),
  )

  for (const scenario of replayCases) {
    it.scopedLive(`resolves ${scenario.name} through real storage and tool capture`, () =>
      Effect.gen(function* () {
        const capability = makeTool()
        const declared = defineExtension({
          id: "@test/replay-extension",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register("tool", capability)
            yield* host.register(
              "resource",
              defineResource({
                id: "test/replay-policy-resource",
                scope: "process",
                layer: Layer.succeed(ReplayResource, ReplayResource.of({ value: "live" })),
              }),
            )
          }),
        })
        let extension = declared
        if (scenario.durable) {
          extension = {
            ...declared,
            artifactIdentity: LoadedArtifactIdentity.make("replay-artifact-1"),
          }
        }
        const layer = Layer.merge(
          createE2ELayer({
            agents: [],
            extensionInputs: [extension],
            providerLayer: LanguageModelLayers.debug(),
          }),
          ProcessLocalToolReplay.Live,
        )
        yield* Effect.gen(function* () {
          const sessionId = SessionId.make("replay-policy-session")
          const branchId = BranchId.make("replay-policy-branch")
          const assistantMessageId = MessageId.make("replay-policy-assistant")
          const toolCallId = ToolCallId.make("replay-policy-call")
          const address = { sessionId, branchId, assistantMessageId, toolCallId }
          const toolCall = Prompt.toolCallPart({
            id: toolCallId,
            name: "replay_tool",
            params: { value: "input" },
            providerExecuted: false,
          })
          yield* ensureStorageParents({ sessionId, branchId })
          const messages = yield* MessageStorage
          yield* messages.createMessage(
            Message.cases.regular.make({
              id: assistantMessageId,
              sessionId,
              branchId,
              role: "assistant",
              parts: [toolCall],
              createdAt: dateFromMillis(0),
            }),
          )
          const cache = yield* SessionProfileCache
          const profile = yield* cache.resolve((yield* RuntimeEnvironment).cwd)
          const current = yield* captureCurrentToolBinding(toolCall.name)
          if (Option.isNone(current)) return yield* Effect.die("Expected captured capability")
          const replay = yield* ProcessLocalToolReplay
          const key = processLocalReplayBindingKey(address)
          if (scenario.local) {
            yield* replay.setBinding(key, { entry: current.value })
          }
          if (scenario.saved) {
            const storage = yield* ToolCallBindingStorage
            let binding = current.value.binding
            if (Predicate.isUndefined(binding))
              return yield* Effect.die("Expected durable identity")
            if (scenario.changed)
              binding = ToolBindingIdentity.make({
                ...binding,
                source: ToolBindingSource.cases.Static.make({
                  sourceRevision: ToolSourceRevision.make("old-source"),
                }),
              })
            yield* storage.save({ ...address, binding })
          }
          const result = yield* resolveReplayToolBinding({
            ...address,
            toolCall,
            generationId: profile.generationId,
          }).pipe(Effect.exit)
          if (Exit.isSuccess(result)) {
            expect(scenario.reason).toBe("")
            expect(result.value.capability).toBe(capability)
            return
          }
          expect(Cause.squash(result.cause)).toMatchObject({
            _tag: "ToolBindingReplayError",
            reason: scenario.reason,
          })
          expect(Option.isNone(yield* replay.getBinding(key))).toBe(true)
        }).pipe(Effect.provide(layer))
      }).pipe(Effect.timeout("5 seconds")),
    )
  }

  it.scopedLive("resumes a process-local binding only inside its live process", () =>
    Effect.gen(function* () {
      const capability = makeTool()
      const extension = defineExtension({
        id: "@test/replay-extension",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register("tool", capability)
        }),
      })
      const layer = Layer.merge(
        createE2ELayer({
          agents: [],
          extensionInputs: [extension],
          providerLayer: LanguageModelLayers.debug(),
        }),
        ProcessLocalToolReplay.Live,
      )
      yield* Effect.gen(function* () {
        const sessionId = SessionId.make("process-local-session")
        const address = {
          sessionId,
          assistantMessageId: MessageId.make("process-local-assistant"),
          toolCallId: ToolCallId.make("process-local-call"),
        }
        const cache = yield* SessionProfileCache
        const profile = yield* cache.resolve((yield* RuntimeEnvironment).cwd)
        const generationId = profile.generationId
        const current = yield* captureCurrentToolBinding("replay_tool")
        if (Option.isNone(current)) return yield* Effect.die("Expected captured capability")
        // A source-loaded extension has no build artifact, so no durable identity.
        expect(current.value.binding).toBeUndefined()
        expect(Option.isNone(yield* innerOperationBindingIdentity(current.value))).toBe(true)
        const identity = yield* innerOperationBindingIdentity(current.value, generationId)
        if (Option.isNone(identity)) return yield* Effect.die("Expected process-local identity")
        expect(identity.value.source).toEqual({
          _tag: "ProcessLocal",
          sourceRevision: ToolSourceRevision.make(`process:${generationId}`),
        })

        const live = yield* resolveStoredToolBinding({
          ...address,
          binding: identity.value,
          generationId,
        })
        expect(live.capability).toBe(capability)

        const retired = yield* resolveStoredToolBinding({
          ...address,
          binding: ToolBindingIdentity.make({
            ...identity.value,
            source: ToolBindingSource.cases.ProcessLocal.make({
              sourceRevision: ToolSourceRevision.make("process:retired-process"),
            }),
          }),
          generationId,
        }).pipe(Effect.flip)
        expect(retired).toMatchObject({ _tag: "ToolBindingReplayError", reason: "SourceMismatch" })

        const withoutProcess = yield* resolveStoredToolBinding({
          ...address,
          binding: identity.value,
        }).pipe(Effect.flip)
        expect(withoutProcess).toMatchObject({
          _tag: "ToolBindingReplayError",
          reason: "SourceMismatch",
        })
      }).pipe(Effect.provide(layer))
    }).pipe(Effect.timeout("5 seconds")),
  )

  it.live("does not backfill a binding on an existing assistant message", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("binding-replay-existing-session")
      const branchId = BranchId.make("binding-replay-existing-branch")
      const messageId = MessageId.make("binding-replay-existing-message")
      const toolCallId = ToolCallId.make("binding-replay-existing-call")
      yield* ensureStorageParents({ sessionId, branchId })
      const messages = yield* MessageStorage
      const bindingStorage = yield* ToolCallBindingStorage
      const storageTransaction = yield* makeStorageTransaction
      const toolCallPart = Prompt.toolCallPart({
        id: toolCallId,
        name: "replay_tool",
        params: { value: "legacy" },
        providerExecuted: false,
      })
      const message = Message.cases.regular.make({
        id: messageId,
        sessionId,
        branchId,
        role: "assistant",
        parts: [toolCallPart],
        createdAt: dateFromMillis(1_767_225_600_000),
      })
      yield* messages.createMessage(message)
      const capability = makeTool()
      const entry = {
        extensionId: ExtensionId.make("@test/replay-extension"),
        capability,
        binding: makeBinding(),
      } satisfies ResolvedToolCapability

      yield* persistAssistantPartsWithBindings({
        sessionId,
        branchId,
        messageId,
        parts: [toolCallPart],
        toolBindings: new Map([["replay_tool", entry]]),
        storageTransaction,
      })

      expect(
        yield* bindingStorage.get({
          sessionId,
          branchId,
          assistantMessageId: messageId,
          toolCallId,
        }),
      ).toBeUndefined()
    }).pipe(Effect.provide(Layer.mergeAll(testSqliteStorage(Layer.empty, {}), EventStore.Memory))),
  )
  it.live("replays the structured terminal result for the current assistant only", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("binding-replay-result-session")
      const branchId = BranchId.make("binding-replay-result-branch")
      const oldAssistantId = MessageId.make("binding-replay-result-old-assistant")
      const assistantId = MessageId.make("binding-replay-result-assistant")
      const toolCallId = ToolCallId.make("binding-replay-result-call")
      const toolCall = Prompt.toolCallPart({
        id: toolCallId,
        name: "replay_tool",
        params: { value: "current" },
        providerExecuted: false,
      })
      yield* ensureStorageParents({ sessionId, branchId })
      const makeAssistant = (id: MessageId, value: string) =>
        Message.cases.regular.make({
          id,
          sessionId,
          branchId,
          role: "assistant",
          parts: [
            Prompt.toolCallPart({
              id: toolCallId,
              name: "replay_tool",
              params: { value },
              providerExecuted: false,
            }),
          ],
          createdAt: dateFromMillis(1_767_225_600_000),
        })
      const eventStorage = yield* EventStorage
      yield* eventStorage.appendEvent(
        MessageReceived.make({ message: makeAssistant(oldAssistantId, "old") }),
      )
      yield* eventStorage.appendEvent(
        ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId,
          toolName: "replay_tool",
          output: "old display",
          resultJson: encodeToolOutput({ value: "old" }),
        }),
      )
      yield* eventStorage.appendEvent(
        MessageReceived.make({ message: makeAssistant(assistantId, "current") }),
      )
      yield* eventStorage.appendEvent(
        ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId,
          toolName: "replay_tool",
          output: "current display",
          resultJson: encodeToolOutput({ value: "current" }),
        }),
      )
      const results = yield* findPersistedToolResults({
        sessionId,
        branchId,
        assistantMessageId: assistantId,
        toolCalls: [toolCall],
      })
      expect(results.get(toolCallId)?.result).toEqual({ value: "current" })
    }).pipe(Effect.provide(Layer.mergeAll(testSqliteStorage(Layer.empty, {}), EventStore.Memory))),
  )
  it.live("does not replay a terminal result without its assistant anchor", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("binding-replay-result-no-anchor-session")
      const branchId = BranchId.make("binding-replay-result-no-anchor-branch")
      const toolCallId = ToolCallId.make("binding-replay-result-no-anchor-call")
      yield* ensureStorageParents({ sessionId, branchId })
      const eventStorage = yield* EventStorage
      yield* eventStorage.appendEvent(
        ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId,
          toolName: "replay_tool",
          output: "unanchored display",
          resultJson: encodeToolOutput({ value: "unanchored" }),
        }),
      )

      const results = yield* findPersistedToolResults({
        sessionId,
        branchId,
        assistantMessageId: MessageId.make("binding-replay-result-missing-assistant"),
        toolCalls: [
          Prompt.toolCallPart({
            id: toolCallId,
            name: "replay_tool",
            params: { value: "missing" },
            providerExecuted: false,
          }),
        ],
      })
      expect(results.size).toBe(0)
    }).pipe(Effect.provide(Layer.mergeAll(testSqliteStorage(Layer.empty, {}), EventStore.Memory))),
  )
  it.live("stops result replay at the next assistant message", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("binding-replay-result-window-session")
      const branchId = BranchId.make("binding-replay-result-window-branch")
      const assistantId = MessageId.make("binding-replay-result-window-assistant")
      const laterAssistantId = MessageId.make("binding-replay-result-window-later")
      const toolCallId = ToolCallId.make("binding-replay-result-window-call")
      const makeAssistant = (id: MessageId) =>
        Message.cases.regular.make({
          id,
          sessionId,
          branchId,
          role: "assistant",
          parts: [
            Prompt.toolCallPart({
              id: toolCallId,
              name: "replay_tool",
              params: { value: id },
              providerExecuted: false,
            }),
          ],
          createdAt: dateFromMillis(1_767_225_600_000),
        })
      yield* ensureStorageParents({ sessionId, branchId })
      const eventStorage = yield* EventStorage
      yield* eventStorage.appendEvent(MessageReceived.make({ message: makeAssistant(assistantId) }))
      yield* eventStorage.appendEvent(
        ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId,
          toolName: "replay_tool",
          output: "current display",
          resultJson: encodeToolOutput({ value: "current" }),
        }),
      )
      yield* eventStorage.appendEvent(
        MessageReceived.make({ message: makeAssistant(laterAssistantId) }),
      )
      yield* eventStorage.appendEvent(
        ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId,
          toolName: "replay_tool",
          output: "later display",
          resultJson: encodeToolOutput({ value: "later" }),
        }),
      )

      const results = yield* findPersistedToolResults({
        sessionId,
        branchId,
        assistantMessageId: assistantId,
        toolCalls: [
          Prompt.toolCallPart({
            id: toolCallId,
            name: "replay_tool",
            params: { value: "current" },
            providerExecuted: false,
          }),
        ],
      })
      expect(results.get(toolCallId)?.result).toEqual({ value: "current" })
    }).pipe(Effect.provide(Layer.mergeAll(testSqliteStorage(Layer.empty, {}), EventStore.Memory))),
  )
  it.live("rejects a corrupt structured terminal result", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("binding-replay-result-corrupt-session")
      const branchId = BranchId.make("binding-replay-result-corrupt-branch")
      const assistantId = MessageId.make("binding-replay-result-corrupt-assistant")
      const toolCallId = ToolCallId.make("binding-replay-result-corrupt-call")
      const message = Message.cases.regular.make({
        id: assistantId,
        sessionId,
        branchId,
        role: "assistant",
        parts: [
          Prompt.toolCallPart({
            id: toolCallId,
            name: "replay_tool",
            params: { value: "corrupt" },
            providerExecuted: false,
          }),
        ],
        createdAt: dateFromMillis(1_767_225_600_000),
      })
      yield* ensureStorageParents({ sessionId, branchId })
      const eventStorage = yield* EventStorage
      yield* eventStorage.appendEvent(MessageReceived.make({ message }))
      yield* eventStorage.appendEvent(
        ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId,
          toolName: "replay_tool",
          output: "display must not become authoritative",
          resultJson: "{invalid-json",
        }),
      )

      const exit = yield* Effect.exit(
        findPersistedToolResults({
          sessionId,
          branchId,
          assistantMessageId: assistantId,
          toolCalls: [
            Prompt.toolCallPart({
              id: toolCallId,
              name: "replay_tool",
              params: { value: "corrupt" },
              providerExecuted: false,
            }),
          ],
        }),
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const error = Cause.findErrorOption(exit.cause)
        expect(Option.isSome(error) && Schema.is(ToolResultReplayError)(error.value)).toBe(true)
      }
    }).pipe(Effect.provide(Layer.mergeAll(testSqliteStorage(Layer.empty, {}), EventStore.Memory))),
  )
  it.live("isolates process-local replay state between server scopes", () =>
    Effect.scoped(
      Effect.acquireUseRelease(
        Scope.make(),
        (firstScope) =>
          Effect.acquireUseRelease(
            Scope.make(),
            (secondScope) =>
              Effect.gen(function* () {
                const firstContext = yield* Layer.buildWithScope(
                  ProcessLocalToolReplay.Live,
                  firstScope,
                )
                const secondContext = yield* Layer.buildWithScope(
                  ProcessLocalToolReplay.Live,
                  secondScope,
                )
                const first = Context.get(firstContext, ProcessLocalToolReplay)
                const second = Context.get(secondContext, ProcessLocalToolReplay)
                const key = "same-session:same-branch:assistant:call"
                const result = Prompt.toolResultPart({
                  id: "call",
                  name: "replay_tool",
                  result: { value: "first-root" },
                  isFailure: false,
                  providerExecuted: false,
                })

                yield* first.setResults(key, new Map([[result.id, result]]))
                expect((yield* first.getResults(key)).get(result.id)).toEqual(result)
                expect((yield* second.getResults(key)).size).toBe(0)
              }),
            (scope) => Scope.close(scope, Exit.void).pipe(Effect.ignore),
          ),
        (scope) => Scope.close(scope, Exit.void).pipe(Effect.ignore),
      ),
    ),
  )
  it.live("clears process-local replay state when its server scope closes", () =>
    Effect.scoped(
      Effect.acquireUseRelease(
        Scope.make(),
        (scope) =>
          Effect.gen(function* () {
            const context = yield* Layer.buildWithScope(ProcessLocalToolReplay.Live, scope)
            const replay = Context.get(context, ProcessLocalToolReplay)
            const key = "shutdown-session:shutdown-branch:tool-result"
            const result = Prompt.toolResultPart({
              id: "shutdown-call",
              name: "replay_tool",
              result: "result",
              isFailure: false,
              providerExecuted: false,
            })
            yield* replay.setResults(key, new Map([[result.id, result]]))
            return replay
          }),
        (scope) => Scope.close(scope, Exit.void).pipe(Effect.ignore),
      ),
    ).pipe(
      Effect.flatMap((service) =>
        Effect.gen(function* () {
          const results = yield* service.getResults("shutdown-session:shutdown-branch:tool-result")
          expect(results.size).toBe(0)
        }),
      ),
    ),
  )
})

// ── a tool call a restart cut short ─────────────────────────────────────────

describe("a tool call a restart cut short", () => {
  it.scopedLive(
    "is reported to the model as interrupted, and does not run again",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDirectoryScoped("gent-cut-short-")
        const dbPath = `${tempDir}/gent.db`
        const runs = yield* Ref.make(0)
        const running = yield* Deferred.make<void>()
        // The first run never returns: the process stops while it runs.
        const sideEffect = tool({
          id: "side_effect",
          description: "Does something that must not happen twice",
          params: Schema.Struct({}),
          output: Schema.String,
          execute: () =>
            Ref.updateAndGet(runs, (n) => n + 1).pipe(
              Effect.flatMap((n) => {
                if (n > 1) return Effect.succeed("ran again")
                return Deferred.succeed(running, void 0).pipe(Effect.andThen(Effect.never))
              }),
            ),
        })
        // A build identity gives the call a durable binding, as a shipped tool has.
        const extension: LoadedExtension = {
          manifest: { id: ExtensionId.make("@test/cut-short") },
          scope: "builtin",
          sourcePath: "test",
          artifactIdentity: LoadedArtifactIdentity.make("@test/cut-short@artifact-1"),
          contributions: { tools: [sideEffect] },
        }
        const layerFor = (providerLayer: Layer.Layer<LanguageModel.LanguageModel>) =>
          createE2ELayer({
            agents: e2ePreset.agents,
            providerLayer,
            extensions: [extension],
            storagePath: dbPath,
          })

        // First process: the model calls the tool, and the process stops while it runs.
        const target = yield* Effect.scoped(
          Effect.gen(function* () {
            const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
              toolCallStep("side_effect", {}),
            ])
            const { client } = yield* createRpcClient(layerFor(providerLayer))
            const { sessionId, branchId } = yield* client.session.create({})
            yield* client.message.send({ sessionId, branchId, content: "do it once" })
            yield* Deferred.await(running)
            return { sessionId, branchId }
          }),
        )

        // Second process: the turn resumes; the model reads what happened.
        const seen = yield* Ref.make(Option.none<Prompt.Prompt>())
        yield* Effect.scoped(
          Effect.gen(function* () {
            const providerLayer = LanguageModelLayers.testStream((options) =>
              Ref.set(seen, Option.some(Prompt.make(options.prompt))).pipe(
                Effect.as(
                  Stream.fromIterable([
                    textDeltaPart("told it was cut short"),
                    finishPart({ finishReason: "stop" }),
                  ] satisfies LanguageModelStreamPart[]),
                ),
              ),
            )
            const { client } = yield* createRpcClient(layerFor(providerLayer))
            yield* waitFor(
              client.session.getSnapshot(target),
              (snapshot) =>
                snapshot.runtime._tag === "Idle" &&
                hasAssistantText(snapshot.messages, "told it was cut short"),
              5_000,
              "the resumed turn answered",
            )
          }),
        )
        expect(yield* Ref.get(runs)).toBe(1)
        const prompt = Option.getOrThrow(yield* Ref.get(seen))
        const results = prompt.content.flatMap((message) => {
          if (message.role !== "tool") return []
          return message.content.filter((part) => part.type === "tool-result")
        })
        expect(results).toHaveLength(1)
        expect(results[0]?.isFailure).toBe(true)
        // A sibling that finished in memory, or a call that never started,
        // reads the same way, so the text claims only what is known.
        expect(results[0]?.result).toMatchObject({
          reason: "Interrupted",
          error:
            "No result was recorded before the server stopped: the tool may have run in part, in full, or not at all. It did not run again; check its effects before you retry it.",
        })
      }).pipe(Effect.timeout("15 seconds")),
    20_000,
  )

  it.scopedLive(
    "a parked mark the database refuses fails the step, so the turn does not park unmarked",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDirectoryScoped("gent-mark-refused-")
        const dbPath = `${tempDir}/gent.db`
        const asking = tool({
          id: "asking_work",
          description: "Asks before it works",
          params: Schema.Struct({}),
          output: Schema.String,
          execute: Effect.fn("asking_work")(function* () {
            const ctx = yield* ExtensionContext
            const decision = yield* ctx.Interaction.approve({ text: "do the work?" })
            if (!decision.approved) return "declined"
            return "worked"
          }),
        })
        const extension: LoadedExtension = {
          manifest: { id: ExtensionId.make("@test/mark-refused") },
          scope: "builtin",
          sourcePath: "test",
          artifactIdentity: LoadedArtifactIdentity.make("@test/mark-refused@artifact-1"),
          contributions: { tools: [asking] },
        }
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          toolCallStep("asking_work", {}),
        ])
        const { client } = yield* createRpcClient(
          createE2ELayer({
            agents: e2ePreset.agents,
            providerLayer,
            extensions: [extension],
            approvalLayer: ApprovalService.Live,
            storagePath: dbPath,
          }),
        )
        const { sessionId, branchId } = yield* client.session.create({})
        // The database refuses any turn row that carries a parked mark.
        yield* Effect.sync(() => {
          const db = new Database(dbPath)
          db.exec("PRAGMA busy_timeout = 2000")
          for (const event of ["INSERT", "UPDATE"]) {
            db.exec(
              `CREATE TRIGGER refuse_parked_${event.toLowerCase()} BEFORE ${event} ON turn_records WHEN NEW.pending_tool_calls_json LIKE '%"parked":true%' BEGIN SELECT RAISE(ABORT, 'parked mark refused'); END`,
            )
          }
          db.close()
        })
        yield* client.message.send({ sessionId, branchId, content: "ask first" })
        const settled = yield* waitFor(
          client.session.getSnapshot({ sessionId, branchId }),
          (snapshot) =>
            snapshot.runtime._tag === "Idle" &&
            snapshot.messages.some((message) => message.role === "assistant"),
          5_000,
          "the turn ended instead of parking",
        )
        expect(settled.runtime._tag).toBe("Idle")
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )
})

// ── turn ledger ─────────────────────────────────────────────────────────────

describe("turn ledger", () => {
  it.effect("a turn that mixes a priced and an unpriced step has no cost", () =>
    Effect.gen(function* () {
      const ledger = yield* makeTurnLedger
      const messageId = MessageId.make("ledger-turn")
      yield* ledger.beginTurn(messageId)
      const usage = Option.some({ inputTokens: 100, outputTokens: 10 })
      yield* ledger.noteStep({
        agent: AgentName.make("primary"),
        model: ModelId.make("test/priced"),
        usage,
        costUsd: Option.some(0.5),
        toolCallCount: 1,
      })
      yield* ledger.noteStep({
        agent: AgentName.make("primary"),
        model: ModelId.make("custom/unpriced"),
        usage,
        costUsd: Option.none(),
        toolCallCount: 0,
      })
      const total = yield* ledger.total
      expect(total.usageKnown).toBe(true)
      expect(total.costUsd).toEqual(Option.none())
    }),
  )

  it.effect("a turn whose steps are all priced sums them", () =>
    Effect.gen(function* () {
      const ledger = yield* makeTurnLedger
      yield* ledger.beginTurn(MessageId.make("ledger-priced"))
      for (const cost of [0.5, 0.25]) {
        yield* ledger.noteStep({
          agent: AgentName.make("primary"),
          model: ModelId.make("test/priced"),
          usage: Option.some({ inputTokens: 100, outputTokens: 10 }),
          costUsd: Option.some(cost),
          toolCallCount: 0,
        })
      }
      expect((yield* ledger.total).costUsd).toEqual(Option.some(0.75))
    }),
  )
})
