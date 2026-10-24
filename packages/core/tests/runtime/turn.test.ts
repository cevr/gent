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
  Duration,
  Exit,
  Fiber,
  FileSystem,
  Predicate,
  Result,
} from "effect"
import { TestClock } from "effect/testing"
import {
  assistantMessageIdForTurn,
  dateFromMillis,
  Message,
  responseUsage,
  toolResultMessageIdForTurn,
  encodeToolOutput,
  isRuntimeUserMessage,
  messagePartsText,
  MODEL_ATTEMPTS_MESSAGE_TYPE,
  Session,
  type SessionAdmission,
  SteerCommand,
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
  StepOutcome,
  findPersistedToolResults,
  persistAssistantPartsWithBindings,
  ToolResultReplayError,
  makeTurnLedger,
} from "../../src/runtime/turn"
import {
  BranchId,
  CredentialSlot,
  DEFAULT_CREDENTIAL_SLOT,
  MessageId,
  SessionId,
  ToolCallId,
  ExtensionId,
  RequestId,
  ToolId,
  ProcessGenerationId,
  type InteractionRequestId,
} from "../../src/domain/ids"
import {
  AgentDefinition,
  AgentName,
  DriverRef,
  effectiveModelDriver,
  ModelId,
  Model,
  type ModelPricing,
  ProviderId,
  type ReasoningEffort,
} from "../../src/domain/agent"
import { ProviderError } from "../../src/domain/errors"
import { omitUndefined } from "../../src/domain/guards"
import {
  finishPart,
  textDeltaPart,
  toolCallPart,
  type LanguageModelStreamPart,
  Auth,
  AuthApi,
  AuthInfo,
  CredentialPlacement,
  makeCredentialPlacement,
  ModelCatalogRecord,
  ModelRegistry,
  ModelResolver,
  reasoningDeltaPart,
  multiToolCallStep,
  textStep,
  toolCallStep,
} from "../../src/runtime/provider"
import {
  type AgentEvent,
  ErrorOccurred,
  EventEnvelope,
  EventId,
  EventStore,
  MessageReceived,
  ModelRouted,
  SessionSettingsUpdated,
  StreamEnded,
  ToolCallSucceeded,
  type Usage,
  UsageSchema,
  TurnCompleted,
} from "../../src/domain/event"
import * as Prompt from "effect/ai/Prompt"
import {
  EventStorage,
  MessageStorage,
  makeStorageTransaction,
  SessionOperationStorage,
  SessionStorage,
  ToolCallBindingStorage,
} from "../../src/storage/storage"
import { EventStoreLive } from "../../src/runtime/session"
import {
  captureCurrentToolBinding,
  innerOperationBindingIdentity,
  processLocalReplayBindingKey,
  ProcessLocalToolReplay,
  type ResolvedToolCapability,
  resolveReplayToolBinding,
  resolveStoredToolBinding,
  ToolBindingReplayError,
  ToolCallRecoveryError,
  ToolCallRecoveryOutcome,
  ToolRunner,
} from "../../src/runtime/tools"
import {
  createE2ELayer,
  createRpcClient,
  createRpcHarness,
  ensureStorageParents,
  fixtureModelCatalogSource,
  hostProfileRegistry,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  recordingEventStore,
  TEST_MODEL_ID,
  testSqliteStorage,
  waitFor,
} from "../../src/test-utils/harness"
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
  waitForPhase,
} from "../helpers/agent-loop"
import {
  chainCompactors,
  type ContextRole,
  contextWindowOf,
  ModelCompactionError,
  CompactionOutcome,
  ModelContextCompactor,
  ModelContextWindowPolicy,
} from "../../src/runtime/model-context"
import {
  e2ePreset,
  rangeCompactor,
  rangeCompactorLayer,
  testAgent,
  testAgents,
} from "../helpers/test-preset"
import * as AiModel from "effect/ai/Model"
import {
  DEFAULT_RETRY_POLICY,
  type CacheWarmer,
  type ModelDriverContribution,
  type ProviderReport,
  type QuotaReading,
  reportProviderQuota,
  type SpendLimit,
  type ModelRouteInput,
  type ModelRouterContribution,
  type ProviderAuthInfo,
  type ProviderHints,
  type VirtualModel,
  type VirtualModelChoice,
} from "../../src/domain/driver"
import {
  ConfigService,
  type ProviderConfig,
  RuntimeEnvironment,
  UserConfig,
} from "../../src/runtime/config"
import { GentPlatform } from "../../src/runtime/gent-platform"
import {
  ApprovalService,
  ExtensionRegistry,
  resolveExtensions,
  SessionProfileCache,
} from "../../src/runtime/extension-host"
import { foldSessionMetrics, interjectionMessageId } from "../../src/domain/agent-loop"
import * as AiError from "effect/ai/AiError"
import { Database } from "bun:sqlite"
import { Decision, DecisionModel, type LanguageModel } from "effect/ai"
import {
  ExtensionServiceError,
  LoadedArtifactIdentity,
  type LoadedExtension,
} from "../../src/domain/extension"
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

/** A sign-in on which the owner holds no project's lanes. */
const noHolds = () => Effect.succeed<ReadonlyMap<string, number>>(new Map())

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
        contextOverflow: false,
        retryAt: Option.some(1_000),
      }).pipe(Effect.provide(layer))

      expect(collected.interrupted).toBe(true)
      expect(collected.streamFailed).toBe(false)
      expect(collected.retryAt).toEqual(Option.none())
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
      }).pipe(Effect.provide(layer))

      expect(collected.streamFailed).toBe(true)
      expect(collected.messageProjection.assistant.map((part) => part.type)).toEqual(["text"])
      const errors = (yield* Ref.get(events)).filter(Schema.is(ErrorOccurred))
      expect(errors.map((event) => event.error)).toEqual(["late boom"])
    }),
  )
})

// ── session route ───────────────────────────────────────────────────────────

describe("session route driver", () => {
  const modelId = ModelId.make("anthropic/claude-sonnet-5")
  /** The driver the route's model dispatches through, as the turn derives it. */
  const routeOf = (
    agent: AgentDefinition,
    driverOverrides?: Readonly<Record<string, DriverRef>>,
  ) => {
    const route = resolveSessionRoute({
      agents: [agent],
      admission: Option.some({ agent: agent.name }),
      config: { driverOverrides },
      session: { modelId },
    })
    return {
      modelDriver: Option.map(route.modelId, (id) => effectiveModelDriver(route.driverRef, id)),
    }
  }

  test("the agent's own driver wins over a config override", () => {
    const agent = AgentDefinition.make({
      name: AgentName.make("special"),
      driver: DriverRef.make({ id: "anthropic-proxy" }),
    })
    const route = routeOf(agent, { special: DriverRef.make({ id: "openai-proxy" }) })
    expect(Option.getOrThrow(route.modelDriver).driverId).toEqual(Option.some("anthropic-proxy"))
    expect(Option.getOrThrow(route.modelDriver).contextModelId).toBe(
      ModelId.make("anthropic-proxy/claude-sonnet-5"),
    )
  })

  test("a config override routes an agent that names no driver", () => {
    const agent = AgentDefinition.make({ name: AgentName.make("primary") })
    const route = routeOf(agent, { primary: DriverRef.make({ id: "openai" }) })
    expect(Option.getOrThrow(route.modelDriver).driverId).toEqual(Option.some("openai"))
    expect(Option.getOrThrow(route.modelDriver).contextModelId).toBe(
      ModelId.make("openai/claude-sonnet-5"),
    )
  })

  test("no driver and no override route through the model id's provider", () => {
    const agent = AgentDefinition.make({ name: AgentName.make("primary") })
    for (const route of [routeOf(agent), routeOf(agent, {})]) {
      expect(Option.getOrThrow(route.modelDriver).driverId).toEqual(Option.some("anthropic"))
      expect(Option.getOrThrow(route.modelDriver).contextModelId).toBe(modelId)
    }
  })

  test("an override for another agent does not route this one", () => {
    const agent = AgentDefinition.make({ name: AgentName.make("primary") })
    const route = routeOf(agent, { secondary: DriverRef.make({ id: "openai" }) })
    expect(Option.getOrThrow(route.modelDriver).driverId).toEqual(Option.some("anthropic"))
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
  retryAt: Option.none(),
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
    expect(classifyStep(collected([], { streamFailed: true }))).toEqual(
      StepOutcome.cases.Failed.make({
        partialOutput: false,
        contextOverflow: false,
      }),
    )
    expect(classifyStep(collected([textDeltaPart("some")], { streamFailed: true }))).toEqual(
      StepOutcome.cases.Failed.make({
        partialOutput: true,
        contextOverflow: false,
      }),
    )
    expect(classifyStep(collected([], { streamFailed: true, contextOverflow: true }))).toEqual(
      StepOutcome.cases.Failed.make({
        partialOutput: false,
        contextOverflow: true,
      }),
    )
  })

  test("tool calls are counted", () => {
    const outcome = classifyStep(
      collected([textDeltaPart("thinking"), toolCallPart("a", {}), toolCallPart("b", {})]),
    )
    expect(outcome).toEqual(StepOutcome.cases.ToolCalls.make({ count: 2, contextOverflow: false }))
  })

  test("a plain reply is Answered with neither flag", () => {
    const outcome = classifyStep(
      collected([textDeltaPart("done"), finishPart({ finishReason: "stop" })]),
    )
    expect(outcome).toEqual(
      StepOutcome.cases.Answered.make({
        empty: false,
        truncated: false,
        contextOverflow: false,
        blocked: false,
      }),
    )
  })

  test("no observable output is an empty answer", () => {
    const outcome = classifyStep(collected([finishPart({ finishReason: "stop" })]))
    expect(outcome).toEqual(
      StepOutcome.cases.Answered.make({
        empty: true,
        truncated: false,
        contextOverflow: false,
        blocked: false,
      }),
    )
  })

  test("a length finish marks the answer truncated", () => {
    const outcome = classifyStep(
      collected([textDeltaPart("cut off"), finishPart({ finishReason: "length" })]),
    )
    expect(outcome).toEqual(
      StepOutcome.cases.Answered.make({
        empty: false,
        truncated: true,
        contextOverflow: false,
        blocked: false,
      }),
    )
  })

  test("an unknown finish alone is a finished answer", () => {
    const outcome = classifyStep(
      collected([textDeltaPart("done"), finishPart({ finishReason: "unknown" })]),
    )
    expect(outcome).toEqual(
      StepOutcome.cases.Answered.make({
        empty: false,
        truncated: false,
        contextOverflow: false,
        blocked: false,
      }),
    )
  })

  test("a full window marks the answer truncated and hands off when the turn may", () => {
    const parts = [textDeltaPart("cut off"), finishPart({ finishReason: "unknown" })]
    expect(classifyStep(collected(parts, { windowFull: true, contextOverflow: true }))).toEqual(
      StepOutcome.cases.Answered.make({
        empty: false,
        truncated: true,
        contextOverflow: true,
        blocked: false,
      }),
    )
    // A window already handed off this turn is only continued.
    expect(classifyStep(collected(parts, { windowFull: true }))).toEqual(
      StepOutcome.cases.Answered.make({
        empty: false,
        truncated: true,
        contextOverflow: false,
        blocked: false,
      }),
    )
  })

  test("a content-filter finish marks the answer blocked, with or without text", () => {
    const blockedFinish = finishPart({ finishReason: "content-filter" })
    expect(classifyStep(collected([blockedFinish]))).toEqual(
      StepOutcome.cases.Answered.make({
        empty: true,
        truncated: false,
        contextOverflow: false,
        blocked: true,
      }),
    )
    expect(classifyStep(collected([textDeltaPart("partial"), blockedFinish]))).toEqual(
      StepOutcome.cases.Answered.make({
        empty: false,
        truncated: false,
        contextOverflow: false,
        blocked: true,
      }),
    )
  })
})

// ── tool outcome recording ──────────────────────────────────────────────────

const FIXED_NOW = dateFromMillis(1_767_225_600_000)

const storage = testSqliteStorage
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
      }).pipe(Effect.provide(Layer.mergeAll(testSqliteStorage, publisher.layer)))
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
        yield* runAgentLoop(makeContMessage("test auto-continue"))
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
        yield* runAgentLoop(makeContMessage("text only"))
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
        yield* runAgentLoop(makeContMessage("multi-hop"))
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
        yield* runAgentLoop(makeContMessage("turn-events"))
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
        const messageStorage = yield* MessageStorage
        const turn = makeContMessage("steer at step boundary")
        const fiber = yield* Effect.forkChild(runAgentLoop(turn))
        yield* controls.waitForCall(0)
        yield* steerAgentLoop(
          SteerCommand.cases.Interject.make({
            sessionId: contSessionId,
            branchId: contBranchId,
            requestId: "req-interject-step-boundary",
            message: "steer now",
          }),
        )
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
        const messageStorage = yield* MessageStorage
        const turn = makeContMessage("a sender steers this turn")
        const fiber = yield* Effect.forkChild(runAgentLoop(turn))
        yield* controls.waitForCall(0)
        yield* steerAgentLoop(
          SteerCommand.cases.Interject.make({
            sessionId: contSessionId,
            branchId: contBranchId,
            requestId: "req-interject-keeps-custom-type",
            message: "from another session",
            metadata: { customType: "session-message", details: { from: "sender" } },
          }),
        )
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
          runAgentLoop(makeContMessage("a turn the sender does not own")),
        )
        yield* controls.waitForCall(0)
        yield* steerAgentLoop(
          SteerCommand.cases.Interject.make({
            sessionId: contSessionId,
            branchId: contBranchId,
            requestId,
            message: "TAKEN-BACK",
            wake: true,
          }),
        )
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
          runAgentLoop(makeContMessage("a turn the steer would join")),
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
          SteerCommand.cases.Interject.make({
            sessionId: contSessionId,
            branchId: contBranchId,
            requestId,
            message: "LATE-CORRECTION",
            wake: true,
          }),
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
        const fiber = yield* Effect.forkChild(runAgentLoop(message))
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
        const fiber = yield* Effect.forkChild(runAgentLoop(message))
        yield* controls.waitForCall(0)
        const steer = (requestId: string, text: string, sender: typeof parent) =>
          steerAgentLoop(
            SteerCommand.cases.Interject.make({
              sessionId: contSessionId,
              branchId: contBranchId,
              requestId,
              message: text,
              wake: true,
            }),
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
        yield* steerAgentLoop(
          SteerCommand.cases.Interject.make({
            sessionId: idleSessionId,
            branchId: idleBranchId,
            requestId: "req-interject-idle-start",
            message: "answer me",
            wake: true,
          }),
        )
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
  // Children that end while their starter is idle each leave a steer. The
  // turn the first one opens reads them all in its first request, not one
  // model step per message.
  it.live("a woken turn reads every waiting steer in its first request", () =>
    Effect.gen(function* () {
      const idleSessionId = SessionId.make("cont-waiting-steers-session")
      const idleBranchId = BranchId.make("cont-waiting-steers-branch")
      const firstRequest: Array<string> = []
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        {
          ...textStep("Read all three."),
          assertOptions: (options) => {
            for (const message of Prompt.make(options.prompt).content) {
              if (message.role !== "user") continue
              for (const part of message.content) {
                if (part.type === "text") firstRequest.push(part.text)
              }
            }
          },
        },
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const messageStorage = yield* MessageStorage
        const steer = (requestId: string, message: string, wake: boolean) =>
          steerAgentLoop(
            SteerCommand.cases.Interject.make({
              sessionId: idleSessionId,
              branchId: idleBranchId,
              requestId,
              message,
              wake,
            }),
          )
        yield* steer("req-waiting-first", "FIRST-CHILD", false)
        yield* steer("req-waiting-second", "SECOND-CHILD", false)
        yield* steer("req-waiting-third", "THIRD-CHILD", true)
        yield* waitForPhase(agentLoop, { sessionId: idleSessionId, branchId: idleBranchId }, "Idle")
        expect(yield* controls.callCount).toBe(1)
        expect(firstRequest).toEqual(["FIRST-CHILD", "SECOND-CHILD", "THIRD-CHILD"])
        const events = yield* Ref.get(eventsRef)
        expect(events.filter(Schema.is(TurnCompleted))).toHaveLength(1)
        const messages = yield* messageStorage.listMessages(idleBranchId)
        const joined = messages.filter(
          (message) => message._tag === "interjection" && isRuntimeUserMessage(message),
        )
        // The two the turn did not open are answered by it: a restart does not answer them again.
        expect(joined.map((message) => message.id)).toEqual([
          interjectionMessageId(RequestId.make("req-waiting-second")),
          interjectionMessageId(RequestId.make("req-waiting-third")),
        ])
        yield* controls.assertDone
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }).pipe(Effect.timeout("4 seconds")),
  )
  it.live("a cancel during the continuation step ends the turn interrupted", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        toolCallStep("echo", { text: "step 1" }),
        { ...textStep("Continuation response."), gated: true },
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(runAgentLoop(makeContMessage("interrupt test")))
        yield* controls.waitForCall(1)
        yield* steerAgentLoop(
          SteerCommand.cases.Cancel.make({
            sessionId: contSessionId,
            branchId: contBranchId,
            requestId: "req-continuation-interrupt-first",
          }),
        )
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
  it.live("each step of a multi-hop turn persists its own message", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        toolCallStep("echo", { text: "step 1" }),
        toolCallStep("echo", { text: "step 2" }),
        textStep("Final answer."),
      ])
      yield* Effect.gen(function* () {
        const messageStorage = yield* MessageStorage
        const msg = makeContMessage("multi-hop persistence")
        yield* runAgentLoop(msg)
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
        const first = makeContMessage("first message")
        const followUp = makeContMessage("follow-up after interrupt")
        // Start first turn — tool call auto-continues to gated step
        yield* Effect.forkChild(runAgentLoop(first))
        // Wait for the gated step (second stream call) to start
        yield* controls.waitForCall(1)
        // Queue a follow-up while step 1 is gated
        yield* submitAgentLoop(followUp)
        // Interrupt the current turn. `agentLoop.steer` issues
        // `actor.call(Interrupt)` which is serialized request-reply — by the
        // time it returns, the actor has already set `interruptedRef = true`
        // and signalled the active stream. No additional wait needed.
        yield* steerAgentLoop(
          SteerCommand.cases.Cancel.make({
            sessionId: contSessionId,
            branchId: contBranchId,
            requestId: "req-continuation-interrupt-second",
          }),
        )
        // Release the gated step so the interrupted turn can finalize
        yield* controls.emitAll(1)
        // Wait for the follow-up to complete: the second TurnCompleted, which
        // is what the assertions read. The loop is idle for a moment between
        // the two turns, so the phase alone does not say the follow-up ran.
        const turnCompleted = yield* waitFor(
          Ref.get(eventsRef).pipe(Effect.map((events) => events.filter(Schema.is(TurnCompleted)))),
          (completed) => completed.length >= 2,
          5_000,
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
            const messageStorage = yield* MessageStorage
            const message = makeMessage(SessionId.make("s1"), BranchId.make("b1"), "write it")
            yield* runAgentLoop(message)
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
          const messageStorage = yield* MessageStorage
          const message = makeMessage(SessionId.make("s1"), BranchId.make("b1"), "write it")
          yield* runAgentLoop(message)
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
        yield* runAgentLoop(userMessage("do the thing"))

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
        yield* runAgentLoop(userMessage("do the thing"))

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

  it.live("spends every continuation, then marks the turn unanswered", () =>
    Effect.gen(function* () {
      // Three empty steps: the first two burn both continuations, the third
      // still says nothing. The loop must re-prompt rather than stop at the
      // first empty step, and stop rather than loop forever. The receipt must
      // record that it gave up rather than reporting an ordinary reply.
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        emptyStep(),
        emptyStep(),
        emptyStep(),
      ])
      const events = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* runAgentLoop(userMessage("do the thing"))

          expect(yield* controls.callCount).toBe(3)
          yield* controls.assertDone
          const turnCompleted = (yield* Ref.get(events)).filter(
            (event) => event._tag === "TurnCompleted",
          )

          expect(turnCompleted).toHaveLength(1)
          // Without the flag every field here reads exactly like a successful
          // turn, and the caller cannot tell "gave up" from "replied".
          expect(turnCompleted.every((event) => event.unanswered === true)).toBe(true)
        }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, events))),
      )
    }),
  )
})

// ── provider refusal ────────────────────────────────────────────────────────

/**
 * A provider that blocks a reply (Effect AI maps Anthropic's `refusal` to the
 * `content-filter` finish) blocked the request, not the model's answer. A
 * re-prompt resends the same window to the same filter, so the turn stops
 * with one error that says so and keeps any text the reply had.
 */
describe("provider refusal", () => {
  const sessionId = SessionId.make("refusal-session")
  const branchId = BranchId.make("refusal-branch")

  const userMessage = (text: string) =>
    Message.cases.regular.make({
      id: MessageId.make("refusal-msg-0"),
      sessionId,
      branchId,
      role: "user",
      parts: [Prompt.textPart({ text })],
      createdAt: dateFromMillis(1_767_225_600_000),
    })

  const blockedStep = (text: ReadonlyArray<string>) => ({
    parts: [
      ...text.map((delta) => textDeltaPart(delta)),
      finishPart({ finishReason: "content-filter", usage: { inputTokens: 10, outputTokens: 1 } }),
    ],
  })

  const runBlocked = (step: ReturnType<typeof blockedStep>) =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([step])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      return yield* Effect.gen(function* () {
        yield* runAgentLoop(userMessage("say the blocked thing"))
        expect(yield* controls.callCount).toBe(1)
        yield* controls.assertDone
        const stored = yield* (yield* MessageStorage).listMessages(branchId)
        const events = yield* Ref.get(eventsRef)
        return { stored, events }
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef)))
    }).pipe(Effect.timeout("4 seconds"))

  it.live("a refusal with no text stops the turn unanswered with one error and no re-prompt", () =>
    Effect.gen(function* () {
      const { stored, events } = yield* runBlocked(blockedStep([]))
      expect(stored.filter((message) => message.metadata?.customType === "continuation")).toEqual(
        [],
      )
      expect(events.filter(Schema.is(ErrorOccurred)).map((event) => event.error)).toEqual([
        "the provider blocked the response",
      ])
      expect(events.filter((event) => event._tag === "TurnCompleted")).toMatchObject([
        { unanswered: true },
      ])
    }),
  )

  it.live("a refusal after partial text keeps the text and reports the block", () =>
    Effect.gen(function* () {
      const { stored, events } = yield* runBlocked(blockedStep(["Here is the start"]))
      const assistantTexts = stored
        .filter((message) => message.role === "assistant")
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
      expect(assistantTexts).toEqual(["Here is the start"])
      expect(stored.filter((message) => message.metadata?.customType === "continuation")).toEqual(
        [],
      )
      expect(events.filter(Schema.is(ErrorOccurred)).map((event) => event.error)).toEqual([
        "the provider blocked the response",
      ])
      const completed = events.filter((event) => event._tag === "TurnCompleted")
      expect(completed).toHaveLength(1)
      expect(completed[0]).not.toMatchObject({ unanswered: true })
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
        // The budget is the agent's to lower; three steps prove the same exit
        // the default two hundred do.
        yield* runAgentLoop(userMessage("loop forever"), {
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
        yield* runAgentLoop(userMessage("two steps at most"), {
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
        yield* runAgentLoop(userMessage("two steps at most"), {
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
        yield* runAgentLoop(userMessage("answer once"), {
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
        const fiber = yield* Effect.forkChild(
          runAgentLoop(userMessage("answer once"), {
            runSpec: { overrides: { maxSteps: 1 } },
          }),
        )
        yield* controls.waitForCall(0)
        yield* steerAgentLoop(
          SteerCommand.cases.Interject.make({
            sessionId,
            branchId,
            requestId: "req-interject-last-step",
            message: "steer late",
          }),
        )
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
        yield* runAgentLoop(userMessage("who are you"), {
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

// ── model-call budget ───────────────────────────────────────────────────────

/**
 * A run's model-call budget (`maxModelAttempts`) is counted by one durable
 * reservation per model request (`reserveModelAttempt`). Each step's
 * receipt reads that count, so a client sees what the turn used, its limit
 * and what is left without a second counter. Near the limit the turn writes
 * one notice the next request reads; a turn that spends the budget stops
 * with an error that says so and how to go on.
 */
describe("model-call budget", () => {
  const sessionId = SessionId.make("budget-session")
  const branchId = BranchId.make("budget-branch")

  const userMessage = (id: string, text: string) =>
    Message.cases.regular.make({
      id: MessageId.make(id),
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

  const budget = (maxModelAttempts: number): SessionAdmission => ({
    runSpec: { overrides: { maxModelAttempts } },
  })

  const ended = (events: ReadonlyArray<AgentEvent>) =>
    events.filter((event): event is StreamEnded => event._tag === "StreamEnded")

  /** The budget notices the branch stores. */
  const storedNotices = Effect.gen(function* () {
    const messageStorage = yield* MessageStorage
    return (yield* messageStorage.listMessages(branchId)).filter(
      (message) => message.metadata?.customType === MODEL_ATTEMPTS_MESSAGE_TYPE,
    )
  })

  it.live("each step's receipt counts the turn's model calls against its limit", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        toolCallStep("echo", { text: "one" }),
        toolCallStep("echo", { text: "two" }),
        textStep("done"),
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        yield* runAgentLoop(userMessage("budget-count", "three steps"), budget(8))
        const events = yield* Ref.get(eventsRef)
        expect(ended(events).map((event) => event.modelAttempts)).toEqual([
          { used: 1, limit: 8 },
          { used: 2, limit: 8 },
          { used: 3, limit: 8 },
        ])
        // While the turn runs the session's metrics carry its newest count;
        // once it completes they carry none.
        const second = events.indexOf(ended(events)[1]!)
        const midTurn = foldSessionMetrics(events.slice(0, second + 1).map((event) => ({ event })))
        expect(midTurn.turnModelAttempts).toEqual({ used: 2, limit: 8 })
        const after = foldSessionMetrics(events.map((event) => ({ event })))
        expect(after.turnModelAttempts).toBeUndefined()
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.live("a turn with no budget counts nothing and writes no notice", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("done")])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        yield* runAgentLoop(userMessage("budget-none", "no budget"))
        const events = yield* Ref.get(eventsRef)
        expect(ended(events).map((event) => "modelAttempts" in event)).toEqual([false])
        expect(yield* storedNotices).toEqual([])
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.live("a turn resumed after spending calls counts them, not from zero", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("done")])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const message = userMessage("budget-resumed", "resumed")
        // An earlier process reserved two calls for this turn and died.
        yield* ensureStorageParents({ sessionId, branchId, admission: budget(8) })
        const operations = yield* SessionOperationStorage
        const address = { sessionId, branchId, messageId: message.id, max: 8 }
        yield* operations.reserveModelAttempt(address)
        yield* operations.reserveModelAttempt(address)
        yield* runAgentLoop(message, budget(8))
        const events = yield* Ref.get(eventsRef)
        expect(ended(events).map((event) => event.modelAttempts)).toEqual([{ used: 3, limit: 8 }])
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.live("near the limit one notice reaches the next request and spends no call", () =>
    Effect.gen(function* () {
      const noticeLine = "5 of its 6 model calls left"
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        {
          ...toolCallStep("echo", { text: "one" }),
          assertOptions: (options) => {
            expect(promptText(options.prompt)).not.toContain("model calls left")
          },
        },
        {
          ...toolCallStep("echo", { text: "two" }),
          assertOptions: (options) => {
            expect(promptText(options.prompt)).toContain(noticeLine)
          },
        },
        {
          ...textStep("done"),
          assertOptions: (options) => {
            // Written once: the later step reads the same one line.
            expect(promptText(options.prompt).split("model calls left")).toHaveLength(2)
          },
        },
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        yield* runAgentLoop(userMessage("budget-near", "near the limit"), budget(6))
        yield* controls.assertDone
        const notices = yield* storedNotices
        expect(notices.map((message) => message.metadata?.details)).toEqual([{ used: 1, limit: 6 }])
        // The runtime wrote it inside the turn: recovery never answers it alone.
        expect(notices.every(isRuntimeUserMessage)).toBe(true)
        const events = yield* Ref.get(eventsRef)
        expect(ended(events).map((event) => event.modelAttempts?.used)).toEqual([1, 2, 3])
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }).pipe(Effect.timeout("4 seconds")),
  )

  const lastCallLine = "last model call of this turn's budget of 3"

  it.live(
    "the last allowed call runs with tools off, the turn ends with its answer, and the next message has a fresh budget",
    () =>
      Effect.gen(function* () {
        const toolsOn = (options: LanguageModel.ProviderOptions) => {
          expect(options.toolChoice).not.toBe("none")
          expect(promptText(options.prompt)).not.toContain(lastCallLine)
        }
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          { ...toolCallStep("echo", { text: "one" }), assertOptions: toolsOn },
          { ...toolCallStep("echo", { text: "two" }), assertOptions: toolsOn },
          {
            ...textStep("what the work established"),
            assertOptions: (options) => {
              expect(options.toolChoice).toBe("none")
              expect(promptText(options.prompt)).toContain(lastCallLine)
            },
          },
          textStep("the next turn answers"),
        ])
        const eventsRef = yield* Ref.make<AgentEvent[]>([])
        yield* Effect.gen(function* () {
          yield* runAgentLoop(userMessage("budget-last", "more work than calls"), budget(3))
          const events = yield* Ref.get(eventsRef)
          expect(events.filter((event) => event._tag === "ErrorOccurred")).toEqual([])
          const last = ended(events).at(-1)
          expect(last?.outcome).toBe("Answered")
          expect(last?.modelAttempts).toEqual({ used: 3, limit: 3 })
          const completed = events.filter(
            (event): event is TurnCompleted => event._tag === "TurnCompleted",
          )
          expect(completed.map((event) => [event.streamFailed, event.unanswered === true])).toEqual(
            [[false, false]],
          )
          // The near notice after the first call, then the last call's line;
          // a budget this small is near from the start, but its first step
          // reads only the task.
          expect((yield* storedNotices).map((message) => message.metadata?.details)).toEqual([
            { used: 1, limit: 3 },
            { used: 2, limit: 3 },
          ])

          yield* Ref.set(eventsRef, [])
          yield* runAgentLoop(userMessage("budget-next", "go on"), budget(3))
          yield* controls.assertDone
          const next = yield* Ref.get(eventsRef)
          expect(ended(next).map((event) => [event.outcome, event.modelAttempts] as const)).toEqual(
            [["Answered", { used: 1, limit: 3 }]],
          )
        }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
      }).pipe(Effect.timeout("4 seconds")),
  )

  it.live("a tool call on the last allowed call is refused, not run", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        toolCallStep("echo", { text: "first" }),
        toolCallStep("echo", { text: "past the budget" }),
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        yield* runAgentLoop(userMessage("budget-refused", "two calls at most"), budget(2))
        const events = yield* Ref.get(eventsRef)
        expect(events.filter((event) => event._tag === "ToolCallStarted")).toHaveLength(1)
        const messageStorage = yield* MessageStorage
        const refused = (yield* messageStorage.listMessages(branchId))
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "tool-result" && part.isFailure)
        expect(refused).toHaveLength(1)
        const completed = events.filter(
          (event): event is TurnCompleted => event._tag === "TurnCompleted",
        )
        expect(completed.map((event) => event.unanswered)).toEqual([true])
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.live("a budget of one answers on its only call, with tools off", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        {
          ...textStep("the only answer"),
          assertOptions: (options) => {
            expect(options.toolChoice).toBe("none")
            expect(promptText(options.prompt)).toContain(
              "last model call of this turn's budget of 1",
            )
          },
        },
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        yield* runAgentLoop(userMessage("budget-one", "one call"), budget(1))
        yield* controls.assertDone
        const events = yield* Ref.get(eventsRef)
        expect(events.filter((event) => event._tag === "ErrorOccurred")).toEqual([])
        expect(ended(events).map((event) => event.modelAttempts)).toEqual([{ used: 1, limit: 1 }])
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }).pipe(Effect.timeout("4 seconds")),
  )
})

// ── model driver and catalog ────────────────────────────────────────────────

describe("model driver and catalog", () => {
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
      resolver: ModelResolver.Live.pipe(
        Layer.provide(Auth.Test()),
        Layer.provide(fixtureModelCatalogSource),
      ),
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
        for (const modelId of ["catalog-driver/plain", "catalog-driver/unlisted"]) {
          const admission: SessionAdmission = {
            runSpec: { overrides: { model: ModelId.make(modelId), reasoningEffort: "high" } },
          }
          const name = modelId.split("/")[1]
          const session = SessionId.make(`${sessionId}-${name}`)
          const branch = BranchId.make(`${branchId}-${name}`)
          yield* ensureStorageParents({ sessionId: session, branchId: branch, admission })
          yield* runAgentLoop(makeMessage(session, branch, "hello"), admission)
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
      resolver: ModelResolver.Live.pipe(
        Layer.provide(Auth.Test()),
        Layer.provide(fixtureModelCatalogSource),
      ),
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
        const admission: SessionAdmission = { runSpec: { overrides: { model: modelId } } }
        yield* ensureStorageParents({ sessionId, branchId, admission })
        yield* runAgentLoop(makeMessage(sessionId, branchId, "hello"), admission)
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
})

// ── cache keep-warm ─────────────────────────────────────────────────────────

describe("cache keep-warm", () => {
  /** A five-minute cache gets its warming read 30 seconds before it lapses. */
  const CACHE_TTL_MS = 300_000
  const READ_GAP_MS = 270_000
  /** One warming read: a million tokens read from the cache, at $0.5 a million. */
  const READ_USAGE = {
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 0,
    cacheWritesByLifetime: [],
  }
  const READ_COST = 0.5
  type ReadAnswer = Option.Option.Value<Effect.Success<CacheWarmer["resend"]>>

  /**
   * One turn on an API key whose first step reports a warmer and calls a
   * tool that holds while the clock moves `gaps` read gaps; then the tool
   * ends, or the turn is interrupted. `answer` is what the warmer's read
   * `read` (from 0) answers; default a hit. Answers the times the warmer
   * read while the tool held, the reads after three more gaps past the turn,
   * what the turn spent beyond its steps, and the quotas noted on accounts.
   */
  const runWarmedTurn = (params: {
    readonly name: string
    readonly ttlMs: Option.Option<number>
    readonly gaps: number
    readonly end?: "release" | "interrupt"
    readonly pricing?: ModelPricing
    readonly answer?: (
      read: number,
    ) => Effect.Effect<Option.Option<ReadAnswer>, never, ProviderReport>
  }) =>
    Effect.gen(function* () {
      const reads = yield* Ref.make<ReadonlyArray<number>>([])
      const started = yield* Deferred.make<void>()
      const released = yield* Deferred.make<void>()
      const answer = params.answer ?? (() => Effect.succeedSome<ReadAnswer>(READ_USAGE))
      const warmer: CacheWarmer = {
        sentAtMillis: yield* Clock.currentTimeMillis,
        resend: Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          const before = yield* Ref.getAndUpdate(reads, (all) => [...all, at])
          return yield* answer(before.length)
        }),
      }
      const holdTool = tool({
        id: "hold",
        description: "Runs until the test releases it",
        params: Schema.Struct({}),
        output: Schema.String,
        execute: () =>
          Deferred.succeed(started, void 0).pipe(
            Effect.andThen(Deferred.await(released)),
            Effect.as("released"),
          ),
      })
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        { ...toolCallStep("hold", {}), cacheWarmer: warmer },
        textStep("done"),
      ])
      const modelId = ModelId.make("warm-driver/model")
      const driver: ModelDriverContribution = {
        id: "warm-driver",
        name: "Warm driver",
        resolveModel: () => Effect.succeed(AiModel.make("warm-driver", "model", providerLayer)),
      }
      const realPlacement = yield* makeCredentialPlacement(Option.none())
      const notedQuota = yield* Ref.make<
        ReadonlyArray<Parameters<typeof realPlacement.noteQuota>[0]>
      >([])
      const placement: CredentialPlacement["Service"] = {
        ...realPlacement,
        noteQuota: (quota) =>
          Ref.update(notedQuota, (all) => [...all, quota]).pipe(
            Effect.andThen(realPlacement.noteQuota(quota)),
          ),
      }
      const events = Ref.makeUnsafe<Array<AgentEvent>>([])
      const layer = actorTestRoot({
        resolver: ModelResolver.Live.pipe(
          Layer.provide(
            Auth.Test({ "warm-driver": AuthApi.make({ type: "api", key: "warm-key" }) }),
          ),
          Layer.provide(fixtureModelCatalogSource),
        ),
        eventStore: recordingEventStore(events),
        // The tool runs for real: the warmer reads while it holds.
        toolRunner: ToolRunner.Live,
        registry: ExtensionRegistry.fromResolved(
          resolveExtensions([
            {
              manifest: { id: ExtensionId.make("warm-driver") },
              scope: "builtin",
              sourcePath: "test",
              contributions: { agents: testAgents, modelDrivers: [driver], tools: [holdTool] },
            },
          ]),
        ),
        models: [
          Model.make({
            id: modelId,
            name: "Warm model",
            provider: ProviderId.make("warm-driver"),
            contextLength: 128_000,
            pricing: params.pricing ?? { input: 5, output: 25, cacheRead: READ_COST },
            ...omitUndefined({ promptCacheTtlMs: Option.getOrUndefined(params.ttlMs) }),
          }),
        ],
        overrides: Layer.succeed(CredentialPlacement, placement),
      })
      const sessionId = SessionId.make(`warm-${params.name}-session`)
      const branchId = BranchId.make(`warm-${params.name}-branch`)
      const admission: SessionAdmission = { runSpec: { overrides: { model: modelId } } }
      const gap = Duration.millis(READ_GAP_MS)
      const held = yield* Effect.gen(function* () {
        yield* ensureStorageParents({ sessionId, branchId, admission })
        const turn = yield* Effect.forkChild(
          runAgentLoop(makeMessage(sessionId, branchId, "hold"), admission),
        )
        yield* Deferred.await(started)
        // Each adjust returns once the fibers it woke have suspended again.
        for (let moved = 0; moved < params.gaps; moved++) yield* TestClock.adjust(gap)
        const whileHeld = yield* Ref.get(reads)
        if (params.end === "interrupt") {
          yield* Fiber.interrupt(turn)
          return whileHeld
        }
        yield* Deferred.succeed(released, void 0)
        yield* Fiber.join(turn)
        return whileHeld
      }).pipe(Effect.provide(layer))
      for (let moved = 0; moved < 3; moved++) yield* TestClock.adjust(gap)
      const recorded = yield* Ref.get(events)
      const stepsCost = recorded.reduce((sum, event) => {
        if (event._tag !== "StreamEnded") return sum
        return sum + (event.costUsd ?? 0)
      }, 0)
      const turn = recorded.filter(Schema.is(TurnCompleted))
      return {
        held,
        after: (yield* Ref.get(reads)).length,
        turns: turn.length,
        warmingCost: (turn[0]?.costUsd ?? 0) - stepsCost,
        quota: yield* Ref.get(notedQuota),
      }
    }).pipe(Effect.scoped)

  it.effect("reads the cache before it lapses while tools run, and stops when they end", () =>
    Effect.gen(function* () {
      const { held, after, turns, warmingCost } = yield* runWarmedTurn({
        name: "stops",
        ttlMs: Option.some(CACHE_TTL_MS),
        gaps: 3,
      })
      // Each read waits for the lifetime the last one restarted, less the margin.
      expect(held).toEqual([READ_GAP_MS, 2 * READ_GAP_MS, 3 * READ_GAP_MS])
      expect(after).toBe(3)
      expect(turns).toBe(1)
      // The reads are the turn's spend, though no step made them.
      expect(warmingCost).toBeCloseTo(3 * READ_COST, 9)
    }),
  )

  it.effect("reads at most twelve times however long the tools run", () =>
    Effect.gen(function* () {
      const { held, after, turns, warmingCost } = yield* runWarmedTurn({
        name: "capped",
        ttlMs: Option.some(CACHE_TTL_MS),
        gaps: 15,
      })
      expect(held).toHaveLength(12)
      expect(after).toBe(12)
      expect(turns).toBe(1)
      expect(warmingCost).toBeCloseTo(12 * READ_COST, 9)
    }),
  )

  it.effect("a model whose cache never lapses is not read", () =>
    Effect.gen(function* () {
      const { held, after, turns, warmingCost } = yield* runWarmedTurn({
        name: "lifeless",
        ttlMs: Option.none(),
        gaps: 3,
      })
      expect(held).toEqual([])
      expect(after).toBe(0)
      expect(turns).toBe(1)
      expect(warmingCost).toBeCloseTo(0, 9)
    }),
  )

  it.effect("a failed read stops the reads, and costs nothing", () =>
    Effect.gen(function* () {
      const { held, after, turns, warmingCost } = yield* runWarmedTurn({
        name: "failed",
        ttlMs: Option.some(CACHE_TTL_MS),
        gaps: 4,
        answer: (read) => Effect.succeed(Option.liftPredicate(READ_USAGE, () => read === 0)),
      })
      expect(held).toEqual([READ_GAP_MS, 2 * READ_GAP_MS])
      expect(after).toBe(2)
      expect(turns).toBe(1)
      expect(warmingCost).toBeCloseTo(READ_COST, 9)
    }),
  )

  it.effect("an interrupted turn stops the reads its tools held", () =>
    Effect.gen(function* () {
      const { held, after } = yield* runWarmedTurn({
        name: "interrupted",
        ttlMs: Option.some(CACHE_TTL_MS),
        gaps: 1,
        end: "interrupt",
      })
      expect(held).toEqual([READ_GAP_MS])
      expect(after).toBe(1)
    }),
  )

  it.effect("the quota a read names is noted on the step's account", () =>
    Effect.gen(function* () {
      const reading: QuotaReading = {
        window: "five_hour",
        utilization: 0.4,
        resetAt: 9_000_000,
        rejected: false,
      }
      const { quota } = yield* runWarmedTurn({
        name: "quota",
        ttlMs: Option.some(CACHE_TTL_MS),
        gaps: 1,
        answer: () =>
          reportProviderQuota([reading]).pipe(Effect.as(Option.some<ReadAnswer>(READ_USAGE))),
      })
      expect(quota).toMatchObject([
        { provider: "warm-driver", slot: DEFAULT_CREDENTIAL_SLOT, readings: [reading] },
      ])
    }),
  )

  it.effect("a read that writes the prefix again is priced by its lifetime", () =>
    Effect.gen(function* () {
      // The read came late: the entry lapsed, and the read wrote it again for five minutes.
      const { warmingCost } = yield* runWarmedTurn({
        name: "rewrite",
        ttlMs: Option.some(CACHE_TTL_MS),
        gaps: 1,
        pricing: {
          input: 5,
          output: 25,
          cacheRead: READ_COST,
          cacheWrite: 10,
          cacheWriteByLifetime: [{ ttlMs: CACHE_TTL_MS, price: 6.25 }],
        },
        answer: () =>
          Effect.succeedSome<ReadAnswer>({
            inputTokens: 1_000_000,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 1_000_000,
            cacheWritesByLifetime: [{ ttlMs: CACHE_TTL_MS, tokens: 1_000_000 }],
          }),
      })
      // At the five-minute rate, not the fallback `cacheWrite`.
      expect(warmingCost).toBeCloseTo(6.25, 9)
    }),
  )
})

// ── credential order ────────────────────────────────────────────────────────

describe("credential order", () => {
  const FALLBACK = "fallback"
  const fallbackModel = ModelId.make("fallback/model")
  const fallbackProvider = ProviderId.make(FALLBACK)
  const personal = CredentialSlot.make("personal")
  const work = CredentialSlot.make("work")
  const apiKey = (key: string) => AuthApi.make({ type: "api", key })
  const oauthLogin = AuthInfo.cases.Oauth.make({
    type: "oauth",
    access: "fake-access",
    refresh: "fake-refresh",
    expires: 4_102_444_800_000,
  })
  /** Dollars per million tokens an API key pays; a subscription sign-in lists no price. */
  const apiPricing = { input: 3, output: 15 }
  const subscriptionPricing = { input: 0, output: 0 }
  /** The window each credential lists the model with: the views differ, as an OAuth subset can. */
  const API_WINDOW = 128_000
  const SUBSCRIPTION_WINDOW = 200_000

  /** A usage bucket as the placement's ledger writes it. */
  type SavedBucket = Parameters<
    Option.Option.Value<Parameters<typeof makeCredentialPlacement>[0]>["save"]
  >[0]["buckets"][number]

  /** What a request with one credential streams, by how many it sent before. */
  type Reply = (call: number) => Stream.Stream<LanguageModelStreamPart, AiError.AiError>

  const failWith = (reason: AiError.AiError["reason"]): Stream.Stream<never, AiError.AiError> =>
    Stream.fail(AiError.make({ module: "Fallback", method: "streamText", reason }))
  const httpRequest = {
    method: "POST" as const,
    url: "http://127.0.0.1/nonexistent/loop-probe-x",
    urlParams: [],
    headers: {},
  }
  /** The provider answered 401: the key is refused. */
  const refusal = () =>
    failWith(
      new AiError.AuthenticationError({
        kind: "InvalidKey",
        http: { request: httpRequest, response: { status: 401, headers: {} } },
      }),
    )
  /** The provider answered 429: the account's quota is spent. */
  const quotaSpent = () =>
    failWith(
      new AiError.QuotaExhaustedError({
        http: { request: httpRequest, response: { status: 429, headers: {} } },
      }),
    )
  const answer =
    (text: string, usage = { inputTokens: 10, outputTokens: 5 }): Reply =>
    () =>
      Stream.fromIterable([textDeltaPart(text), finishPart({ finishReason: "stop", usage })])
  /** Output first, then a failure that would move the turn if nothing had been written. */
  const afterOutput =
    (part: LanguageModelStreamPart): Reply =>
    () =>
      Stream.concat(Stream.make(part), quotaSpent())

  const echoTool = tool({
    id: "echo",
    description: "Echoes input",
    params: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
    execute: (params) => Effect.succeed({ text: params.text }),
  })

  /** Which credential a request carried: the stored key, the OAuth sign-in, or none (the environment). */
  const credentialOf = (authInfo: Option.Option<ProviderAuthInfo>): string => {
    if (Option.isNone(authInfo)) return "env"
    if (authInfo.value._tag === "Oauth") return "oauth"
    return authInfo.value.key
  }

  /** The state one in-memory database keeps; one shared value is one database across restarts. */
  type CredentialStorage = Layer.Layer<Layer.Success<typeof testSqliteStorage>>

  interface CredentialRootParams {
    readonly name: string
    readonly order?: ReadonlyArray<CredentialSlot>
    readonly stored: ReadonlyArray<readonly [CredentialSlot, AuthInfo]>
    readonly replies: Readonly<Record<string, Reply>>
    readonly maxModelAttempts?: number
    /** The driver's same-credential retries; default: they end at once. */
    readonly retry?: Partial<typeof DEFAULT_RETRY_POLICY>
    /** The sign-in's order becomes `order` once a request with credential `on` goes out. */
    readonly reorder?: { readonly on: string; readonly order: ReadonlyArray<CredentialSlot> }
    /** The `hold` tool signals here and never returns, as a process that dies in a tool. */
    readonly held?: Deferred.Deferred<void>
    /** Durable state, for a restart: the events go to its log, not to `events`. */
    readonly storage?: CredentialStorage
    /** Messages of this many characters each stored before the turn: 4 or more overflow the window. */
    readonly history?: ReadonlyArray<number>
    /** The compactor the handoff asks; default: `rangeCompactor`. */
    readonly compactor?: ModelContextCompactor["Service"]
    /** The credential the session's run spec pins (`RunSpec.credentialSlot`); default none. */
    readonly pin?: CredentialSlot
    /** The sign-in's pool (`authSpread`); default none. */
    readonly spread?: ReadonlyArray<CredentialSlot>
    /** The server's placement the root's sessions share; default: one in memory per root. */
    readonly placement?: CredentialPlacement["Service"]
    /** The user file lets the sign-in go on past full quota windows (`extraUsage`); default off. */
    readonly extraUsage?: boolean
    /** The model's cache lifetime; default: the catalog names none. */
    readonly cacheTtlMs?: number
    /** The catalog lists the model with no context window: each step fails before its request. */
    readonly windowless?: boolean
    /** The cache lifetime a subscription sign-in lists; default `cacheTtlMs`. */
    readonly subscriptionCacheTtlMs?: number
    /** The spend windows the driver sets on the model; default none. */
    readonly spendLimits?: ReadonlyArray<SpendLimit>
    /** The price the driver bills each request at; default the listed price. */
    readonly requestPricing?: ModelDriverContribution["requestPricing"]
    /** Answers every request by its credential and prompt, in place of `replies`. */
    readonly respond?: (
      credential: string,
      prompt: Prompt.Prompt,
    ) => Stream.Stream<LanguageModelStreamPart, AiError.AiError>
  }

  /**
   * A root that runs `fallback/model` through the live resolver and the live
   * model registry, with `stored` in the auth store and `order` as the
   * sign-in's `authOrder`. The driver answers each request by its
   * credential; it lists the model priced for an API key, free for a
   * subscription sign-in.
   */
  const credentialRoot = (params: CredentialRootParams) => {
    const sent: Array<string> = []
    const resolvedWith: Array<string> = []
    const calls = new Map<string, number>()
    let providerConfig: ProviderConfig = {}
    const setOrder = (order: ReadonlyArray<CredentialSlot>) => {
      providerConfig = {
        providers: {
          [FALLBACK]: { authOrder: order, ...omitUndefined({ authSpread: params.spread }) },
        },
      }
    }
    if (Predicate.isNotUndefined(params.order)) setOrder(params.order)
    const limits = params.spendLimits
    const driver: ModelDriverContribution = {
      id: FALLBACK,
      name: "Fallback driver",
      ...omitUndefined({
        spendLimits: Option.getOrUndefined(
          Option.map(Option.fromUndefinedOr(limits), (found) => () => found),
        ),
        requestPricing: params.requestPricing,
      }),
      // Same-credential retries end at once, so a rate limit moves on quickly.
      retry: {
        ...DEFAULT_RETRY_POLICY,
        initialDelay: 1,
        maxDelay: 5,
        maxAttempts: 2,
        ...params.retry,
      },
      listModels: (_catalog, authInfo) => {
        let pricing = apiPricing
        let contextLength = API_WINDOW
        let promptCacheTtlMs = params.cacheTtlMs
        if (authInfo?._tag === "Oauth") {
          pricing = subscriptionPricing
          contextLength = SUBSCRIPTION_WINDOW
          promptCacheTtlMs = params.subscriptionCacheTtlMs ?? params.cacheTtlMs
        }
        return Effect.succeed([
          Model.make({
            id: fallbackModel,
            name: "Fallback model",
            provider: ProviderId.make(FALLBACK),
            pricing,
            ...omitUndefined({
              promptCacheTtlMs,
              contextLength: Option.getOrUndefined(
                Option.liftPredicate(contextLength, () => params.windowless !== true),
              ),
            }),
          }),
        ])
      },
      resolveModel: (_modelName, authInfo) =>
        Effect.sync(() => {
          const credential = credentialOf(Option.fromUndefinedOr(authInfo))
          resolvedWith.push(credential)
          const providerLayer = LanguageModelLayers.testStream((options) =>
            Effect.sync(() => {
              sent.push(credential)
              if (params.reorder?.on === credential) setOrder(params.reorder.order)
              const call = calls.get(credential) ?? 0
              calls.set(credential, call + 1)
              if (Predicate.isNotUndefined(params.respond))
                return params.respond(credential, Prompt.make(options.prompt))
              const reply = params.replies[credential]
              if (Predicate.isUndefined(reply)) return Stream.die(`no reply for ${credential}`)
              return reply(call)
            }),
          )
          return AiModel.make(FALLBACK, "model", providerLayer)
        }),
    }
    const holdTool = tool({
      id: "hold",
      description: "Holds the turn when the test asks",
      params: Schema.Struct({}),
      output: Schema.String,
      execute: () =>
        Option.match(Option.fromUndefinedOr(params.held), {
          onNone: () => Effect.succeed("released"),
          onSome: (held) => Deferred.succeed(held, void 0).pipe(Effect.andThen(Effect.never)),
        }),
    })
    const authLayer = Layer.effect(
      Auth,
      Effect.gen(function* () {
        const auth = yield* Auth
        for (const [slot, info] of params.stored) yield* auth.set(FALLBACK, info, slot)
        return auth
      }).pipe(Effect.orDie),
    ).pipe(Layer.provide(Auth.Test()))
    const catalogLayers = Layer.mergeAll(authLayer, fixtureModelCatalogSource)
    const events = Ref.makeUnsafe<Array<AgentEvent>>([])
    const durable = Option.map(Option.fromUndefinedOr(params.storage), (storage) => ({
      storage,
      eventStore: Layer.provide(EventStoreLive, storage),
    }))
    const layer = actorTestRoot({
      resolver: ModelResolver.Live.pipe(Layer.provide(catalogLayers)),
      eventStore: Option.match(durable, {
        onNone: () => recordingEventStore(events),
        onSome: (state) => state.eventStore,
      }),
      // A restart re-runs a held tool for real, as a process that resumes does.
      ...omitUndefined({
        storage: Option.getOrUndefined(Option.map(durable, (state) => state.storage)),
        toolRunner: Option.getOrUndefined(Option.map(durable, () => ToolRunner.Live)),
      }),
      registry: ExtensionRegistry.fromResolved(
        resolveExtensions([
          {
            manifest: { id: ExtensionId.make(FALLBACK) },
            scope: "builtin",
            sourcePath: "test",
            contributions: {
              agents: testAgents,
              tools: [echoTool, holdTool],
              modelDrivers: [driver],
            },
          },
        ]),
        Effect.sync(() => providerConfig),
      ),
      overrides: Layer.mergeAll(
        ModelRegistry.Live.pipe(
          Layer.provide(Layer.mergeAll(catalogLayers, ModelCatalogRecord.Live)),
        ),
        ...Option.toArray(
          Option.map(Option.fromUndefinedOr(params.placement), (placement) =>
            Layer.succeed(CredentialPlacement, placement),
          ),
        ),
        ConfigService.Test(
          new UserConfig({
            providers: { [FALLBACK]: { extraUsage: params.extraUsage === true } },
          }),
        ),
      ),
    }).pipe(
      Layer.provideMerge(Layer.succeed(ModelContextCompactor, params.compactor ?? rangeCompactor)),
    )
    const admission: SessionAdmission = {
      runSpec: {
        overrides: {
          model: fallbackModel,
          ...omitUndefined({ maxModelAttempts: params.maxModelAttempts }),
        },
        ...omitUndefined({ credentialSlot: params.pin }),
      },
    }
    const sessionId = SessionId.make(`credential-${params.name}-session`)
    const branchId = BranchId.make(`credential-${params.name}-branch`)
    /** The session's parents and one old assistant message per history entry. */
    const seed = Effect.gen(function* () {
      yield* ensureStorageParents({ sessionId, branchId, admission })
      const storage = yield* MessageStorage
      yield* Effect.forEach(
        params.history ?? [],
        (chars, index) =>
          storage.createMessage(
            Message.cases.regular.make({
              id: MessageId.make(`${params.name}-old-${index + 1}`),
              sessionId,
              branchId,
              role: "assistant",
              parts: [Prompt.textPart({ text: "x".repeat(chars) })],
              createdAt: dateFromMillis(1_000 + index),
            }),
          ),
        { discard: true },
      )
    })
    return { layer, events, sent, resolvedWith, admission, sessionId, branchId, seed }
  }

  /** Each step's credential labels; its sign-in stamp is the store's clock, not the test's. */
  const labelsOf = (ended: ReadonlyArray<AgentEvent>) =>
    ended.flatMap((event) => {
      if (event._tag !== "StreamEnded" || Predicate.isUndefined(event.credential)) return []
      return [{ provider: event.credential.provider, slot: event.credential.slot }]
    })

  /** What a run's events say about its steps, its notices and its retries. */
  const credentialReport = (recorded: ReadonlyArray<AgentEvent>) => ({
    projected: recorded.flatMap((event) => {
      if (event._tag !== "ModelContextProjected") return []
      return [event]
    }),
    ended: recorded.filter((event) => event._tag === "StreamEnded"),
    errors: recorded.flatMap((event) => {
      if (event._tag !== "ErrorOccurred") return []
      return [{ error: event.error, notice: event.notice === true }]
    }),
    retries: recorded.filter((event) => event._tag === "ProviderRetrying").length,
  })

  /** One turn per prompt (default one), in order, on one root. */
  const credentialTurn = (
    params: CredentialRootParams & { readonly prompts?: ReadonlyArray<string> },
  ) =>
    Effect.gen(function* () {
      const root = credentialRoot(params)
      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* root.seed
          return yield* Effect.exit(
            Effect.forEach(
              params.prompts ?? ["hello"],
              (text) =>
                runAgentLoop(makeMessage(root.sessionId, root.branchId, text), root.admission),
              { discard: true },
            ),
          )
        }),
      ).pipe(Effect.provide(root.layer))
      return {
        outcome,
        sent: root.sent,
        resolvedWith: root.resolvedWith,
        ...credentialReport(yield* Ref.get(root.events)),
      }
    }).pipe(Effect.timeout("15 seconds"))

  it.live("a refused credential hands the turn to the next one, which keeps it", () =>
    Effect.gen(function* () {
      const run = yield* credentialTurn({
        name: "refused",
        order: [DEFAULT_CREDENTIAL_SLOT, personal],
        stored: [
          [DEFAULT_CREDENTIAL_SLOT, apiKey("sk-a")],
          [personal, apiKey("sk-b")],
        ],
        replies: {
          "sk-a": refusal,
          "sk-b": (call) => {
            if (call === 0) {
              return Stream.fromIterable([
                toolCallPart("echo", { text: "hi" }),
                finishPart({ finishReason: "tool-calls" }),
              ])
            }
            return answer("done")(call)
          },
        },
      })
      // A refuses once; B answers the step and the tool step after it.
      expect(run.sent).toEqual(["sk-a", "sk-b", "sk-b"])
      expect(labelsOf(run.ended)).toEqual([
        { provider: fallbackProvider, slot: personal },
        { provider: fallbackProvider, slot: personal },
      ])
      expect(run.errors).toEqual([
        {
          error: `Credential "default" of ${FALLBACK} was refused; continuing with "personal"`,
          notice: true,
        },
      ])
    }),
  )

  /** Each account of the fallback provider the lanes name a lost login on, with its reason. */
  const lostLoginsOf = (placement: CredentialPlacement["Service"]) =>
    Effect.map(
      placement.lanes(
        () => Effect.succeedSome([{ provider: fallbackProvider, slot: personal }]),
        noHolds,
        Option.none(),
      ),
      (report) =>
        report.providers
          .filter((lanes) => lanes.provider === FALLBACK)
          .flatMap((lanes) => lanes.accounts)
          .flatMap((account) =>
            Option.toArray(
              Option.map(Option.fromUndefinedOr(account.loginLost), (lost) => [
                account.slot,
                lost.reason,
              ]),
            ),
          ),
    )

  it.live("a refused credential is a lost login the lanes name; the one that served is not", () =>
    Effect.gen(function* () {
      const placement = yield* makeCredentialPlacement(Option.none())
      const run = yield* credentialTurn({
        name: "lost-login",
        order: [DEFAULT_CREDENTIAL_SLOT, personal],
        placement,
        stored: [
          [DEFAULT_CREDENTIAL_SLOT, apiKey("sk-a")],
          [personal, apiKey("sk-b")],
        ],
        replies: { "sk-a": refusal, "sk-b": answer("done") },
      })
      expect(run.sent).toEqual(["sk-a", "sk-b"])
      expect(yield* lostLoginsOf(placement)).toEqual([[DEFAULT_CREDENTIAL_SLOT, "Rejected"]])
    }).pipe(Effect.provide(BunServices.layer)),
  )

  it.live("a pinned run's refused credential is a lost login too, and a spent quota is not", () =>
    Effect.gen(function* () {
      const placement = yield* makeCredentialPlacement(Option.none())
      const refused = yield* credentialTurn({
        name: "lost-login-pinned",
        order: [personal],
        pin: personal,
        placement,
        stored: [[personal, apiKey("sk-b")]],
        replies: { "sk-b": refusal },
      })
      // The pin is the order: nothing else is tried.
      expect(refused.sent).toEqual(["sk-b"])
      expect(yield* lostLoginsOf(placement)).toEqual([[personal, "Rejected"]])
      const spent = yield* makeCredentialPlacement(Option.none())
      yield* credentialTurn({
        name: "spent-quota-pinned",
        order: [personal],
        pin: personal,
        placement: spent,
        stored: [[personal, apiKey("sk-b")]],
        replies: { "sk-b": quotaSpent },
      })
      expect(yield* lostLoginsOf(spent)).toEqual([])
    }).pipe(Effect.provide(BunServices.layer)),
  )

  it.live("a run pinned to a credential sends every request on it, whatever the authOrder", () =>
    Effect.gen(function* () {
      const run = yield* credentialTurn({
        name: "pinned",
        order: [DEFAULT_CREDENTIAL_SLOT, personal],
        pin: personal,
        stored: [
          [DEFAULT_CREDENTIAL_SLOT, apiKey("sk-a")],
          [personal, apiKey("sk-b")],
        ],
        prompts: ["first", "second"],
        replies: {
          "sk-a": answer("from a"),
          "sk-b": (call) => {
            if (call === 0) {
              return Stream.fromIterable([
                toolCallPart("echo", { text: "hi" }),
                finishPart({ finishReason: "tool-calls" }),
              ])
            }
            return answer("from b")(call)
          },
        },
      })
      // Two turns, three steps: the default answers, but the pin names who pays.
      expect(run.sent).toEqual(["sk-b", "sk-b", "sk-b"])
      expect(run.resolvedWith.includes("sk-a")).toBe(false)
      expect(labelsOf(run.ended)).toEqual([
        { provider: fallbackProvider, slot: personal },
        { provider: fallbackProvider, slot: personal },
        { provider: fallbackProvider, slot: personal },
      ])
      expect(run.errors).toEqual([])
    }),
  )

  it.live(
    "a pinned run whose credential refuses fails the turn, and never moves to another credential",
    () =>
      Effect.gen(function* () {
        const run = yield* credentialTurn({
          name: "pinned-refused",
          order: [DEFAULT_CREDENTIAL_SLOT, personal],
          pin: personal,
          stored: [
            [DEFAULT_CREDENTIAL_SLOT, apiKey("sk-a")],
            [personal, apiKey("sk-b")],
          ],
          replies: { "sk-a": answer("from a"), "sk-b": refusal },
        })
        expect(run.sent).toEqual(["sk-b"])
        expect(run.resolvedWith.includes("sk-a")).toBe(false)
        expect(run.errors.some((entry) => entry.notice)).toBe(false)
        expect(run.errors.some((entry) => entry.error.includes("continuing with"))).toBe(false)
        expect(run.ended.map((event) => [event.credential?.slot, event.outcome])).toEqual([
          [personal, "Failed"],
        ])
      }),
  )

  it.live(
    "a pinned summary and a pinned child stay on the pin where the order would move them",
    () =>
      Effect.gen(function* () {
        const keys = [
          [DEFAULT_CREDENTIAL_SLOT, apiKey("sk-a")],
          [personal, apiKey("sk-b")],
        ] as const
        // The handoff summary walks the pinned order: a refusal fails it, and
        // no other credential makes it.
        const summary = yield* credentialTurn({
          name: "pinned-summary",
          order: [personal, DEFAULT_CREDENTIAL_SLOT],
          pin: personal,
          stored: keys,
          history: Array.from({ length: 12 }, () => 50_000),
          replies: { "sk-a": answer("from a"), "sk-b": quotaSpent },
        })
        // The summary fails and the turn omits old messages instead; its step
        // then fails on the pin too. Neither moves to the default.
        expect(summary.sent).toEqual(["sk-b", "sk-b"])
        expect(summary.errors.some((entry) => entry.error.startsWith("Credential"))).toBe(false)
        // A pinned child's first turn does not start from its parent's place
        // in the order: the parent's turn moved to personal, an unpinned child
        // would start there, and the child pinned to the default pays on it.
        const storage: CredentialStorage = Layer.succeedContext(
          yield* Layer.build(testSqliteStorage).pipe(Effect.orDie),
        )
        const order = [DEFAULT_CREDENTIAL_SLOT, personal]
        const runOn = (root: ReturnType<typeof credentialRoot>) =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* ensureStorageParents({
                sessionId: root.sessionId,
                branchId: root.branchId,
                admission: root.admission,
              })
              yield* runAgentLoop(
                makeMessage(root.sessionId, root.branchId, "hello"),
                root.admission,
              )
            }),
          ).pipe(Effect.provide(root.layer))
        const parent = credentialRoot({
          name: "pin-parent",
          order,
          stored: keys,
          storage,
          replies: { "sk-a": refusal, "sk-b": answer("from b") },
        })
        yield* runOn(parent)
        expect(parent.sent).toEqual(["sk-a", "sk-b"])
        const child = credentialRoot({
          name: "pin-child",
          order,
          pin: DEFAULT_CREDENTIAL_SLOT,
          stored: keys,
          storage,
          replies: { "sk-a": answer("from a"), "sk-b": answer("from b") },
        })
        yield* Effect.gen(function* () {
          const now = dateFromMillis(yield* Clock.currentTimeMillis)
          yield* (yield* SessionStorage).createSession(
            new Session({
              id: child.sessionId,
              parentSessionId: parent.sessionId,
              parentBranchId: parent.branchId,
              createdAt: now,
              updatedAt: now,
              admission: child.admission,
            }),
          )
        }).pipe(Effect.provide(storage), Effect.orDie)
        yield* runOn(child)
        expect(child.sent).toEqual(["sk-a"])
      }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
  )

  it.live(
    "an unpinned child of a pinned parent starts at the top of its own order, not on the parent's pin",
    () =>
      Effect.gen(function* () {
        const keys = [
          [DEFAULT_CREDENTIAL_SLOT, apiKey("sk-a")],
          [personal, apiKey("sk-b")],
        ] as const
        const storage: CredentialStorage = Layer.succeedContext(
          yield* Layer.build(testSqliteStorage).pipe(Effect.orDie),
        )
        const order = [DEFAULT_CREDENTIAL_SLOT, personal]
        const runOn = (root: ReturnType<typeof credentialRoot>) =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* ensureStorageParents({
                sessionId: root.sessionId,
                branchId: root.branchId,
                admission: root.admission,
              })
              yield* runAgentLoop(
                makeMessage(root.sessionId, root.branchId, "hello"),
                root.admission,
              )
            }),
          ).pipe(Effect.provide(root.layer))
        // The parent is pinned to personal: its receipts say personal, and
        // prove nothing about the default it never walked.
        const parent = credentialRoot({
          name: "pinned-parent",
          order,
          pin: personal,
          stored: keys,
          storage,
          replies: { "sk-a": answer("from a"), "sk-b": answer("from b") },
        })
        yield* runOn(parent)
        expect(parent.sent).toEqual(["sk-b"])
        // A named-agent thread of that parent stores no pin and walks the order.
        const child = credentialRoot({
          name: "unpinned-child",
          order,
          stored: keys,
          storage,
          replies: { "sk-a": answer("from a"), "sk-b": answer("from b") },
        })
        yield* Effect.gen(function* () {
          const now = dateFromMillis(yield* Clock.currentTimeMillis)
          yield* (yield* SessionStorage).createSession(
            new Session({
              id: child.sessionId,
              parentSessionId: parent.sessionId,
              parentBranchId: parent.branchId,
              createdAt: now,
              updatedAt: now,
              admission: child.admission,
            }),
          )
        }).pipe(Effect.provide(storage), Effect.orDie)
        yield* runOn(child)
        expect(child.sent).toEqual(["sk-a"])
      }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
  )

  it.live("an exhausted quota moves the turn on; one that answers stays", () =>
    Effect.gen(function* () {
      const moved = yield* credentialTurn({
        name: "quota",
        order: [DEFAULT_CREDENTIAL_SLOT, personal],
        stored: [
          [DEFAULT_CREDENTIAL_SLOT, apiKey("sk-a")],
          [personal, apiKey("sk-b")],
        ],
        replies: { "sk-a": quotaSpent, "sk-b": answer("from b") },
      })
      expect(moved.sent).toEqual(["sk-a", "sk-b"])
      expect(moved.ended.map((event) => event.outcome)).toEqual(["Answered"])
      const stayed = yield* credentialTurn({
        name: "stays",
        order: [DEFAULT_CREDENTIAL_SLOT, personal],
        stored: [
          [DEFAULT_CREDENTIAL_SLOT, apiKey("sk-a")],
          [personal, apiKey("sk-b")],
        ],
        replies: { "sk-a": answer("from a"), "sk-b": answer("from b") },
      })
      expect(stayed.sent).toEqual(["sk-a"])
      expect(labelsOf(stayed.ended)).toEqual([
        { provider: fallbackProvider, slot: DEFAULT_CREDENTIAL_SLOT },
      ])
    }),
  )

  it.live("a handoff summary walks the order as a step does, with one notice", () =>
    Effect.gen(function* () {
      const run = yield* credentialTurn({
        name: "summary-moves",
        order: [DEFAULT_CREDENTIAL_SLOT, personal],
        stored: [
          [DEFAULT_CREDENTIAL_SLOT, apiKey("sk-a")],
          [personal, apiKey("sk-b")],
        ],
        // About 150k tokens: over the 128k window, so the turn hands it off first.
        history: Array.from({ length: 12 }, () => 50_000),
        replies: { "sk-a": quotaSpent, "sk-b": answer("from b") },
      })
      // Default refuses the summary; personal makes it, and the step stays there.
      expect(run.sent).toEqual(["sk-a", "sk-b", "sk-b"])
      expect(run.projected.map((event) => event.compacted)).toEqual([true])
      expect(run.errors).toEqual([
        {
          error: `Credential "default" of ${FALLBACK} is out of quota; continuing with "personal"`,
          notice: true,
        },
      ])
      expect(labelsOf(run.ended)).toEqual([{ provider: fallbackProvider, slot: personal }])
    }),
  )

  it.live("a chained compactor's refusal moves its summary before the next compactor runs", () =>
    Effect.gen(function* () {
      const builtinCalls = Ref.makeUnsafe(0)
      // The builtin under it refuses with no model failure behind it, as the
      // shipped one does for a history it cannot fit.
      const builtin = ModelContextCompactor.of({
        compact: (request) =>
          Ref.update(builtinCalls, (count) => count + 1).pipe(
            Effect.andThen(
              Effect.fail(
                new ModelCompactionError({ modelId: request.modelId, reason: "SourceTooLarge" }),
              ),
            ),
          ),
      })
      const run = yield* credentialTurn({
        name: "chain-refusal",
        order: [DEFAULT_CREDENTIAL_SLOT, personal],
        stored: [
          [DEFAULT_CREDENTIAL_SLOT, apiKey("sk-a")],
          [personal, apiKey("sk-b")],
        ],
        history: Array.from({ length: 12 }, () => 50_000),
        compactor: chainCompactors(rangeCompactor, builtin),
        replies: { "sk-a": quotaSpent, "sk-b": answer("from b") },
      })
      // The project compactor makes the summary on personal; the history is not dropped.
      expect(run.sent).toEqual(["sk-a", "sk-b", "sk-b"])
      expect(run.projected.map((event) => event.compacted)).toEqual([true])
      expect(run.errors).toEqual([
        {
          error: `Credential "default" of ${FALLBACK} is out of quota; continuing with "personal"`,
          notice: true,
        },
      ])
      expect(yield* Ref.get(builtinCalls)).toBe(0)
      expect(labelsOf(run.ended)).toEqual([{ provider: fallbackProvider, slot: personal }])
    }),
  )

  it.live("each compactor of a chain gets the summary's retries once", () =>
    Effect.gen(function* () {
      const run = yield* credentialTurn({
        name: "chain-retries",
        order: [DEFAULT_CREDENTIAL_SLOT],
        stored: [[DEFAULT_CREDENTIAL_SLOT, apiKey("sk-a")]],
        history: Array.from({ length: 12 }, () => 50_000),
        compactor: chainCompactors(rangeCompactor, rangeCompactor),
        replies: {
          "sk-a": (call) => {
            if (call < 4) return failWith(new AiError.RateLimitError({}))
            return answer("from a")(call)
          },
        },
      })
      // Two tries per compactor, then the window is cut and the step answers.
      expect(run.sent).toEqual(["sk-a", "sk-a", "sk-a", "sk-a", "sk-a"])
      expect(run.retries).toBe(2)
      expect(run.projected.map((event) => event.compacted)).toEqual([false])
      expect(
        run.errors.map((entry) => entry.error.startsWith("Context compaction failed")),
      ).toEqual([true])
    }),
  )

  it.live("a handoff summary retries a transient rate limit on its own credential", () =>
    Effect.gen(function* () {
      const run = yield* credentialTurn({
        name: "summary-retries",
        order: [DEFAULT_CREDENTIAL_SLOT, personal],
        stored: [
          [DEFAULT_CREDENTIAL_SLOT, apiKey("sk-a")],
          [personal, apiKey("sk-b")],
        ],
        history: Array.from({ length: 12 }, () => 50_000),
        replies: {
          "sk-a": (call) => {
            if (call === 0) return failWith(new AiError.RateLimitError({}))
            return answer("from a")(call)
          },
          "sk-b": answer("from b"),
        },
      })
      // One 429, one retry on default: the summary and the step stay there.
      expect(run.sent).toEqual(["sk-a", "sk-a", "sk-a"])
      expect(run.retries).toBe(1)
      expect(run.projected.map((event) => event.compacted)).toEqual([true])
      expect(run.errors).toEqual([])
      expect(labelsOf(run.ended)).toEqual([
        { provider: fallbackProvider, slot: DEFAULT_CREDENTIAL_SLOT },
      ])
    }),
  )

  it.live("a handoff summary moves on a rate limit only once its retries end", () =>
    Effect.gen(function* () {
      const run = yield* credentialTurn({
        name: "summary-rate-limit",
        order: [DEFAULT_CREDENTIAL_SLOT, personal],
        stored: [
          [DEFAULT_CREDENTIAL_SLOT, apiKey("sk-a")],
          [personal, apiKey("sk-b")],
        ],
        history: Array.from({ length: 12 }, () => 50_000),
        replies: {
          "sk-a": () => failWith(new AiError.RateLimitError({})),
          "sk-b": answer("from b"),
        },
      })
      expect(run.sent).toEqual(["sk-a", "sk-a", "sk-b", "sk-b"])
      expect(run.retries).toBe(1)
      expect(run.projected.map((event) => event.compacted)).toEqual([true])
      expect(run.errors).toEqual([
        {
          error: `Credential "default" of ${FALLBACK} is rate limited; continuing with "personal"`,
          notice: true,
        },
      ])
      expect(labelsOf(run.ended)).toEqual([{ provider: fallbackProvider, slot: personal }])
    }),
  )

  it.live("a rate limit moves the turn on only once its same-credential retries end", () =>
    Effect.gen(function* () {
      const run = yield* credentialTurn({
        name: "rate-limit",
        order: [DEFAULT_CREDENTIAL_SLOT, personal],
        stored: [
          [DEFAULT_CREDENTIAL_SLOT, apiKey("sk-a")],
          [personal, apiKey("sk-b")],
        ],
        replies: {
          "sk-a": () => failWith(new AiError.RateLimitError({})),
          "sk-b": answer("from b"),
        },
      })
      expect(run.sent).toEqual(["sk-a", "sk-a", "sk-b"])
      expect(run.retries).toBe(1)
    }),
  )

  for (const [name, part] of [
    ["text", textDeltaPart("partial")],
    ["reasoning", reasoningDeltaPart("thinking")],
    ["tool-call", toolCallPart("echo", { text: "hi" })],
    [
      "file",
      Response.makePart("file", { mediaType: "image/png", data: new Uint8Array([137, 80]) }),
    ],
    [
      "approval-request",
      Response.makePart("tool-approval-request", {
        approvalId: "approval-1",
        toolCallId: "call-1",
      }),
    ],
  ] as const) {
    it.live(`${name} output keeps the turn on its credential when the stream then fails`, () =>
      Effect.gen(function* () {
        const run = yield* credentialTurn({
          name: `after-${name}`,
          order: [DEFAULT_CREDENTIAL_SLOT, personal],
          stored: [
            [DEFAULT_CREDENTIAL_SLOT, apiKey("sk-a")],
            [personal, apiKey("sk-b")],
          ],
          replies: { "sk-a": afterOutput(part), "sk-b": answer("from b") },
        })
        // The turn keeps what arrived and goes on, every step on the same credential.
        expect(run.sent.length).toBeGreaterThan(0)
        expect(run.sent.every((credential) => credential === "sk-a")).toBe(true)
        expect(run.ended.map((event) => event.outcome)).toContain("Failed")
        expect(run.ended.map((event) => event.credential?.slot)).toEqual(
          run.ended.map(() => DEFAULT_CREDENTIAL_SLOT),
        )
        expect(run.errors.some((entry) => entry.error.includes("continuing with"))).toBe(false)
      }),
    )
  }

  for (const [name, reply] of [
    [
      "a network fault",
      () => failWith(new AiError.NetworkError({ reason: "TransportError", request: httpRequest })),
    ],
    [
      "an overload",
      () => failWith(new AiError.InternalProviderError({ description: "overloaded" })),
    ],
    [
      "a refused request",
      () =>
        failWith(
          new AiError.InvalidRequestError({
            http: { request: httpRequest, response: { status: 400, headers: {} } },
          }),
        ),
    ],
    [
      "an authentication error no response proves",
      () => failWith(new AiError.AuthenticationError({ kind: "InvalidKey" })),
    ],
    ["a defect", () => Stream.die("driver bug")],
  ] as const satisfies ReadonlyArray<readonly [string, Reply]>) {
    it.live(`${name} leaves the turn on its credential`, () =>
      Effect.gen(function* () {
        const run = yield* credentialTurn({
          name: name.replaceAll(" ", "-"),
          order: [DEFAULT_CREDENTIAL_SLOT, personal],
          stored: [
            [DEFAULT_CREDENTIAL_SLOT, apiKey("sk-a")],
            [personal, apiKey("sk-b")],
          ],
          replies: { "sk-a": reply, "sk-b": answer("from b") },
        })
        expect(run.sent.includes("sk-b")).toBe(false)
        expect(run.errors.some((entry) => entry.error.includes("continuing with"))).toBe(false)
      }),
    )
  }

  it.live("a named credential with nothing stored never falls back to the environment", () =>
    Effect.gen(function* () {
      // Only the named slot is in the order: the turn fails without a request.
      const alone = yield* credentialTurn({
        name: "named-alone",
        order: [work],
        stored: [],
        replies: { env: answer("from env") },
      })
      expect(alone.resolvedWith).toEqual([])
      expect(alone.errors.map((entry) => entry.error)).toEqual([
        `Credential "work" of provider "${FALLBACK}" holds no sign-in: it was removed in /auth or never signed in. Sign it in again in /auth, or move another credential into the order`,
      ])
      // First in the order, it moves the turn to the stored default.
      const first = yield* credentialTurn({
        name: "named-first",
        order: [work, DEFAULT_CREDENTIAL_SLOT],
        stored: [[DEFAULT_CREDENTIAL_SLOT, apiKey("sk-a")]],
        replies: { "sk-a": answer("from a"), env: answer("from env") },
      })
      expect(first.resolvedWith).toEqual(["sk-a"])
      expect(labelsOf(first.ended)).toEqual([
        { provider: fallbackProvider, slot: DEFAULT_CREDENTIAL_SLOT },
      ])
    }),
  )

  it.live("a step is projected by the window of the credential it goes out with", () =>
    Effect.gen(function* () {
      // The API key lists a 128k window, the subscription 200k. The first
      // step goes out with the key and moves; the second runs on the sign-in.
      const run = yield* credentialTurn({
        name: "window",
        order: [DEFAULT_CREDENTIAL_SLOT, personal],
        stored: [
          [DEFAULT_CREDENTIAL_SLOT, apiKey("sk-a")],
          [personal, oauthLogin],
        ],
        replies: {
          "sk-a": refusal,
          oauth: (call) => {
            if (call === 0) {
              return Stream.fromIterable([
                toolCallPart("echo", { text: "hi" }),
                finishPart({ finishReason: "tool-calls" }),
              ])
            }
            return answer("done")(call)
          },
        },
      })
      expect(run.sent).toEqual(["sk-a", "oauth", "oauth"])
      expect(run.projected.map((event) => event.contextLimitTokens)).toEqual([
        API_WINDOW,
        SUBSCRIPTION_WINDOW,
      ])
    }),
  )

  it.live("a step's receipt carries its credential's sign-in; the environment's has none", () =>
    Effect.gen(function* () {
      const stored = yield* credentialTurn({
        name: "stamp-stored",
        stored: [[DEFAULT_CREDENTIAL_SLOT, apiKey("sk-a")]],
        replies: { "sk-a": answer("from a") },
      })
      expect(stored.ended.map((event) => Predicate.isNumber(event.credential?.signedInAt))).toEqual(
        [true],
      )
      const fromEnv = yield* credentialTurn({
        name: "stamp-env",
        stored: [],
        replies: { env: answer("from env") },
      })
      expect(
        fromEnv.ended.map((event) => Predicate.isUndefined(event.credential?.signedInAt)),
      ).toEqual([true])
    }),
  )

  it.live("each credential the turn tries spends one model attempt", () =>
    Effect.gen(function* () {
      const run = yield* credentialTurn({
        name: "attempt-budget",
        order: [DEFAULT_CREDENTIAL_SLOT, personal],
        stored: [
          [DEFAULT_CREDENTIAL_SLOT, apiKey("sk-a")],
          [personal, apiKey("sk-b")],
        ],
        replies: { "sk-a": refusal, "sk-b": answer("from b") },
        maxModelAttempts: 1,
      })
      expect(run.sent).toEqual(["sk-a"])
      expect(
        run.errors.some((entry) =>
          entry.error.startsWith("Stopped at the model-call budget: 1 of 1 model calls used"),
        ),
      ).toBe(true)
    }),
  )

  it.live("a step is priced as its credential lists the model", () =>
    Effect.gen(function* () {
      const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
      // The subscription sign-in is spent; the API key answers and pays.
      const paid = yield* credentialTurn({
        name: "priced-api",
        order: [DEFAULT_CREDENTIAL_SLOT, personal],
        stored: [
          [DEFAULT_CREDENTIAL_SLOT, oauthLogin],
          [personal, apiKey("sk-b")],
        ],
        replies: { oauth: quotaSpent, "sk-b": answer("paid", usage) },
      })
      expect(paid.ended.map((event) => [event.credential?.slot, event.costUsd])).toEqual([
        [personal, apiPricing.input + apiPricing.output],
      ])
      // The subscription sign-in answers: the same model costs nothing.
      const free = yield* credentialTurn({
        name: "priced-subscription",
        order: [DEFAULT_CREDENTIAL_SLOT, personal],
        stored: [
          [DEFAULT_CREDENTIAL_SLOT, oauthLogin],
          [personal, apiKey("sk-b")],
        ],
        replies: { oauth: answer("free", usage), "sk-b": answer("paid", usage) },
      })
      expect(free.ended.map((event) => [event.credential?.slot, event.costUsd])).toEqual([
        [DEFAULT_CREDENTIAL_SLOT, 0],
      ])
    }),
  )

  const twoKeys = [
    [DEFAULT_CREDENTIAL_SLOT, apiKey("sk-a")],
    [personal, apiKey("sk-b")],
  ] as const

  it.live("a new turn starts its credential order again", () =>
    Effect.gen(function* () {
      const run = yield* credentialTurn({
        name: "new-turn",
        order: [DEFAULT_CREDENTIAL_SLOT, personal],
        stored: twoKeys,
        prompts: ["first", "second"],
        replies: {
          "sk-a": (call) => {
            if (call === 0) return refusal()
            return answer("from a")(call)
          },
          "sk-b": answer("from b"),
        },
      })
      // The first turn leaves A; the second asks A first again, and A answers.
      expect(run.sent).toEqual(["sk-a", "sk-b", "sk-a"])
      expect(run.ended.map((event) => event.credential?.slot)).toEqual([
        personal,
        DEFAULT_CREDENTIAL_SLOT,
      ])
    }),
  )

  it.live("a cancel during a same-credential retry wait leaves the credential", () =>
    Effect.gen(function* () {
      const root = credentialRoot({
        name: "cancel-backoff",
        order: [DEFAULT_CREDENTIAL_SLOT, personal],
        stored: twoKeys,
        // The retry waits long enough for the cancel to land inside it.
        retry: { initialDelay: 60_000, maxDelay: 120_000 },
        replies: {
          "sk-a": () => failWith(new AiError.RateLimitError({})),
          "sk-b": answer("from b"),
        },
      })
      const message = makeMessage(root.sessionId, root.branchId, "hello")
      const seen = (tag: AgentEvent["_tag"]) =>
        waitFor(
          Ref.get(root.events),
          (all) => all.some((event) => event._tag === tag),
          5_000,
          `a ${tag} event`,
        )
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* submitAgentLoop(message, root.admission)
          yield* seen("ProviderRetrying")
          yield* stopAgentLoopMessage({
            sessionId: root.sessionId,
            branchId: root.branchId,
            messageId: message.id,
            requestId: "cancel-backoff",
          })
          yield* seen("TurnCompleted")
        }),
      ).pipe(Effect.provide(root.layer))
      const report = credentialReport(yield* Ref.get(root.events))
      // No move: B is never resolved and no notice says the turn continues.
      expect(root.sent).toEqual(["sk-a"])
      expect(root.resolvedWith).toEqual(["sk-a"])
      expect(report.errors.some((entry) => entry.error.includes("continuing with"))).toBe(false)
    }).pipe(Effect.timeout("15 seconds")),
  )

  /** Waits for the first event with the tag; fails when none comes in time. */
  type Seen = (
    tag: AgentEvent["_tag"],
  ) => Effect.Effect<void, Effect.Error<ReturnType<typeof waitFor>>>
  /**
   * One turn over a seeded history, stopped once `before` returns; `after`
   * runs once the stop is in. Returns the turn's events and the model calls
   * its budget row counts.
   */
  const stoppedTurn = (
    params: CredentialRootParams & {
      readonly before: (seen: Seen) => Effect.Effect<void, Effect.Error<ReturnType<Seen>>>
      readonly after?: Effect.Effect<void>
    },
  ) =>
    Effect.gen(function* () {
      const root = credentialRoot(params)
      const message = makeMessage(root.sessionId, root.branchId, "hello")
      const seen = (tag: AgentEvent["_tag"]) =>
        waitFor(
          Ref.get(root.events),
          (all) => all.some((event) => event._tag === tag),
          5_000,
          `a ${tag} event`,
        ).pipe(Effect.asVoid)
      const attemptsUsed = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* root.seed
          yield* submitAgentLoop(message, root.admission)
          yield* params.before(seen)
          yield* stopAgentLoopMessage({
            sessionId: root.sessionId,
            branchId: root.branchId,
            messageId: message.id,
            requestId: params.name,
          })
          yield* params.after ?? Effect.void
          yield* seen("TurnCompleted")
          const operations = yield* SessionOperationStorage
          return yield* operations.modelAttemptsUsed({ messageId: message.id })
        }),
      ).pipe(Effect.provide(root.layer))
      const recorded = yield* Ref.get(root.events)
      return {
        sent: root.sent,
        attemptsUsed,
        assigned: recorded.flatMap((event) => {
          if (event._tag !== "CredentialAssigned") return []
          return [{ slot: event.slot, reason: event.reason }]
        }),
        ...credentialReport(recorded),
        interrupted: recorded.flatMap((event) => {
          if (event._tag !== "TurnCompleted") return []
          return [event.interrupted === true]
        }),
      }
    }).pipe(Effect.timeout("15 seconds"))

  it.live(
    "a cancel during a chained summary's retry wait ends the turn with no other model call",
    () =>
      Effect.gen(function* () {
        const run = yield* stoppedTurn({
          name: "cancel-summary-backoff",
          order: [DEFAULT_CREDENTIAL_SLOT, personal],
          stored: twoKeys,
          maxModelAttempts: 10,
          // The retry waits long enough for the cancel to land inside it.
          retry: { initialDelay: 60_000, maxDelay: 120_000 },
          history: Array.from({ length: 12 }, () => 50_000),
          compactor: chainCompactors(rangeCompactor, rangeCompactor),
          replies: {
            "sk-a": () => failWith(new AiError.RateLimitError({})),
            "sk-b": answer("from b"),
          },
          before: (seen) => seen("ProviderRetrying"),
        })
        // The first summary's request is the only one: no second compactor,
        // no step, no move, and no truncation notice.
        expect(run.sent).toEqual(["sk-a"])
        expect(run.attemptsUsed).toBe(1)
        expect(run.errors).toEqual([])
        expect(run.projected).toEqual([])
        expect(run.interrupted).toEqual([true])
      }),
  )

  it.live("a compactor that asks for its summary model after a stop gets no model", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const finished = yield* Deferred.make<void>()
      // It holds the window until the stop is in, and no stop can end it
      // first: it reaches the summary model's admission after the stop.
      const late = ModelContextCompactor.of({
        compact: (request) =>
          Deferred.succeed(entered, void 0).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(rangeCompactor.compact(request)),
            Effect.ensuring(Deferred.succeed(finished, void 0)),
            Effect.uninterruptible,
          ),
      })
      const run = yield* stoppedTurn({
        name: "late-summary",
        order: [DEFAULT_CREDENTIAL_SLOT],
        stored: [[DEFAULT_CREDENTIAL_SLOT, apiKey("sk-a")]],
        maxModelAttempts: 10,
        history: Array.from({ length: 12 }, () => 50_000),
        compactor: late,
        replies: { "sk-a": answer("from a") },
        before: () => Deferred.await(entered),
        after: Deferred.succeed(release, void 0).pipe(Effect.andThen(Deferred.await(finished))),
      })
      expect(run.sent).toEqual([])
      expect(run.attemptsUsed).toBe(0)
      expect(run.errors).toEqual([])
      expect(run.interrupted).toEqual([true])
    }),
  )

  it.live("a reorder while a request runs leaves its receipt, price and move on its slot", () =>
    Effect.gen(function* () {
      const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
      const stored = [
        [DEFAULT_CREDENTIAL_SLOT, oauthLogin],
        [personal, apiKey("sk-b")],
      ] as const
      // The order turns around as the subscription's request goes out.
      const reorder = { on: "oauth", order: [personal, DEFAULT_CREDENTIAL_SLOT] }
      const answered = yield* credentialTurn({
        name: "reorder-answered",
        order: [DEFAULT_CREDENTIAL_SLOT, personal],
        stored,
        reorder,
        replies: { oauth: answer("free", usage), "sk-b": answer("paid", usage) },
      })
      // The subscription served the step: its receipt and its price.
      expect(answered.ended.map((event) => [event.credential?.slot, event.costUsd])).toEqual([
        [DEFAULT_CREDENTIAL_SLOT, 0],
      ])
      const moved = yield* credentialTurn({
        name: "reorder-moved",
        order: [DEFAULT_CREDENTIAL_SLOT, personal],
        stored,
        reorder,
        replies: { oauth: quotaSpent, "sk-b": answer("paid", usage) },
      })
      // The subscription failed: the turn leaves it, never the key it did not use.
      expect(moved.sent).toEqual(["oauth", "sk-b"])
      expect(moved.errors).toEqual([
        {
          error: `Credential "default" of ${FALLBACK} is out of quota; continuing with "personal"`,
          notice: true,
        },
      ])
      expect(moved.ended.map((event) => [event.credential?.slot, event.costUsd])).toEqual([
        [personal, apiPricing.input + apiPricing.output],
      ])
    }),
  )

  it.live("an order edited mid-turn to only slots the turn left names the edit", () =>
    Effect.gen(function* () {
      const run = yield* credentialTurn({
        name: "reorder-passed",
        order: [DEFAULT_CREDENTIAL_SLOT, personal],
        stored: [
          [DEFAULT_CREDENTIAL_SLOT, apiKey("sk-a")],
          [personal, apiKey("sk-b")],
        ],
        // Once B serves, the order names only A, which the turn already left.
        reorder: { on: "sk-b", order: [DEFAULT_CREDENTIAL_SLOT] },
        replies: {
          "sk-a": quotaSpent,
          "sk-b": () =>
            Stream.fromIterable([
              toolCallPart("echo", { text: "hi" }),
              finishPart({ finishReason: "tool-calls" }),
            ]),
        },
      })
      expect(run.sent).toEqual(["sk-a", "sk-b"])
      expect(run.errors.map((entry) => entry.error).at(-1)).toBe(
        `The authOrder of provider "${FALLBACK}" changed during this turn, and the turn already left every credential it names now (default). The next turn starts again at its first credential`,
      )
    }),
  )

  it.live("a turn resumed after a restart stays on the credential it moved to", () =>
    Effect.gen(function* () {
      const storage: CredentialStorage = Layer.succeedContext(
        yield* Layer.build(testSqliteStorage).pipe(Effect.orDie),
      )
      const order = [DEFAULT_CREDENTIAL_SLOT, personal]
      const held = yield* Deferred.make<void>()
      // First process: A refuses, B calls a tool that holds, and the process dies there.
      const first = credentialRoot({
        name: "resumed",
        order,
        stored: twoKeys,
        held,
        storage,
        replies: {
          "sk-a": refusal,
          "sk-b": () =>
            Stream.fromIterable([
              toolCallPart("hold", {}),
              finishPart({ finishReason: "tool-calls" }),
            ]),
        },
      })
      const { sessionId, branchId } = first
      const durableEvents = Effect.gen(function* () {
        const envelopes = yield* (yield* EventStorage).listEvents({ sessionId, branchId })
        return envelopes.map((envelope) => envelope.event)
      }).pipe(Effect.provide(storage), Effect.orDie)
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* submitAgentLoop(makeMessage(sessionId, branchId, "hello"), first.admission)
          yield* Deferred.await(held)
        }),
      ).pipe(Effect.provide(first.layer))
      expect(first.sent).toEqual(["sk-a", "sk-b"])
      const before = (yield* durableEvents).length
      // Second process: the turn resumes after the tool, still on B.
      const second = credentialRoot({
        name: "resumed",
        order,
        stored: twoKeys,
        storage,
        replies: { "sk-a": refusal, "sk-b": answer("done") },
      })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          yield* agentLoop.getState({ sessionId, branchId })
          yield* waitFor(
            durableEvents,
            (all) => all.slice(before).some((event) => event._tag === "TurnCompleted"),
            10_000,
            "the resumed turn to end",
          )
        }),
      ).pipe(Effect.provide(second.layer))
      const resumed = credentialReport((yield* durableEvents).slice(before))
      expect(second.sent).toEqual(["sk-b"])
      expect(resumed.errors.some((entry) => entry.error.includes("continuing with"))).toBe(false)
      expect(labelsOf(resumed.ended)).toEqual([{ provider: fallbackProvider, slot: personal }])
    }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
  )

  it.live("a spawned child starts where its parent's turn stands in the order", () =>
    Effect.gen(function* () {
      const storage: CredentialStorage = Layer.succeedContext(
        yield* Layer.build(testSqliteStorage).pipe(Effect.orDie),
      )
      const order = [DEFAULT_CREDENTIAL_SLOT, personal]
      const replies = { "sk-a": refusal, "sk-b": answer("from b") }
      const runOn = (root: ReturnType<typeof credentialRoot>) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* ensureStorageParents({
              sessionId: root.sessionId,
              branchId: root.branchId,
              admission: root.admission,
            })
            yield* runAgentLoop(makeMessage(root.sessionId, root.branchId, "hello"), root.admission)
          }),
        ).pipe(Effect.provide(root.layer))
      // The parent's turn: A refuses, B answers.
      const parent = credentialRoot({ name: "parent", order, stored: twoKeys, storage, replies })
      yield* runOn(parent)
      expect(parent.sent).toEqual(["sk-a", "sk-b"])
      // A child the parent's turn spawned goes out with B at once.
      const child = credentialRoot({ name: "child", order, stored: twoKeys, storage, replies })
      yield* Effect.gen(function* () {
        const now = dateFromMillis(yield* Clock.currentTimeMillis)
        yield* (yield* SessionStorage).createSession(
          new Session({
            id: child.sessionId,
            parentSessionId: parent.sessionId,
            parentBranchId: parent.branchId,
            createdAt: now,
            updatedAt: now,
            admission: child.admission,
          }),
        )
      }).pipe(Effect.provide(storage), Effect.orDie)
      yield* runOn(child)
      expect(child.sent).toEqual(["sk-b"])
      // A session of its own starts at the top of the order.
      const own = credentialRoot({ name: "own", order, stored: twoKeys, storage, replies })
      yield* runOn(own)
      expect(own.sent).toEqual(["sk-a", "sk-b"])
    }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
  )

  it.live("a child takes its parent's place in the order on its first turn only", () =>
    Effect.gen(function* () {
      const storage: CredentialStorage = Layer.succeedContext(
        yield* Layer.build(testSqliteStorage).pipe(Effect.orDie),
      )
      const order = [DEFAULT_CREDENTIAL_SLOT, personal]
      const bothAnswer = { "sk-a": answer("from a"), "sk-b": answer("from b") }
      const runOn = (root: ReturnType<typeof credentialRoot>, text: string) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* ensureStorageParents({
              sessionId: root.sessionId,
              branchId: root.branchId,
              admission: root.admission,
            })
            yield* runAgentLoop(makeMessage(root.sessionId, root.branchId, text), root.admission)
          }),
        ).pipe(Effect.provide(root.layer))
      const rootOf = (name: string, replies: Readonly<Record<string, Reply>>) =>
        credentialRoot({ name, order, stored: twoKeys, storage, replies })
      // The parent's first turn answers on the default; its child's first
      // turn starts there too.
      const parent = rootOf("parent-first", bothAnswer)
      yield* runOn(parent, "first")
      const child = rootOf("child-first", bothAnswer)
      yield* Effect.gen(function* () {
        const now = dateFromMillis(yield* Clock.currentTimeMillis)
        yield* (yield* SessionStorage).createSession(
          new Session({
            id: child.sessionId,
            parentSessionId: parent.sessionId,
            parentBranchId: parent.branchId,
            createdAt: now,
            updatedAt: now,
            admission: child.admission,
          }),
        )
      }).pipe(Effect.provide(storage), Effect.orDie)
      yield* runOn(child, "child first")
      expect(child.sent).toEqual(["sk-a"])
      // The parent's next turn moves past a refusing default. The child's
      // later turn is its own: it starts at the top of the order, as the
      // parent's own next turn would, not where that later parent turn ended.
      const parentAgain = rootOf("parent-first", { "sk-a": refusal, "sk-b": answer("from b") })
      yield* runOn(parentAgain, "second")
      expect(parentAgain.sent).toEqual(["sk-a", "sk-b"])
      const childAgain = rootOf("child-first", bothAnswer)
      yield* runOn(childAgain, "child second")
      expect(childAgain.sent).toEqual(["sk-a"])
    }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
  )

  describe("spread", () => {
    const a = CredentialSlot.make("a")
    const b = CredentialSlot.make("b")
    const c = CredentialSlot.make("c")
    const HOUR_MS = 3_600_000
    const otherModel = ModelId.make("fallback/other")
    /**
     * The sign-ins of one credential store. Each root of a world is a
     * session of one server, which reads one store, so every root holds the
     * same sign-in under a label: the stamp is the sign-in's, not the root's.
     */
    const keysOf = (slots: ReadonlyArray<CredentialSlot>) =>
      slots.map(
        (slot) => [slot, AuthApi.make({ type: "api", key: `sk-${slot}`, signedInAt: 1 })] as const,
      )
    const answers = (slots: ReadonlyArray<CredentialSlot>): Readonly<Record<string, Reply>> =>
      Object.fromEntries(slots.map((slot) => [`sk-${slot}`, answer(`from ${slot}`)]))

    /** The wall clock moved on by `offset.ms`: a lifetime or a reset lapses without a wait. */
    const skewedClock = (offset: { ms: number }): Clock.Clock => {
      const wall = Clock.Clock.defaultValue()
      const millis = () => wall.currentTimeMillisUnsafe() + offset.ms
      const nanos = () => wall.currentTimeNanosUnsafe() + BigInt(offset.ms) * 1_000_000n
      return {
        currentTimeMillisUnsafe: millis,
        currentTimeMillis: Effect.sync(millis),
        currentTimeNanosUnsafe: nanos,
        currentTimeNanos: Effect.sync(nanos),
        monotonicTimeNanosUnsafe: () => wall.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: wall.monotonicTimeNanos,
        sleep: (duration) => wall.sleep(duration),
      }
    }

    /** Usage another session recorded on `slot`; its cache is gone at once. */
    const spend = (
      placement: CredentialPlacement["Service"],
      slot: CredentialSlot,
      costUsd: number,
      session: string,
    ) =>
      placement.noteStep({
        provider: FALLBACK,
        slot,
        sessionId: SessionId.make(session),
        model: fallbackModel,
        costUsd: Option.some(costUsd),
        ttlMs: Option.some(0),
      })

    /** One server's durable state and its placement, shared by every root a test runs. */
    const spreadWorld = Effect.gen(function* () {
      const storage: CredentialStorage = Layer.succeedContext(
        yield* Layer.build(testSqliteStorage).pipe(Effect.orDie),
      )
      return { storage, placement: yield* makeCredentialPlacement(Option.none()) }
    })
    type SpreadWorld = Effect.Success<typeof spreadWorld>

    /** A root of `world` whose sign-in spreads over `pool` (default `[a, b]`), with a one-hour cache. */
    const spreadRoot = (
      world: SpreadWorld,
      name: string,
      options: {
        readonly pool?: ReadonlyArray<CredentialSlot>
        readonly replies?: Readonly<Record<string, Reply>>
        readonly pin?: CredentialSlot
        readonly retry?: Partial<typeof DEFAULT_RETRY_POLICY>
        readonly held?: Deferred.Deferred<void>
        readonly history?: ReadonlyArray<number>
        readonly windowless?: boolean
        readonly compactor?: ModelContextCompactor["Service"]
        readonly spendLimits?: ReadonlyArray<SpendLimit>
        readonly requestPricing?: ModelDriverContribution["requestPricing"]
        readonly extraUsage?: boolean
      } = {},
    ) => {
      const pool = options.pool ?? [a, b]
      return credentialRoot({
        name,
        order: pool,
        spread: pool,
        stored: keysOf(pool),
        replies: options.replies ?? answers(pool),
        storage: world.storage,
        placement: world.placement,
        cacheTtlMs: HOUR_MS,
        ...omitUndefined({
          pin: options.pin,
          retry: options.retry,
          held: options.held,
          history: options.history,
          windowless: options.windowless,
          compactor: options.compactor,
          spendLimits: options.spendLimits,
          requestPricing: options.requestPricing,
          extraUsage: options.extraUsage,
        }),
      })
    }

    type RootContext = Context.Context<Layer.Success<ReturnType<typeof credentialRoot>["layer"]>>
    /**
     * Each root is one process, built once in the test's scope: its sign-ins
     * are stamped once, so a cache it wrote still stands on its next turn.
     */
    const processes = new WeakMap<ReturnType<typeof credentialRoot>, RootContext>()
    const processOf = (root: ReturnType<typeof credentialRoot>) =>
      Option.match(Option.fromUndefinedOr(processes.get(root)), {
        onSome: Effect.succeed,
        onNone: () =>
          Layer.build(root.layer).pipe(
            Effect.tap((context) => Effect.sync(() => processes.set(root, context))),
          ),
      })

    const runOn = (root: ReturnType<typeof credentialRoot>, text: string) =>
      Effect.gen(function* () {
        const context = yield* processOf(root)
        yield* Effect.gen(function* () {
          yield* ensureStorageParents({
            sessionId: root.sessionId,
            branchId: root.branchId,
            admission: root.admission,
          })
          yield* runAgentLoop(makeMessage(root.sessionId, root.branchId, text), root.admission)
        }).pipe(Effect.provide(context))
      })

    const eventsOf = (world: SpreadWorld, root: ReturnType<typeof credentialRoot>) =>
      Effect.gen(function* () {
        const envelopes = yield* (yield* EventStorage).listEvents({
          sessionId: root.sessionId,
          branchId: root.branchId,
        })
        return envelopes.map((envelope) => envelope.event)
      }).pipe(Effect.provide(world.storage), Effect.orDie)

    const slotsOf = (events: ReadonlyArray<AgentEvent>) =>
      labelsOf(events).map((label) => label.slot)

    const placementsOf = (events: ReadonlyArray<AgentEvent>) =>
      events.flatMap((event) => {
        if (event._tag !== "CredentialAssigned") return []
        const from = Option.getOrElse(Option.fromUndefinedOr(event.from), () => "none")
        return [{ slot: event.slot, reason: event.reason, from }]
      })

    /** A session `root` runs, created as `parent`'s child, or as its handoff with `handoff`. */
    const createChild = (
      world: SpreadWorld,
      root: ReturnType<typeof credentialRoot>,
      parent: ReturnType<typeof credentialRoot>,
      handoff: boolean,
    ) =>
      Effect.gen(function* () {
        const now = dateFromMillis(yield* Clock.currentTimeMillis)
        yield* (yield* SessionStorage).createSession(
          new Session({
            id: root.sessionId,
            parentSessionId: parent.sessionId,
            parentBranchId: parent.branchId,
            createdAt: now,
            updatedAt: now,
            admission: root.admission,
            // A handoff joins its predecessor's thread; a child starts its own.
            ...omitUndefined({
              threadId: Option.getOrUndefined(
                Option.liftPredicate(parent.sessionId, () => handoff),
              ),
            }),
          }),
        )
      }).pipe(Effect.provide(world.storage), Effect.orDie)

    /** A step of `root`'s branch that ran on another model, on `slot`. */
    const stepOnOtherModel = (
      world: SpreadWorld,
      root: ReturnType<typeof credentialRoot>,
      slot: CredentialSlot,
    ) =>
      Effect.gen(function* () {
        yield* (yield* EventStore).append(
          StreamEnded.make({
            sessionId: root.sessionId,
            branchId: root.branchId,
            messageId: MessageId.make(`${root.sessionId}-other-model`),
            step: 1,
            model: otherModel,
            outcome: "Answered",
            credential: { provider: fallbackProvider, slot },
          }),
        )
      }).pipe(Effect.provide(Layer.provide(EventStoreLive, world.storage)), Effect.orDie)

    it.live(
      "a spread run stays on the account its cache is warm on, however uneven the usage",
      () =>
        Effect.gen(function* () {
          const world = yield* spreadWorld
          const root = spreadRoot(world, "warm")
          yield* runOn(root, "first")
          yield* spend(world.placement, a, 50, "elsewhere-a")
          yield* spend(world.placement, b, 1, "elsewhere-b")
          for (const text of ["second", "third", "fourth"]) yield* runOn(root, text)
          const events = yield* eventsOf(world, root)
          expect(placementsOf(events)).toEqual([{ slot: a, reason: "new", from: "none" }])
          expect(slotsOf(events)).toEqual([a, a, a, a])
        }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
    )

    it.live(
      "a spread run whose cache went cold stays on its account unless another is used less by more than one session",
      () => {
        const offset = { ms: 0 }
        return Effect.gen(function* () {
          const world = yield* spreadWorld
          const root = spreadRoot(world, "cold")
          yield* runOn(root, "first")
          // Past the lifetime, with only this session's own use on a: within one session.
          offset.ms += 2 * HOUR_MS
          yield* runOn(root, "second")
          // Past it again, with a far above b.
          yield* spend(world.placement, a, 50, "elsewhere-a")
          yield* spend(world.placement, b, 1, "elsewhere-b")
          offset.ms += 2 * HOUR_MS
          yield* runOn(root, "third")
          // The last request ran on another model: its cache is not this model's.
          yield* stepOnOtherModel(world, root, b)
          yield* runOn(root, "fourth")
          const events = yield* eventsOf(world, root)
          expect(slotsOf(events)).toEqual([a, a, b, b, b])
          expect(placementsOf(events)).toEqual([
            { slot: a, reason: "new", from: "none" },
            { slot: a, reason: "cold", from: a },
            { slot: b, reason: "cold", from: a },
            { slot: b, reason: "cold", from: "none" },
          ])
        }).pipe(
          Effect.scoped,
          Effect.provideService(Clock.Clock, skewedClock(offset)),
          Effect.timeout("30 seconds"),
        )
      },
    )

    it.live(
      "a spread run is placed again after its window is handed off, and the summary stays on the account that holds the window",
      () =>
        Effect.gen(function* () {
          const world = yield* spreadWorld
          const root = spreadRoot(world, "handoff")
          yield* runOn(root, "first")
          yield* spend(world.placement, a, 50, "elsewhere-a")
          yield* spend(world.placement, b, 1, "elsewhere-b")
          // About 150k tokens join the branch: the next turn, warm on a, hands its window off.
          yield* Effect.gen(function* () {
            const storage = yield* MessageStorage
            const now = yield* Clock.currentTimeMillis
            yield* Effect.forEach(
              Array.from({ length: 12 }, (_, index) => index),
              (index) =>
                storage.createMessage(
                  Message.cases.regular.make({
                    id: MessageId.make(`handoff-grown-${index + 1}`),
                    sessionId: root.sessionId,
                    branchId: root.branchId,
                    role: "assistant",
                    parts: [Prompt.textPart({ text: "x".repeat(50_000) })],
                    createdAt: dateFromMillis(now + index),
                  }),
                ),
              { discard: true },
            )
          }).pipe(Effect.provide(world.storage), Effect.orDie)
          yield* runOn(root, "second")
          const events = yield* eventsOf(world, root)
          // Turn one on a; the summary on a; the step after it placed on b.
          expect(root.sent).toEqual(["sk-a", "sk-a", "sk-b"])
          expect(
            events.flatMap((event) => {
              if (event._tag !== "ModelContextProjected") return []
              return [event.compacted]
            }),
          ).toEqual([false, true])
          expect(slotsOf(events)).toEqual([a, b])
          expect(placementsOf(events)).toEqual([
            { slot: a, reason: "new", from: "none" },
            { slot: b, reason: "compacted", from: a },
          ])
        }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
    )

    it.live(
      "a handoff session starts on its predecessor's account unless another is used less by more than one session",
      () =>
        Effect.gen(function* () {
          const world = yield* spreadWorld
          const predecessor = spreadRoot(world, "predecessor")
          yield* runOn(predecessor, "first")
          // b a little above a, with the predecessor's cache live on a: within one session.
          yield* spend(world.placement, a, 10, "elsewhere-a")
          yield* spend(world.placement, b, 11, "elsewhere-b")
          const near = spreadRoot(world, "handoff-near")
          yield* createChild(world, near, predecessor, true)
          yield* runOn(near, "continue")
          // Then a far above b.
          yield* spend(world.placement, a, 50, "elsewhere-a-again")
          const far = spreadRoot(world, "handoff-far")
          yield* createChild(world, far, predecessor, true)
          yield* runOn(far, "continue")
          expect(placementsOf(yield* eventsOf(world, near))).toEqual([
            { slot: a, reason: "handoff", from: a },
          ])
          expect(placementsOf(yield* eventsOf(world, far))).toEqual([
            { slot: b, reason: "handoff", from: a },
          ])
          expect(near.sent).toEqual(["sk-a"])
          expect(far.sent).toEqual(["sk-b"])
        }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
    )

    it.live(
      "a fresh child starts on its parent's account unless another is used less by more than one session",
      () =>
        Effect.gen(function* () {
          const world = yield* spreadWorld
          const parent = spreadRoot(world, "spawner")
          yield* runOn(parent, "first")
          yield* spend(world.placement, a, 10, "elsewhere-a")
          yield* spend(world.placement, b, 11, "elsewhere-b")
          const near = spreadRoot(world, "child-near")
          yield* createChild(world, near, parent, false)
          yield* runOn(near, "task")
          yield* spend(world.placement, a, 50, "elsewhere-a-again")
          const far = spreadRoot(world, "child-far")
          yield* createChild(world, far, parent, false)
          yield* runOn(far, "task")
          // A parent whose last request ran on another model names no account.
          yield* stepOnOtherModel(world, parent, a)
          const elsewhere = spreadRoot(world, "child-other-model")
          yield* createChild(world, elsewhere, parent, false)
          yield* runOn(elsewhere, "task")
          expect(placementsOf(yield* eventsOf(world, near))).toEqual([
            { slot: a, reason: "spawned", from: a },
          ])
          expect(placementsOf(yield* eventsOf(world, far))).toEqual([
            { slot: b, reason: "spawned", from: a },
          ])
          expect(placementsOf(yield* eventsOf(world, elsewhere))).toEqual([
            { slot: b, reason: "spawned", from: "none" },
          ])
        }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
    )

    it.live(
      "a spread run refused for a rate limit past its retry cap moves at once to the least-used account, and stays there after the reset",
      () => {
        const offset = { ms: 0 }
        return Effect.gen(function* () {
          const world = yield* spreadWorld
          const pool = [a, b, c]
          // a is unused, c lightly used, b heavily: a run starts on a.
          yield* spend(world.placement, b, 50, "elsewhere-b")
          yield* spend(world.placement, c, 5, "elsewhere-c")
          const replies = {
            ...answers(pool),
            "sk-a": () =>
              failWith(new AiError.RateLimitError({ retryAfter: Duration.minutes(10) })),
          }
          const root = spreadRoot(world, "limited", { pool, replies })
          yield* runOn(root, "first")
          // Before the reset, a new session is not placed on a.
          const other = spreadRoot(world, "limited-other", { pool, replies })
          yield* runOn(other, "first")
          offset.ms += 11 * 60_000
          yield* runOn(root, "second")
          const events = yield* eventsOf(world, root)
          expect(root.sent).toEqual(["sk-a", "sk-c", "sk-c"])
          expect(slotsOf(events)).toEqual([c, c])
          // a served no request: its placement is never recorded, only the
          // move with the receipt on c.
          expect(placementsOf(events)).toEqual([{ slot: c, reason: "refused", from: a }])
          expect(credentialReport(events).errors).toEqual([
            {
              error: `Credential "a" of ${FALLBACK} is rate limited; continuing with "c"`,
              notice: true,
            },
          ])
          expect(
            placementsOf(yield* eventsOf(world, other)).map((entry) => entry.slot),
          ).not.toContain(a)
          expect(other.sent).not.toContain("sk-a")
        }).pipe(
          Effect.scoped,
          Effect.provideService(Clock.Clock, skewedClock(offset)),
          Effect.timeout("30 seconds"),
        )
      },
    )

    it.live(
      "a rate limit that clears within the retry cap retries a spread run on the same account",
      () =>
        Effect.gen(function* () {
          const world = yield* spreadWorld
          const root = spreadRoot(world, "short-limit", {
            retry: { maxDelay: 1_000 },
            replies: {
              ...answers([a, b]),
              "sk-a": (call) => {
                if (call === 0) {
                  return failWith(new AiError.RateLimitError({ retryAfter: Duration.millis(20) }))
                }
                return answer("from a")(call)
              },
            },
          })
          yield* runOn(root, "first")
          const events = yield* eventsOf(world, root)
          expect(root.sent).toEqual(["sk-a", "sk-a"])
          expect(credentialReport(events).retries).toBe(1)
          expect(slotsOf(events)).toEqual([a])
          expect(placementsOf(events)).toEqual([{ slot: a, reason: "new", from: "none" }])
        }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
    )

    it.live(
      "a pinned run ignores the spread: every request on its pin, no placement, and a refusal fails the turn",
      () =>
        Effect.gen(function* () {
          const world = yield* spreadWorld
          // b far above a: an unpinned run would go to a.
          yield* spend(world.placement, b, 50, "elsewhere-b")
          const root = spreadRoot(world, "pinned-spread", {
            pin: b,
            replies: {
              ...answers([a, b]),
              "sk-b": (call) => {
                if (call === 0) return answer("from b")(call)
                return refusal()
              },
            },
          })
          yield* runOn(root, "first")
          const second = yield* Effect.exit(runOn(root, "second"))
          const events = yield* eventsOf(world, root)
          // The answer and the refused step both on b.
          expect(root.sent).toEqual(["sk-b", "sk-b"])
          expect(slotsOf(events)).toEqual([b, b])
          expect(placementsOf(events)).toEqual([])
          expect(
            credentialReport(events).errors.some((entry) => entry.error.includes("continuing")),
          ).toBe(false)
          expect(Exit.isSuccess(second)).toBe(true)
          expect(
            events.some((event) => event._tag === "ErrorOccurred" && event.notice !== true),
          ).toBe(true)
        }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
    )

    it.live("a recovered turn walks the placement it recorded and never places again", () =>
      Effect.gen(function* () {
        const world = yield* spreadWorld
        // a far above b: the turn is placed on b.
        yield* spend(world.placement, a, 50, "elsewhere-a")
        const held = yield* Deferred.make<void>()
        const first = spreadRoot(world, "recovered", {
          held,
          replies: {
            ...answers([a, b]),
            "sk-b": () =>
              Stream.fromIterable([
                toolCallPart("hold", {}),
                finishPart({ finishReason: "tool-calls" }),
              ]),
          },
        })
        const { sessionId, branchId } = first
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* ensureStorageParents({ sessionId, branchId, admission: first.admission })
            yield* submitAgentLoop(makeMessage(sessionId, branchId, "hello"), first.admission)
            yield* Deferred.await(held)
          }),
        ).pipe(Effect.provide(first.layer))
        expect(first.sent).toEqual(["sk-b"])
        // While the process was down, b went far above a.
        yield* spend(world.placement, b, 500, "elsewhere-b")
        const before = (yield* eventsOf(world, first)).length
        const second = spreadRoot(world, "recovered")
        yield* Effect.scoped(
          Effect.gen(function* () {
            const agentLoop = yield* makeAgentLoopService
            yield* agentLoop.getState({ sessionId, branchId })
            yield* waitFor(
              eventsOf(world, first),
              (all) => all.slice(before).some((event) => event._tag === "TurnCompleted"),
              10_000,
              "the recovered turn to end",
            )
          }),
        ).pipe(Effect.provide(second.layer))
        const events = yield* eventsOf(world, first)
        expect(second.sent).toEqual(["sk-b"])
        expect(slotsOf(events)).toEqual([b, b])
        expect(placementsOf(events)).toEqual([{ slot: b, reason: "new", from: "none" }])
      }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
    )

    /** A tool step echoing `chars` characters on the turn's first request, then `then` on each later one. */
    const toolStepThen =
      (chars: number, then: Reply): Reply =>
      (call) => {
        if (call > 0) return then(call)
        return Stream.fromIterable([
          toolCallPart("echo", { text: "x".repeat(chars) }),
          finishPart({ finishReason: "tool-calls" }),
        ])
      }
    /** A request that never ends: the process dies while it is out. */
    const dyingRequest =
      (sent: Deferred.Deferred<void>): Reply =>
      () =>
        Stream.fromEffect(Deferred.succeed(sent, void 0).pipe(Effect.andThen(Effect.never)))
    /**
     * Run `text` on `first` until its request to the placed account is out,
     * stop the process there, and recover the turn on `second`.
     */
    const dieAndRecover = (
      world: SpreadWorld,
      first: ReturnType<typeof credentialRoot>,
      second: ReturnType<typeof credentialRoot>,
      out: Deferred.Deferred<void>,
    ) =>
      Effect.gen(function* () {
        const { sessionId, branchId } = first
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* first.seed
            yield* submitAgentLoop(makeMessage(sessionId, branchId, "hello"), first.admission)
            yield* Deferred.await(out)
          }),
        ).pipe(Effect.provide(first.layer))
        return yield* dieAndRecoverTail(world, first, second)
      })
    /** Recover `first`'s stopped turn on `next` and run it to its end: the session's events. */
    const dieAndRecoverTail = (
      world: SpreadWorld,
      first: ReturnType<typeof credentialRoot>,
      next: ReturnType<typeof credentialRoot>,
    ) =>
      Effect.gen(function* () {
        const { sessionId, branchId } = first
        const before = (yield* eventsOf(world, first)).length
        yield* Effect.scoped(
          Effect.gen(function* () {
            const agentLoop = yield* makeAgentLoopService
            yield* agentLoop.getState({ sessionId, branchId })
            yield* waitFor(
              eventsOf(world, first),
              (all) => all.slice(before).some((event) => event._tag === "TurnCompleted"),
              10_000,
              "the recovered turn to end",
            )
          }),
        ).pipe(Effect.provide(next.layer))
        return yield* eventsOf(world, first)
      })

    /**
     * `slot`'s five-hour window is full until `resetAt`, as a served
     * response's headers say, for the sign-in `signedInAt` (default unstamped).
     */
    const fill = (
      placement: CredentialPlacement["Service"],
      slot: CredentialSlot,
      resetAt: number,
      signedInAt: Option.Option<number> = Option.none(),
    ) =>
      placement.noteQuota({
        provider: FALLBACK,
        slot,
        signedInAt,
        readings: [{ window: "5h", utilization: 1, resetAt, rejected: true }],
      })
    /** A tool step whose response fills its account's window, then `then` on each later request. */
    const fillingToolStep =
      (fills: Effect.Effect<void>, then: Reply): Reply =>
      (call) => {
        if (call > 0) return then(call)
        return Stream.fromEffect(fills).pipe(
          Stream.drain,
          Stream.concat(
            Stream.fromIterable([
              toolCallPart("echo", { text: "hi" }),
              finishPart({ finishReason: "tool-calls" }),
            ]),
          ),
        )
      }
    /** The run's errors that are not notices, with the reset each names. */
    const failuresOf = (events: ReadonlyArray<AgentEvent>) =>
      events.flatMap((event) => {
        if (event._tag !== "ErrorOccurred" || event.notice === true) return []
        return [{ error: event.error, retryAt: event.retryAt }]
      })

    it.live(
      "a step whose account filled its quota window mid-turn moves to one that has not, with a notice",
      () =>
        Effect.gen(function* () {
          const world = yield* spreadWorld
          const resetAt = (yield* Clock.currentTimeMillis) + HOUR_MS
          const root = spreadRoot(world, "filled-moves", {
            replies: {
              "sk-a": fillingToolStep(fill(world.placement, a, resetAt), answer("from a")),
              "sk-b": answer("from b"),
            },
          })
          yield* runOn(root, "first")
          const events = yield* eventsOf(world, root)
          expect(root.sent).toEqual(["sk-a", "sk-b"])
          expect(slotsOf(events)).toEqual([a, b])
          expect(placementsOf(events)).toEqual([
            { slot: a, reason: "new", from: "none" },
            { slot: b, reason: "filled", from: a },
          ])
          expect(credentialReport(events).errors).toEqual([
            {
              error: `Credential "a" of ${FALLBACK} filled its quota window; continuing with "b"`,
              notice: true,
            },
          ])
        }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
    )

    it.live(
      "a step whose every account filled its quota window stops before its request, naming the first reset, unless the sign-in allows extra usage",
      () =>
        Effect.gen(function* () {
          const run = (name: string, extraUsage: boolean) =>
            Effect.gen(function* () {
              const world = yield* spreadWorld
              const now = yield* Clock.currentTimeMillis
              yield* fill(world.placement, b, now + 2 * HOUR_MS)
              // Two tool steps on a, then an answer: the notice shows once a turn.
              const twoSteps = fillingToolStep(fill(world.placement, a, now + HOUR_MS), (call) => {
                if (call > 1) return answer("from a")(call)
                return Stream.fromIterable([
                  toolCallPart("echo", { text: "again" }),
                  finishPart({ finishReason: "tool-calls" }),
                ])
              })
              const root = spreadRoot(world, name, {
                extraUsage,
                replies: { "sk-a": twoSteps, "sk-b": answer("from b") },
              })
              yield* runOn(root, "first")
              const events = yield* eventsOf(world, root)
              return { now, root, events }
            })
          const stopped = yield* run("filled-stops", false)
          expect(stopped.root.sent).toEqual(["sk-a"])
          expect(slotsOf(stopped.events)).toEqual([a])
          expect(failuresOf(stopped.events)).toEqual([
            {
              error: `Every credential of ${FALLBACK} filled its quota window; set providers.${FALLBACK}.extraUsage to go on past it`,
              retryAt: stopped.now + HOUR_MS,
            },
          ])
          expect(stopped.events.filter((event) => event._tag === "StreamStarted")).toHaveLength(1)
          expect(stopped.events.filter((event) => event._tag === "TurnCompleted")).toHaveLength(1)

          const extra = yield* run("filled-extra-usage", true)
          expect(extra.root.sent).toEqual(["sk-a", "sk-a", "sk-a"])
          expect(slotsOf(extra.events)).toEqual([a, a, a])
          expect(failuresOf(extra.events)).toEqual([])
          expect(credentialReport(extra.events).errors).toEqual([
            {
              error: `Every credential of ${FALLBACK} filled its quota window; continuing on extra usage`,
              notice: true,
            },
          ])
        }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
    )

    it.live(
      "a refused run skips an account that filled its quota window, and takes one only when every other filled and the sign-in allows extra usage",
      () =>
        Effect.gen(function* () {
          const run = (name: string, filled: ReadonlyArray<CredentialSlot>, extraUsage: boolean) =>
            Effect.gen(function* () {
              const placement = yield* makeCredentialPlacement(Option.none())
              const resetAt = (yield* Clock.currentTimeMillis) + HOUR_MS
              yield* Effect.forEach(filled, (slot) => fill(placement, slot, resetAt), {
                discard: true,
              })
              // An order, not a pool: the walk is the order itself.
              const root = credentialRoot({
                name,
                order: [a, b, c],
                stored: keysOf([a, b, c]),
                replies: { "sk-a": refusal, "sk-b": answer("from b"), "sk-c": answer("from c") },
                placement,
                extraUsage,
              })
              yield* runOn(root, "first")
              return root.sent
            })
          // An account not filled comes first, extra usage or not.
          expect(yield* run("refused-skips-filled", [b], false)).toEqual(["sk-a", "sk-c"])
          expect(yield* run("refused-skips-filled-extra", [b], true)).toEqual(["sk-a", "sk-c"])
          // Every other filled: the refusal ends the turn, or the next goes on extra usage.
          expect(yield* run("refused-all-filled", [b, c], false)).toEqual(["sk-a"])
          expect(yield* run("refused-takes-filled", [b, c], true)).toEqual(["sk-a", "sk-b"])
        }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
    )

    it.live(
      "a step whose account filled its window moves to an account signed in again since its old sign-in filled one",
      () =>
        Effect.gen(function* () {
          const world = yield* spreadWorld
          const resetAt = (yield* Clock.currentTimeMillis) + HOUR_MS
          // b's old sign-in (stamp 0) filled its window; the store holds a new one (stamp 1).
          yield* fill(world.placement, b, resetAt, Option.some(0))
          // An order, not a pool: nothing binds b's new sign-in before the move reads it.
          const root = credentialRoot({
            name: "filled-replaced-sign-in",
            order: [a, b],
            stored: keysOf([a, b]),
            replies: {
              "sk-a": fillingToolStep(fill(world.placement, a, resetAt), answer("from a")),
              "sk-b": answer("from b"),
            },
            storage: world.storage,
            placement: world.placement,
          })
          yield* runOn(root, "first")
          expect(root.sent).toEqual(["sk-a", "sk-b"])
          expect(failuresOf(yield* eventsOf(world, root))).toEqual([])
        }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
    )

    it.live(
      "a turn that starts on its order's full first account and moves back to the account its last turn ran on reads that warm cache; a move to another hands a large history off",
      () =>
        Effect.gen(function* () {
          /**
           * Two turns on the order `[a, b]` with a one-hour cache. a's window
           * is full before the first turn (`fullFirst`), which then runs on
           * b, or after it, which ran on a. Between them the history grows
           * large; the second turn starts at a, full, and moves to b.
           */
          const run = (name: string, fullFirst: boolean) =>
            Effect.gen(function* () {
              const world = yield* spreadWorld
              const resetAt = (yield* Clock.currentTimeMillis) + HOUR_MS
              // Two sign-ins: a cache is a sign-in's, whatever label holds it.
              const root = credentialRoot({
                name,
                order: [a, b],
                stored: [
                  [a, AuthApi.make({ type: "api", key: "sk-a", signedInAt: 1 })],
                  [b, AuthApi.make({ type: "api", key: "sk-b", signedInAt: 2 })],
                ],
                replies: answers([a, b]),
                storage: world.storage,
                placement: world.placement,
                cacheTtlMs: HOUR_MS,
              })
              if (fullFirst) yield* fill(world.placement, a, resetAt)
              yield* runOn(root, "first")
              if (!fullFirst) yield* fill(world.placement, a, resetAt)
              // Dated before the turns' prompts, as a seeded history is: all
              // of it is history before the second prompt.
              yield* Effect.gen(function* () {
                const storage = yield* MessageStorage
                yield* Effect.forEach(
                  [0, 1, 2],
                  (index) =>
                    storage.createMessage(
                      Message.cases.regular.make({
                        id: MessageId.make(`${name}-grown-${index + 1}`),
                        sessionId: root.sessionId,
                        branchId: root.branchId,
                        role: "assistant",
                        parts: [Prompt.textPart({ text: "x".repeat(110_000) })],
                        createdAt: dateFromMillis(1_000 + index),
                      }),
                    ),
                  { discard: true },
                )
              }).pipe(Effect.provide(world.storage), Effect.orDie)
              yield* runOn(root, "second")
              const events = yield* eventsOf(world, root)
              return {
                sent: root.sent,
                compacted: credentialReport(events).projected.map((event) => event.compacted),
              }
            })
          const returned = yield* run("filled-warm-return", true)
          expect(returned).toEqual({ sent: ["sk-b", "sk-b"], compacted: [false, false] })
          const moved = yield* run("filled-cold-move", false)
          expect(moved.sent.at(-1)).toBe("sk-b")
          expect(moved.compacted).toEqual([false, true])
        }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
    )

    it.live(
      "a turn recovered after a refusal moved it, before the new account's first receipt, resumes on its newest receipt's account and records only a move that has a receipt",
      () =>
        Effect.gen(function* () {
          /**
           * The turn is placed on a; its tool step runs there, and the step
           * after it is refused and moves to b, where the process dies. The
           * restart answers on a as `afterRestart` says.
           */
          const recover = (name: string, afterRestart: Reply) =>
            Effect.gen(function* () {
              const world = yield* spreadWorld
              const out = yield* Deferred.make<void>()
              const first = spreadRoot(world, name, {
                replies: {
                  "sk-a": toolStepThen(2, () => refusal()),
                  "sk-b": dyingRequest(out),
                },
              })
              const second = spreadRoot(world, name, {
                replies: { "sk-a": afterRestart, "sk-b": answer("from b") },
              })
              const events = yield* dieAndRecover(world, first, second, out)
              expect(first.sent).toEqual(["sk-a", "sk-a", "sk-b"])
              return { sent: second.sent, events }
            })
          // a still refuses: the recovered step starts on a, its newest
          // receipt's account, moves to b at once, and records the move with
          // b's receipt.
          const refusing = yield* recover("recovered-refused", () => refusal())
          expect(refusing.sent).toEqual(["sk-a", "sk-b"])
          expect(slotsOf(refusing.events)).toEqual([a, b])
          expect(placementsOf(refusing.events)).toEqual([
            { slot: a, reason: "new", from: "none" },
            { slot: b, reason: "refused", from: a },
          ])
          // a answers again: the step stays on a, and the move the crash cut
          // off, which no receipt shows, is never recorded.
          const answering = yield* recover("recovered-refused-answers", answer("from a"))
          expect(answering.sent).toEqual(["sk-a"])
          expect(slotsOf(answering.events)).toEqual([a, a])
          expect(placementsOf(answering.events)).toEqual([{ slot: a, reason: "new", from: "none" }])
        }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
    )

    it.live(
      "a turn recovered after a handoff placed it, before the placed account's first receipt, resumes on its newest receipt's account and records no placement",
      () =>
        Effect.gen(function* () {
          const world = yield* spreadWorld
          const out = yield* Deferred.make<void>()
          // The turn is placed on a, over a window near full, and its tool step
          // fills it mid-turn: the next step hands the window off, with the
          // summary on a, and is placed on b, by then far less used, where
          // the process dies.
          const toolStep = toolStepThen(60_000, answer("summary"))
          const first = spreadRoot(world, "recovered-compacted", {
            history: [110_000, 110_000, 110_000],
            replies: {
              "sk-a": (call) => {
                if (call > 0) return toolStep(call)
                const spent = Effect.andThen(
                  spend(world.placement, a, 50, "elsewhere-a"),
                  spend(world.placement, b, 1, "elsewhere-b"),
                )
                return Stream.unwrap(Effect.as(spent, toolStep(call)))
              },
              "sk-b": dyingRequest(out),
            },
          })
          const second = spreadRoot(world, "recovered-compacted")
          const events = yield* dieAndRecover(world, first, second, out)
          expect(first.sent).toEqual(["sk-a", "sk-a", "sk-b"])
          expect(
            events.flatMap((event) => {
              if (event._tag !== "ModelContextProjected") return []
              return [event.compacted]
            }),
          ).toEqual([false, true, false])
          // The decision for b never went out: the recovered turn reads its
          // receipts, the newest on a, and goes on there.
          expect(second.sent).toEqual(["sk-a"])
          expect(slotsOf(events)).toEqual([a, a])
          expect(placementsOf(events)).toEqual([{ slot: a, reason: "new", from: "none" }])
        }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
    )

    it.live(
      "a spread run that fell to an account outside the pool stays there while every pool account is held, and returns to the pool at the next turn one is not",
      () => {
        const offset = { ms: 0 }
        return Effect.gen(function* () {
          const world = yield* spreadWorld
          const limitedOnce = (slot: string) => (call: number) => {
            if (call === 0)
              return failWith(new AiError.RateLimitError({ retryAfter: Duration.minutes(10) }))
            return answer(`from ${slot}`)(call)
          }
          const root = credentialRoot({
            name: "billed-fallback",
            order: [a, b, c],
            spread: [a, b],
            stored: keysOf([a, b, c]),
            replies: {
              "sk-a": limitedOnce("a"),
              "sk-b": limitedOnce("b"),
              "sk-c": answer("from c"),
            },
            storage: world.storage,
            placement: world.placement,
            cacheTtlMs: HOUR_MS,
          })
          yield* runOn(root, "first")
          // Both pool accounts still held, inside the cache lifetime: c.
          offset.ms += 5 * 60_000
          yield* runOn(root, "second")
          // Past both resets, inside the cache lifetime: back to the pool.
          offset.ms += 6 * 60_000
          yield* runOn(root, "third")
          offset.ms += 5 * 60_000
          yield* runOn(root, "fourth")
          const events = yield* eventsOf(world, root)
          expect(root.sent).toEqual(["sk-a", "sk-b", "sk-c", "sk-c", "sk-a", "sk-a"])
          expect(slotsOf(events)).toEqual([c, c, a, a])
          // The fall to c is the order's walk, not a placement, and a and b,
          // which refused, served no request: the return alone is recorded.
          expect(placementsOf(events)).toEqual([{ slot: a, reason: "returned", from: c }])
        }).pipe(
          Effect.scoped,
          Effect.provideService(Clock.Clock, skewedClock(offset)),
          Effect.timeout("30 seconds"),
        )
      },
    )

    /** A sign-in of a, b and c spreading over a and b, sharing `world`'s placement. */
    const outsideRoot = (
      world: SpreadWorld,
      name: string,
      replies: Readonly<Record<string, Reply>>,
      history?: ReadonlyArray<number>,
    ) =>
      credentialRoot({
        name,
        order: [a, b, c],
        spread: [a, b],
        stored: keysOf([a, b, c]),
        replies,
        storage: world.storage,
        placement: world.placement,
        cacheTtlMs: HOUR_MS,
        ...omitUndefined({ history }),
      })
    /** The provider answered 429 for ten minutes. */
    const heldTenMinutes = () =>
      failWith(
        new AiError.RateLimitError({
          retryAfter: Duration.minutes(10),
          http: { request: httpRequest, response: { status: 429, headers: {} } },
        }),
      )
    const compactedOf = (events: ReadonlyArray<AgentEvent>) =>
      events.flatMap((event) => {
        if (event._tag !== "ModelContextProjected") return []
        return [event.compacted]
      })

    it.live("a cold return to the pool names the account outside the pool it left", () => {
      const offset = { ms: 0 }
      return Effect.gen(function* () {
        const world = yield* spreadWorld
        const limitedOnce = (slot: string) => (call: number) => {
          if (call === 0) return heldTenMinutes()
          return answer(`from ${slot}`)(call)
        }
        const root = outsideRoot(world, "billed-fallback-cold", {
          "sk-a": limitedOnce("a"),
          "sk-b": limitedOnce("b"),
          "sk-c": answer("from c"),
        })
        yield* runOn(root, "first")
        // Past both resets and the cache lifetime: a cold turn, back to the pool.
        offset.ms += 70 * 60_000
        yield* runOn(root, "second")
        const events = yield* eventsOf(world, root)
        expect(root.sent).toEqual(["sk-a", "sk-b", "sk-c", "sk-a"])
        expect(placementsOf(events)).toEqual([{ slot: a, reason: "returned", from: c }])
      }).pipe(
        Effect.scoped,
        Effect.provideService(Clock.Clock, skewedClock(offset)),
        Effect.timeout("30 seconds"),
      )
    })

    it.live(
      "a run outside the pool whose window is handed off while every pool account is held stays there, records nothing, and recovers there",
      () =>
        Effect.gen(function* () {
          const world = yield* spreadWorld
          const out = yield* Deferred.make<void>()
          // a and b refuse, and the turn falls to c over a window near full:
          // its tool step fills it, the summary stays on c, and the process
          // dies on the step after the handoff.
          const onC = toolStepThen(60_000, answer("summary"))
          const first = outsideRoot(
            world,
            "outside-handoff-held",
            {
              "sk-a": heldTenMinutes,
              "sk-b": heldTenMinutes,
              "sk-c": (call) => {
                if (call === 2) return dyingRequest(out)(call)
                return onC(call)
              },
            },
            [110_000, 110_000, 110_000],
          )
          const second = outsideRoot(world, "outside-handoff-held", {
            "sk-a": heldTenMinutes,
            "sk-b": heldTenMinutes,
            "sk-c": answer("from c"),
          })
          const events = yield* dieAndRecover(world, first, second, out)
          expect(first.sent).toEqual(["sk-a", "sk-b", "sk-c", "sk-c", "sk-c"])
          expect(compactedOf(events).slice(0, 2)).toEqual([false, true])
          // Recovered where the turn was: c, not a and b again.
          expect(second.sent).toEqual(["sk-c"])
          // No placement: a and b served no request, and c is outside the pool.
          expect(placementsOf(events)).toEqual([])
        }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
    )

    it.live(
      "a later turn outside the pool whose window is handed off while every pool account is held stays there, and one handed off once a pool account is eligible returns",
      () => {
        const offset = { ms: 0 }
        return Effect.gen(function* () {
          const world = yield* spreadWorld
          const history = [110_000, 110_000, 110_000]
          // The first turn falls to c; the second, 5 minutes on with both
          // accounts still held, fills its window on c with a tool step.
          const afterFirst = toolStepThen(60_000, answer("from c"))
          const held = outsideRoot(
            world,
            "outside-handoff-held-later",
            {
              "sk-a": heldTenMinutes,
              "sk-b": heldTenMinutes,
              "sk-c": (call) => {
                if (call === 0) return answer("from c")(call)
                return afterFirst(call - 1)
              },
            },
            history,
          )
          yield* Effect.scoped(held.seed.pipe(Effect.provide(held.layer)))
          yield* runOn(held, "first")
          offset.ms += 5 * 60_000
          yield* runOn(held, "second")
          const heldEvents = yield* eventsOf(world, held)
          expect(held.sent).toEqual(["sk-a", "sk-b", "sk-c", "sk-c", "sk-c", "sk-c"])
          expect(compactedOf(heldEvents)).toEqual([false, false, true])
          expect(placementsOf(heldEvents)).toEqual([])
          expect(heldEvents.filter((event) => event._tag === "ErrorOccurred").length).toBe(2)

          // The same on another server, but the holds lapse while the second
          // turn's tool step runs: the step after the handoff returns to the pool.
          const toolStep = toolStepThen(60_000, answer("summary"))
          const otherWorld = yield* spreadWorld
          const lapsing = outsideRoot(
            otherWorld,
            "outside-handoff-lapsing",
            {
              "sk-a": (call) => {
                if (call === 0) return heldTenMinutes()
                return answer("from a")(call)
              },
              "sk-b": heldTenMinutes,
              "sk-c": (call) => {
                if (call === 0) return answer("from c")(call)
                if (call > 1) return toolStep(call - 1)
                return Stream.unwrap(
                  Effect.sync(() => {
                    offset.ms += 6 * 60_000
                    return toolStep(0)
                  }),
                )
              },
            },
            history,
          )
          yield* Effect.scoped(lapsing.seed.pipe(Effect.provide(lapsing.layer)))
          yield* runOn(lapsing, "first")
          offset.ms += 5 * 60_000
          yield* runOn(lapsing, "second")
          const lapsingEvents = yield* eventsOf(otherWorld, lapsing)
          expect(lapsing.sent).toEqual(["sk-a", "sk-b", "sk-c", "sk-c", "sk-c", "sk-a"])
          expect(compactedOf(lapsingEvents)).toEqual([false, false, true])
          expect(placementsOf(lapsingEvents)).toEqual([{ slot: a, reason: "returned", from: c }])
        }).pipe(
          Effect.scoped,
          Effect.provideService(Clock.Clock, skewedClock(offset)),
          Effect.timeout("30 seconds"),
        )
      },
    )

    it.live(
      "a turn that left every pool account stays outside the pool at each handoff, its holds lapsed or not, and its next turn returns",
      () => {
        const offset = { ms: 0 }
        return Effect.gen(function* () {
          const world = yield* spreadWorld
          // On c: a tool step fills the window, the first summary, then a
          // second tool step, during which both holds lapse, fills it again
          // (its reported input near the window), the second summary, and
          // the answer.
          const secondTool = Stream.fromIterable([
            toolCallPart("echo", { text: "x".repeat(60_000) }),
            finishPart({
              finishReason: "tool-calls",
              usage: { inputTokens: 120_000, outputTokens: 5 },
            }),
          ])
          const onC: Reply = (call) => {
            if (call === 0) return toolStepThen(60_000, answer("x"))(0)
            if (call === 1) return answer("summary one")(call)
            if (call === 2)
              return Stream.unwrap(
                Effect.sync(() => {
                  offset.ms += 11 * 60_000
                  return secondTool
                }),
              )
            if (call === 3) return answer("summary two")(call)
            return answer("from c")(call)
          }
          const limitedOnce = (slot: string) => (call: number) => {
            if (call === 0) return heldTenMinutes()
            return answer(`from ${slot}`)(call)
          }
          const root = outsideRoot(
            world,
            "outside-two-handoffs",
            { "sk-a": limitedOnce("a"), "sk-b": limitedOnce("b"), "sk-c": onC },
            [110_000, 110_000, 110_000],
          )
          yield* Effect.scoped(root.seed.pipe(Effect.provide(root.layer)))
          yield* runOn(root, "first")
          const first = yield* eventsOf(world, root)
          // The holds lapsed before the second handoff, but the turn left a
          // and b: it stays on c, and records nothing after the fall.
          expect(root.sent).toEqual(["sk-a", "sk-b", "sk-c", "sk-c", "sk-c", "sk-c", "sk-c"])
          expect(compactedOf(first)).toEqual([false, true, true])
          expect(placementsOf(first)).toEqual([])
          // The next turn has left nothing: it returns.
          offset.ms += 60_000
          yield* runOn(root, "second")
          expect(root.sent.at(-1)).toBe("sk-a")
          expect(placementsOf(yield* eventsOf(world, root)).at(-1)).toEqual({
            slot: a,
            reason: "returned",
            from: c,
          })
        }).pipe(
          Effect.scoped,
          Effect.provideService(Clock.Clock, skewedClock(offset)),
          Effect.timeout("30 seconds"),
        )
      },
    )

    it.live(
      "a recovered turn outside the pool whose window is handed off with no summary request records no placement, and recovers on its account again",
      () =>
        Effect.gen(function* () {
          const world = yield* spreadWorld
          const firstOut = yield* Deferred.make<void>()
          const secondOut = yield* Deferred.make<void>()
          // The first process: a and b refuse, c runs a tool step that fills
          // the window, and the process dies while the next step's compactor runs.
          const dyingCompactor = ModelContextCompactor.of({
            compact: () => Deferred.succeed(firstOut, void 0).pipe(Effect.andThen(Effect.never)),
          })
          // Later processes summarize with no model request.
          const localCompactor = ModelContextCompactor.of({
            compact: (request) =>
              Effect.succeed(
                CompactionOutcome.cases.Summarized.make({
                  notice: "Summary: local",
                  modelId: request.modelId,
                }),
              ),
          })
          const base = {
            name: "outside-recovered-local-handoff",
            order: [a, b, c],
            spread: [a, b],
            stored: keysOf([a, b, c]),
            storage: world.storage,
            placement: world.placement,
            cacheTtlMs: HOUR_MS,
            history: [110_000, 110_000, 110_000],
          }
          const first = credentialRoot({
            ...base,
            compactor: dyingCompactor,
            replies: {
              "sk-a": heldTenMinutes,
              "sk-b": heldTenMinutes,
              "sk-c": toolStepThen(60_000, answer("from c")),
            },
          })
          // The second process dies on the step after its handoff.
          const second = credentialRoot({
            ...base,
            compactor: localCompactor,
            replies: {
              "sk-a": answer("from a"),
              "sk-b": answer("from b"),
              "sk-c": dyingRequest(secondOut),
            },
          })
          const third = credentialRoot({
            ...base,
            compactor: localCompactor,
            replies: {
              "sk-a": answer("from a"),
              "sk-b": answer("from b"),
              "sk-c": answer("from c"),
            },
          })
          const { sessionId, branchId } = first
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* first.seed
              yield* submitAgentLoop(makeMessage(sessionId, branchId, "hello"), first.admission)
              yield* Deferred.await(firstOut)
            }),
          ).pipe(Effect.provide(first.layer))
          yield* Effect.scoped(
            Effect.gen(function* () {
              const agentLoop = yield* makeAgentLoopService
              yield* agentLoop.getState({ sessionId, branchId })
              yield* Deferred.await(secondOut)
            }),
          ).pipe(Effect.provide(second.layer))
          const events = yield* dieAndRecoverTail(world, first, third)
          expect(first.sent).toEqual(["sk-a", "sk-b", "sk-c"])
          expect(second.sent).toEqual(["sk-c"])
          expect(compactedOf(events).slice(0, 2)).toEqual([false, true])
          // A second restart before c's next receipt still resumes on c.
          expect(third.sent).toEqual(["sk-c"])
          // No placement: a and b served no request, and c is outside the pool.
          expect(placementsOf(events)).toEqual([])
        }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
    )

    it.live(
      "a fork keeps its parent's account outside the pool, and returns to the pool at its next turn",
      () =>
        Effect.gen(function* () {
          const world = yield* spreadWorld
          const parent = credentialRoot({
            name: "fork-parent-pinned",
            order: [a, b, c],
            spread: [a, b],
            stored: keysOf([a, b, c]),
            replies: answers([a, b, c]),
            storage: world.storage,
            placement: world.placement,
            cacheTtlMs: HOUR_MS,
            pin: c,
          })
          yield* runOn(parent, "first")
          // The fork's window holds the parent's reply, copied at create.
          const fork = credentialRoot({
            name: "fork-of-pinned",
            order: [a, b, c],
            spread: [a, b],
            stored: keysOf([a, b, c]),
            replies: answers([a, b, c]),
            storage: world.storage,
            placement: world.placement,
            cacheTtlMs: HOUR_MS,
            history: [100],
          })
          yield* createChild(world, fork, parent, false)
          yield* Effect.scoped(fork.seed.pipe(Effect.provide(fork.layer)))
          yield* runOn(fork, "task")
          yield* runOn(fork, "next")
          const events = yield* eventsOf(world, fork)
          expect(parent.sent).toEqual(["sk-c"])
          expect(fork.sent).toEqual(["sk-c", "sk-a"])
          expect(placementsOf(events)).toEqual([{ slot: a, reason: "returned", from: c }])
        }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
    )

    it.live(
      "a run placed again after a handoff budgets its window by the placed account's catalog entry",
      () =>
        Effect.gen(function* () {
          const world = yield* spreadWorld
          // a an API key, b a subscription sign-in with a larger window.
          const root = credentialRoot({
            name: "handoff-window",
            order: [a, b],
            spread: [a, b],
            stored: [
              [a, apiKey("sk-a")],
              [b, oauthLogin],
            ],
            replies: { "sk-a": answer("from a"), oauth: answer("from b") },
            storage: world.storage,
            placement: world.placement,
            cacheTtlMs: HOUR_MS,
          })
          yield* runOn(root, "first")
          yield* spend(world.placement, a, 50, "elsewhere-a")
          yield* Effect.gen(function* () {
            const storage = yield* MessageStorage
            const now = yield* Clock.currentTimeMillis
            yield* Effect.forEach(
              Array.from({ length: 12 }, (_, index) => index),
              (index) =>
                storage.createMessage(
                  Message.cases.regular.make({
                    id: MessageId.make(`handoff-window-grown-${index + 1}`),
                    sessionId: root.sessionId,
                    branchId: root.branchId,
                    role: "assistant",
                    parts: [Prompt.textPart({ text: "x".repeat(50_000) })],
                    createdAt: dateFromMillis(now + index),
                  }),
                ),
              { discard: true },
            )
          }).pipe(Effect.provide(world.storage), Effect.orDie)
          yield* runOn(root, "second")
          const events = yield* eventsOf(world, root)
          expect(root.sent).toEqual(["sk-a", "sk-a", "oauth"])
          expect(
            events.flatMap((event) => {
              if (event._tag !== "ModelContextProjected") return []
              return [{ compacted: event.compacted, window: event.contextLimitTokens }]
            }),
          ).toEqual([
            { compacted: false, window: API_WINDOW },
            { compacted: true, window: SUBSCRIPTION_WINDOW },
          ])
        }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
    )

    it.live(
      "a spread run's cache lives as long as the account of its last request lists it",
      () => {
        const offset = { ms: 0 }
        return Effect.gen(function* () {
          const world = yield* spreadWorld
          // a an API key listing an hour, b a subscription sign-in listing 5 minutes.
          const root = credentialRoot({
            name: "lifetime-of-account",
            order: [a, b],
            spread: [a, b],
            stored: [
              [a, apiKey("sk-a")],
              [b, oauthLogin],
            ],
            replies: { "sk-a": answer("from a"), oauth: answer("from b") },
            storage: world.storage,
            placement: world.placement,
            cacheTtlMs: HOUR_MS,
            subscriptionCacheTtlMs: 5 * 60_000,
          })
          // a used: the run is placed on b.
          yield* spend(world.placement, a, 50, "elsewhere-a")
          yield* spend(world.placement, b, 1, "elsewhere-b")
          yield* runOn(root, "first")
          // Past b's lifetime, inside a's: the cache on b is cold, and the
          // turn is placed again.
          offset.ms += 10 * 60_000
          yield* runOn(root, "second")
          const events = yield* eventsOf(world, root)
          expect(root.sent).toEqual(["oauth", "oauth"])
          expect(placementsOf(events)).toEqual([
            { slot: b, reason: "new", from: "none" },
            { slot: b, reason: "cold", from: b },
          ])
        }).pipe(
          Effect.scoped,
          Effect.provideService(Clock.Clock, skewedClock(offset)),
          Effect.timeout("30 seconds"),
        )
      },
    )

    it.live(
      "a step a refusal moved counts live on its new account for as long as that account lists the cache",
      () => {
        const offset = { ms: 0 }
        return Effect.gen(function* () {
          const world = yield* spreadWorld
          // a an API key listing an hour, b a subscription sign-in listing 5 minutes.
          const root = credentialRoot({
            name: "moved-lifetime",
            order: [a, b],
            spread: [a, b],
            stored: [
              [a, apiKey("sk-a")],
              [b, oauthLogin],
            ],
            replies: { "sk-a": () => refusal(), oauth: answer("from b") },
            storage: world.storage,
            placement: world.placement,
            cacheTtlMs: HOUR_MS,
            subscriptionCacheTtlMs: 5 * 60_000,
          })
          // Placed on a, refused there, answered on b.
          yield* runOn(root, "first")
          expect(root.sent).toEqual(["sk-a", "oauth"])
          // Another session's cache lives on a for the hour.
          yield* world.placement.noteStep({
            provider: FALLBACK,
            slot: a,
            sessionId: SessionId.make("live-on-a"),
            model: fallbackModel,
            costUsd: Option.none(),
            ttlMs: Option.some(HOUR_MS),
          })
          // Past b's lifetime and the hold on a: b holds no live cache now,
          // so a fresh run goes there, not to a's live one.
          offset.ms += 10 * 60_000
          const walk = yield* world.placement.place({
            provider: FALLBACK,
            pool: [a, b],
            model: fallbackModel,
            sessionId: SessionId.make("fresh"),
            preferred: Option.none(),
            starter: Option.none(),
            left: new Set(),
            ttlMs: Option.some(0),
          })
          expect(walk[0]).toBe(b)
        }).pipe(
          Effect.scoped,
          Effect.provideService(Clock.Clock, skewedClock(offset)),
          Effect.timeout("30 seconds"),
        )
      },
    )

    /**
     * Each placement written without the receipt of the first request on its
     * account just after it in the log: none, by construction.
     */
    const placementsWithoutReceipt = (events: ReadonlyArray<AgentEvent>) =>
      events.flatMap((event, index) => {
        if (event._tag !== "CredentialAssigned") return []
        const next = events[index + 1]
        if (
          next?._tag === "StreamEnded" &&
          next.messageId === event.messageId &&
          next.credential?.provider === event.provider &&
          next.credential.slot === event.slot
        )
          return []
        return [{ slot: event.slot, reason: event.reason, next: next?._tag ?? "none" }]
      })
    /** `root`'s first turn answers, its second runs a tool step and dies on its next request. */
    const twoTurnsThenDie = (
      root: ReturnType<typeof credentialRoot>,
      out: Deferred.Deferred<void>,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* root.seed
          yield* runAgentLoop(
            makeMessage(root.sessionId, root.branchId, "turn one"),
            root.admission,
          )
          yield* submitAgentLoop(
            makeMessage(root.sessionId, root.branchId, "turn two"),
            root.admission,
          )
          yield* Deferred.await(out)
        }),
      ).pipe(Effect.provide(root.layer))
    /** Recover `first`'s stopped turn on `next` until `next`'s request is out, and stop it there. */
    const recoverAndDie = (
      first: ReturnType<typeof credentialRoot>,
      next: ReturnType<typeof credentialRoot>,
      out: Deferred.Deferred<void>,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          yield* agentLoop.getState({ sessionId: first.sessionId, branchId: first.branchId })
          yield* Deferred.await(out)
        }),
      ).pipe(Effect.provide(next.layer))
    /** Answers its first request, runs a tool step on its second, and dies on its third. */
    const answerToolThenDie =
      (out: Deferred.Deferred<void>): Reply =>
      (call) => {
        if (call === 0) return answer("turn one")(call)
        if (call === 1) return toolStepThen(10, answer("unused"))(0)
        return dyingRequest(out)(call)
      }

    it.live(
      "a turn recovered past its cache lifetime with receipts of its own resumes on its newest receipt's account and is never placed again at its start, across a second restart",
      () => {
        const offset = { ms: 0 }
        return Effect.gen(function* () {
          const world = yield* spreadWorld
          const out = yield* Deferred.make<void>()
          // Turn one is placed on a; turn two starts warm there, runs a tool
          // step on a, and the process dies on its next request.
          const first = spreadRoot(world, "recovered-cold", {
            replies: { "sk-a": answerToolThenDie(out), "sk-b": answer("from b") },
          })
          yield* twoTurnsThenDie(first, out)
          expect(first.sent).toEqual(["sk-a", "sk-a", "sk-a"])
          // Down past the cache lifetime, with a busier than b by more than
          // one session: a turn starting now would be placed on b.
          offset.ms += 70 * 60_000
          for (const other of ["cold-x1", "cold-x2", "cold-x3"])
            yield* world.placement.noteStep({
              provider: FALLBACK,
              slot: a,
              sessionId: SessionId.make(other),
              model: fallbackModel,
              costUsd: Option.none(),
              ttlMs: Option.some(HOUR_MS),
            })
          // The restart dies again before its first receipt; the third ends the turn.
          const again = yield* Deferred.make<void>()
          const second = spreadRoot(world, "recovered-cold", {
            replies: { "sk-a": dyingRequest(again), "sk-b": answer("from b") },
          })
          yield* recoverAndDie(first, second, again)
          // The third refuses on a: the turn moves on from where it walks.
          const third = spreadRoot(world, "recovered-cold", {
            replies: { "sk-a": () => refusal(), "sk-b": answer("from b") },
          })
          const events = yield* dieAndRecoverTail(world, first, third)
          // The turn is past its first request: it goes on from its receipt's
          // account, never placed again at its start, so b is still ahead
          // of it when a refuses, and the move is recorded with b's receipt.
          expect(second.sent).toEqual(["sk-a"])
          expect(third.sent).toEqual(["sk-a", "sk-b"])
          expect(slotsOf(events)).toEqual([a, a, b])
          expect(placementsOf(events)).toEqual([
            { slot: a, reason: "new", from: "none" },
            { slot: b, reason: "refused", from: a },
          ])
          expect(placementsWithoutReceipt(events)).toEqual([])
        }).pipe(
          Effect.scoped,
          Effect.provideService(Clock.Clock, skewedClock(offset)),
          Effect.timeout("30 seconds"),
        )
      },
    )

    it.live(
      "a turn outside the pool recovered once the pool's holds lapsed resumes on its newest receipt's account and records no return, across a second restart",
      () => {
        const offset = { ms: 0 }
        return Effect.gen(function* () {
          const world = yield* spreadWorld
          const out = yield* Deferred.make<void>()
          // Turn one falls to c past held a and b; turn two stays on c while
          // they are held, runs a tool step there, and the process dies on
          // its next request.
          const first = outsideRoot(world, "recovered-outside", {
            "sk-a": heldTenMinutes,
            "sk-b": heldTenMinutes,
            "sk-c": answerToolThenDie(out),
          })
          yield* twoTurnsThenDie(first, out)
          expect(first.sent.slice(-3)).toEqual(["sk-c", "sk-c", "sk-c"])
          // Down 11 minutes: both holds lapsed, c's cache still warm. A turn
          // starting now would return to the pool.
          offset.ms += 11 * 60_000
          const again = yield* Deferred.make<void>()
          const second = outsideRoot(world, "recovered-outside", {
            ...answers([a, b]),
            "sk-c": dyingRequest(again),
          })
          yield* recoverAndDie(first, second, again)
          const third = outsideRoot(world, "recovered-outside", answers([a, b, c]))
          const events = yield* dieAndRecoverTail(world, first, third)
          expect(second.sent).toEqual(["sk-c"])
          expect(third.sent).toEqual(["sk-c"])
          expect(slotsOf(events)).toEqual([c, c, c])
          expect(placementsOf(events)).toEqual([])
        }).pipe(
          Effect.scoped,
          Effect.provideService(Clock.Clock, skewedClock(offset)),
          Effect.timeout("30 seconds"),
        )
      },
    )

    it.live(
      "a refusal move the model-call budget stops before its request goes out records no placement, and its receipt is as before",
      () =>
        Effect.gen(function* () {
          // a refuses the turn's one model call; the move to b is decided,
          // and the budget stops the step before its request goes out.
          const root = credentialRoot({
            name: "budget-stops-move",
            order: [a, b],
            spread: [a, b],
            stored: keysOf([a, b]),
            replies: { "sk-a": refusal, "sk-b": answer("from b") },
            maxModelAttempts: 1,
            cacheTtlMs: HOUR_MS,
          })
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* root.seed
              yield* runAgentLoop(
                makeMessage(root.sessionId, root.branchId, "hello"),
                root.admission,
              )
            }),
          ).pipe(Effect.provide(root.layer))
          const events = yield* Ref.get(root.events)
          expect(root.sent).toEqual(["sk-a"])
          // The receipt names the account the step selected, as at base.
          const ended = events.flatMap((event) => {
            if (event._tag !== "StreamEnded") return []
            return [`${event.outcome}:${event.credential?.slot}`]
          })
          expect(ended).toEqual(["Failed:b"])
          // No request went out on b: no placement names it.
          expect(placementsOf(events)).toEqual([])
          expect(
            events.some(
              (event) =>
                event._tag === "ErrorOccurred" &&
                event.error.startsWith("Stopped at the model-call budget"),
            ),
          ).toBe(true)
        }).pipe(Effect.timeout("30 seconds")),
    )

    it.live(
      "a move whose request fails before the provider answers it, as a credential that fails at signing, records no placement, and one the provider refuses records it",
      () =>
        Effect.gen(function* () {
          /**
           * a refuses; the turn moves to b, the walk's last account, whose
           * reply is `onB`. The step ends on b's failure: its receipt names b.
           */
          const run = (name: string, onB: Reply) =>
            Effect.gen(function* () {
              const root = credentialRoot({
                name,
                order: [a, b],
                spread: [a, b],
                stored: keysOf([a, b]),
                replies: { "sk-a": refusal, "sk-b": onB },
                cacheTtlMs: HOUR_MS,
              })
              yield* Effect.scoped(
                Effect.gen(function* () {
                  yield* root.seed
                  yield* runAgentLoop(
                    makeMessage(root.sessionId, root.branchId, "hello"),
                    root.admission,
                  )
                }),
              ).pipe(Effect.provide(root.layer))
              const events = yield* Ref.get(root.events)
              const ended = events.flatMap((event) => {
                if (event._tag !== "StreamEnded") return []
                return [`${event.outcome}:${event.credential?.slot}`]
              })
              return { ended, placements: placementsOf(events) }
            })
          // b's credential fails as the request is signed, as `authorizedClient`
          // reports it: an encode failure with no response, so nothing reached
          // the provider.
          const unsent = yield* run("signing-fails", () =>
            failWith(
              new AiError.NetworkError({
                reason: "EncodeError",
                request: httpRequest,
                description: "the sign-in could not be refreshed",
              }),
            ),
          )
          expect(unsent).toEqual({ ended: ["Failed:b"], placements: [] })
          // b's request reached the provider, which refused it: it went out.
          const refused = yield* run("b-refuses", refusal)
          expect(refused).toEqual({
            ended: ["Failed:b"],
            placements: [{ slot: b, reason: "refused", from: a }],
          })
        }).pipe(Effect.timeout("30 seconds")),
    )

    it.live(
      "a turn recovered after its receipt's account left the pool and order is placed afresh by the ranking, recorded with its first request there",
      () =>
        Effect.gen(function* () {
          const world = yield* spreadWorld
          const out = yield* Deferred.make<void>()
          // Turn one is placed on a; turn two runs a tool step there and the
          // process dies on its next request.
          const first = spreadRoot(world, "recovered-left-pool", {
            replies: { "sk-a": answerToolThenDie(out), "sk-b": answer("from b") },
          })
          yield* twoTurnsThenDie(first, out)
          expect(first.sent).toEqual(["sk-a", "sk-a", "sk-a"])
          // The restart's pool and order are [b, c], with b busier than c by
          // three sessions: the ranking takes c, the pool's second, as for a
          // run returning to the pool from a, now outside it.
          for (const other of ["left-pool-1", "left-pool-2", "left-pool-3"])
            yield* world.placement.place({
              provider: FALLBACK,
              pool: [b, c],
              model: fallbackModel,
              sessionId: SessionId.make(other),
              preferred: Option.some(b),
              starter: Option.none(),
              left: new Set([c]),
              ttlMs: Option.some(HOUR_MS),
            })
          const second = spreadRoot(world, "recovered-left-pool", { pool: [b, c] })
          const events = yield* dieAndRecoverTail(world, first, second)
          expect(second.sent).toEqual(["sk-c"])
          expect(slotsOf(events)).toEqual([a, a, c])
          expect(placementsOf(events)).toEqual([
            { slot: a, reason: "new", from: "none" },
            { slot: c, reason: "returned", from: a },
          ])
          expect(placementsWithoutReceipt(events)).toEqual([])
        }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
    )

    it.live(
      "a turn recovered after its receipt's account left the pool and order, while every pool account is held, is placed by the ranking and recorded, whether or not its order has an account outside the pool",
      () =>
        Effect.gen(function* () {
          const d = CredentialSlot.make("d")
          /**
           * Turn one is placed on a; turn two runs a tool step there and the
           * process dies. The restart's pool is [b, c], both held, and its
           * order is `order`: the recovered turn's events.
           */
          const recoverHeld = (name: string, order: ReadonlyArray<CredentialSlot>) =>
            Effect.gen(function* () {
              const world = yield* spreadWorld
              const out = yield* Deferred.make<void>()
              const first = spreadRoot(world, name, {
                replies: { "sk-a": answerToolThenDie(out), "sk-b": answer("from b") },
              })
              yield* twoTurnsThenDie(first, out)
              for (const slot of [b, c])
                yield* world.placement.refuse({
                  provider: FALLBACK,
                  slot,
                  signedInAt: Option.none(),
                  model: Option.none(),
                  retryAt: Option.none(),
                })
              const second = credentialRoot({
                name,
                order,
                spread: [b, c],
                stored: keysOf(order),
                replies: answers(order),
                storage: world.storage,
                placement: world.placement,
                cacheTtlMs: HOUR_MS,
              })
              const events = yield* dieAndRecoverTail(world, first, second)
              return { sent: second.sent, slots: slotsOf(events), placements: placementsOf(events) }
            })
          // The turn ran on no account of its new order, so it has none to
          // stay on: the ranking places it, falling back to the pool's first
          // with every account held, and the decision is recorded with b's
          // receipt. An account past the pool (d, a fallback key) is never
          // chosen for it, and no request goes anywhere unrecorded.
          expect(yield* recoverHeld("recovered-held-outside", [b, c, d])).toEqual({
            sent: ["sk-b"],
            slots: [a, a, b],
            placements: [
              { slot: a, reason: "new", from: "none" },
              { slot: b, reason: "returned", from: a },
            ],
          })
          // The order is the pool: the same.
          expect(yield* recoverHeld("recovered-held-pool", [b, c])).toEqual({
            sent: ["sk-b"],
            slots: [a, a, b],
            placements: [
              { slot: a, reason: "new", from: "none" },
              { slot: b, reason: "returned", from: a },
            ],
          })
        }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
    )

    describe("crash points", () => {
      /** mulberry32: one seed draws the same crash points on every run. */
      const drawsOf = (seed: number) => {
        let state = seed >>> 0
        return () => {
          state = (state + 0x6d2b79f5) >>> 0
          let mixed = Math.imul(state ^ (state >>> 15), state | 1)
          mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
          return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
        }
      }
      const SEEDS = 40
      /**
       * One session's turns: tool steps, refusals on a and on b, windows
       * filled mid-turn, and a last turn that spends its model-call budget.
       */
      const WORKLOAD = [
        "w1 tool",
        "w2 refuse-a",
        "w3 fill",
        "w4 refuse-b",
        "w5 tool",
        "w6 fill",
        "w7 spend",
      ]
      /** The model-call budget of every turn: only `w7 spend` reaches it. */
      const BUDGET = 8
      const textOf = (message: Prompt.Message) => {
        if (message.role === "system") return message.content
        const texts: Array<string> = []
        for (const part of message.content) if (part.type === "text") texts.push(part.text)
        return texts.join("")
      }
      /** The newest workload prompt in `prompt`; none for the summary request. */
      const workloadAt = (prompt: Prompt.Prompt) =>
        prompt.content.findLastIndex(
          (message) => message.role === "user" && WORKLOAD.includes(textOf(message)),
        )
      /**
       * The reply to a request on `credential`: by the newest workload prompt
       * in it, and whether a tool result came after that prompt. A request
       * with none (the summary request) answers. `w7 spend` calls a tool on
       * every request but its `BUDGET`-th (`spent`), which is refused: the
       * move after it is stopped by the budget before its request goes out.
       */
      const workloadReply = (
        credential: string,
        prompt: Prompt.Prompt,
        refused: Set<string>,
        spent: number,
      ) => {
        const messages = prompt.content
        const at = workloadAt(prompt)
        if (at < 0) return { refused: false, reply: answer("done")(0) }
        const kind = textOf(messages[at]!).split(" ")[1]
        if (kind === "spend") {
          if (spent === BUDGET) return { refused: true, reply: refusal() }
          return { refused: false, reply: toolStepThen(10, answer("unused"))(0) }
        }
        if (messages.slice(at + 1).some((message) => message.role === "tool"))
          return { refused: false, reply: answer("done")(0) }
        // A refusal on its account, once per turn and process.
        const refusing =
          (kind === "refuse-a" && credential === "sk-a") ||
          (kind === "refuse-b" && credential === "sk-b")
        const key = `${textOf(messages[at]!)} ${credential}`
        if (refusing && !refused.has(key)) {
          refused.add(key)
          return { refused: true, reply: refusal() }
        }
        // A tool step that fills the window mid-turn, or a small one.
        const echoed = new Map([["fill", 60_000]]).get(kind ?? "") ?? 10
        return { refused: false, reply: toolStepThen(echoed, answer("unused"))(0) }
      }
      /** A request that went out: its workload turn (none for a summary), account and refusal. */
      interface SentRequest {
        readonly text: Option.Option<string>
        readonly credential: string
        readonly refused: boolean
      }
      /** The workload text of each turn's user message, by its id. */
      const turnTexts = (events: ReadonlyArray<AgentEvent>) =>
        new Map(
          events.flatMap((event) => {
            if (event._tag !== "MessageReceived" || event.message.role !== "user") return []
            const text = event.message.parts.flatMap((part) => {
              if (part.type !== "text") return []
              return [part.text]
            })
            return [[event.message.id, text.join("")] as const]
          }),
        )
      /**
       * Placements no request of their turn went out on: a placement is
       * written only with the receipt of a request sent on its account.
       */
      const placementsNeverSent = (
        events: ReadonlyArray<AgentEvent>,
        sent: ReadonlyArray<SentRequest>,
      ) => {
        const texts = turnTexts(events)
        return events.flatMap((event) => {
          if (event._tag !== "CredentialAssigned") return []
          const text = texts.get(event.messageId)
          const went = sent.some(
            (request) =>
              Option.contains(request.text, text ?? "") &&
              request.credential === `sk-${event.slot}`,
          )
          if (went) return []
          return [{ text, slot: event.slot, reason: event.reason }]
        })
      }
      const turnsEnded = (events: ReadonlyArray<AgentEvent>) =>
        new Set(
          events.flatMap((event) => {
            if (event._tag !== "TurnCompleted" || Predicate.isUndefined(event.messageId)) return []
            return [event.messageId]
          }),
        )

      /**
       * One process of `seed`'s session: a fresh placement, as a restart has,
       * that recovers the open turn and runs the workload's next turns, and
       * dies on its `crashAt`-th request when one is drawn (`w7 spend`'s
       * requests are never drawn). `busy` is an account three other sessions
       * hold in the new placement, so a turn placed afresh would leave it.
       */
      const runProcess = (
        world: SpreadWorld,
        seed: number,
        crashAt: Option.Option<number>,
        busy: Option.Option<CredentialSlot>,
        progress: { submitted: number; seeded: boolean },
      ) =>
        Effect.gen(function* () {
          const out = yield* Deferred.make<void>()
          const placement = yield* makeCredentialPlacement(Option.none())
          for (const slot of Option.toArray(busy))
            for (const other of [1, 2, 3])
              yield* placement.place({
                provider: FALLBACK,
                pool: [a, b],
                model: fallbackModel,
                sessionId: SessionId.make(`crash-${seed}-busy-${other}`),
                preferred: Option.some(slot),
                starter: Option.none(),
                left: new Set([a, b].filter((other) => other !== slot)),
                ttlMs: Option.some(HOUR_MS),
              })
          let requests = 0
          let spent = 0
          const refused = new Set<string>()
          const sent: Array<SentRequest> = []
          const root = credentialRoot({
            name: `crash-${seed}`,
            order: [a, b],
            spread: [a, b],
            stored: keysOf([a, b]),
            replies: {},
            storage: world.storage,
            placement,
            cacheTtlMs: HOUR_MS,
            history: [110_000, 110_000, 110_000],
            maxModelAttempts: BUDGET,
            respond: (credential, prompt) => {
              const at = workloadAt(prompt)
              const text = Option.liftPredicate(at, (found) => found >= 0).pipe(
                Option.map((found) => textOf(prompt.content[found]!)),
              )
              if (Option.contains(text, "w7 spend")) spent += 1
              else requests += 1
              if (Option.contains(crashAt, requests) && !Option.contains(text, "w7 spend")) {
                sent.push({ text, credential, refused: false })
                return dyingRequest(out)(0)
              }
              const reply = workloadReply(credential, prompt, refused, spent)
              sent.push({ text, credential, refused: reply.refused })
              return reply.reply
            },
          })
          const work = Effect.gen(function* () {
            if (!progress.seeded) {
              yield* root.seed
              progress.seeded = true
            }
            const agentLoop = yield* makeAgentLoopService
            yield* agentLoop.getState({ sessionId: root.sessionId, branchId: root.branchId })
            yield* waitFor(
              Effect.map(eventsOf(world, root), (events) => turnsEnded(events).size),
              (ended) => ended >= progress.submitted,
              10_000,
              "the recovered turn to end",
            )
            while (progress.submitted < WORKLOAD.length) {
              progress.submitted += 1
              const text = WORKLOAD[progress.submitted - 1]!
              // Stamped now, so the prompt orders it after the turns before it.
              const message = Message.cases.regular.make({
                id: makeMessage(root.sessionId, root.branchId, text).id,
                sessionId: root.sessionId,
                branchId: root.branchId,
                role: "user",
                parts: [Prompt.textPart({ text })],
                createdAt: dateFromMillis(yield* Clock.currentTimeMillis),
              })
              yield* runAgentLoop(message, root.admission)
            }
          }).pipe(Effect.provide(root.layer))
          const crashed = yield* Effect.raceFirst(
            Effect.as(work, false),
            Effect.as(Deferred.await(out), true),
          )
          return { root, crashed, sent }
        }).pipe(Effect.scoped)

      /**
       * The recovered turn's requests in a process, from its first: each
       * goes to `slot` until the first refusal moves the turn or a summary
       * request hands its window off (each included). Those that went
       * elsewhere.
       */
      const offResumedSlot = (
        sent: ReadonlyArray<SentRequest>,
        text: string,
        slot: CredentialSlot,
      ) => {
        const off: Array<string> = []
        for (const request of sent) {
          if (Option.isSome(request.text) && request.text.value !== text) break
          if (request.credential !== `sk-${slot}`) off.push(request.credential)
          if (request.refused || Option.isNone(request.text)) break
        }
        return off
      }

      it.live(
        "across random crash points, every placement is written with the receipt of a request that went out on its account, and a recovered turn's requests go to its newest receipt's account until it moves",
        () =>
          Effect.gen(function* () {
            const coverage = {
              restarts: 0,
              resumed: 0,
              placements: 0,
              reasons: new Set<string>(),
              stopped: 0,
            }
            for (let seed = 1; seed <= SEEDS; seed += 1) {
              const draw = drawsOf(seed)
              const world = yield* spreadWorld
              const progress = { submitted: 0, seeded: false }
              const offset = { ms: 0 }
              const sent: Array<SentRequest> = []
              let crashes = 1 + Math.floor(draw() * 3)
              let events: ReadonlyArray<AgentEvent> = []
              for (let processes = 1; processes <= 12; processes += 1) {
                // The open turn's newest receipt, before this process starts.
                const ended = turnsEnded(events)
                const resumeOn = Option.fromUndefinedOr(
                  events.findLast(
                    (event): event is StreamEnded =>
                      event._tag === "StreamEnded" &&
                      Predicate.isNotUndefined(event.credential) &&
                      Predicate.isNotUndefined(event.messageId) &&
                      !ended.has(event.messageId),
                  ),
                )
                const resumed = Option.flatMap(resumeOn, (receipt) =>
                  Option.all({
                    slot: Option.fromUndefinedOr(receipt.credential?.slot),
                    text: Option.fromUndefinedOr(
                      turnTexts(events).get(receipt.messageId ?? MessageId.make("none")),
                    ),
                  }),
                )
                // A restart comes past the cache's lifetime, with the receipt's
                // account the busier: a turn placed afresh would leave it.
                if (processes > 1) offset.ms += HOUR_MS + 60_000
                const crashAt = Option.liftPredicate(1 + Math.floor(draw() * 9), () => crashes > 0)
                const process = yield* runProcess(
                  world,
                  seed,
                  crashAt,
                  Option.map(resumed, (found) => found.slot),
                  progress,
                ).pipe(Effect.provideService(Clock.Clock, skewedClock(offset)))
                sent.push(...process.sent)
                if (processes > 1) coverage.restarts += 1
                if (Option.isSome(resumed)) {
                  coverage.resumed += 1
                  const { slot, text } = resumed.value
                  expect({ seed, text, off: offResumedSlot(process.sent, text, slot) }).toEqual({
                    seed,
                    text,
                    off: [],
                  })
                }
                events = yield* eventsOf(world, process.root)
                if (!process.crashed) break
                crashes -= 1
              }
              // Every turn ends, none on a failure but the last, which the
              // model-call budget stops.
              const completed = events.filter((event) => event._tag === "TurnCompleted")
              expect({ seed, ended: turnsEnded(events).size }).toEqual({
                seed,
                ended: WORKLOAD.length,
              })
              const texts = turnTexts(events)
              expect({
                seed,
                failed: completed.flatMap((event) => {
                  if (event.streamFailed !== true) return []
                  return [texts.get(event.messageId ?? MessageId.make("none"))]
                }),
              }).toEqual({ seed, failed: ["w7 spend"] })
              expect({ seed, unreceipted: placementsWithoutReceipt(events) }).toEqual({
                seed,
                unreceipted: [],
              })
              expect({ seed, neverSent: placementsNeverSent(events, sent) }).toEqual({
                seed,
                neverSent: [],
              })
              const stopped = events.some(
                (event) =>
                  event._tag === "ErrorOccurred" &&
                  event.error.startsWith("Stopped at the model-call budget"),
              )
              if (stopped) coverage.stopped += 1
              for (const placed of placementsOf(events)) coverage.reasons.add(placed.reason)
              coverage.placements += placementsOf(events).length
            }
            // The draws reach the cases the properties are about: restarts
            // with and without receipts of the open turn, placements of each
            // kind the workload makes, and a refusal move the budget stops
            // before its request goes out. (40 seeds: 79 restarts, 37 with a
            // receipt, 139 placements, 40 budget stops.)
            expect(coverage.restarts).toBeGreaterThanOrEqual(SEEDS)
            expect(coverage.resumed).toBeGreaterThanOrEqual(20)
            expect(coverage.restarts - coverage.resumed).toBeGreaterThanOrEqual(20)
            expect(coverage.stopped).toBe(SEEDS)
            expect(
              ["new", "cold", "refused", "compacted"].filter(
                (reason) => !coverage.reasons.has(reason),
              ),
            ).toEqual([])
          }).pipe(Effect.scoped, Effect.timeout("110 seconds")),
        120_000,
      )
    })

    it.live(
      "without authSpread each turn starts at the first credential of its authOrder, as before",
      () =>
        Effect.gen(function* () {
          const root = credentialRoot({
            name: "unspread",
            order: [a, b],
            stored: keysOf([a, b]),
            replies: {
              "sk-a": (call) => {
                if (call === 0) return refusal()
                return answer("from a")(call)
              },
              "sk-b": answer("from b"),
            },
          })
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* root.seed
              for (const text of ["one", "two"])
                yield* runAgentLoop(
                  makeMessage(root.sessionId, root.branchId, text),
                  root.admission,
                )
            }),
          ).pipe(Effect.provide(root.layer))
          const events = yield* Ref.get(root.events)
          expect(root.sent).toEqual(["sk-a", "sk-b", "sk-a"])
          expect(slotsOf(events)).toEqual([b, a])
          expect(events.some((event) => event._tag === "CredentialAssigned")).toBe(false)
        }).pipe(Effect.timeout("30 seconds")),
    )

    it.live(
      "an interrupted step whose request a part answered records its placement with its receipt, and one interrupted before its first part records nothing",
      () =>
        Effect.gen(function* () {
          const pool = [a, b]
          const stopped = (
            name: string,
            reply: Reply,
            before: (seen: Seen) => Effect.Effect<void, Effect.Error<ReturnType<Seen>>>,
          ) =>
            stoppedTurn({
              name,
              order: pool,
              spread: pool,
              stored: keysOf(pool),
              cacheTtlMs: HOUR_MS,
              replies: { ...answers(pool), "sk-a": reply },
              before,
            })
          // A part arrived, then the stop: the provider answered the request.
          const answered = yield* stopped(
            "stopped-after-part",
            () => Stream.concat(Stream.make(textDeltaPart("partial")), Stream.never),
            (seen) => seen("StreamChunk"),
          )
          expect(answered.sent).toEqual(["sk-a"])
          expect(answered.interrupted).toEqual([true])
          expect(labelsOf(answered.ended)).toEqual([{ provider: fallbackProvider, slot: a }])
          expect(answered.assigned).toEqual([{ slot: a, reason: "new" }])
          // The request went out, but no part came before the stop: nothing
          // proves the provider took it, so the receipt names the account and
          // no placement is recorded.
          const requested = yield* Deferred.make<void>()
          const silent = yield* stopped(
            "stopped-before-part",
            () => Stream.unwrap(Deferred.succeed(requested, void 0).pipe(Effect.as(Stream.never))),
            () => Deferred.await(requested),
          )
          expect(silent.sent).toEqual(["sk-a"])
          expect(silent.interrupted).toEqual([true])
          expect(labelsOf(silent.ended)).toEqual([{ provider: fallbackProvider, slot: a }])
          expect(silent.assigned).toEqual([])
        }),
    )

    it.live(
      "a fresh child whose turn ends before its first step releases its warming guard, so its sibling may still be placed on that account",
      () =>
        Effect.gen(function* () {
          const world = yield* spreadWorld
          const parent = spreadRoot(world, "guard-parent")
          yield* runOn(parent, "first")
          // a far above b: a fresh child of the parent goes to b.
          yield* spend(world.placement, a, 50, "elsewhere-a")
          yield* spend(world.placement, b, 1, "elsewhere-b")
          // The first child is placed on b and warms it, then its turn fails
          // before its first request: its catalog entry names no window.
          const broken = spreadRoot(world, "guard-broken", { windowless: true })
          yield* createChild(world, broken, parent, false)
          yield* Effect.exit(runOn(broken, "task"))
          expect(broken.sent).toEqual([])
          // Its sibling, placed after that turn ended, finds b free to warm.
          const sibling = spreadRoot(world, "guard-sibling")
          yield* createChild(world, sibling, parent, false)
          yield* runOn(sibling, "task")
          expect(placementsOf(yield* eventsOf(world, sibling))).toEqual([
            { slot: b, reason: "spawned", from: a },
          ])
          expect(sibling.sent).toEqual(["sk-b"])
        }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
    )

    it.live(
      "a rate limit holds its account for the refused model alone, and an exhausted quota holds it for every model",
      () =>
        Effect.gen(function* () {
          const cases = [
            {
              name: "held-rate",
              reply: () =>
                failWith(new AiError.RateLimitError({ retryAfter: Duration.minutes(10) })),
              otherModelOn: a,
            },
            { name: "held-quota", reply: quotaSpent, otherModelOn: b },
          ]
          for (const { name, reply, otherModelOn } of cases) {
            const world = yield* spreadWorld
            const root = spreadRoot(world, name, { replies: { ...answers([a, b]), "sk-a": reply } })
            yield* runOn(root, "first")
            expect(root.sent).toEqual(["sk-a", "sk-b"])
            const placeFor = (model: ModelId, session: string) =>
              Effect.map(
                world.placement.place({
                  provider: FALLBACK,
                  pool: [a, b],
                  model,
                  sessionId: SessionId.make(`${name}-${session}`),
                  preferred: Option.none(),
                  starter: Option.none(),
                  left: new Set(),
                  ttlMs: Option.some(0),
                }),
                (walk) => walk[0],
              )
            // The refused model is held off a either way.
            expect(yield* placeFor(fallbackModel, "same-model")).toBe(b)
            // Another model: a, unused, unless the refusal held the whole account.
            expect(yield* placeFor(otherModel, "other-model")).toBe(otherModelOn)
          }
        }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
    )

    /** A placement whose ledger is a list: each write it saved, oldest first. */
    const recordedLedger = Effect.gen(function* () {
      const saved = yield* Ref.make<ReadonlyArray<ReadonlyArray<SavedBucket>>>([])
      const placement = yield* makeCredentialPlacement(
        Option.some({
          load: Effect.succeed({ buckets: [] }),
          save: (ledger: { readonly buckets: ReadonlyArray<SavedBucket> }) =>
            Ref.update(saved, (all) => [...all, ledger.buckets]).pipe(Effect.as(true)),
        }),
      )
      return { placement, saved }
    })

    /** A compactor whose summary keeps the usage its model reported, so the turn can price it. */
    const pricedCompactor = ModelContextCompactor.of({
      compact: (request) =>
        Effect.gen(function* () {
          const failed = (error: { readonly message: string }) =>
            new ModelCompactionError({
              modelId: request.modelId,
              reason: error.message,
              cause: error,
            })
          const model = yield* request.summaryModel(1_000).pipe(Effect.mapError(failed))
          const text: Array<string> = []
          let usage = Option.none<Usage>()
          yield* Stream.runForEach(model.streamText({ prompt: "summarize" }), (part) =>
            Effect.sync(() => {
              if (part.type === "text-delta") text.push(part.delta)
              if (part.type === "finish") usage = responseUsage(part.usage)
            }),
          ).pipe(Effect.mapError(failed))
          return CompactionOutcome.cases.Summarized.make({
            notice: `Summary:\n${text.join("")}`,
            modelId: request.modelId,
            ...omitUndefined({ usage: Option.getOrUndefined(usage) }),
          })
        }),
    })

    it.live("a handoff summary's price counts toward the load of the account it ran on", () =>
      Effect.gen(function* () {
        const ledger = yield* recordedLedger
        const world = { ...(yield* spreadWorld), placement: ledger.placement }
        const root = spreadRoot(world, "summary-load", { compactor: pricedCompactor })
        yield* runOn(root, "first")
        // About 150k tokens join the branch: the next turn, warm on a, hands its window off.
        yield* Effect.gen(function* () {
          const storage = yield* MessageStorage
          const now = yield* Clock.currentTimeMillis
          yield* Effect.forEach(
            Array.from({ length: 12 }, (_, index) => index),
            (index) =>
              storage.createMessage(
                Message.cases.regular.make({
                  id: MessageId.make(`summary-load-grown-${index + 1}`),
                  sessionId: root.sessionId,
                  branchId: root.branchId,
                  role: "assistant",
                  parts: [Prompt.textPart({ text: "x".repeat(50_000) })],
                  createdAt: dateFromMillis(now + index),
                }),
              ),
            { discard: true },
          )
        }).pipe(Effect.provide(world.storage), Effect.orDie)
        yield* runOn(root, "second")
        // A step, the summary and a step, all on a: three requests' price.
        expect(root.sent).toEqual(["sk-a", "sk-a", "sk-a"])
        yield* ledger.placement.flush
        const written = (yield* Ref.get(ledger.saved)).at(-1) ?? []
        const request = (10 * apiPricing.input + 5 * apiPricing.output) / 1_000_000
        const onA = written
          .filter((bucket) => bucket.slot === a)
          .reduce((sum, bucket) => sum + bucket.costUsd, 0)
        expect(onA).toBeCloseTo(3 * request, 12)
      }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
    )

    it.live("a step bills at the price its driver names for that request", () =>
      Effect.gen(function* () {
        const ledger = yield* recordedLedger
        const world = { ...(yield* spreadWorld), placement: ledger.placement }
        const asked: Array<readonly [string, number]> = []
        const root = spreadRoot(world, "request-price", {
          // A long request bills double: the driver sees its input tokens.
          requestPricing: (modelName, listed, request) => {
            asked.push([modelName, request.inputTokens])
            return { ...listed, input: listed.input * 2, output: listed.output * 2 }
          },
        })
        yield* runOn(root, "first")
        expect(asked).toEqual([["model", 10]])
        yield* ledger.placement.flush
        const written = (yield* Ref.get(ledger.saved)).at(-1) ?? []
        const request = (10 * apiPricing.input + 5 * apiPricing.output) / 1_000_000
        const onA = written
          .filter((bucket) => bucket.slot === a)
          .reduce((sum, bucket) => sum + bucket.costUsd, 0)
        expect(onA).toBeCloseTo(2 * request, 12)
      }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
    )

    it.live(
      "a handoff summary on a model its driver limits by cost spends that model's quota",
      () =>
        Effect.gen(function* () {
          const world = yield* spreadWorld
          const request = (10 * apiPricing.input + 5 * apiPricing.output) / 1_000_000
          const root = spreadRoot(world, "summary-meter", {
            compactor: pricedCompactor,
            spendLimits: [{ window: "5h", usd: 10 * request }],
          })
          yield* runOn(root, "first")
          yield* Effect.gen(function* () {
            const storage = yield* MessageStorage
            const now = yield* Clock.currentTimeMillis
            yield* Effect.forEach(
              Array.from({ length: 12 }, (_, index) => index),
              (index) =>
                storage.createMessage(
                  Message.cases.regular.make({
                    id: MessageId.make(`summary-meter-grown-${index + 1}`),
                    sessionId: root.sessionId,
                    branchId: root.branchId,
                    role: "assistant",
                    parts: [Prompt.textPart({ text: "x".repeat(50_000) })],
                    createdAt: dateFromMillis(now + index),
                  }),
                ),
              { discard: true },
            )
          }).pipe(Effect.provide(world.storage), Effect.orDie)
          yield* runOn(root, "second")
          expect(root.sent).toEqual(["sk-a", "sk-a", "sk-a"])
          // A step, the summary and a step: three requests of the ten the window holds.
          const report = yield* world.placement.lanes(
            () => Effect.succeedSome([{ provider: fallbackProvider, slot: a }]),
            noHolds,
            Option.none(),
          )
          const window = report.providers
            .find((lanes) => lanes.provider === FALLBACK)
            ?.accounts.find((account) => account.slot === a)
            ?.windows.find((found) => found.window === "5h")
          expect(window?.model).toBe(fallbackModel)
          expect(window?.utilization).toBeCloseTo(0.3, 12)
        }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
    )

    it.live(
      "a handoff summary that fills its account's window moves the step after it to an account that has not",
      () =>
        Effect.gen(function* () {
          const world = yield* spreadWorld
          const request = (10 * apiPricing.input + 5 * apiPricing.output) / 1_000_000
          // An order, not a pool: the step after the summary is placed nowhere.
          const root = credentialRoot({
            name: "summary-fills",
            order: [a, b],
            stored: keysOf([a, b]),
            replies: answers([a, b]),
            storage: world.storage,
            placement: world.placement,
            cacheTtlMs: HOUR_MS,
            compactor: pricedCompactor,
            // The first turn's step and the summary fill a's window between them.
            spendLimits: [{ window: "5h", usd: 1.5 * request }],
          })
          yield* runOn(root, "first")
          yield* Effect.gen(function* () {
            const storage = yield* MessageStorage
            // Dated before the turns' prompts: history the second turn hands off.
            yield* Effect.forEach(
              Array.from({ length: 12 }, (_, index) => index),
              (index) =>
                storage.createMessage(
                  Message.cases.regular.make({
                    id: MessageId.make(`summary-fills-grown-${index + 1}`),
                    sessionId: root.sessionId,
                    branchId: root.branchId,
                    role: "assistant",
                    parts: [Prompt.textPart({ text: "x".repeat(50_000) })],
                    createdAt: dateFromMillis(1_000 + index),
                  }),
                ),
              { discard: true },
            )
          }).pipe(Effect.provide(world.storage), Effect.orDie)
          yield* runOn(root, "second")
          // A step and the summary on a, then the step on b.
          expect(root.sent).toEqual(["sk-a", "sk-a", "sk-b"])
          expect(credentialReport(yield* eventsOf(world, root)).errors).toEqual([
            {
              error: `Credential "a" of ${FALLBACK} filled its quota window; continuing with "b"`,
              notice: true,
            },
          ])
        }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
    )

    it.live(
      "a sign-in with no pool records no usage, so a server where nothing spreads writes no ledger",
      () =>
        Effect.gen(function* () {
          const ledger = yield* recordedLedger
          const world = yield* spreadWorld
          const root = credentialRoot({
            name: "no-pool",
            order: [a, b],
            stored: keysOf([a, b]),
            replies: answers([a, b]),
            storage: world.storage,
            placement: ledger.placement,
            cacheTtlMs: HOUR_MS,
          })
          yield* runOn(root, "first")
          expect(root.sent).toEqual(["sk-a"])
          yield* ledger.placement.flush
          expect(yield* Ref.get(ledger.saved)).toEqual([])
        }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
    )

    it.effect(
      "spread usage survives a server restart: the last 7 days of each account's buckets load from the server-wide ledger",
      () =>
        Effect.gen(function* () {
          const home = yield* makeTempDirectoryScoped("gent-spread-ledger-")
          const server = CredentialPlacement.Live.pipe(
            Layer.provide(
              Layer.mergeAll(
                RuntimeEnvironment.Live({ cwd: home, home }),
                BunServices.layer,
                GentPlatform.Test(),
              ),
            ),
          )
          const placeNew = (session: string) =>
            Effect.scoped(
              Effect.gen(function* () {
                const placement = Context.get(yield* Layer.build(server), CredentialPlacement)
                const walk = yield* placement.place({
                  provider: FALLBACK,
                  pool: [a, b],
                  model: fallbackModel,
                  sessionId: SessionId.make(session),
                  preferred: Option.none(),
                  starter: Option.none(),
                  left: new Set(),
                  ttlMs: Option.some(0),
                })
                return walk[0]
              }),
            )
          // A server with no ledger has nothing on either account: the pool's first.
          expect(yield* placeNew("before-any-use")).toBe(a)
          // The first server: heavy use of b eight days ago, then a above b this week.
          yield* Effect.scoped(
            Effect.gen(function* () {
              const placement = Context.get(yield* Layer.build(server), CredentialPlacement)
              yield* spend(placement, b, 100, "last-week")
              yield* TestClock.adjust("8 days")
              yield* spend(placement, a, 10, "this-week-a")
              yield* spend(placement, b, 1, "this-week-b")
            }),
          )
          // After the restart: this week's buckets, without last week's, put a above b.
          expect(yield* placeNew("after-restart")).toBe(b)
          // The ledger holds labels and numbers only.
          const ledger = yield* (yield* FileSystem.FileSystem).readFileString(
            `${home}/.gent/credential-usage.json`,
          )
          expect(ledger).toContain('"slot":"a"')
          expect(ledger).not.toContain("sk-")
        }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    )

    it.effect("the usage ledger is written as each hour closes, with no step after it", () =>
      Effect.gen(function* () {
        const home = yield* makeTempDirectoryScoped("gent-spread-ledger-hour-")
        const fs = yield* FileSystem.FileSystem
        const file = `${home}/.gent/credential-usage.json`
        const server = CredentialPlacement.Live.pipe(
          Layer.provide(
            Layer.mergeAll(
              RuntimeEnvironment.Live({ cwd: home, home }),
              BunServices.layer,
              GentPlatform.Test(),
            ),
          ),
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            const placement = Context.get(yield* Layer.build(server), CredentialPlacement)
            yield* spend(placement, a, 2, "one-step")
            expect(yield* fs.exists(file)).toBe(false)
            // The hour closes with the server still up and no step after it.
            yield* TestClock.adjust("1 hour")
            // The write is real file IO on the woken fiber: wait for it on the
            // live clock, a pause between checks, and fail loudly past 5 s.
            yield* waitFor(
              fs.exists(file),
              (found) => found,
              5_000,
              "the hourly ledger write",
            ).pipe(TestClock.withLive)
            expect(yield* fs.readFileString(file)).toContain('"costUsd":2')
          }),
        )
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    )

    it.effect("a usage ledger write that fails is made again at the next write", () =>
      Effect.gen(function* () {
        const home = yield* makeTempDirectoryScoped("gent-spread-ledger-retry-")
        const fs = yield* FileSystem.FileSystem
        const dataDir = `${home}/.gent`
        const file = `${dataDir}/credential-usage.json`
        const server = CredentialPlacement.Live.pipe(
          Layer.provide(
            Layer.mergeAll(
              RuntimeEnvironment.Live({ cwd: home, home }),
              BunServices.layer,
              GentPlatform.Test(),
            ),
          ),
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            const placement = Context.get(yield* Layer.build(server), CredentialPlacement)
            // The data directory's place holds a file: the write fails.
            yield* fs.writeFileString(dataDir, "")
            yield* spend(placement, a, 2, "one-step")
            yield* placement.flush
            expect(yield* fs.readFileString(dataDir)).toBe("")
            yield* fs.remove(dataDir)
            // No step since the failed write: its buckets are written now.
            yield* placement.flush
            expect(yield* fs.readFileString(file)).toContain('"costUsd":2')
          }),
        )
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    )
  })
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
        yield* ensureStorageParents({ sessionId, branchId })
        const storage = yield* MessageStorage
        yield* Effect.forEach(oldMessages, (message) => storage.createMessage(message), {
          discard: true,
        })
        yield* runAgentLoop(makeMessage(sessionId, branchId, "native current turn"))

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
        const details = Option.getOrThrow(contextWindowOf(marker))
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
      resolver: ModelResolver.Live.pipe(
        Layer.provide(Auth.Test()),
        Layer.provide(fixtureModelCatalogSource),
      ),
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
        const admission: SessionAdmission = {
          runSpec: { overrides: { model: modelId, reasoningEffort: "high" } },
        }
        yield* ensureStorageParents({ sessionId, branchId, admission })
        const storage = yield* MessageStorage
        yield* Effect.forEach(oldMessages, (message) => storage.createMessage(message), {
          discard: true,
        })
        yield* runAgentLoop(makeMessage(sessionId, branchId, "summarize then answer"), admission)
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
        const admission = { runSpec: { overrides: { contextLength: 6_000 } } }
        yield* ensureStorageParents({ sessionId, branchId, admission })
        const storage = yield* MessageStorage
        yield* Effect.forEach(oldMessages, (message) => storage.createMessage(message), {
          discard: true,
        })
        yield* runAgentLoop(makeMessage(sessionId, branchId, "small current turn"), admission)

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

// ── role context window ─────────────────────────────────────────────────────

describe("role context window", () => {
  const ROLE_DRIVER = "role-window-driver"
  const roleModelId = ModelId.make(`${ROLE_DRIVER}/model`)
  /** The model's own window; the role windows below sit under it. */
  const MODEL_WINDOW = 200_000
  /** A worker on the session cache: spawned, yet its role keys as `child: false`. */
  const roleWorker = AgentDefinition.make({
    name: AgentName.make("role-window-worker"),
    model: roleModelId,
    promptCache: "session",
  })
  const roleEcho = tool({
    id: "echo",
    description: "Echoes input",
    params: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
    execute: (params) => Effect.succeed({ text: params.text }),
  })
  /**
   * One step's reply: a tool call echoing `chars` characters (about
   * `chars / 4` tokens in the window), or text.
   */
  type RoleStep = { readonly echo: number } | { readonly text: string }
  const replyOf = (step: RoleStep) => {
    if ("text" in step) {
      return Stream.fromIterable([textDeltaPart(step.text), finishPart({ finishReason: "stop" })])
    }
    return Stream.fromIterable([
      toolCallPart("echo", { text: "x".repeat(step.echo) }),
      finishPart({ finishReason: "tool-calls" }),
    ])
  }
  const lastUserText = (prompt: Prompt.Prompt) => {
    const last = prompt.content.findLast((message) => message.role === "user")
    if (Predicate.isUndefined(last) || Predicate.isString(last.content)) return ""
    return last.content
      .flatMap((part) => {
        if (part.type !== "text") return []
        return [part.text]
      })
      .join("")
  }

  /**
   * A root over a 200k model whose turn steps reply from `steps` in order
   * (the summary request answers apart), with `window` as every role's
   * window when one is set. It records the roles the policy was asked for,
   * each request's hints and every event.
   */
  const roleRoot = (params: {
    readonly window: Option.Option<number>
    readonly steps: ReadonlyArray<RoleStep>
  }) =>
    Effect.gen(function* () {
      const hints: Array<ProviderHints> = []
      const asked: Array<ContextRole> = []
      const events = yield* Ref.make<AgentEvent[]>([])
      let next = 0
      const providerLayer = LanguageModelLayers.testStream((options) => {
        const prompt = Prompt.make(options.prompt)
        if (lastUserText(prompt) === "summarize")
          return Effect.succeed(replyOf({ text: "summary" }))
        const step = params.steps[next] ?? { text: "done" }
        next += 1
        return Effect.succeed(replyOf(step))
      })
      const driver: ModelDriverContribution = {
        id: ROLE_DRIVER,
        name: "Role window driver",
        resolveModel: (_modelName, _authInfo, requested) =>
          Effect.sync(() => {
            if (Predicate.isNotUndefined(requested)) hints.push(requested)
            return AiModel.make(ROLE_DRIVER, "model", providerLayer)
          }),
      }
      const policy = Layer.succeed(
        ModelContextWindowPolicy,
        ModelContextWindowPolicy.of({
          window: (role) =>
            Effect.sync(() => {
              asked.push(role)
              return params.window
            }),
        }),
      )
      const layer = actorTestRoot({
        resolver: ModelResolver.Live.pipe(
          Layer.provide(Auth.Test()),
          Layer.provide(fixtureModelCatalogSource),
        ),
        registry: ExtensionRegistry.fromResolved(
          resolveExtensions([
            {
              manifest: { id: ExtensionId.make(ROLE_DRIVER) },
              scope: "builtin",
              sourcePath: "test",
              contributions: {
                agents: [...testAgents, roleWorker],
                modelDrivers: [driver],
                tools: [roleEcho],
              },
            },
          ]),
        ),
        eventStore: recordingEventStore(events),
        models: [
          Model.make({
            id: roleModelId,
            name: "Role window model",
            provider: ProviderId.make(ROLE_DRIVER),
            contextLength: MODEL_WINDOW,
          }),
        ],
      }).pipe(
        Layer.provideMerge(rangeCompactorLayer),
        Layer.provideMerge(
          Option.match(params.window, { onNone: () => Layer.empty, onSome: () => policy }),
        ),
      )
      return { layer, hints, asked, events }
    })

  const projectedOf = (events: ReadonlyArray<AgentEvent>, sessionId: SessionId) =>
    events.flatMap((event) => {
      if (event._tag !== "ModelContextProjected" || event.sessionId !== sessionId) return []
      return [event]
    })
  /** The turn steps' output caps: the summary request asks for its own 1,000. */
  const turnMaxTokens = (hints: ReadonlyArray<ProviderHints>) =>
    hints.flatMap((hint) => {
      if (hint.maxTokens === 1_000) return []
      return [hint.maxTokens]
    })

  /** A session spawned under a root, as a delegate's child is. */
  const spawnedSession = (name: string, admission: SessionAdmission) =>
    Effect.gen(function* () {
      const parentId = SessionId.make(`${name}-parent`)
      const parentBranch = BranchId.make(`${name}-parent-branch`)
      yield* ensureStorageParents({ sessionId: parentId, branchId: parentBranch })
      const sessionId = SessionId.make(`${name}-child`)
      const now = dateFromMillis(yield* Clock.currentTimeMillis)
      yield* (yield* SessionStorage).createSession(
        new Session({
          id: sessionId,
          parentSessionId: parentId,
          parentBranchId: parentBranch,
          createdAt: now,
          updatedAt: now,
          admission,
        }),
      )
      return { sessionId, branchId: BranchId.make(`${name}-child-branch`) }
    })

  const modelAdmission: SessionAdmission = { runSpec: { overrides: { model: roleModelId } } }
  /**
   * Two echo steps of ~50k tokens each, then text: ~100k tokens before the
   * last step, past 120k less its 32k output reserve, within 200k less it.
   */
  const growingTurn: ReadonlyArray<RoleStep> = [
    { echo: 200_000 },
    { echo: 200_000 },
    { text: "done" },
  ]

  it.live("a role window keeps the model's budget and output cap", () =>
    Effect.gen(function* () {
      const runAt = (name: string, window: Option.Option<number>) =>
        Effect.gen(function* () {
          const root = yield* roleRoot({ window, steps: [{ text: "ok" }] })
          return yield* Effect.gen(function* () {
            const child = yield* spawnedSession(name, modelAdmission)
            yield* runAgentLoop(
              makeMessage(child.sessionId, child.branchId, "hello"),
              modelAdmission,
            )
            const projected = projectedOf(yield* Ref.get(root.events), child.sessionId)
            return {
              available: projected[0]?.availableInputTokens ?? 0,
              ceiling: projected[0]?.contextLimitTokens ?? 0,
              reserve: projected[0]?.reservedOutputTokens,
              maxTokens: turnMaxTokens(root.hints),
            }
          }).pipe(Effect.provide(root.layer), Effect.scoped)
        })
      const none = yield* runAt("role-lowers-none", Option.none())
      const lower = yield* runAt("role-lowers-120k", Option.some(120_000))
      const above = yield* runAt("role-lowers-300k", Option.some(300_000))
      // The budget stays the model's window: 120k is a soft limit, and a
      // window past the model's changes nothing either.
      expect(lower.available).toBe(none.available)
      expect(above.available).toBe(none.available)
      // The reply cap stays the model window's 32k: a quarter of 120k is 30k.
      expect(lower.maxTokens).toEqual([32_000])
      expect(none.maxTokens).toEqual([32_000])
      // The step reports the model's window and the reserve it sent as the cap.
      expect(lower.ceiling).toBe(MODEL_WINDOW)
      expect(lower.reserve).toBe(32_000)
    }).pipe(Effect.timeout("20 seconds")),
  )

  it.live(
    "a spawned session whose first prompt is past its role window runs under the model's budget",
    () =>
      Effect.gen(function* () {
        // ~90k tokens: past 120k less its 32k reserve, within 200k less it.
        // Nothing comes before the prompt to summarize, so the call goes out.
        const root = yield* roleRoot({ window: Option.some(120_000), steps: [{ text: "done" }] })
        yield* Effect.gen(function* () {
          const child = yield* spawnedSession("spawned-prompt-past-role", modelAdmission)
          yield* runAgentLoop(
            makeMessage(child.sessionId, child.branchId, "x".repeat(360_000)),
            modelAdmission,
          )
          const events = yield* Ref.get(root.events)
          expect(
            events.filter(
              (event) => event._tag === "ErrorOccurred" && event.sessionId === child.sessionId,
            ),
          ).toEqual([])
          expect(projectedOf(events, child.sessionId).map((event) => event.compacted)).toEqual([
            false,
          ])
          expect(turnMaxTokens(root.hints)).toEqual([32_000])
          const durable = yield* (yield* MessageStorage).listMessages(child.branchId)
          expect(
            durable.some(
              (message) =>
                message.role === "assistant" &&
                message.parts.some((part) => part.type === "text" && part.text === "done"),
            ),
          ).toBe(true)
        }).pipe(Effect.provide(root.layer), Effect.scoped)
      }).pipe(Effect.timeout("20 seconds")),
  )

  it.live("a spawned session hands off between steps at its role window", () =>
    Effect.gen(function* () {
      const runAt = (name: string, window: Option.Option<number>) =>
        Effect.gen(function* () {
          const root = yield* roleRoot({ window, steps: growingTurn })
          return yield* Effect.gen(function* () {
            const child = yield* spawnedSession(name, modelAdmission)
            yield* runAgentLoop(
              makeMessage(child.sessionId, child.branchId, "grow"),
              modelAdmission,
            )
            const projected = projectedOf(yield* Ref.get(root.events), child.sessionId)
            return { compacted: projected.map((event) => event.compacted), asked: root.asked }
          }).pipe(Effect.provide(root.layer), Effect.scoped)
        })
      const lower = yield* runAt("spawned-step-120k", Option.some(120_000))
      // ~100k tokens before step three: past 120k less the 32k reserve, so
      // the third step hands off inside the turn.
      expect(lower.compacted).toEqual([false, false, true])
      expect(lower.asked[0]).toEqual({ agent: testAgent.name, child: true })
      const model = yield* runAt("spawned-step-none", Option.none())
      expect(model.compacted).toEqual([false, false, false])
    }).pipe(Effect.timeout("20 seconds")),
  )

  it.live(
    "a worker on the session cache keys as child false and still hands off between steps",
    () =>
      Effect.gen(function* () {
        const admission: SessionAdmission = { agent: roleWorker.name, ...modelAdmission }
        const root = yield* roleRoot({ window: Option.some(120_000), steps: growingTurn })
        yield* Effect.gen(function* () {
          const child = yield* spawnedSession("worker-step", admission)
          yield* runAgentLoop(makeMessage(child.sessionId, child.branchId, "grow"), admission)
          const projected = projectedOf(yield* Ref.get(root.events), child.sessionId)
          expect(projected.map((event) => event.compacted)).toEqual([false, false, true])
          expect(root.asked[0]).toEqual({ agent: roleWorker.name, child: false })
        }).pipe(Effect.provide(root.layer), Effect.scoped)
      }).pipe(Effect.timeout("20 seconds")),
  )

  it.live(
    "a root past its role window keeps the turn whole and hands off when the next turn starts",
    () =>
      Effect.gen(function* () {
        const sessionId = SessionId.make("root-role-window")
        const branchId = BranchId.make("root-role-window-branch")
        // Each turn's echo adds ~50k tokens. The second turn starts at ~50k,
        // under 120k less its 32k reserve, and crosses it at its second step
        // with the first turn behind it to summarize: the turn stays whole.
        // The third turn starts at ~100k and hands off first.
        const root = yield* roleRoot({
          window: Option.some(120_000),
          steps: [
            { echo: 200_000 },
            { text: "first answer" },
            { echo: 200_000 },
            { text: "second answer" },
            { text: "third answer" },
          ],
        })
        yield* Effect.gen(function* () {
          yield* runAgentLoop(makeMessage(sessionId, branchId, "grow"), modelAdmission)
          yield* runAgentLoop(makeMessage(sessionId, branchId, "second turn"), modelAdmission)
          yield* runAgentLoop(makeMessage(sessionId, branchId, "third turn"), modelAdmission)
          const projected = projectedOf(yield* Ref.get(root.events), sessionId)
          expect(projected.map((event) => event.compacted)).toEqual([
            false,
            false,
            false,
            false,
            true,
          ])
          expect(root.asked[0]).toEqual({ agent: testAgent.name, child: false })
          const durable = yield* (yield* MessageStorage).listMessages(branchId)
          const marker = durable.find((message) => Option.isSome(contextWindowOf(message)))
          if (Predicate.isUndefined(marker)) return yield* Effect.die("marker missing")
          // The window reopens at the new prompt and summarizes both earlier turns.
          const window = Option.getOrThrow(contextWindowOf(marker))
          expect(window.keepFromMessageId).toBe(makeMessage(sessionId, branchId, "third turn").id)
          expect(window.summarized?.firstMessageId).toBe(
            makeMessage(sessionId, branchId, "grow").id,
          )
        }).pipe(Effect.provide(root.layer), Effect.scoped)
      }).pipe(Effect.timeout("20 seconds")),
  )

  it.live("a root past its model window still hands off between steps", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("root-role-ceiling")
      const branchId = BranchId.make("root-role-ceiling-branch")
      const root = yield* roleRoot({
        window: Option.some(120_000),
        // ~90k tokens a step: past the model's 168k input before step three.
        steps: [{ echo: 360_000 }, { echo: 360_000 }, { text: "done" }],
      })
      yield* Effect.gen(function* () {
        yield* runAgentLoop(makeMessage(sessionId, branchId, "overflow"), modelAdmission)
        const projected = projectedOf(yield* Ref.get(root.events), sessionId)
        expect(projected.map((event) => event.compacted)).toEqual([false, false, true])
      }).pipe(Effect.provide(root.layer), Effect.scoped)
    }).pipe(Effect.timeout("20 seconds")),
  )

  it.live("with no window policy a root keeps today's window across turns", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("root-no-policy")
      const branchId = BranchId.make("root-no-policy-branch")
      const root = yield* roleRoot({
        window: Option.none(),
        steps: [...growingTurn, { text: "second answer" }],
      })
      yield* Effect.gen(function* () {
        yield* runAgentLoop(makeMessage(sessionId, branchId, "grow"), modelAdmission)
        yield* runAgentLoop(makeMessage(sessionId, branchId, "second turn"), modelAdmission)
        const projected = projectedOf(yield* Ref.get(root.events), sessionId)
        expect(projected.map((event) => event.compacted)).toEqual([false, false, false, false])
        expect(projected.every((event) => event.contextLimitTokens === MODEL_WINDOW)).toBe(true)
        expect(turnMaxTokens(root.hints).every((tokens) => tokens === 32_000)).toBe(true)
      }).pipe(Effect.provide(root.layer), Effect.scoped)
    }).pipe(Effect.timeout("20 seconds")),
  )
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

        yield* runAgentLoop(makeMessage(sessionId, branchId, "fresh request"))

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
        const sessionId = SessionId.make("model-context-tool-session")
        const branchId = BranchId.make("model-context-tool-branch")
        yield* runAgentLoop(makeMessage(sessionId, branchId, "run parallel tools"))
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

  it.live(
    "asks for the output the budget reserves and passes the stable session cache key and the turn's key",
    () => {
      const modelId = ModelId.make("context-driver/model")
      let observedMaxTokens = Option.none<number>()
      const observedCacheKeys: Array<Option.Option<string>> = []
      const observedTurnKeys: Array<Option.Option<string>> = []
      let streams = 0
      // The first turn takes two steps: a tool call, then its answer.
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.sync(() => {
          streams += 1
          if (streams === 1)
            return Stream.make(
              toolCallPart("echo", { text: "step" }),
              finishPart({ finishReason: "tool-calls" }),
            )
          return Stream.fromIterable([textDeltaPart("ok"), finishPart({ finishReason: "stop" })])
        }),
      )
      const echoTool = tool({
        id: "echo",
        description: "Echoes input",
        params: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        execute: (params) => Effect.succeed({ text: params.text }),
      })
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
            observedTurnKeys.push(Option.fromUndefinedOr(hints?.turnKey))
            return AiModel.make("context-driver", "model", providerLayer)
          }),
      }
      const resolved = resolveExtensions([
        {
          manifest: { id: ExtensionId.make("model-context-driver") },
          scope: "builtin",
          sourcePath: "test",
          contributions: { agents: testAgents, modelDrivers: [driver], tools: [echoTool] },
        },
      ])
      const extensionRegistry = ExtensionRegistry.fromResolved(resolved)
      const modelResolver = ModelResolver.Live.pipe(
        Layer.provide(Auth.Test()),
        Layer.provide(fixtureModelCatalogSource),
      )
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
          const first = makeMessage(
            SessionId.make("model-context-driver-session"),
            BranchId.make("model-context-driver-branch"),
            "request provider budget",
          )
          yield* runAgentLoop(first, { runSpec: { overrides: { model: modelId } } })
          // The catalog cap is under 32k, so the request asks for all of it.
          expect(observedMaxTokens).toEqual(Option.some(16_000))
          const second = makeMessage(
            SessionId.make("model-context-driver-session"),
            BranchId.make("model-context-driver-branch"),
            "continue with the same cache key",
          )
          yield* runAgentLoop(second, { runSpec: { overrides: { model: modelId } } })
          expect(observedCacheKeys).toEqual([
            Option.some("model-context-driver-session"),
            Option.some("model-context-driver-session"),
            Option.some("model-context-driver-session"),
          ])
          // A turn's steps share its key; the next turn takes its own.
          expect(observedTurnKeys).toEqual([
            Option.some(first.id),
            Option.some(first.id),
            Option.some(second.id),
          ])
        }),
      ).pipe(Effect.provide(layer), Effect.timeout("5 seconds"))
    },
  )
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

// ── virtual model routing ───────────────────────────────────────────────────

const LIGHT_MODEL = ModelId.make("custom/light")
const STRONG_MODEL = ModelId.make("custom/strong")
const AUTO_MODEL = ModelId.make("router/auto")

/** Light (the default), then strong at high effort. */
const lightAndStrong: ReadonlyArray<VirtualModelChoice> = [
  { model: LIGHT_MODEL, reason: "light work" },
  { model: STRONG_MODEL, effort: "high", reason: "hard work" },
]

/** The texts of the user messages a router read. */
const userTexts = (input: ModelRouteInput) =>
  input.messages.filter((message) => message.role === "user").map((m) => messagePartsText(m.parts))

/**
 * A router that serves `router/auto` over `choices` with `route`, a tool
 * that holds while `hold` is open, and any other registration the test needs.
 */
const routingExtension = (params: {
  readonly route: ModelRouterContribution["route"]
  readonly choices?: ReadonlyArray<VirtualModelChoice>
  readonly fallback?: number
  readonly hold?: HoldGate
  readonly drivers?: ReadonlyArray<ModelDriverContribution>
  /** The effort router `/effort auto` runs (`ModelRouterContribution.effort`). */
  readonly effort?: VirtualModel
}) =>
  defineExtension({
    id: "test-routing",
    setup: Effect.gen(function* () {
      const host = yield* ExtensionHost
      yield* host.register("modelRouter", {
        id: "router",
        name: "Test router",
        models: [
          {
            name: "auto",
            label: "Auto",
            choices: params.choices ?? lightAndStrong,
            fallback: params.fallback ?? 0,
          },
        ],
        route: params.route,
        ...omitUndefined({ effort: params.effort }),
      })
      for (const driver of params.drivers ?? []) yield* host.register("modelDriver", driver)
      yield* host.register(
        "tool",
        tool({
          id: "route_hold",
          description: "Hold until the test releases it",
          params: Schema.Struct({}),
          output: Schema.Struct({ held: Schema.Boolean }),
          execute: Effect.fn("route_hold")(function* () {
            yield* ExtensionContext
            if (Predicate.isNotUndefined(params.hold)) {
              yield* Deferred.succeed(params.hold.entered, void 0)
              yield* Deferred.await(params.hold.release)
            }
            return { held: true }
          }),
        }),
      )
    }),
  })

type RoutingClient = Effect.Success<ReturnType<typeof createRpcHarness>>["client"]

/** Record every event of the branch, from its first; read them once `turns` turns ended. */
const recordBranchEvents = Effect.fn("test.recordBranchEvents")(function* (
  client: RoutingClient,
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

const routedEvents = (events: ReadonlyArray<AgentEvent>) => events.filter(Schema.is(ModelRouted))

const stepModels = (events: ReadonlyArray<AgentEvent>) =>
  events.flatMap((event) => {
    if (event._tag !== "StreamEnded") return []
    return [event.model]
  })

const selectAuto = (client: RoutingClient, sessionId: SessionId) =>
  client.session.updateSettings({
    sessionId,
    modelId: Option.some(AUTO_MODEL),
    reasoningLevel: Option.none(),
  })

describe("virtual model routing", () => {
  it.scopedLive(
    "a turn on a virtual model runs every step on the model its router picks, routed once",
    () =>
      Effect.gen(function* () {
        const inputs = yield* Ref.make<ReadonlyArray<ModelRouteInput>>([])
        const picks = [1, 0]
        // Each request runs on its routed model, at its choice's effort.
        const onModel =
          (model: ModelId, reasoning: Option.Option<string>) =>
          (request: { readonly model: string; readonly reasoning?: string }) => {
            expect(request.model).toBe(model)
            expect(Option.fromUndefinedOr(request.reasoning)).toEqual(reasoning)
          }
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          {
            ...toolCallStep("route_hold", {}),
            assertRequest: onModel(STRONG_MODEL, Option.some("high")),
          },
          { ...textStep("hard answer"), assertRequest: onModel(STRONG_MODEL, Option.some("high")) },
          { ...textStep("light answer"), assertRequest: onModel(LIGHT_MODEL, Option.none()) },
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: e2ePreset.agents,
          providerLayer,
          extensionInputs: [
            routingExtension({
              route: (input) =>
                Ref.updateAndGet(inputs, (all) => [...all, input]).pipe(
                  Effect.map((all) => ({
                    choice: picks[all.length - 1] ?? 0,
                    reason: `pick ${all.length}`,
                  })),
                ),
            }),
          ],
        })
        const afterTurns = yield* recordBranchEvents(client, { sessionId, branchId })
        yield* selectAuto(client, sessionId)
        yield* client.message.send({ sessionId, branchId, content: "do the hard thing" })
        const firstTurn = yield* afterTurns(1)
        // One route for the turn's two steps: both run on the strong model.
        expect(routedEvents(firstTurn)).toHaveLength(1)
        expect(routedEvents(firstTurn)[0]).toMatchObject({
          selected: AUTO_MODEL,
          model: STRONG_MODEL,
          choice: 1,
          effort: "high",
          reason: "pick 1",
        })
        expect(routedEvents(firstTurn)[0]?.fallback).toBeUndefined()
        expect(stepModels(firstTurn)).toEqual([STRONG_MODEL, STRONG_MODEL])
        // The route lands before the turn's first request.
        expect(firstTurn.findIndex(Schema.is(ModelRouted))).toBeLessThan(
          firstTurn.findIndex((event) => event._tag === "StreamStarted"),
        )
        const [first] = yield* Ref.get(inputs)
        expect(first?.current).toEqual(Option.none())
        expect(first?.candidates.map(Option.map((model) => model.id))).toEqual([
          Option.some(LIGHT_MODEL),
          Option.some(STRONG_MODEL),
        ])
        expect(first?.messages.at(-1)?.role).toBe("user")

        yield* client.message.send({ sessionId, branchId, content: "now something light" })
        const both = yield* afterTurns(2)
        expect(routedEvents(both).map((event) => event.model)).toEqual([STRONG_MODEL, LIGHT_MODEL])
        expect(stepModels(both)).toEqual([STRONG_MODEL, STRONG_MODEL, LIGHT_MODEL])
        // The second route reads the warm strong model and the history a switch rewrites.
        const second = (yield* Ref.get(inputs))[1]
        expect(Option.map(second?.current ?? Option.none(), (current) => current.model.id)).toEqual(
          Option.some(STRONG_MODEL),
        )
        expect(Option.exists(second?.current ?? Option.none(), (current) => current.warm)).toBe(
          true,
        )
        expect(
          Option.exists(second?.current ?? Option.none(), (current) => current.historyTokens > 0),
        ).toBe(true)
        const snapshot = yield* client.session.getSnapshot({ sessionId, branchId })
        // The footer still names the virtual model; the metrics name where it routed.
        expect(snapshot.resolvedModelId).toBe(AUTO_MODEL)
        expect(snapshot.metrics.routed).toMatchObject({ selected: AUTO_MODEL, model: LIGHT_MODEL })
        yield* controls.assertDone
      }).pipe(Effect.timeout("15 seconds")),
    20_000,
  )

  it.scopedLive(
    "a route reads the branch's model as cold only where its last account certainly moved",
    () =>
      Effect.gen(function* () {
        const work = CredentialSlot.make("work")
        // The order before each turn. A new sign-in on the same slot is the
        // other certain move; the effort test shows it on the live registry,
        // whose receipts carry sign-in stamps. Route and effort read one answer.
        const cases: ReadonlyArray<{
          readonly name: string
          readonly first: ReadonlyArray<CredentialSlot>
          readonly second: ReadonlyArray<CredentialSlot>
          readonly warm: boolean
        }> = [
          // The slot the last request used left the order.
          { name: "left", first: [DEFAULT_CREDENTIAL_SLOT], second: [work], warm: false },
          // A first credential the turn may again move past (a spent quota):
          // where the next request goes out is not known, so it is no move.
          { name: "steady", first: [work], second: [DEFAULT_CREDENTIAL_SLOT, work], warm: true },
        ]
        for (const { name, first, second: order, warm } of cases) {
          const inputs = yield* Ref.make<ReadonlyArray<ModelRouteInput>>([])
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            textStep("first"),
            textStep("second"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            agents: e2ePreset.agents,
            providerLayer,
            extensionInputs: [
              routingExtension({
                route: (input) =>
                  Ref.update(inputs, (all) => [...all, input]).pipe(
                    Effect.as({ choice: 1, reason: "strong" }),
                  ),
              }),
            ],
          })
          const afterTurns = yield* recordBranchEvents(client, { sessionId, branchId })
          yield* selectAuto(client, sessionId)
          yield* client.auth.setKey({ provider: "custom", key: "sk-fake-a", sessionId })
          yield* client.auth.setKey({ provider: "custom", slot: work, key: "sk-fake-b", sessionId })
          yield* client.auth.setOrder({ provider: "custom", order: first, sessionId })
          yield* client.message.send({ sessionId, branchId, content: "first" })
          yield* afterTurns(1)
          yield* client.auth.setOrder({ provider: "custom", order, sessionId })
          yield* client.message.send({ sessionId, branchId, content: "second" })
          yield* afterTurns(2)
          const next = (yield* Ref.get(inputs))[1]
          expect([
            name,
            Option.map(next?.current ?? Option.none(), (current) => current.model.id),
          ]).toEqual([name, Option.some(STRONG_MODEL)])
          expect([
            name,
            Option.exists(next?.current ?? Option.none(), (current) => current.warm),
          ]).toEqual([name, warm])
        }
      }).pipe(Effect.timeout("15 seconds")),
    20_000,
  )

  it.scopedLive(
    "a router runs under its own extension id: its state pulse names it and the route stands",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          {
            ...textStep("hard answer"),
            assertRequest: (request) => expect(request.model).toBe(STRONG_MODEL),
          },
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: e2ePreset.agents,
          providerLayer,
          extensionInputs: [
            routingExtension({
              route: () =>
                Effect.gen(function* () {
                  const ctx = yield* ExtensionContext
                  // A failed pulse fails the route, and the turn falls back.
                  yield* ctx.State.changed()
                  return { choice: 1, reason: `routed by ${ctx.extensionId}` }
                }),
            }),
          ],
        })
        const afterTurns = yield* recordBranchEvents(client, { sessionId, branchId })
        yield* selectAuto(client, sessionId)
        yield* client.message.send({ sessionId, branchId, content: "do the hard thing" })
        const events = yield* afterTurns(1)
        expect(routedEvents(events)).toHaveLength(1)
        expect(routedEvents(events)[0]).toMatchObject({
          model: STRONG_MODEL,
          choice: 1,
          reason: "routed by test-routing",
        })
        expect(routedEvents(events)[0]?.fallback).toBeUndefined()
        expect(
          events.flatMap((event) => {
            if (event._tag !== "ExtensionStateChanged") return []
            return [event.extensionId]
          }),
        ).toEqual([ExtensionId.make("test-routing")])
        yield* controls.assertDone
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )

  it.scopedLive(
    "a routed switch writes the model-change notice a switch by hand writes, and nothing else",
    () =>
      Effect.gen(function* () {
        // One conversation on light, then a second turn on strong: picked by
        // hand, or by the router. The second request is what is compared;
        // both run in one directory, which the system prompt names.
        const cwd = yield* makeTempDirectoryScoped("gent-route-bytes-")
        const secondTurn = Effect.fn("test.secondTurn")(function* (selection: ModelId) {
          const seen: Array<Prompt.Prompt> = []
          const capture = (options: { readonly prompt: Prompt.Prompt }) => {
            seen.push(options.prompt)
          }
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            textStep("first answer"),
            { ...textStep("strong answer"), assertOptions: capture },
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            agents: e2ePreset.agents,
            providerLayer,
            cwd,
            extensionInputs: [
              routingExtension({ route: () => Effect.succeed({ choice: 1, reason: "hard" }) }),
            ],
          })
          const afterTurns = yield* recordBranchEvents(client, { sessionId, branchId })
          yield* client.session.updateSettings({
            sessionId,
            modelId: Option.some(LIGHT_MODEL),
            reasoningLevel: Option.none(),
          })
          yield* client.message.send({ sessionId, branchId, content: "first" })
          yield* afterTurns(1)
          yield* client.session.updateSettings({
            sessionId,
            modelId: Option.some(selection),
            reasoningLevel: Option.none(),
          })
          yield* client.message.send({ sessionId, branchId, content: "second" })
          const events = yield* afterTurns(2)
          const messages = yield* client.message.list({ branchId })
          const [prompt] = seen
          return {
            models: stepModels(events),
            transcript: messages.map((message) => message.metadata?.customType ?? message.role),
            request: (prompt?.content ?? []).map((message) => ({
              role: message.role,
              text: promptText(Prompt.make([message])),
            })),
          }
        })
        const byHand = yield* secondTurn(STRONG_MODEL)
        const routed = yield* secondTurn(AUTO_MODEL)
        expect(routed.models).toEqual([LIGHT_MODEL, STRONG_MODEL])
        // The route adds only the notice a hand switch adds, and sends the same request.
        expect(routed.transcript).toEqual([
          "user",
          "assistant",
          "user",
          "model-change",
          "assistant",
        ])
        expect(routed.transcript).toEqual(byHand.transcript)
        expect(routed.request).toEqual(byHand.request)
        expect(routed.request.at(-1)?.role).toBe("user")
        expect(routed.request.at(-1)?.text).toContain(`continues with ${STRONG_MODEL}]`)
      }).pipe(Effect.timeout("15 seconds")),
    20_000,
  )

  it.scopedLive(
    "a router that fails, dies or picks a choice the turn cannot run leaves the turn on the default choice",
    () =>
      Effect.gen(function* () {
        const routes: ReadonlyArray<{
          readonly route: ModelRouterContribution["route"]
          readonly reason: string
        }> = [
          {
            route: () =>
              Effect.fail(
                new ExtensionServiceError({
                  service: "Models",
                  operation: "decide",
                  message: "no classifier",
                }),
              ),
            reason: "the router failed: no classifier",
          },
          { route: () => Effect.die("router bug"), reason: "the router failed" },
          {
            route: () => Effect.succeed({ choice: 7, reason: "out of range" }),
            reason: "the router picked choice 7, which the turn cannot run",
          },
        ]
        for (const { route, reason } of routes) {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            textStep("fallback answer"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            agents: e2ePreset.agents,
            providerLayer,
            extensionInputs: [routingExtension({ route, fallback: 1 })],
          })
          const afterTurns = yield* recordBranchEvents(client, { sessionId, branchId })
          yield* selectAuto(client, sessionId)
          yield* client.message.send({ sessionId, branchId, content: "route me" })
          const events = yield* afterTurns(1)
          const [routed] = routedEvents(events)
          expect(routed).toMatchObject({ model: STRONG_MODEL, choice: 1, fallback: true })
          expect(routed?.reason).toContain(reason)
          expect(stepModels(events)).toEqual([STRONG_MODEL])
          expect(events.filter(Schema.is(ErrorOccurred))).toEqual([])
        }
      }).pipe(Effect.timeout("20 seconds")),
    25_000,
  )

  it.scopedLive(
    "a router that does not answer within 10 seconds leaves the turn on the default choice",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          textStep("late answer"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: e2ePreset.agents,
          providerLayer,
          extensionInputs: [routingExtension({ route: () => Effect.never })],
        })
        const afterTurns = yield* recordBranchEvents(client, { sessionId, branchId })
        yield* selectAuto(client, sessionId)
        yield* client.message.send({ sessionId, branchId, content: "route me" })
        const events = yield* afterTurns(1)
        expect(routedEvents(events)[0]).toMatchObject({
          model: LIGHT_MODEL,
          choice: 0,
          fallback: true,
          reason: "the router gave no answer within 10000 ms",
        })
        expect(stepModels(events)).toEqual([LIGHT_MODEL])
      }).pipe(Effect.timeout("18 seconds")),
    22_000,
  )

  it.scopedLive(
    "a router's pick on a provider with no sign-in leaves the turn on the default, and the route says why",
    () =>
      Effect.gen(function* () {
        // The default's provider has a sign-in, the alternative's has none
        // until the second turn.
        const signedModel = ModelId.make("signed/main")
        const unsignedModel = ModelId.make("unsigned/alt")
        const chatDriver = (id: string): ModelDriverContribution => ({
          id,
          name: id,
          envCredential: "GENT_TEST_ROUTE_SIGN_IN_KEY_NEVER_SET",
          resolveModel: () => Effect.die("the test resolver serves the scripted model"),
        })
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          textStep("on the default"),
          textStep("on the alternative"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: e2ePreset.agents,
          providerLayer,
          signIn: "checked",
          extensionInputs: [
            routingExtension({
              choices: [
                { model: signedModel, reason: "everyday work" },
                { model: unsignedModel, reason: "hard work" },
              ],
              drivers: [chatDriver("signed"), chatDriver("unsigned")],
              route: () => Effect.succeed({ choice: 1, reason: "hard" }),
            }),
          ],
        })
        yield* client.auth.setKey({ provider: "signed", key: "test-key", sessionId })
        const afterTurns = yield* recordBranchEvents(client, { sessionId, branchId })
        yield* selectAuto(client, sessionId)
        yield* client.message.send({ sessionId, branchId, content: "hard" })
        yield* afterTurns(1)
        // With a sign-in, the same pick runs.
        yield* client.auth.setKey({ provider: "unsigned", key: "test-key", sessionId })
        yield* client.message.send({ sessionId, branchId, content: "hard again" })
        const events = yield* afterTurns(2)
        const routed = routedEvents(events)
        expect(routed[0]).toMatchObject({
          model: signedModel,
          choice: 0,
          fallback: true,
          reason: 'the router picked choice 1, whose provider "unsigned" has no sign-in',
        })
        expect(routed[1]).toMatchObject({ model: unsignedModel, choice: 1, reason: "hard" })
        expect(routed[1]?.fallback).toBeUndefined()
        expect(stepModels(events)).toEqual([signedModel, unsignedModel])
      }).pipe(Effect.timeout("15 seconds")),
    20_000,
  )

  it.scopedLive(
    "a route with no choice signed in asks no classifier, falls back, and names the providers without a sign-in",
    () =>
      Effect.gen(function* () {
        // The classifier has a sign-in; neither choice's provider has one.
        const mainModel = ModelId.make("unsigned-main/main")
        const altModel = ModelId.make("unsigned-alt/alt")
        const chatDriver = (id: string): ModelDriverContribution => ({
          id,
          name: id,
          envCredential: "GENT_TEST_ROUTE_SIGN_IN_KEY_NEVER_SET",
          resolveModel: () => Effect.die("the test resolver serves the scripted model"),
        })
        const routes = yield* Ref.make(0)
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          textStep("on the default"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: e2ePreset.agents,
          providerLayer,
          signIn: "checked",
          extensionInputs: [
            routingExtension({
              choices: [
                { model: mainModel, reason: "everyday work" },
                { model: altModel, reason: "hard work" },
              ],
              drivers: [chatDriver("unsigned-main"), chatDriver("unsigned-alt"), routeJudgeDriver],
              route: () =>
                Effect.gen(function* () {
                  yield* Ref.update(routes, (count) => count + 1)
                  const ctx = yield* ExtensionContext
                  yield* ctx.Models.decide({
                    definition: Decision.make({
                      input: Schema.String,
                      decisions: {
                        choice: Decision.classify({
                          instructions: "Which choice",
                          criteria: { choice1: "light work", choice2: "hard work" },
                        }),
                      },
                    }),
                    input: "route me",
                  })
                  return { choice: 1, reason: "hard" }
                }),
            }),
          ],
        })
        yield* client.auth.setKey({ provider: "route-judge", key: "test-key", sessionId })
        const afterTurns = yield* recordBranchEvents(client, { sessionId, branchId })
        yield* selectAuto(client, sessionId)
        yield* client.message.send({ sessionId, branchId, content: "route me" })
        const events = yield* afterTurns(1)
        expect(yield* Ref.get(routes)).toBe(0)
        const [routed] = routedEvents(events)
        expect(routed).toMatchObject({
          model: mainModel,
          choice: 0,
          fallback: true,
          reason:
            'no choice can run: the providers "unsigned-main" and "unsigned-alt" have no sign-in',
        })
        expect(routed?.classifier).toBeUndefined()
        expect(routed?.costUsd).toBeUndefined()
        expect(stepModels(events)).toEqual([mainModel])
      }).pipe(Effect.timeout("15 seconds")),
    20_000,
  )

  it.scopedLive(
    "a route that falls back keeps the model the branch runs on when it is a choice",
    () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make(0)
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          textStep("strong answer"),
          textStep("still strong"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: e2ePreset.agents,
          providerLayer,
          extensionInputs: [
            routingExtension({
              route: () =>
                Ref.updateAndGet(calls, (count) => count + 1).pipe(
                  Effect.flatMap((count) => {
                    if (count === 1) return Effect.succeed({ choice: 1, reason: "hard" })
                    return Effect.die("router bug")
                  }),
                ),
            }),
          ],
        })
        const afterTurns = yield* recordBranchEvents(client, { sessionId, branchId })
        yield* selectAuto(client, sessionId)
        yield* client.message.send({ sessionId, branchId, content: "hard" })
        yield* afterTurns(1)
        yield* client.message.send({ sessionId, branchId, content: "again" })
        const events = yield* afterTurns(2)
        // The default is light, but the branch's warm strong model is a choice.
        expect(routedEvents(events).map((event) => [event.model, event.fallback === true])).toEqual(
          [
            [STRONG_MODEL, false],
            [STRONG_MODEL, true],
          ],
        )
        expect(stepModels(events)).toEqual([STRONG_MODEL, STRONG_MODEL])
      }).pipe(Effect.timeout("15 seconds")),
    20_000,
  )

  it.scopedLive(
    "selecting a virtual model while a tool runs keeps the turn on its model until the next turn",
    () =>
      Effect.gen(function* () {
        const gate: HoldGate = {
          entered: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        }
        const calls = yield* Ref.make(0)
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          toolCallStep("route_hold", {}),
          textStep("same model"),
          textStep("routed now"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: e2ePreset.agents,
          providerLayer,
          extensionInputs: [
            routingExtension({
              hold: gate,
              route: () =>
                Ref.update(calls, (count) => count + 1).pipe(
                  Effect.as({ choice: 1, reason: "hard" }),
                ),
            }),
          ],
        })
        const afterTurns = yield* recordBranchEvents(client, { sessionId, branchId })
        yield* client.message.send({ sessionId, branchId, content: "hold" })
        yield* Deferred.await(gate.entered)
        yield* selectAuto(client, sessionId)
        yield* Deferred.succeed(gate.release, void 0)
        const first = yield* afterTurns(1)
        const [opening] = stepModels(first)
        // Step 2 keeps the step-1 model: no route mid-turn, no notice, no router call.
        expect(stepModels(first)).toEqual([opening, opening])
        expect(routedEvents(first)).toHaveLength(1)
        expect(routedEvents(first)[0]).toMatchObject({
          model: opening,
          fallback: true,
          reason: "a turn routes only before its first request",
        })
        expect(routedEvents(first)[0]?.choice).toBeUndefined()
        expect(yield* Ref.get(calls)).toBe(0)
        const messages = yield* client.message.list({ branchId })
        expect(messages.some((message) => message.metadata?.customType === "model-change")).toBe(
          false,
        )
        yield* client.message.send({ sessionId, branchId, content: "next turn" })
        const both = yield* afterTurns(2)
        expect(stepModels(both).at(-1)).toBe(STRONG_MODEL)
        expect(yield* Ref.get(calls)).toBe(1)
      }).pipe(Effect.timeout("15 seconds")),
    20_000,
  )

  it.scopedLive(
    "a recovered turn runs on its recorded route and does not ask the router again",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDirectoryScoped("gent-route-replay-")
        const dbPath = `${tempDir}/gent.db`
        const gate: HoldGate = {
          entered: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        }
        const firstText = "FIRST-TURN"
        // First process: the turn routes to strong, runs its tool, and dies
        // while step 2 waits on the model.
        const firstProvider = yield* LanguageModelLayers.sequence([
          toolCallStep("route_hold", {}),
          { ...textStep("never emitted"), gated: true },
        ])
        const started = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(
              createE2ELayer({
                agents: e2ePreset.agents,
                providerLayer: firstProvider.layer,
                extensionInputs: [
                  routingExtension({
                    hold: gate,
                    route: () => Effect.succeed({ choice: 1, reason: "hard" }),
                  }),
                ],
                storagePath: dbPath,
              }),
            )
            const { sessionId, branchId } = yield* client.session.create({})
            yield* selectAuto(client, sessionId)
            yield* client.message
              .send({ sessionId, branchId, content: firstText })
              .pipe(Effect.forkScoped)
            yield* Deferred.await(gate.entered)
            yield* Deferred.succeed(gate.release, void 0)
            yield* firstProvider.controls.waitForCall(1)
            return { sessionId, branchId }
          }).pipe(Effect.timeout("10 seconds")),
        )

        // Second process: the router would pick light; the turn replays on strong.
        const asked = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([])
        const secondProvider = yield* LanguageModelLayers.sequence([
          textStep("RECOVERED"),
          textStep("NEXT"),
        ])
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(
              createE2ELayer({
                agents: e2ePreset.agents,
                providerLayer: secondProvider.layer,
                extensionInputs: [
                  routingExtension({
                    route: (input) =>
                      Ref.update(asked, (all) => [...all, userTexts(input)]).pipe(
                        Effect.as({ choice: 0, reason: "light" }),
                      ),
                  }),
                ],
                storagePath: dbPath,
              }),
            )
            const afterTurns = yield* recordBranchEvents(client, started)
            yield* client.session.getSnapshot(started)
            yield* client.message.send({ ...started, content: "next" })
            const events = yield* afterTurns(2)
            const routed = routedEvents(events)
            // One route per turn: the recovered turn's, recorded by the first process.
            expect(routed.map((event) => event.model)).toEqual([STRONG_MODEL, LIGHT_MODEL])
            // The first process's step 1, the recovered step 2, the next turn.
            expect(stepModels(events)).toEqual([STRONG_MODEL, STRONG_MODEL, LIGHT_MODEL])
            // The router saw only the next turn, never the recovered one.
            expect((yield* Ref.get(asked)).map((texts) => texts.at(-1))).toEqual(["next"])
          }).pipe(Effect.timeout("20 seconds")),
        )
      }).pipe(Effect.timeout("40 seconds")),
    60_000,
  )

  it.scopedLive(
    "a turn recovered after its route and before its first step keeps the route's charge in its cost, once",
    () =>
      Effect.gen(function* () {
        // A priced classifier makes the cost its 21 tokens plus the step's;
        // an unpriced one leaves the turn's cost unknown.
        const cases = [
          { judge: routeJudgeDriver, cost: Option.some((21 + 13) / 1_000_000) },
          { judge: unpricedRouteJudgeDriver, cost: Option.none<number>() },
        ]
        for (const { judge, cost } of cases) {
          const tempDir = yield* makeTempDirectoryScoped("gent-route-charge-")
          const dbPath = `${tempDir}/gent.db`
          const judged: ModelRouterContribution["route"] = () =>
            Effect.gen(function* () {
              const ctx = yield* ExtensionContext
              yield* ctx.Models.decide({
                definition: Decision.make({
                  input: Schema.String,
                  decisions: {
                    choice: Decision.classify({
                      instructions: "Which choice",
                      criteria: { choice1: "light work", choice2: "hard work" },
                    }),
                  },
                }),
                input: "route me",
              })
              return { choice: 1, reason: "hard" }
            })
          // First process: the turn routes, sends its first request and dies
          // before the step commits.
          const firstProvider = yield* LanguageModelLayers.sequence([
            { ...textStep("never emitted"), gated: true },
          ])
          const started = yield* Effect.scoped(
            Effect.gen(function* () {
              const { client } = yield* createRpcClient(
                createE2ELayer({
                  agents: e2ePreset.agents,
                  providerLayer: firstProvider.layer,
                  extensionInputs: [routingExtension({ drivers: [judge], route: judged })],
                  storagePath: dbPath,
                  modelPricing: { input: 1, output: 1 },
                }),
              )
              const { sessionId, branchId } = yield* client.session.create({})
              yield* client.auth.setKey({ provider: judge.id, key: "test-key", sessionId })
              yield* selectAuto(client, sessionId)
              yield* client.message
                .send({ sessionId, branchId, content: "route me" })
                .pipe(Effect.forkScoped)
              yield* firstProvider.controls.waitForCall(0)
              return { sessionId, branchId }
            }).pipe(Effect.timeout("10 seconds")),
          )

          // Second process: the recovered turn runs its step on the recorded
          // route; the router is not asked again.
          const secondProvider = yield* LanguageModelLayers.sequence([textStep("RECOVERED")])
          yield* Effect.scoped(
            Effect.gen(function* () {
              const { client } = yield* createRpcClient(
                createE2ELayer({
                  agents: e2ePreset.agents,
                  providerLayer: secondProvider.layer,
                  extensionInputs: [
                    routingExtension({ drivers: [judge], route: () => Effect.die("asked again") }),
                  ],
                  storagePath: dbPath,
                  modelPricing: { input: 1, output: 1 },
                }),
              )
              const afterTurns = yield* recordBranchEvents(client, started)
              yield* client.session.getSnapshot(started)
              const events = yield* afterTurns(1)
              expect(routedEvents(events)).toHaveLength(1)
              expect(stepModels(events)).toEqual([STRONG_MODEL])
              const completed = events.filter(Schema.is(TurnCompleted))
              expect(completed).toHaveLength(1)
              const turnCost = Option.fromUndefinedOr(completed[0]?.costUsd)
              expect([judge.id, Option.isSome(turnCost)]).toEqual([judge.id, Option.isSome(cost)])
              if (Option.isSome(cost))
                expect(Option.getOrThrow(turnCost)).toBeCloseTo(cost.value, 12)
            }).pipe(Effect.timeout("20 seconds")),
          )
        }
      }).pipe(Effect.timeout("50 seconds")),
    60_000,
  )

  it.scopedLive(
    "a virtual model that routes to a router is refused: the catalog omits it and its turn says why",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: e2ePreset.agents,
          providerLayer,
          extensionInputs: [
            routingExtension({
              choices: [{ model: AUTO_MODEL, reason: "itself" }],
              route: () => Effect.succeed({ choice: 0, reason: "loop" }),
            }),
          ],
        })
        const afterTurns = yield* recordBranchEvents(client, { sessionId, branchId })
        const models = yield* client.model.list({ sessionId })
        expect(models.some((model) => model.id === AUTO_MODEL)).toBe(false)
        yield* selectAuto(client, sessionId)
        yield* client.message.send({ sessionId, branchId, content: "route me" })
        const events = yield* afterTurns(1)
        expect(events.filter(Schema.is(ErrorOccurred)).map((event) => event.error)).toEqual([
          `Model router "${AUTO_MODEL}": a router cannot route to a router: choice "${AUTO_MODEL}"`,
        ])
        expect(routedEvents(events)).toEqual([])
        expect(stepModels(events)).toEqual([])
      }).pipe(Effect.timeout("15 seconds")),
    20_000,
  )

  it.scopedLive(
    "the catalog lists a virtual model with its label, beside the models it routes to",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
        const { client, sessionId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          extensionInputs: [
            ...e2ePreset.extensionInputs,
            routingExtension({ route: () => Effect.succeed({ choice: 0, reason: "any" }) }),
          ],
        })
        const models = yield* client.model.list({ sessionId })
        expect(models.find((model) => model.id === AUTO_MODEL)).toMatchObject({
          name: "Auto",
          kind: "virtual",
        })
      }).pipe(Effect.timeout("15 seconds")),
    20_000,
  )

  it.scopedLive(
    "the auth gate asks for the driver of a virtual model's default choice",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
        const { client, sessionId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          extensionInputs: [
            ...e2ePreset.extensionInputs,
            routingExtension({
              choices: [
                { model: LIGHT_MODEL, reason: "light" },
                { model: TEST_MODEL_ID, reason: "default" },
              ],
              fallback: 1,
              route: () => Effect.succeed({ choice: 0, reason: "any" }),
            }),
          ],
        })
        yield* selectAuto(client, sessionId)
        const providers = yield* client.auth.listProviders({ sessionId })
        expect(
          providers
            .filter((provider) => provider.required)
            .map((provider) => String(provider.provider)),
        ).toEqual(TEST_MODEL_ID.split("/").slice(0, 1))
      }).pipe(Effect.timeout("15 seconds")),
    20_000,
  )

  it.scopedLive(
    "a route to another provider sends the earlier model's reasoning as text, without its provider state",
    () =>
      Effect.gen(function* () {
        const prompts = yield* Ref.make<ReadonlyArray<Prompt.Prompt>>([])
        const encrypted = { openai: { itemId: "rs_1", encryptedContent: "enc-1" } }
        const providerLayer = LanguageModelLayers.testStream((options) =>
          Ref.updateAndGet(prompts, (all) => [...all, options.prompt]).pipe(
            Effect.map((all) => {
              // The first turn reasons with OpenAI state; the routed one only answers.
              if (all.length > 1)
                return Stream.fromIterable([
                  textDeltaPart("routed answer"),
                  finishPart({ finishReason: "stop" }),
                ] satisfies LanguageModelStreamPart[])
              return Stream.fromIterable([
                Response.makePart("reasoning-start", { id: "rs_1:0", metadata: encrypted }),
                Response.makePart("reasoning-delta", { id: "rs_1:0", delta: "plan" }),
                Response.makePart("reasoning-end", { id: "rs_1:0", metadata: encrypted }),
                textDeltaPart("first answer"),
                finishPart({ finishReason: "stop" }),
              ] satisfies LanguageModelStreamPart[])
            }),
          ),
        )
        const openai = ModelId.make("openai/gpt-5.4")
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: e2ePreset.agents,
          providerLayer,
          extensionInputs: [
            routingExtension({
              choices: [
                { model: openai, reason: "light" },
                { model: STRONG_MODEL, reason: "hard" },
              ],
              route: () => Effect.succeed({ choice: 1, reason: "hard" }),
            }),
          ],
        })
        const afterTurns = yield* recordBranchEvents(client, { sessionId, branchId })
        yield* client.session.updateSettings({
          sessionId,
          modelId: Option.some(openai),
          reasoningLevel: Option.none(),
        })
        yield* client.message.send({ sessionId, branchId, content: "first" })
        yield* afterTurns(1)
        yield* selectAuto(client, sessionId)
        yield* client.message.send({ sessionId, branchId, content: "second" })
        const events = yield* afterTurns(2)
        expect(stepModels(events)).toEqual([openai, STRONG_MODEL])
        const routedPrompt = (yield* Ref.get(prompts))[1]
        const replayed = (routedPrompt?.content ?? []).flatMap((message) => {
          if (message.role !== "assistant") return []
          return message.content.flatMap((part) => {
            if (part.type !== "reasoning") return []
            return [[part.text, part.options]]
          })
        })
        // The text goes back; the encrypted item, which only OpenAI reads, does not.
        expect(replayed).toEqual([["plan", {}]])
      }).pipe(Effect.timeout("15 seconds")),
    20_000,
  )

  it.scopedLive(
    "a route's classifier calls are priced into its event and the session's cost",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          textStep("classified answer"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: e2ePreset.agents,
          providerLayer,
          extensionInputs: [
            routingExtension({
              drivers: [routeJudgeDriver],
              route: () =>
                Effect.gen(function* () {
                  const ctx = yield* ExtensionContext
                  const reply = yield* ctx.Models.decide({
                    definition: Decision.make({
                      input: Schema.String,
                      decisions: {
                        choice: Decision.classify({
                          instructions: "Which choice",
                          criteria: { choice1: "light work", choice2: "hard work" },
                        }),
                      },
                    }),
                    input: "route me",
                  })
                  return {
                    choice: Number(reply.answers.choice.label === "choice2"),
                    reason: reply.answers.choice.label,
                  }
                }),
            }),
          ],
        })
        yield* client.auth.setKey({ provider: "route-judge", key: "test-key", sessionId })
        const afterTurns = yield* recordBranchEvents(client, { sessionId, branchId })
        yield* selectAuto(client, sessionId)
        yield* client.message.send({ sessionId, branchId, content: "route me" })
        const events = yield* afterTurns(1)
        const [routed] = routedEvents(events)
        // 21 input tokens at $1 per million.
        expect(routed).toMatchObject({ classifier: "route-judge/jev", model: STRONG_MODEL })
        expect(routed?.costUsd).toBeCloseTo(21 / 1_000_000, 12)
        const snapshot = yield* client.session.getSnapshot({ sessionId, branchId })
        expect(snapshot.metrics.costUsd).toBeGreaterThanOrEqual(21 / 1_000_000)
      }).pipe(Effect.timeout("15 seconds")),
    20_000,
  )
})

/** One priced classifier that answers every classification with its last label, at 21 input tokens. */
const routeJudgeDriver: ModelDriverContribution = {
  id: "route-judge",
  name: "Route judge",
  envCredential: "GENT_TEST_ROUTE_JUDGE_KEY_NEVER_SET",
  resolveModel: () => Effect.die("the route judge serves a classifier only"),
  listModels: () =>
    Effect.succeed([
      Model.make({
        id: ModelId.make("route-judge/jev"),
        name: "jev",
        provider: ProviderId.make("route-judge"),
        kind: "classifier",
        pricing: { input: 1, output: 1 },
      }),
    ]),
  resolveDecisionModel: () =>
    Effect.succeed(
      Layer.effect(
        DecisionModel.DecisionModel,
        DecisionModel.make({
          decide: (options) =>
            Effect.succeed({
              answers: Object.fromEntries(
                Object.entries(options.decisions).map(([name, decision]) => {
                  let labels: ReadonlyArray<string> = []
                  if (decision._tag === "Classify") labels = Object.keys(decision.criteria)
                  const last = labels.length - 1
                  return [
                    name,
                    // oxlint-disable-next-line effect/preferTaggedConstructors -- the raw provider answer DecisionModel.make validates; effect/ai's ProviderClassifyAnswer has no constructor
                    {
                      _tag: "Classify" as const,
                      label: labels[last] ?? "",
                      probabilities: Object.fromEntries(
                        labels.map((label, index) => [label, Number(index === last)]),
                      ),
                      confidence: 0.9,
                    },
                  ]
                }),
              ),
              usage: { inputTokens: 21, outputTokens: 0 },
            }),
        }),
      ),
    ),
}

/** The route judge with no price: a route through it has no known cost. */
const unpricedRouteJudgeDriver: ModelDriverContribution = {
  ...routeJudgeDriver,
  id: "free-judge",
  name: "Free judge",
  listModels: () =>
    Effect.succeed([
      Model.make({
        id: ModelId.make("free-judge/jev"),
        name: "jev",
        provider: ProviderId.make("free-judge"),
        kind: "classifier",
      }),
    ]),
}

// ── effort auto ─────────────────────────────────────────────────────────────

const EFFORT_ROUTE = ModelId.make("router/effort")

/** Low, medium, then high (the default): choices that set only an effort. */
const effortRouter: VirtualModel = {
  name: "effort",
  label: "Effort",
  choices: [
    { effort: "low", reason: "quick questions" },
    { effort: "medium", reason: "ordinary work" },
    { effort: "high", reason: "hard work" },
  ],
  fallback: 2,
}

/** A reasoning model on the `carrier` driver (`carrierDriver`), warm for five minutes. */
const CARRIER_MODEL = new Model({
  id: ModelId.make("carrier/thinker"),
  name: "Carrier Thinker",
  provider: ProviderId.make("carrier"),
  contextLength: 200_000,
  reasoning: true,
  efforts: ["low", "medium", "high"],
  promptCacheTtlMs: 300_000,
})

/**
 * The driver of `CARRIER_MODEL`: its wire carries an effort change inside
 * the conversation where `carries` says so for the request's hints.
 */
const carrierDriver = (
  carries: (hints: ProviderHints) => boolean = () => true,
): ModelDriverContribution => ({
  id: "carrier",
  name: "Carrier",
  resolveModel: () => Effect.die("the scripted model answers every request"),
  carriesEffort: (_modelName, hints) => carries(hints),
})

/**
 * The same kind of model on a wire that changes the effort only at the top
 * of a request; absent `promptCacheTtlMs`, its cache never goes cold.
 */
const plainModel = (promptCacheTtlMs: Option.Option<number>) =>
  new Model({
    id: ModelId.make("plain/thinker"),
    name: "Plain Thinker",
    provider: ProviderId.make("plain"),
    contextLength: 200_000,
    reasoning: true,
    efforts: ["low", "medium", "high"],
    ...omitUndefined({ promptCacheTtlMs: Option.getOrUndefined(promptCacheTtlMs) }),
  })

const agentOn = (model: Model) => [AgentDefinition.make({ ...testAgent, model: model.id })]

const effortRoutes = (events: ReadonlyArray<AgentEvent>) =>
  routedEvents(events).filter((event) => event.effortOnly === true)

/** The level each step's request went out at, from its receipt. */
const stepLevels = (events: ReadonlyArray<AgentEvent>) =>
  events.flatMap((event) => {
    if (event._tag !== "StreamEnded") return []
    return [Option.fromUndefinedOr(event.reasoningLevel)]
  })

const levelsOf = (levels: ReadonlyArray<ReasoningEffort>) => levels.map(Option.some)

const selectEffortAuto = (client: RoutingClient, sessionId: SessionId) =>
  client.session.updateSettings({ sessionId, reasoningLevel: Option.some("auto") })

/** A route that answers with `picks` in order, and records what it read. */
const pickEfforts =
  (
    inputs: Ref.Ref<ReadonlyArray<ModelRouteInput>>,
    picks: ReadonlyArray<number>,
  ): ModelRouterContribution["route"] =>
  (input) =>
    Ref.updateAndGet(inputs, (all) => [...all, input]).pipe(
      Effect.map((all) => ({ choice: picks[all.length - 1] ?? 0, reason: `pick ${all.length}` })),
    )

describe("effort auto", () => {
  it.scopedLive(
    "/effort auto asks the effort router once per user turn, at its first step, and every step of the turn runs at its level",
    () =>
      Effect.gen(function* () {
        const inputs = yield* Ref.make<ReadonlyArray<ModelRouteInput>>([])
        const atLevel = (level: string) => (request: { readonly reasoning?: string }) => {
          expect(request.reasoning).toBe(level)
        }
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          { ...toolCallStep("route_hold", {}), assertRequest: atLevel("high") },
          { ...textStep("hard answer"), assertRequest: atLevel("high") },
          { ...textStep("quick answer"), assertRequest: atLevel("low") },
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: agentOn(CARRIER_MODEL),
          providerLayer,
          models: [CARRIER_MODEL],
          extensionInputs: [
            routingExtension({
              effort: effortRouter,
              route: pickEfforts(inputs, [2, 0]),
              drivers: [carrierDriver()],
            }),
          ],
        })
        const afterTurns = yield* recordBranchEvents(client, { sessionId, branchId })
        const settings = yield* selectEffortAuto(client, sessionId)
        expect(settings).toMatchObject({ reasoningAuto: true })
        expect(settings.reasoningLevel).toBeUndefined()
        yield* client.message.send({ sessionId, branchId, content: "do the hard thing" })
        const firstTurn = yield* afterTurns(1)
        // One route for the turn's two steps; it lands before the first request.
        expect(effortRoutes(firstTurn)).toHaveLength(1)
        expect(effortRoutes(firstTurn)[0]).toMatchObject({
          selected: EFFORT_ROUTE,
          model: CARRIER_MODEL.id,
          effort: "high",
          choice: 2,
          reason: "pick 1",
          effortOnly: true,
        })
        expect(firstTurn.findIndex(Schema.is(ModelRouted))).toBeLessThan(
          firstTurn.findIndex((event) => event._tag === "StreamStarted"),
        )
        const [first] = yield* Ref.get(inputs)
        expect(first?.model.name).toBe("effort")
        expect(first?.child).toBe(false)
        // Every choice runs on the turn's model; the router reads the user's request last.
        expect(first?.candidates.map(Option.map((model) => model.id))).toEqual([
          Option.some(CARRIER_MODEL.id),
          Option.some(CARRIER_MODEL.id),
          Option.some(CARRIER_MODEL.id),
        ])
        expect(first?.messages.at(-1)?.role).toBe("user")

        yield* client.message.send({ sessionId, branchId, content: "a quick one" })
        const both = yield* afterTurns(2)
        expect(effortRoutes(both).map((event) => event.effort)).toEqual(["high", "low"])
        expect(stepLevels(both)).toEqual(levelsOf(["high", "high", "low"]))
        expect(yield* Ref.get(inputs)).toHaveLength(2)
        const snapshot = yield* client.session.getSnapshot({ sessionId, branchId })
        expect(snapshot.reasoningAuto).toBe(true)
        expect(snapshot.reasoningLevel).toBeUndefined()
        // The effort route is not a model route: the status row's model stays the session's.
        expect(snapshot.metrics.routed).toBeUndefined()
        expect(snapshot.metrics.effortRouted).toMatchObject({ effort: "low" })
        yield* controls.assertDone
      }).pipe(Effect.timeout("15 seconds")),
    20_000,
  )

  it.scopedLive(
    "a model with no effort carrier holds the effort of its warm cache and asks no classifier; a cold cache is asked again",
    () =>
      Effect.gen(function* () {
        // No lifetime: the cache never goes cold. 1 ms: it is cold by the next turn.
        const cases: ReadonlyArray<{
          readonly ttlMs: Option.Option<number>
          readonly levels: ReadonlyArray<ReasoningEffort>
          readonly asked: number
        }> = [
          { ttlMs: Option.none(), levels: ["high", "high"], asked: 1 },
          { ttlMs: Option.some(1), levels: ["high", "low"], asked: 2 },
        ]
        for (const { ttlMs, levels, asked } of cases) {
          const inputs = yield* Ref.make<ReadonlyArray<ModelRouteInput>>([])
          const model = plainModel(ttlMs)
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            textStep("first"),
            textStep("second"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            agents: agentOn(model),
            providerLayer,
            models: [model],
            extensionInputs: [
              routingExtension({ effort: effortRouter, route: pickEfforts(inputs, [2, 0]) }),
            ],
          })
          const afterTurns = yield* recordBranchEvents(client, { sessionId, branchId })
          yield* selectEffortAuto(client, sessionId)
          yield* client.message.send({ sessionId, branchId, content: "first" })
          yield* afterTurns(1)
          yield* client.message.send({ sessionId, branchId, content: "second" })
          const events = yield* afterTurns(2)
          expect([ttlMs, stepLevels(events)]).toEqual([ttlMs, levels.map(Option.some)])
          expect([ttlMs, (yield* Ref.get(inputs)).length]).toEqual([ttlMs, asked])
          const second = effortRoutes(events)[1]
          if (asked === 1) {
            // The held route says why, and asked no classifier. A hold is a
            // decision, not a fallback: the router did not fail.
            expect(second).toMatchObject({ effort: "high" })
            expect(second?.fallback).toBeUndefined()
            expect(second?.reason).toContain("warm")
            expect(second?.classifier).toBeUndefined()
          }
        }
      }).pipe(Effect.timeout("20 seconds")),
    25_000,
  )

  it.scopedLive(
    "an effort is held for a warm cache unless its last account certainly moved",
    () =>
      Effect.gen(function* () {
        const work = CredentialSlot.make("work")
        const cases: ReadonlyArray<{
          readonly name: string
          readonly first: ReadonlyArray<CredentialSlot>
          readonly second: ReadonlyArray<CredentialSlot>
          readonly slots: ReadonlyArray<CredentialSlot>
          readonly levels: ReadonlyArray<ReasoningEffort>
          readonly asked: number
          /** The default slot is signed in again before the second turn. */
          readonly signInAgain?: true
        }> = [
          // The slot the last request used left the order: the router is asked again.
          {
            name: "left",
            first: [DEFAULT_CREDENTIAL_SLOT],
            second: [work],
            slots: [DEFAULT_CREDENTIAL_SLOT, work],
            levels: ["high", "low"],
            asked: 2,
          },
          // The slot holds another sign-in than the one the request used.
          {
            name: "relogin",
            first: [DEFAULT_CREDENTIAL_SLOT],
            second: [DEFAULT_CREDENTIAL_SLOT],
            slots: [DEFAULT_CREDENTIAL_SLOT, DEFAULT_CREDENTIAL_SLOT],
            levels: ["high", "low"],
            asked: 2,
            signInAgain: true,
          },
          // A first credential the next turn may move past again is no move:
          // the cache the last request wrote holds its effort.
          {
            name: "steady",
            first: [work],
            second: [DEFAULT_CREDENTIAL_SLOT, work],
            slots: [work, DEFAULT_CREDENTIAL_SLOT],
            levels: ["high", "high"],
            asked: 1,
          },
        ]
        // No lifetime: only the account can make the cache cold.
        const model = plainModel(Option.none())
        // The live registry knows the model through its driver, and stamps
        // each receipt with its sign-in, as production does.
        const plainDriver: ModelDriverContribution = {
          id: "plain",
          name: "Plain",
          resolveModel: () => Effect.die("the scripted model answers every request"),
          listModels: () => Effect.succeed([model]),
        }
        for (const { name, first, second, slots, levels, asked, signInAgain } of cases) {
          const inputs = yield* Ref.make<ReadonlyArray<ModelRouteInput>>([])
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            textStep("first"),
            textStep("second"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            agents: agentOn(model),
            providerLayer,
            models: "catalog",
            extensionInputs: [
              routingExtension({
                effort: effortRouter,
                route: pickEfforts(inputs, [2, 0]),
                drivers: [plainDriver],
              }),
            ],
          })
          const afterTurns = yield* recordBranchEvents(client, { sessionId, branchId })
          yield* selectEffortAuto(client, sessionId)
          yield* client.auth.setKey({ provider: "plain", key: "sk-fake-a", sessionId })
          yield* client.auth.setKey({ provider: "plain", slot: work, key: "sk-fake-b", sessionId })
          yield* client.auth.setOrder({ provider: "plain", order: first, sessionId })
          yield* client.message.send({ sessionId, branchId, content: "first" })
          yield* afterTurns(1)
          if (signInAgain === true)
            yield* client.auth.setKey({ provider: "plain", key: "sk-fake-c", sessionId })
          yield* client.auth.setOrder({ provider: "plain", order: second, sessionId })
          yield* client.message.send({ sessionId, branchId, content: "second" })
          const events = yield* afterTurns(2)
          const sent = events.flatMap((event) => {
            if (event._tag !== "StreamEnded" || Predicate.isUndefined(event.credential)) return []
            return [event.credential.slot]
          })
          expect({ name, sent }).toEqual({ name, sent: [...slots] })
          expect([name, stepLevels(events)]).toEqual([name, levels.map(Option.some)])
          expect([name, (yield* Ref.get(inputs)).length]).toEqual([name, asked])
        }
      }).pipe(Effect.timeout("20 seconds")),
    25_000,
  )

  // A child on the session cache (a track's seat) is still a child: unrouted.
  for (const [cache, agents] of [
    ["child", agentOn(CARRIER_MODEL)],
    [
      "session",
      [AgentDefinition.make({ ...testAgent, model: CARRIER_MODEL.id, promptCache: "session" })],
    ],
  ] as const) {
    it.scopedLive(
      `a spawned child session on the ${cache} cache never asks the effort router`,
      () =>
        Effect.gen(function* () {
          const inputs = yield* Ref.make<ReadonlyArray<ModelRouteInput>>([])
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            textStep("child answer"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            agents,
            providerLayer,
            models: [CARRIER_MODEL],
            extensionInputs: [
              routingExtension({ effort: effortRouter, route: pickEfforts(inputs, [0]) }),
            ],
          })
          const child = yield* client.session.create({
            parentSessionId: sessionId,
            parentBranchId: branchId,
          })
          const afterTurns = yield* recordBranchEvents(client, child)
          yield* selectEffortAuto(client, child.sessionId)
          yield* client.message.send({ ...child, content: "child work" })
          const events = yield* afterTurns(1)
          expect(routedEvents(events)).toEqual([])
          expect(yield* Ref.get(inputs)).toEqual([])
        }).pipe(Effect.timeout("15 seconds")),
      20_000,
    )
  }

  it.scopedLive(
    "a recovered turn runs at its recorded effort route and does not ask the router again",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDirectoryScoped("gent-effort-replay-")
        const dbPath = `${tempDir}/gent.db`
        const gate: HoldGate = {
          entered: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        }
        // First process: the turn routes to high, runs its tool, and dies
        // while step 2 waits on the model.
        const firstProvider = yield* LanguageModelLayers.sequence([
          toolCallStep("route_hold", {}),
          { ...textStep("never emitted"), gated: true },
        ])
        const started = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(
              createE2ELayer({
                agents: agentOn(CARRIER_MODEL),
                providerLayer: firstProvider.layer,
                models: [CARRIER_MODEL],
                extensionInputs: [
                  routingExtension({
                    hold: gate,
                    effort: effortRouter,
                    route: () => Effect.succeed({ choice: 2, reason: "hard" }),
                  }),
                ],
                storagePath: dbPath,
              }),
            )
            const { sessionId, branchId } = yield* client.session.create({})
            yield* selectEffortAuto(client, sessionId)
            yield* client.message
              .send({ sessionId, branchId, content: "FIRST-TURN" })
              .pipe(Effect.forkScoped)
            yield* Deferred.await(gate.entered)
            yield* Deferred.succeed(gate.release, void 0)
            yield* firstProvider.controls.waitForCall(1)
            return { sessionId, branchId }
          }).pipe(Effect.timeout("10 seconds")),
        )

        // Second process: the router would pick low; the recovered turn stays at high.
        const asked = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([])
        const secondProvider = yield* LanguageModelLayers.sequence([
          textStep("RECOVERED"),
          textStep("NEXT"),
        ])
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(
              createE2ELayer({
                agents: agentOn(CARRIER_MODEL),
                providerLayer: secondProvider.layer,
                models: [CARRIER_MODEL],
                extensionInputs: [
                  routingExtension({
                    effort: effortRouter,
                    drivers: [carrierDriver()],
                    route: (input) =>
                      Ref.update(asked, (all) => [...all, userTexts(input)]).pipe(
                        Effect.as({ choice: 0, reason: "quick" }),
                      ),
                  }),
                ],
                storagePath: dbPath,
              }),
            )
            const afterTurns = yield* recordBranchEvents(client, started)
            yield* client.session.getSnapshot(started)
            yield* client.message.send({ ...started, content: "next" })
            const events = yield* afterTurns(2)
            expect(effortRoutes(events).map((event) => event.effort)).toEqual(["high", "low"])
            // The first process's step 1, the recovered step 2, the next turn.
            expect(stepLevels(events)).toEqual(levelsOf(["high", "high", "low"]))
            expect((yield* Ref.get(asked)).map((texts) => texts.at(-1))).toEqual(["next"])
          }).pipe(Effect.timeout("20 seconds")),
        )
      }).pipe(Effect.timeout("40 seconds")),
    60_000,
  )

  it.scopedLive(
    "the effort route's classifier call is priced into its event, the turn's cost and the session's",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          textStep("classified answer"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: e2ePreset.agents,
          providerLayer,
          modelPricing: { input: 1, output: 1 },
          extensionInputs: [
            routingExtension({
              drivers: [routeJudgeDriver],
              effort: effortRouter,
              route: () =>
                Effect.gen(function* () {
                  const ctx = yield* ExtensionContext
                  yield* ctx.Models.decide({
                    definition: Decision.make({
                      input: Schema.String,
                      decisions: {
                        choice: Decision.classify({
                          instructions: "Which effort",
                          criteria: { choice1: "quick", choice2: "ordinary", choice3: "hard" },
                        }),
                      },
                    }),
                    input: "route me",
                  })
                  return { choice: 2, reason: "hard" }
                }),
            }),
          ],
        })
        yield* client.auth.setKey({ provider: "route-judge", key: "test-key", sessionId })
        const afterTurns = yield* recordBranchEvents(client, { sessionId, branchId })
        yield* selectEffortAuto(client, sessionId)
        yield* client.message.send({ sessionId, branchId, content: "route me" })
        const events = yield* afterTurns(1)
        const [routed] = effortRoutes(events)
        expect(routed).toMatchObject({ classifier: "route-judge/jev", effort: "high" })
        expect(routed?.costUsd).toBeCloseTo(21 / 1_000_000, 12)
        // The turn's cost is its step's and its route's.
        const stepCost = events.reduce((sum, event) => {
          if (event._tag !== "StreamEnded") return sum
          return sum + Option.getOrElse(Option.fromUndefinedOr(event.costUsd), () => 0)
        }, 0)
        expect(stepCost).toBeGreaterThan(0)
        const [completed] = events.filter(Schema.is(TurnCompleted))
        expect(completed?.costUsd).toBeCloseTo(stepCost + 21 / 1_000_000, 12)
        const snapshot = yield* client.session.getSnapshot({ sessionId, branchId })
        expect(snapshot.metrics.costUsd).toBeCloseTo(stepCost + 21 / 1_000_000, 12)
      }).pipe(Effect.timeout("15 seconds")),
    20_000,
  )

  it.scopedLive(
    "/effort <level> leaves auto, and auto with no effort router runs at the agent's level and records no route",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          textStep("default answer"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: agentOn(CARRIER_MODEL),
          providerLayer,
          models: [CARRIER_MODEL],
          extensionInputs: [
            routingExtension({ route: () => Effect.succeed({ choice: 0, reason: "any" }) }),
          ],
        })
        const afterTurns = yield* recordBranchEvents(client, { sessionId, branchId })
        yield* selectEffortAuto(client, sessionId)
        yield* client.message.send({ sessionId, branchId, content: "no effort router" })
        const events = yield* afterTurns(1)
        expect(routedEvents(events)).toEqual([])
        expect(stepLevels(events)).toEqual([Option.none()])
        expect(events.filter(Schema.is(SessionSettingsUpdated)).at(-1)).toMatchObject({
          reasoningAuto: true,
        })
        const view = yield* client.session.get({ sessionId })
        expect(view?.reasoningAuto).toBe(true)
        // A level leaves auto.
        const high = yield* client.session.updateSettings({
          sessionId,
          reasoningLevel: Option.some("high"),
        })
        expect(high).toMatchObject({ reasoningLevel: "high" })
        expect(high.reasoningAuto).toBeUndefined()
        const after = yield* client.session.get({ sessionId })
        expect(after?.reasoningAuto).toBeUndefined()
        expect(after?.reasoningLevel).toBe("high")
      }).pipe(Effect.timeout("15 seconds")),
    20_000,
  )

  it.scopedLive(
    "under a virtual model the effort route runs after the model route, on the routed model, and its level wins",
    () =>
      Effect.gen(function* () {
        const inputs = yield* Ref.make<ReadonlyArray<ModelRouteInput>>([])
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          {
            ...textStep("strong and quick"),
            assertRequest: (request: { readonly model: string; readonly reasoning?: string }) => {
              expect([request.model, request.reasoning]).toEqual([STRONG_MODEL, "low"])
            },
          },
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: e2ePreset.agents,
          providerLayer,
          extensionInputs: [
            routingExtension({
              effort: effortRouter,
              route: (input) =>
                Ref.update(inputs, (all) => [...all, input]).pipe(
                  Effect.as({ choice: Number(input.model.name === "auto"), reason: "picked" }),
                ),
            }),
          ],
        })
        const afterTurns = yield* recordBranchEvents(client, { sessionId, branchId })
        yield* selectAuto(client, sessionId)
        yield* selectEffortAuto(client, sessionId)
        yield* client.message.send({ sessionId, branchId, content: "route both" })
        const events = yield* afterTurns(1)
        expect(
          routedEvents(events).map((event) => [event.selected, event.model, event.effort]),
        ).toEqual([
          [AUTO_MODEL, STRONG_MODEL, "high"],
          [EFFORT_ROUTE, STRONG_MODEL, "low"],
        ])
        expect((yield* Ref.get(inputs)).map((input) => input.model.name)).toEqual([
          "auto",
          "effort",
        ])
        const snapshot = yield* client.session.getSnapshot({ sessionId, branchId })
        // The model route still names the routed model; the effort route its level.
        expect(snapshot.metrics.routed).toMatchObject({ selected: AUTO_MODEL, model: STRONG_MODEL })
        expect(snapshot.metrics.effortRouted).toMatchObject({ effort: "low" })
      }).pipe(Effect.timeout("15 seconds")),
    20_000,
  )

  it.scopedLive(
    "under a virtual model on auto, a combined call that fails is not asked again for the effort: both routes fall back with its reason",
    () =>
      Effect.gen(function* () {
        const asks = yield* Ref.make(0)
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          textStep("fell back"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: e2ePreset.agents,
          providerLayer,
          extensionInputs: [
            routingExtension({
              effort: effortRouter,
              route: () =>
                Ref.update(asks, (count) => count + 1).pipe(
                  Effect.andThen(Effect.die("no classifier model has a credential")),
                ),
            }),
          ],
        })
        const afterTurns = yield* recordBranchEvents(client, { sessionId, branchId })
        yield* selectAuto(client, sessionId)
        yield* selectEffortAuto(client, sessionId)
        yield* client.message.send({ sessionId, branchId, content: "route both" })
        const events = yield* afterTurns(1)
        expect(yield* Ref.get(asks)).toBe(1)
        const routes = routedEvents(events)
        expect(routes.map((event) => [event.selected, event.fallback])).toEqual([
          [AUTO_MODEL, true],
          [EFFORT_ROUTE, true],
        ])
        expect(routes[1]?.reason).toContain("no classifier model has a credential")
      }).pipe(Effect.timeout("15 seconds")),
    20_000,
  )

  it.scopedLive(
    "under a virtual model on auto, a router that answers both picks the model and the effort in one call: two receipts, one charge",
    () =>
      Effect.gen(function* () {
        const inputs = yield* Ref.make<ReadonlyArray<ModelRouteInput>>([])
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          {
            ...textStep("strong and quick"),
            assertRequest: (request: { readonly model: string; readonly reasoning?: string }) => {
              expect([request.model, request.reasoning]).toEqual([STRONG_MODEL, "low"])
            },
          },
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: e2ePreset.agents,
          providerLayer,
          modelPricing: { input: 1, output: 1 },
          extensionInputs: [
            routingExtension({
              drivers: [routeJudgeDriver],
              effort: effortRouter,
              route: (input) =>
                Effect.gen(function* () {
                  yield* Ref.update(inputs, (all) => [...all, input])
                  const ctx = yield* ExtensionContext
                  yield* ctx.Models.decide({
                    definition: Decision.make({
                      input: Schema.String,
                      decisions: {
                        choice: Decision.classify({
                          instructions: "Which model",
                          criteria: { choice1: "light", choice2: "strong" },
                        }),
                        effort: Decision.classify({
                          instructions: "Which effort",
                          criteria: { choice1: "quick", choice2: "ordinary", choice3: "hard" },
                        }),
                      },
                    }),
                    input: "route both",
                  })
                  return {
                    choice: 1,
                    reason: "strong",
                    effort: { choice: 0, reason: "quick" },
                  }
                }),
            }),
          ],
        })
        yield* client.auth.setKey({ provider: "route-judge", key: "test-key", sessionId })
        const afterTurns = yield* recordBranchEvents(client, { sessionId, branchId })
        yield* selectAuto(client, sessionId)
        yield* selectEffortAuto(client, sessionId)
        yield* client.message.send({ sessionId, branchId, content: "route both" })
        const events = yield* afterTurns(1)
        // One call, which read the effort router's choices too.
        const asked = yield* Ref.get(inputs)
        expect(asked).toHaveLength(1)
        expect(asked[0]?.model.name).toBe("auto")
        expect(asked[0]?.effort?.model.name).toBe("effort")
        const routes = routedEvents(events)
        expect(routes.map((event) => [event.selected, event.model, event.effort])).toEqual([
          [AUTO_MODEL, STRONG_MODEL, "high"],
          [EFFORT_ROUTE, STRONG_MODEL, "low"],
        ])
        // The model route's receipt holds the call and its price; the effort route adds none.
        expect(routes[0]?.costUsd).toBeCloseTo(21 / 1_000_000, 12)
        expect(routes[1]).toMatchObject({ effortOnly: true, reason: "quick" })
        expect(routes[1]?.costUsd).toBeUndefined()
        expect(routes[1]?.classifier).toBeUndefined()
        const stepCost = events.reduce((sum, event) => {
          if (event._tag !== "StreamEnded") return sum
          return sum + Option.getOrElse(Option.fromUndefinedOr(event.costUsd), () => 0)
        }, 0)
        const [completed] = events.filter(Schema.is(TurnCompleted))
        expect(completed?.costUsd).toBeCloseTo(stepCost + 21 / 1_000_000, 12)
      }).pipe(Effect.timeout("15 seconds")),
    20_000,
  )

  it.scopedLive(
    "effort routing reads the driver the turn dispatches through: its levels, its cache lifetime, and whether it carries a change",
    () =>
      Effect.gen(function* () {
        const inputs = yield* Ref.make<ReadonlyArray<ModelRouteInput>>([])
        // As listed, the model carries a change and its cache is cold by the
        // next turn; the driver the agent names takes no `medium`, carries
        // no change, and never goes cold.
        const listed = new Model({ ...CARRIER_MODEL, promptCacheTtlMs: 1 })
        const dispatched = new Model({
          id: ModelId.make("plain/thinker"),
          name: "Plain Thinker",
          provider: ProviderId.make("plain"),
          contextLength: 200_000,
          reasoning: true,
          efforts: ["low", "high"],
        })
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          textStep("first"),
          textStep("second"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: [
            AgentDefinition.make({
              ...testAgent,
              model: listed.id,
              driver: DriverRef.make({ id: "plain" }),
            }),
          ],
          providerLayer,
          models: [listed, dispatched],
          extensionInputs: [
            routingExtension({
              effort: effortRouter,
              route: pickEfforts(inputs, [2, 0]),
              drivers: [carrierDriver()],
            }),
          ],
        })
        const afterTurns = yield* recordBranchEvents(client, { sessionId, branchId })
        yield* selectEffortAuto(client, sessionId)
        yield* client.message.send({ sessionId, branchId, content: "first" })
        yield* afterTurns(1)
        yield* client.message.send({ sessionId, branchId, content: "second" })
        const events = yield* afterTurns(2)
        const asked = yield* Ref.get(inputs)
        // The dispatched model takes no `medium`.
        expect(asked[0]?.candidates.map(Option.isSome)).toEqual([true, false, true])
        // Its cache is warm and its driver carries no change: the second turn holds.
        expect(asked).toHaveLength(1)
        expect(stepLevels(events)).toEqual(levelsOf(["high", "high"]))
        // The receipts keep the model the session asked for.
        expect(effortRoutes(events).map((event) => event.model)).toEqual([listed.id, listed.id])
      }).pipe(Effect.timeout("15 seconds")),
    20_000,
  )

  it.scopedLive(
    "on a warm cache the router is offered only the levels the driver carries from this history, and a change it carries on none holds the level",
    () =>
      Effect.gen(function* () {
        // A stand-in for a wire that cannot carry some changes: no move to
        // `medium`, and no change at all after a run at `low`.
        const carries = (hints: ProviderHints) =>
          hints.reasoning !== "medium" &&
          !(hints.reasoningHistory ?? []).some((run) => Option.contains(run, "low"))
        const cases: ReadonlyArray<{
          readonly picks: ReadonlyArray<number>
          readonly levels: ReadonlyArray<ReasoningEffort>
          readonly asked: number
        }> = [
          { picks: [2, 0], levels: ["high", "low"], asked: 2 },
          { picks: [0, 2], levels: ["low", "low"], asked: 1 },
        ]
        for (const { picks, levels, asked } of cases) {
          const inputs = yield* Ref.make<ReadonlyArray<ModelRouteInput>>([])
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            textStep("first"),
            textStep("second"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            agents: agentOn(CARRIER_MODEL),
            providerLayer,
            models: [CARRIER_MODEL],
            extensionInputs: [
              routingExtension({
                effort: effortRouter,
                route: pickEfforts(inputs, picks),
                drivers: [carrierDriver(carries)],
              }),
            ],
          })
          const afterTurns = yield* recordBranchEvents(client, { sessionId, branchId })
          yield* selectEffortAuto(client, sessionId)
          yield* client.message.send({ sessionId, branchId, content: "first" })
          yield* afterTurns(1)
          yield* client.message.send({ sessionId, branchId, content: "second" })
          const events = yield* afterTurns(2)
          const all = yield* Ref.get(inputs)
          expect([picks, stepLevels(events)]).toEqual([picks, levelsOf(levels)])
          expect([picks, all.length]).toEqual([picks, asked])
          if (asked === 2) {
            // Warm on `high`: the driver carries `low`, not `medium`.
            expect(all[1]?.candidates.map(Option.isSome)).toEqual([true, false, true])
          } else {
            const held = effortRoutes(events)[1]
            expect(held).toMatchObject({ effort: "low" })
            expect(held?.reason).toContain("carries no change")
            expect(held?.fallback).toBeUndefined()
          }
        }
      }).pipe(Effect.timeout("20 seconds")),
    25_000,
  )

  it.scopedLive(
    "a router that fails keeps the exact level the branch runs at, max and the model's default included",
    () =>
      Effect.gen(function* () {
        // Cold by the next turn: the router is asked, and fails.
        const withMax = new Model({
          ...CARRIER_MODEL,
          efforts: ["low", "medium", "high", "max"],
          promptCacheTtlMs: 1,
        })
        const cases: ReadonlyArray<{
          readonly set: Option.Option<ReasoningEffort>
          readonly levels: ReadonlyArray<Option.Option<ReasoningEffort>>
        }> = [
          { set: Option.some("max"), levels: levelsOf(["max", "max"]) },
          // No level named: the model's default, and still none after the failure.
          { set: Option.none(), levels: [Option.none(), Option.none()] },
        ]
        for (const { set, levels } of cases) {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            textStep("first"),
            textStep("second"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            agents: agentOn(withMax),
            providerLayer,
            models: [withMax],
            extensionInputs: [
              routingExtension({
                effort: effortRouter,
                route: () => Effect.die("no classifier model has a credential"),
                drivers: [carrierDriver()],
              }),
            ],
          })
          const afterTurns = yield* recordBranchEvents(client, { sessionId, branchId })
          if (Option.isSome(set))
            yield* client.session.updateSettings({ sessionId, reasoningLevel: set })
          yield* client.message.send({ sessionId, branchId, content: "first" })
          yield* afterTurns(1)
          yield* selectEffortAuto(client, sessionId)
          yield* client.message.send({ sessionId, branchId, content: "second" })
          const events = yield* afterTurns(2)
          expect([set, stepLevels(events)]).toEqual([set, [...levels]])
          const [route] = effortRoutes(events)
          expect([set, route?.fallback, route?.effort]).toEqual([
            set,
            true,
            Option.getOrUndefined(set),
          ])
        }
      }).pipe(Effect.timeout("20 seconds")),
    25_000,
  )

  it.scopedLive(
    "a recovered turn runs at and charges its stored effort route when the effort router is gone",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDirectoryScoped("gent-effort-gone-")
        const dbPath = `${tempDir}/gent.db`
        // Priced, so the turn's cost is known.
        const priced = new Model({ ...CARRIER_MODEL, pricing: { input: 1, output: 1 } })
        // The agent's own level, which a turn that lost its route would send.
        const agents = [
          AgentDefinition.make({ ...testAgent, model: priced.id, reasoningEffort: "low" }),
        ]
        // First process: a priced classifier routes the turn to high; the
        // process dies while step 1 waits on the model, after the route is stored.
        const firstProvider = yield* LanguageModelLayers.sequence([
          { ...textStep("never emitted"), gated: true },
        ])
        const started = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(
              createE2ELayer({
                agents,
                providerLayer: firstProvider.layer,
                models: [priced],
                modelPricing: { input: 1, output: 1 },
                extensionInputs: [
                  routingExtension({
                    effort: effortRouter,
                    drivers: [routeJudgeDriver, carrierDriver()],
                    route: () =>
                      Effect.gen(function* () {
                        const ctx = yield* ExtensionContext
                        yield* ctx.Models.decide({
                          definition: Decision.make({
                            input: Schema.String,
                            decisions: {
                              choice: Decision.classify({
                                instructions: "Which effort",
                                criteria: { choice1: "quick", choice2: "hard" },
                              }),
                            },
                          }),
                          input: "route me",
                        })
                        return { choice: 2, reason: "hard" }
                      }),
                  }),
                ],
                storagePath: dbPath,
              }),
            )
            const { sessionId, branchId } = yield* client.session.create({})
            yield* client.auth.setKey({ provider: "route-judge", key: "test-key", sessionId })
            yield* selectEffortAuto(client, sessionId)
            yield* client.message
              .send({ sessionId, branchId, content: "FIRST-TURN" })
              .pipe(Effect.forkScoped)
            yield* firstProvider.controls.waitForCall(0)
            return { sessionId, branchId }
          }).pipe(Effect.timeout("10 seconds")),
        )

        // Second process: no effort router at all. The recovered step still
        // runs at the stored level, and the turn's cost holds its route.
        const secondProvider = yield* LanguageModelLayers.sequence([textStep("RECOVERED")])
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(
              createE2ELayer({
                agents,
                providerLayer: secondProvider.layer,
                models: [priced],
                modelPricing: { input: 1, output: 1 },
                extensionInputs: [
                  routingExtension({ route: () => Effect.succeed({ choice: 0, reason: "any" }) }),
                ],
                storagePath: dbPath,
              }),
            )
            const afterTurns = yield* recordBranchEvents(client, started)
            yield* client.session.getSnapshot(started)
            const events = yield* afterTurns(1)
            expect(stepLevels(events)).toEqual(levelsOf(["high"]))
            const [route] = effortRoutes(events)
            const [completed] = events.filter(Schema.is(TurnCompleted))
            const recoveredStep = Option.getOrThrow(
              Option.fromUndefinedOr(events.filter(Schema.is(StreamEnded)).at(-1)?.costUsd),
            )
            expect(route?.costUsd).toBeCloseTo(21 / 1_000_000, 12)
            expect(completed?.costUsd).toBeCloseTo(recoveredStep + 21 / 1_000_000, 12)
          }).pipe(Effect.timeout("20 seconds")),
        )
      }).pipe(Effect.timeout("40 seconds")),
    60_000,
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
          overrides: { tools: ["*", "!resume_probe"], systemPromptAddendum: addendum },
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
            yield* submitAgentLoop(makeMessage(sessionId, branchId, "child task before restart"), {
              agent: helperAgent.name,
              runSpec,
            })
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
            yield* waitFor(
              Ref.get(secondRequests),
              (seen) => seen.length > 0,
              5_000,
              "the recovered turn called the model",
            )
            // The agent picks the model: the child's agent, not the default one.
            const eventStorage = yield* EventStorage
            const streamModel = yield* waitFor(
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
              Option.isSome,
              5_000,
              "the recovered step ended",
            )
            expect(streamModel.value._tag === "StreamEnded" && streamModel.value.model).toBe(
              helperAgent.model,
            )
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
            yield* submitAgentLoop(makeMessage(sessionId, branchId, "work under the helper"), {
              agent: helperAgent.name,
            })
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
            const events = yield* waitFor(
              eventStorage
                .listEvents({ sessionId, branchId })
                .pipe(Effect.map((envelopes) => envelopes.map(({ event }) => event))),
              (all) => all.some((event) => event._tag === "TurnCompleted"),
              5_000,
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
            yield* submitAgentLoop(makeMessage(sessionId, branchId, "dispatch under the helper"), {
              agent: helperAgent.name,
            })
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
            const events = yield* waitFor(
              eventStorage
                .listEvents({ sessionId, branchId })
                .pipe(Effect.map((envelopes) => envelopes.map(({ event }) => event))),
              (all) => all.some((event) => event._tag === "TurnCompleted"),
              5_000,
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
  // The process a test resolves its bindings in.
  const liveGeneration = ProcessGenerationId.make("test")
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
          generationId: liveGeneration,
        }).pipe(Effect.exit)
        expect(Exit.isFailure(refused)).toBe(true)
        if (Exit.isFailure(refused)) {
          expect(Cause.squash(refused.cause)).toBeInstanceOf(ToolBindingReplayError)
          expect(Cause.squash(refused.cause)).toMatchObject({
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
        generationId: liveGeneration,
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
            generationId: liveGeneration,
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
          expect(Cause.squash(result.cause)).toBeInstanceOf(ToolBindingReplayError)
          expect(Cause.squash(result.cause)).toMatchObject({
            reason: scenario.reason,
          })
          expect(Option.isNone(yield* replay.getBinding(key))).toBe(true)
        }).pipe(
          Effect.provideServiceEffect(ExtensionRegistry, hostProfileRegistry),
          Effect.provide(layer),
        )
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
        const identity = yield* innerOperationBindingIdentity(current.value, generationId)
        if (Option.isNone(identity)) return yield* Effect.die("Expected process-local identity")
        expect(identity.value.source).toEqual(
          ToolBindingSource.cases.ProcessLocal.make({
            sourceRevision: ToolSourceRevision.make(`process:${generationId}`),
          }),
        )

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
        expect(retired._tag).toBe("ToolBindingReplayError")
        expect(retired).toMatchObject({ reason: "SourceMismatch" })
      }).pipe(
        Effect.provideServiceEffect(ExtensionRegistry, hostProfileRegistry),
        Effect.provide(layer),
      )
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
    }).pipe(Effect.provide(Layer.mergeAll(testSqliteStorage, EventStore.Memory))),
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
    }).pipe(Effect.provide(Layer.mergeAll(testSqliteStorage, EventStore.Memory))),
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
    }).pipe(Effect.provide(Layer.mergeAll(testSqliteStorage, EventStore.Memory))),
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
    }).pipe(Effect.provide(Layer.mergeAll(testSqliteStorage, EventStore.Memory))),
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
    }).pipe(Effect.provide(Layer.mergeAll(testSqliteStorage, EventStore.Memory))),
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

  it.scopedLive(
    "each tool settles its own crashed call as its extension's leaf, and a tool without recover is reported interrupted",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDirectoryScoped("gent-tool-recover-")
        const dbPath = `${tempDir}/gent.db`
        const runs = yield* Ref.make(0)
        const allRunning = yield* Deferred.make<void>()
        // Every call starts, and the process stops while the three run.
        const hang = Ref.updateAndGet(runs, (n) => n + 1).pipe(
          Effect.flatMap((n) =>
            Effect.when(Deferred.succeed(allRunning, void 0), Effect.succeed(n === 3)),
          ),
          Effect.andThen(Effect.never),
        )
        const settling = (id: string) =>
          tool({
            id,
            description: "Keeps a receipt it settles from",
            params: Schema.Struct({}),
            output: Schema.String,
            execute: () => hang,
            recover: (call) =>
              Effect.gen(function* () {
                const ctx = yield* ExtensionContext
                return ToolCallRecoveryOutcome.cases.Settled.make({
                  result: Prompt.toolResultPart({
                    id: call.toolCall.id,
                    name: call.toolCall.name,
                    isFailure: false,
                    providerExecuted: false,
                    result: {
                      settledBy: ctx.extensionId,
                      ownCall: ctx.toolCallId === call.toolCall.id,
                    },
                  }),
                })
              }),
          })
        const plain = tool({
          id: "no_recover",
          description: "Keeps no receipt",
          params: Schema.Struct({}),
          output: Schema.String,
          execute: () => hang,
        })
        // A build identity gives each call a durable binding, as a shipped tool has.
        const extensionOf = (
          id: string,
          tools: NonNullable<LoadedExtension["contributions"]["tools"]>,
        ): LoadedExtension => ({
          manifest: { id: ExtensionId.make(id) },
          scope: "builtin",
          sourcePath: "test",
          artifactIdentity: LoadedArtifactIdentity.make(`${id}@artifact-1`),
          contributions: { tools },
        })
        const extensions = [
          extensionOf("@test/recover-one", [settling("settle_one")]),
          extensionOf("@test/recover-two", [settling("settle_two")]),
          extensionOf("@test/recover-none", [plain]),
        ]
        const layerFor = (providerLayer: Layer.Layer<LanguageModel.LanguageModel>) =>
          createE2ELayer({
            agents: e2ePreset.agents,
            providerLayer,
            extensions,
            storagePath: dbPath,
          })

        // First process: the model calls the three tools, and the process stops while they run.
        const target = yield* Effect.scoped(
          Effect.gen(function* () {
            const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
              multiToolCallStep(
                { toolName: "settle_one", input: {} },
                { toolName: "settle_two", input: {} },
                { toolName: "no_recover", input: {} },
              ),
            ])
            const { client } = yield* createRpcClient(layerFor(providerLayer))
            const { sessionId, branchId } = yield* client.session.create({})
            yield* client.message.send({ sessionId, branchId, content: "run all three" })
            yield* Deferred.await(allRunning)
            return { sessionId, branchId }
          }),
        )

        // Second process: the turn resumes; the model reads what each tool settled.
        const seen = yield* Ref.make(Option.none<Prompt.Prompt>())
        yield* Effect.scoped(
          Effect.gen(function* () {
            const providerLayer = LanguageModelLayers.testStream((options) =>
              Ref.set(seen, Option.some(Prompt.make(options.prompt))).pipe(
                Effect.as(
                  Stream.fromIterable([
                    textDeltaPart("read the settled calls"),
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
                hasAssistantText(snapshot.messages, "read the settled calls"),
              5_000,
              "the resumed turn answered",
            )
          }),
        )
        expect(yield* Ref.get(runs)).toBe(3)
        const prompt = Option.getOrThrow(yield* Ref.get(seen))
        const results = prompt.content.flatMap((message) => {
          if (message.role !== "tool") return []
          return message.content.filter((part) => part.type === "tool-result")
        })
        const byName = new Map(results.map((part) => [part.name, part]))
        expect(byName.get("settle_one")).toMatchObject({
          isFailure: false,
          result: { settledBy: "@test/recover-one", ownCall: true },
        })
        expect(byName.get("settle_two")).toMatchObject({
          isFailure: false,
          result: { settledBy: "@test/recover-two", ownCall: true },
        })
        expect(byName.get("no_recover")).toMatchObject({
          isFailure: true,
          result: { reason: "Interrupted" },
        })
      }).pipe(Effect.timeout("15 seconds")),
    20_000,
  )

  it.scopedLive(
    "a tool's recover that waits on an interaction parks the turn, and settles the call once it is answered",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDirectoryScoped("gent-recover-asks-")
        const dbPath = `${tempDir}/gent.db`
        const runs = yield* Ref.make(0)
        const recovers = yield* Ref.make(0)
        const answered = yield* Ref.make(false)
        const asked = yield* Ref.make(Option.none<InteractionRequestId>())
        const asking = tool({
          id: "ask_then_recover",
          description: "Asks, and keeps the request it waits on",
          params: Schema.Struct({}),
          output: Schema.String,
          execute: Effect.fn("ask_then_recover")(function* () {
            yield* Ref.update(runs, (n) => n + 1)
            const ctx = yield* ExtensionContext
            const decision = yield* ctx.Interaction.approve({ text: "proceed?" })
            return `executed: ${String(decision.approved)}`
          }),
          // The receipt the tool keeps is the request it asked; once that is
          // answered, the receipt settles the call.
          recover: (call) =>
            Effect.gen(function* () {
              yield* Ref.update(recovers, (n) => n + 1)
              const requestId = Option.getOrThrow(yield* Ref.get(asked))
              if (!(yield* Ref.get(answered)))
                return ToolCallRecoveryOutcome.cases.Suspended.make({ requestId })
              return ToolCallRecoveryOutcome.cases.Settled.make({
                result: Prompt.toolResultPart({
                  id: call.toolCall.id,
                  name: call.toolCall.name,
                  isFailure: false,
                  providerExecuted: false,
                  result: "settled after the answer",
                }),
              })
            }),
        })
        const extension: LoadedExtension = {
          manifest: { id: ExtensionId.make("@test/recover-asks") },
          scope: "builtin",
          sourcePath: "test",
          artifactIdentity: LoadedArtifactIdentity.make("@test/recover-asks@artifact-1"),
          contributions: { tools: [asking] },
        }
        const layerFor = (providerLayer: Layer.Layer<LanguageModel.LanguageModel>) =>
          createE2ELayer({
            agents: e2ePreset.agents,
            providerLayer,
            extensions: [extension],
            approvalLayer: ApprovalService.Live,
            storagePath: dbPath,
          })

        // First process: the call asks, the turn parks, and the process stops.
        const target = yield* Effect.scoped(
          Effect.gen(function* () {
            const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
              toolCallStep("ask_then_recover", {}),
            ])
            const { client } = yield* createRpcClient(layerFor(providerLayer))
            const { sessionId, branchId } = yield* client.session.create({})
            const presented = yield* client.session.events({ sessionId, branchId }).pipe(
              Stream.filterMap((envelope) => {
                if (envelope.event._tag === "InteractionPresented")
                  return Result.succeed(envelope.event.requestId)
                return Result.failVoid
              }),
              Stream.take(1),
              Stream.runHead,
              Effect.forkScoped,
            )
            yield* client.message.send({ sessionId, branchId, content: "ask first" })
            yield* Ref.set(asked, yield* Fiber.join(presented))
            yield* waitFor(
              client.session.getSnapshot({ sessionId, branchId }),
              (snapshot) => snapshot.runtime._tag === "WaitingForInteraction",
              5_000,
              "parked before the restart",
            )
            return { sessionId, branchId }
          }),
        )

        // Second process: the tool's recover parks the turn on its request; the answer settles it.
        const seen = yield* Ref.make(Option.none<Prompt.Prompt>())
        yield* Effect.scoped(
          Effect.gen(function* () {
            const providerLayer = LanguageModelLayers.testStream((options) =>
              Ref.set(seen, Option.some(Prompt.make(options.prompt))).pipe(
                Effect.as(
                  Stream.fromIterable([
                    textDeltaPart("read the settled call"),
                    finishPart({ finishReason: "stop" }),
                  ] satisfies LanguageModelStreamPart[]),
                ),
              ),
            )
            const { client } = yield* createRpcClient(layerFor(providerLayer))
            yield* waitFor(
              Effect.all([client.session.getSnapshot(target), Ref.get(recovers)]),
              ([snapshot, count]) =>
                snapshot.runtime._tag === "WaitingForInteraction" && count === 1,
              5_000,
              "the recovered call parked the turn",
            )
            yield* Ref.set(answered, true)
            yield* client.interaction.respondInteraction({
              ...target,
              requestId: Option.getOrThrow(yield* Ref.get(asked)),
              approved: true,
            })
            yield* waitFor(
              client.session.getSnapshot(target),
              (snapshot) =>
                snapshot.runtime._tag === "Idle" &&
                hasAssistantText(snapshot.messages, "read the settled call"),
              5_000,
              "the resumed turn answered",
            )
          }),
        )
        expect(yield* Ref.get(runs)).toBe(1)
        expect(yield* Ref.get(recovers)).toBe(2)
        const prompt = Option.getOrThrow(yield* Ref.get(seen))
        const results = prompt.content.flatMap((message) => {
          if (message.role !== "tool") return []
          return message.content.filter((part) => part.type === "tool-result")
        })
        expect(results).toHaveLength(1)
        expect(results[0]).toMatchObject({ isFailure: false, result: "settled after the answer" })
      }).pipe(Effect.timeout("15 seconds")),
    20_000,
  )

  it.scopedLive(
    "answering a parked call never runs recover for a sibling that already finished, and the turn continues",
    () =>
      Effect.gen(function* () {
        const recovers = yield* Ref.make(0)
        const finished = tool({
          id: "finished_work",
          description: "Finishes at once",
          params: Schema.Struct({}),
          output: Schema.String,
          execute: () => Effect.succeed("finished"),
          // The call has a result: a recover that ran would end the turn.
          recover: () =>
            Ref.update(recovers, (n) => n + 1).pipe(
              Effect.andThen(
                Effect.fail(new ToolCallRecoveryError({ message: "no receipt to settle from" })),
              ),
            ),
        })
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
          manifest: { id: ExtensionId.make("@test/finished-sibling") },
          scope: "builtin",
          sourcePath: "test",
          contributions: { tools: [finished, asking] },
        }
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          multiToolCallStep(
            { toolName: "finished_work", input: {} },
            { toolName: "asking_work", input: {} },
          ),
          {
            ...textStep("read both results"),
            assertOptions: (options) => {
              const results = Prompt.make(options.prompt).content.flatMap((message) => {
                if (message.role !== "tool") return []
                return message.content.filter((part) => part.type === "tool-result")
              })
              const byName = new Map(results.map((part) => [part.name, part]))
              expect(byName.get("finished_work")).toMatchObject({
                isFailure: false,
                result: "finished",
              })
              expect(byName.get("asking_work")).toMatchObject({
                isFailure: false,
                result: "worked",
              })
            },
          },
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: e2ePreset.agents,
          providerLayer,
          extensions: [extension],
          approvalLayer: ApprovalService.Live,
        })
        const presented = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.filterMap((envelope) => {
            if (envelope.event._tag === "InteractionPresented")
              return Result.succeed(envelope.event.requestId)
            return Result.failVoid
          }),
          Stream.take(1),
          Stream.runHead,
          Effect.forkScoped,
        )
        yield* client.message.send({ sessionId, branchId, content: "finish one, ask on the other" })
        const requestId = Option.getOrThrow(yield* Fiber.join(presented))
        yield* client.interaction.respondInteraction({
          sessionId,
          branchId,
          requestId,
          approved: true,
        })
        yield* waitFor(
          client.session.getSnapshot({ sessionId, branchId }),
          (snapshot) =>
            snapshot.runtime._tag === "Idle" &&
            hasAssistantText(snapshot.messages, "read both results"),
          5_000,
          "the answered turn continued",
        )
        yield* controls.assertDone
        expect(yield* Ref.get(recovers)).toBe(0)
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )
})

// ── turn ledger ─────────────────────────────────────────────────────────────

describe("turn ledger", () => {
  it.effect(
    "a placement is recorded only by a receipt on its account after a request went out there, and waits for no later receipt",
    () =>
      Effect.gen(function* () {
        const ledger = yield* makeTurnLedger
        yield* ledger.beginTurn(MessageId.make("ledger-placement"))
        const provider = "spread"
        const b = CredentialSlot.make("b")
        const c = CredentialSlot.make("c")
        const decision = { slot: b, from: Option.none(), reason: "new" as const }
        // A request that went out on c does not make b's placement recordable.
        yield* ledger.placeCredential(provider, decision)
        yield* ledger.noteDispatched(provider, c)
        expect(yield* ledger.takePlacement(provider, b)).toEqual(Option.none())
        // A receipt on another account records nothing, and the placement is gone.
        yield* ledger.placeCredential(provider, decision)
        yield* ledger.noteDispatched(provider, b)
        expect(yield* ledger.takePlacement(provider, c)).toEqual(Option.none())
        expect(yield* ledger.takePlacement(provider, b)).toEqual(Option.none())
        // A request went out on b: b's receipt records it, once.
        yield* ledger.placeCredential(provider, decision)
        yield* ledger.noteDispatched(provider, b)
        expect(yield* ledger.takePlacement(provider, b)).toEqual(Option.some(decision))
        expect(yield* ledger.takePlacement(provider, b)).toEqual(Option.none())
        // A receipt on b whose request never went out records nothing, and
        // a later request there does not bring the placement back.
        yield* ledger.placeCredential(provider, decision)
        expect(yield* ledger.takePlacement(provider, b)).toEqual(Option.none())
        yield* ledger.noteDispatched(provider, b)
        expect(yield* ledger.takePlacement(provider, b)).toEqual(Option.none())
      }),
  )

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

  it.effect("a route that every step of its turn reads is charged once", () =>
    Effect.gen(function* () {
      const ledger = yield* makeTurnLedger
      const messageId = MessageId.make("ledger-routed")
      yield* ledger.beginTurn(messageId)
      const route = ModelRouted.make({
        sessionId,
        branchId,
        messageId,
        selected: ModelId.make("router/auto"),
        model: ModelId.make("test/priced"),
        reason: "hard",
        classifier: ModelId.make("judge/jev"),
        costUsd: 0.125,
        durationMs: 1,
      })
      for (const cost of [0.5, 0.25]) {
        yield* ledger.noteRoute(route)
        yield* ledger.noteStep({
          agent: AgentName.make("primary"),
          model: ModelId.make("test/priced"),
          usage: Option.some({ inputTokens: 100, outputTokens: 10 }),
          costUsd: Option.some(cost),
          toolCallCount: 0,
        })
      }
      expect((yield* ledger.total).costUsd).toEqual(Option.some(0.875))
    }),
  )

  it.effect("a model route and an effort route of one name are each charged", () =>
    Effect.gen(function* () {
      const ledger = yield* makeTurnLedger
      const messageId = MessageId.make("ledger-two-routes")
      yield* ledger.beginTurn(messageId)
      const route = {
        sessionId,
        branchId,
        messageId,
        selected: ModelId.make("router/auto"),
        model: ModelId.make("test/priced"),
        reason: "hard",
        classifier: ModelId.make("judge/jev"),
        durationMs: 1,
      }
      yield* ledger.noteRoute(ModelRouted.make({ ...route, costUsd: 0.25 }))
      yield* ledger.noteRoute(ModelRouted.make({ ...route, costUsd: 0.5, effortOnly: true }))
      expect((yield* ledger.total).costUsd).toEqual(Option.some(0.75))
    }),
  )
})
