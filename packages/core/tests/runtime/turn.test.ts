import { describe, expect, it, test } from "effect-bun-test"
import { Clock, Effect, Layer, Option, Ref, Schema, type Scope, Stream } from "effect"
import {
  assistantMessageIdForTurn,
  dateFromMillis,
  Message,
  responseUsage,
  toolResultMessageIdForTurn,
} from "../../src/domain/message"
import * as Response from "effect/unstable/ai/Response"
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
} from "../../src/runtime/turn"
import { BranchId, MessageId, SessionId, ToolCallId } from "../../src/domain/ids"
import { AgentDefinition, AgentName, DriverRef, ModelId } from "../../src/domain/agent"
import { ProviderError } from "../../src/domain/errors"
import { finishPart, textDeltaPart, toolCallPart } from "../../src/runtime/provider"
import {
  type AgentEvent,
  EventEnvelope,
  EventId,
  EventStore,
  MessageReceived,
  ToolCallSucceeded,
  UsageSchema,
} from "../../src/domain/event"
import * as Prompt from "effect/unstable/ai/Prompt"
import { EventStorage, MessageStorage } from "../../src/storage/storage"
import { EventStoreLive } from "../../src/runtime/session"
import { noBranchTools } from "../../src/runtime/tools"
import { ensureStorageParents, testSqliteStorage } from "../../src/test-utils/harness"

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
    for (const total of [Option.getOrUndefined(Option.none<number>()), -1, 1.5, Number.NaN]) {
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
    for (const count of [Option.getOrUndefined(Option.none<number>()), -1, 1.5, Number.NaN]) {
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

  test("unknown finish reasons collapse to unknown", () => {})

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
    const agent = AgentDefinition.make({ name: AgentName.make("cowork") })
    const route = routeOf(agent, { cowork: DriverRef.make({ id: "openai" }) })
    expect(route.modelDriver.driverId).toEqual(Option.some("openai"))
    expect(route.modelDriver.contextModelId).toBe(ModelId.make("openai/claude-sonnet-5"))
  })

  test("no driver and no override route through the model id's provider", () => {
    const agent = AgentDefinition.make({ name: AgentName.make("cowork") })
    for (const route of [routeOf(agent), routeOf(agent, {})]) {
      expect(route.modelDriver.driverId).toEqual(Option.some("anthropic"))
      expect(route.modelDriver.contextModelId).toBe(modelId)
    }
  })

  test("an override for another agent does not route this one", () => {
    const agent = AgentDefinition.make({ name: AgentName.make("cowork") })
    const route = routeOf(agent, { deepwork: DriverRef.make({ id: "openai" }) })
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
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            testSqliteStorage(() => Layer.empty, {}),
            publisher.layer,
          ),
        ),
      )
    }),
  )
})
