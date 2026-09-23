import { test } from "bun:test"
import { Clock, Effect, Layer, Option, Predicate, Ref, Result, Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import {
  ActorCommandId,
  BranchId,
  ExtensionId,
  MessageId,
  SessionId,
  ToolCallId,
} from "../../src/domain/ids"
import {
  Branch,
  dateFromMillis,
  Message,
  type MessagePart,
  normalizeResponseParts,
  projectResponsePartsToMessageParts,
  Session,
} from "../../src/domain/message"
import {
  boundToolResultForModel,
  type CompactionRequest,
  ContextDirective,
  estimateTokens,
  latestUserMessageId,
  maximumModelToolResultChars,
  messagesInCurrentWindow,
  MODEL_OUTPUT_RESERVE_TOKENS,
  ModelCompactionError,
  ModelContextBudget,
  ModelContextCompactor,
  ModelContextError,
  type ModelContextError as ModelContextErrorValue,
  ModelContextLedger,
  ModelContextProjection,
  ModelContextProjectionError,
  type ModelContextProjection as ModelContextProjectionValue,
  projectContextWindow,
  projectModelContext,
  toPrompt,
  toPromptMessages,
  windowDetails,
  settledMessages,
  windowMarkerMessage,
  estimateTextTokens,
} from "../../src/runtime/model-context"
import { describe, expect, it } from "effect-bun-test"
import { narrowR } from "../helpers/effect"
import { AgentDefinition, AgentName, Model, ModelId, ProviderId } from "../../src/domain/agent"
import { LanguageModelLayers, textStep } from "../../src/test-utils/language-model"
import { ModelRegistry } from "../../src/runtime/provider"
import { SessionRuntime } from "../../src/runtime/session"
import { getSessionSnapshot } from "../../src/server/server"
import {
  BranchStorage,
  EventStorage,
  MessageStorage,
  SessionStorage,
} from "../../src/storage/storage"
import { baseLocalLayerWithProvider } from "../../src/test-utils/harness"
import { type AgentEvent, EventEnvelope, EventId, EventPublisher } from "../../src/domain/event"
import * as Response from "effect/unstable/ai/Response"

// ── model-context.test ──────────────────────────────────────────────────────

interface TestMessageOptional {
  metadata?: {
    readonly customType?: string
    readonly extensionId?: string
    readonly hidden?: boolean
    readonly details?: unknown
  }
}

const sessionId = SessionId.make("session")
const branchId = BranchId.make("branch")
const createdAt = dateFromMillis(1_767_225_600_000)

const text = (value: string): MessagePart => Prompt.textPart({ text: value })

const call = (id: string, name = "read"): MessagePart =>
  Prompt.toolCallPart({
    id: ToolCallId.make(id),
    name,
    params: { path: id },
    providerExecuted: false,
  })

const result = (id: string, name = "read"): MessagePart =>
  Prompt.toolResultPart({
    id: ToolCallId.make(id),
    name,
    isFailure: false,
    providerExecuted: false,
    result: { value: id },
  })

const message = (
  id: string,
  role: "user" | "assistant" | "system" | "tool",
  parts: ReadonlyArray<MessagePart>,
  metadata?: TestMessageOptional["metadata"],
): Message => {
  const optional: TestMessageOptional = {}
  const maybeMetadata = Option.fromNullishOr(metadata)
  if (Option.isSome(maybeMetadata)) optional.metadata = maybeMetadata.value
  return Message.cases.regular.make({
    id: MessageId.make(id),
    sessionId,
    branchId,
    role,
    parts: [...parts],
    createdAt,
    ...optional,
  })
}

const budget = (contextLimitTokens: number): ModelContextBudget =>
  ModelContextBudget.make({
    contextLimitTokens,
    reservedSystemTokens: 0,
    reservedToolTokens: 0,
    reservedOutputTokens: 0,
  })

const success = (value: ReturnType<typeof projectModelContext>): ModelContextProjectionValue =>
  Result.getOrThrow(value)

const failure = (value: ReturnType<typeof projectModelContext>): ModelContextErrorValue =>
  Result.getOrThrow(Result.flip(value))

const ids = (projection: ModelContextProjectionValue): ReadonlyArray<string> =>
  projection.messages.map((item) => item.id)

describe("projectModelContext", () => {
  test("selects a newest suffix and reports separate reservations", () => {
    const messages = [
      message("old", "assistant", [text("old!")]),
      message("user", "user", [text("user")]),
      message("answer", "assistant", [text("done")]),
    ]
    const result = projectModelContext(
      messages,
      ModelContextBudget.make({
        contextLimitTokens: 5,
        reservedSystemTokens: 1,
        reservedToolTokens: 1,
        reservedOutputTokens: 1,
      }),
    )

    const projection = success(result)
    expect(projection.availableInputTokens).toBe(2)
    expect(projection.estimatedTokens).toBe(2)
    expect(ids(projection)).toEqual(["user", "answer"])
    expect(projection.omittedMessageIds).toEqual([MessageId.make("old")])
  })

  test("is deterministic for the same ordered input and does not mutate it", () => {
    const messages = [
      message("first", "user", [text("first")]),
      message("second", "assistant", [text("second")]),
      message("latest", "user", [text("latest")]),
    ]
    const snapshot = [...messages]
    const first = success(projectModelContext(messages, budget(2)))
    const second = success(projectModelContext(messages, budget(2)))
    const firstIds = ids(first)

    expect(firstIds).toEqual(ids(second))
    expect(first.omittedMessageIds).toEqual(second.omittedMessageIds)
    expect(messages).toEqual(snapshot)
    expect(first.messages).not.toBe(messages)
    messages.reverse()
    expect(ids(first)).toEqual(firstIds)
  })

  test("keeps a complete single tool group indivisible", () => {
    const user = message("user", "user", [text("user")])
    const assistant = message("call", "assistant", [call("call-1")])
    const tool = message("result", "tool", [result("call-1")])
    const old = message("old", "assistant", [text("old")])
    const available = estimateTokens([user, assistant, tool])

    const projection = success(projectModelContext([old, user, assistant, tool], budget(available)))

    expect(ids(projection)).toEqual(["user", "call", "result"])
    expect(projection.omittedMessageIds).toEqual([MessageId.make("old")])
  })

  test("keeps parallel calls and all results in one selection unit", () => {
    const user = message("user", "user", [text("user")])
    const assistant = message("calls", "assistant", [call("call-1"), call("call-2")])
    const firstResult = message("result-1", "tool", [result("call-1")])
    const secondResult = message("result-2", "tool", [result("call-2")])
    const old = message("old", "assistant", [text("old")])
    const available = estimateTokens([user, assistant, firstResult, secondResult])

    const projection = success(
      projectModelContext([old, user, assistant, firstResult, secondResult], budget(available)),
    )

    expect(ids(projection)).toEqual(["user", "calls", "result-1", "result-2"])
    expect(projection.omittedMessageIds).toEqual([MessageId.make("old")])
  })

  test("rejects an oversized newest user turn instead of returning an empty prompt", () => {
    const messages = [
      message("old", "assistant", [text("old")]),
      message("latest", "user", [text("latest")]),
    ]
    const available = estimateTokens([messages[1]!])
    const error = failure(projectModelContext(messages, budget(available - 1)))

    expect(error._tag).toBe("BudgetExceeded")
    if (error._tag === "BudgetExceeded") {
      expect(error.messageIds).toEqual([MessageId.make("latest")])
      expect(error.estimatedTokens).toBe(2)
      expect(error.availableInputTokens).toBe(1)
    }
  })

  test("rejects reservations that leave no valid input budget", () => {
    const error = failure(
      projectModelContext(
        [message("user", "user", [text("user")])],
        ModelContextBudget.make({
          contextLimitTokens: 3,
          reservedSystemTokens: 1,
          reservedToolTokens: 1,
          reservedOutputTokens: 2,
        }),
      ),
    )

    expect(error).toEqual(
      ModelContextError.cases.ReserveExhausted.make({
        contextLimitTokens: 3,
        reservedTokens: 4,
      }),
    )
  })

  test("requires decoded non-negative finite budget fields", () => {
    const decodeBudget = Schema.decodeSync(ModelContextBudget)

    expect(() =>
      decodeBudget({
        contextLimitTokens: -1,
        reservedSystemTokens: 0,
        reservedToolTokens: 0,
        reservedOutputTokens: 0,
      }),
    ).toThrow()
    expect(() =>
      decodeBudget({
        contextLimitTokens: Number.NaN,
        reservedSystemTokens: 0,
        reservedToolTokens: 0,
        reservedOutputTokens: 0,
      }),
    ).toThrow()
  })

  test("omits a hidden complete tool group without breaking visible history", () => {
    const messages = [
      message("hidden-call", "assistant", [call("hidden")], { hidden: true }),
      message("hidden-result", "tool", [result("hidden")], { hidden: true }),
      message("visible", "user", [text("visible")]),
    ]

    const projection = success(projectModelContext(messages, budget(10)))

    expect(ids(projection)).toEqual(["visible"])
    expect(projection.omittedMessageIds).toEqual([])
  })

  test("rejects a visible result whose call is hidden", () => {
    const error = failure(
      projectModelContext(
        [
          message("hidden-call", "assistant", [call("hidden")], { hidden: true }),
          message("visible-result", "tool", [result("hidden")]),
        ],
        budget(10),
      ),
    )

    expect(error._tag).toBe("OrphanToolResult")
  })

  test("rejects a visible call whose result is hidden", () => {
    const error = failure(
      projectModelContext(
        [
          message("visible-call", "assistant", [call("hidden-result")]),
          message("hidden-result", "tool", [result("hidden-result")], { hidden: true }),
        ],
        budget(10),
      ),
    )

    expect(error._tag).toBe("IncompleteToolCallGroup")
  })

  test("rejects duplicate call and result IDs", () => {
    const duplicateCall = failure(
      projectModelContext(
        [
          message("call-1", "assistant", [call("duplicate")]),
          message("call-2", "assistant", [call("duplicate")]),
        ],
        budget(10),
      ),
    )
    expect(duplicateCall).toEqual(
      ModelContextError.cases.DuplicateToolCallId.make({ id: ToolCallId.make("duplicate") }),
    )

    const duplicateResult = failure(
      projectModelContext(
        [
          message("call", "assistant", [call("duplicate-result")]),
          message("result-1", "tool", [result("duplicate-result")]),
          message("result-2", "tool", [result("duplicate-result")]),
        ],
        budget(10),
      ),
    )
    expect(duplicateResult).toEqual(
      ModelContextError.cases.DuplicateToolResultId.make({
        id: ToolCallId.make("duplicate-result"),
      }),
    )
  })

  test("rejects orphan, incomplete, and mismatched tool groups", () => {
    const orphan = failure(
      projectModelContext([message("orphan", "tool", [result("missing")])], budget(10)),
    )
    expect(orphan._tag).toBe("OrphanToolResult")

    const incomplete = failure(
      projectModelContext(
        [message("incomplete", "assistant", [call("missing-result")])],
        budget(10),
      ),
    )
    expect(incomplete._tag).toBe("IncompleteToolCallGroup")

    const mismatched = failure(
      projectModelContext(
        [
          message("call", "assistant", [call("mismatch", "read")]),
          message("result", "tool", [result("mismatch", "write")]),
        ],
        budget(10),
      ),
    )
    expect(mismatched).toEqual(
      ModelContextError.cases.MismatchedToolResultName.make({
        id: ToolCallId.make("mismatch"),
        expectedName: "read",
        actualName: "write",
      }),
    )
  })

  test("rejects tool parts in roles that cannot represent them", () => {
    const callError = failure(
      projectModelContext([message("user-call", "user", [call("wrong-role")])], budget(10)),
    )
    expect(callError._tag).toBe("ToolCallWrongRole")

    const resultError = failure(
      projectModelContext(
        [message("assistant-result", "assistant", [result("wrong-role")])],
        budget(10),
      ),
    )
    expect(resultError._tag).toBe("ToolResultWrongRole")
  })

  test("returns a schema-decodable success value", () => {
    const projection = success(
      projectModelContext([message("user", "user", [text("hello")])], budget(10)),
    )

    expect(Schema.decodeSync(ModelContextProjection)(projection)).toEqual(projection)
  })
})

// ── model-context-degrade.test ──────────────────────────────────────────────

const CONTEXT_LIMIT_TOKENS = 40_000
const modelId = ModelId.make("test/small-window")
const agent = AgentDefinition.make({ name: AgentName.make("cowork"), model: modelId })
const smallWindowModel = new Model({
  id: modelId,
  name: "Small Window",
  provider: ProviderId.make("test"),
  contextLength: CONTEXT_LIMIT_TOKENS,
})
const sessionIdModelContextDegrade = SessionId.make("degrade-session")
const branchIdModelContextDegrade = BranchId.make("degrade-branch")

/** Older history that overflows the small window several times over. */
const seedOverflowingHistory = Effect.gen(function* () {
  const sessions = yield* SessionStorage
  const branches = yield* BranchStorage
  const messages = yield* MessageStorage
  const now = dateFromMillis(1_767_225_600_000)
  yield* sessions.createSession(
    new Session({
      id: sessionIdModelContextDegrade,
      name: "Degrade Test",
      createdAt: now,
      updatedAt: now,
    }),
  )
  yield* branches.createBranch(
    new Branch({
      id: branchIdModelContextDegrade,
      sessionId: sessionIdModelContextDegrade,
      createdAt: now,
    }),
  )
  const roles: ReadonlyArray<"user" | "assistant"> = ["user", "assistant"]
  for (let exchange = 0; exchange < 6; exchange += 1) {
    for (const role of roles) {
      const ordinal = exchange * roles.length + roles.indexOf(role)
      yield* messages.createMessage(
        Message.cases.regular.make({
          id: MessageId.make(`old-${ordinal}`),
          sessionId: sessionIdModelContextDegrade,
          branchId: branchIdModelContextDegrade,
          role,
          parts: [Prompt.textPart({ text: `old-${ordinal} ${"x".repeat(40_000)}` })],
          createdAt: dateFromMillis(1_000 + ordinal),
        }),
      )
    }
  }
})

/** A compactor whose summary model is down; the seam contract says the turn degrades. */
const failingCompactor = Layer.succeed(
  ModelContextCompactor,
  ModelContextCompactor.of({
    compact: (request) =>
      Effect.fail(
        new ModelCompactionError({
          modelId: request.modelId,
          reason: "SummaryGenerationFailed",
        }),
      ),
  }),
)

describe("context compaction degrade path", () => {
  it.live("a failing compactor does not cost the turn; the notice names the omission", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        textStep("reply after degrade"),
      ])
      const layer = baseLocalLayerWithProvider(providerLayer, {
        agents: [agent],
        extraLayers: [ModelRegistry.Test([smallWindowModel]), failingCompactor],
      })
      const result = yield* narrowR(
        Effect.gen(function* () {
          yield* seedOverflowingHistory
          const runtime = yield* SessionRuntime
          yield* runtime.sendUserMessage({
            sessionId: sessionIdModelContextDegrade,
            branchId: branchIdModelContextDegrade,
            commandId: ActorCommandId.make("turn:continue"),
            content: "continue",
            agentOverride: agent.name,
          })
          const events = (yield* (yield* EventStorage).listEvents({
            sessionId: sessionIdModelContextDegrade,
            branchId: branchIdModelContextDegrade,
          })).map((envelope) => envelope.event)
          const durable = yield* (yield* MessageStorage).listMessages(branchIdModelContextDegrade)
          const metrics = (yield* getSessionSnapshot({
            sessionId: sessionIdModelContextDegrade,
            branchId: branchIdModelContextDegrade,
          })).metrics
          return { events, durable, metrics }
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer), Effect.timeout("8 seconds")),
      )
      expect(yield* controls.callCount).toBe(1)
      // The notice text is the projection's; tests/runtime/agent/turn-window.test.ts reads it.
      expect(result.events.filter((event) => event._tag === "ErrorOccurred")).toHaveLength(1)
      expect(result.events.some((event) => event._tag === "TurnCompleted")).toBe(true)
      expect(
        result.durable.some((message) => message.metadata?.customType === "context-window"),
      ).toBe(false)
      const last = result.durable.at(-1)
      expect(last?.role).toBe("assistant")
      expect(result.metrics.context?.omittedMessages).toBeGreaterThan(0)
      expect(result.metrics.context?.compactions).toBe(0)
    }),
  )
})

// ── model-context-ledger.test ───────────────────────────────────────────────

describe("model context ledger", () => {
  it.effect("a branch starts without a projection and reports the last one recorded", () =>
    Effect.gen(function* () {
      const ledger = yield* ModelContextLedger.make
      expect(Option.isNone(yield* ledger.status)).toBe(true)
      yield* ledger.recordProjection({
        estimatedTokens: 10,
        availableInputTokens: 90,
        contextLimitTokens: 100,
        omittedMessages: 0,
      })
      yield* ledger.recordProjection({
        estimatedTokens: 20,
        availableInputTokens: 80,
        contextLimitTokens: 100,
        omittedMessages: 2,
        handoffMessageId: MessageId.make("context-handoff:b:m"),
      })
      const status = Option.getOrThrow(yield* ledger.status)
      expect(status.estimatedTokens).toBe(20)
      expect(status.handoffMessageId).toBe(MessageId.make("context-handoff:b:m"))
    }),
  )

  it.effect(
    "the newest directive wins and stays pending until its projection acknowledges it",
    () =>
      Effect.gen(function* () {
        const ledger = yield* ModelContextLedger.make
        expect(Option.isNone(yield* ledger.pendingDirective)).toBe(true)
        yield* ledger.schedule(ContextDirective.cases.Compact.make({ instructions: "keep paths" }))
        const newWindow = ContextDirective.cases.NewWindow.make({ notice: "older context dropped" })
        yield* ledger.schedule(newWindow)
        const pending = yield* ledger.pendingDirective
        expect(Option.map(pending, (directive) => directive._tag)).toEqual(Option.some("NewWindow"))
        // A failed projection leaves the directive for the retry.
        expect(Option.isSome(yield* ledger.pendingDirective)).toBe(true)
        yield* ledger.acknowledgeDirective(newWindow)
        expect(Option.isNone(yield* ledger.pendingDirective)).toBe(true)
      }),
  )

  it.effect("acknowledging a replaced directive keeps the newer one", () =>
    Effect.gen(function* () {
      const ledger = yield* ModelContextLedger.make
      const stale = ContextDirective.cases.Compact.make({})
      yield* ledger.schedule(stale)
      yield* ledger.schedule(
        ContextDirective.cases.NewWindow.make({ notice: "older context dropped" }),
      )
      yield* ledger.acknowledgeDirective(stale)
      expect(Option.map(yield* ledger.pendingDirective, (d) => d._tag)).toEqual(
        Option.some("NewWindow"),
      )
      yield* ledger.discardDirective
      expect(Option.isNone(yield* ledger.pendingDirective)).toBe(true)
    }),
  )
})

// ── model-context-window.test ───────────────────────────────────────────────

const sessionIdModelContextWindow = SessionId.make("window-session")
const branchIdModelContextWindow = BranchId.make("window-branch")

const messageModelContextWindow = (id: string, role: "user" | "assistant", ordinal: number) =>
  Message.cases.regular.make({
    id: MessageId.make(id),
    sessionId: sessionIdModelContextWindow,
    branchId: branchIdModelContextWindow,
    role,
    parts: [Prompt.textPart({ text: id })],
    createdAt: dateFromMillis(1_000 + ordinal),
  })

describe("model context window", () => {
  test("a marker leads the window and everything before its anchor leaves the view", () => {
    const history = [
      messageModelContextWindow("u1", "user", 1),
      messageModelContextWindow("a1", "assistant", 2),
      messageModelContextWindow("u2", "user", 3),
      messageModelContextWindow("a2", "assistant", 4),
    ]
    const anchor = Option.getOrThrow(latestUserMessageId(history))
    expect(anchor).toBe(MessageId.make("u2"))
    const marker = windowMarkerMessage({
      sessionId: sessionIdModelContextWindow,
      branchId: branchIdModelContextWindow,
      keepFromMessageId: anchor,
      notice: "older context dropped",
      createdAt: dateFromMillis(2_000),
    })
    const windowed = messagesInCurrentWindow([
      ...history,
      marker,
      messageModelContextWindow("u3", "user", 5),
    ])
    expect(windowed.map((entry) => String(entry.id))).toEqual([String(marker.id), "u2", "a2", "u3"])
    // The marker itself never anchors a later window.
    expect(latestUserMessageId([...history, marker])).toEqual(Option.some(MessageId.make("u2")))
  })

  test("the marker survives a projection so tight that only the latest user unit fits", () => {
    const wide = (id: string, role: "user" | "assistant", ordinal: number) =>
      Message.cases.regular.make({
        id: MessageId.make(id),
        sessionId: sessionIdModelContextWindow,
        branchId: branchIdModelContextWindow,
        role,
        parts: [Prompt.textPart({ text: `${id} ${"y".repeat(2_000)}` })],
        createdAt: dateFromMillis(1_000 + ordinal),
      })
    const history = [wide("u1", "user", 1), wide("a1", "assistant", 2), wide("u2", "user", 3)]
    const marker = windowMarkerMessage({
      sessionId: sessionIdModelContextWindow,
      branchId: branchIdModelContextWindow,
      keepFromMessageId: MessageId.make("u2"),
      notice: "older context dropped",
      createdAt: dateFromMillis(2_000),
    })
    const latest = wide("u3", "user", 5)
    const windowed = messagesInCurrentWindow([
      ...history,
      marker,
      wide("a2", "assistant", 4),
      latest,
    ])
    // Room for the latest user unit and the marker, but not for another wide message.
    const budget = ModelContextBudget.make({
      contextLimitTokens: estimateTokens([latest, marker]) + 50,
      reservedSystemTokens: 0,
      reservedToolTokens: 0,
      reservedOutputTokens: 0,
    })
    const projection = Result.getOrThrow(projectModelContext(windowed, budget))
    expect(projection.messages.map((entry) => String(entry.id))).toEqual([String(marker.id), "u3"])
    expect(projection.omittedMessageIds.map(String)).toEqual(["u2", "a2"])
  })

  test("a copy taken mid-step leaves the running tool call out with its step", () => {
    const tool = (id: string, parts: ReadonlyArray<MessagePart>, ordinal: number) =>
      Message.cases.regular.make({
        id: MessageId.make(id),
        sessionId: sessionIdModelContextWindow,
        branchId: branchIdModelContextWindow,
        role: "tool",
        parts: [...parts],
        createdAt: dateFromMillis(1_000 + ordinal),
      })
    const assistant = (id: string, parts: ReadonlyArray<MessagePart>, ordinal: number) =>
      Message.cases.regular.make({
        id: MessageId.make(id),
        sessionId: sessionIdModelContextWindow,
        branchId: branchIdModelContextWindow,
        role: "assistant",
        parts: [...parts],
        createdAt: dateFromMillis(1_000 + ordinal),
      })
    const call = (id: string) =>
      Prompt.toolCallPart({ id, name: "read", params: { path: id }, providerExecuted: false })
    const result = (id: string) =>
      Prompt.toolResultPart({
        id,
        name: "read",
        isFailure: false,
        providerExecuted: false,
        result: "ok",
      })
    const history = [
      messageModelContextWindow("u1", "user", 1),
      assistant("a1", [Prompt.textPart({ text: "reading" }), call("c1")], 2),
      tool("t1", [result("c1")], 3),
      assistant("a2", [Prompt.textPart({ text: "forking" }), call("c2")], 4),
      assistant("a3", [call("c3")], 5),
    ]
    const settled = settledMessages(history)
    expect(settled.map((entry) => String(entry.id))).toEqual(["u1", "a1", "t1", "a2"])
    expect(settled[3]?.parts).toEqual([Prompt.textPart({ text: "forking" })])
    // Messages that lose nothing are the same objects; a run with every call answered is unchanged.
    expect(settled[1]).toBe(history[1])
    const answered = history.slice(0, 3)
    expect(settledMessages(answered)).toEqual(answered)
    // A window cut between a call and its result leaves an orphan result; it goes too.
    expect(settledMessages(history.slice(2, 4)).map((entry) => String(entry.id))).toEqual(["a2"])
  })

  test("a marker whose anchor is gone is ignored so nothing is lost", () => {
    const history = [
      messageModelContextWindow("u1", "user", 1),
      messageModelContextWindow("a1", "assistant", 2),
    ]
    const marker = windowMarkerMessage({
      sessionId: sessionIdModelContextWindow,
      branchId: branchIdModelContextWindow,
      keepFromMessageId: MessageId.make("missing"),
      notice: "older context dropped",
      createdAt: dateFromMillis(2_000),
    })
    expect(messagesInCurrentWindow([...history, marker])).toEqual([...history, marker])
    expect(messagesInCurrentWindow(history)).toBe(history)
  })
})

// ── token-estimation.test ───────────────────────────────────────────────────

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

describe("Token Estimation", () => {
  test("estimateTokens calculates token count", () => {
    const messages = [
      Message.cases.regular.make({
        id: MessageId.make("m1"),
        sessionId: SessionId.make("s"),
        branchId: BranchId.make("b"),
        role: "user",
        parts: [Prompt.textPart({ text: "Hello world" })], // 11 chars
        createdAt: dateFromMillis(1_767_225_600_000),
      }),
    ]

    const tokens = estimateTokens(messages)
    expect(tokens).toBe(3) // ceil(11/4) = 3
  })
})
describe("estimateTokens", () => {
  test("text parts", () => {
    const messages = [
      Message.cases.regular.make({
        id: MessageId.make("m1"),
        sessionId: SessionId.make("s"),
        branchId: BranchId.make("b"),
        role: "user",
        parts: [Prompt.textPart({ text: "x".repeat(100) })],
        createdAt: dateFromMillis(1_767_225_600_000),
      }),
    ]
    expect(estimateTokens(messages)).toBe(25) // 100/4
  })

  test("a one-text message costs what its text costs, so text bounds match the projection", () => {
    // Compaction bounds a summary with estimateTextTokens; the projection
    // budgets the same summary as a message. The two must agree at the edge.
    const project = (text: string) =>
      estimateTokens([
        Message.cases.regular.make({
          id: MessageId.make("summary"),
          sessionId: SessionId.make("s"),
          branchId: BranchId.make("b"),
          role: "assistant",
          parts: [Prompt.textPart({ text })],
          createdAt: dateFromMillis(1_767_225_600_000),
        }),
      ])
    for (const text of ["x".repeat(4_000), "x".repeat(4_001)]) {
      expect(estimateTextTokens(text)).toBe(project(text))
    }
  })

  test("tool-call parts use JSON.stringify of input", () => {
    const messages = [
      Message.cases.regular.make({
        id: MessageId.make("m1"),
        sessionId: SessionId.make("s"),
        branchId: BranchId.make("b"),
        role: "assistant",
        parts: [
          Prompt.toolCallPart({
            id: ToolCallId.make("tc1"),
            name: "test",
            params: { key: "value" },
            providerExecuted: false,
          }),
        ],
        createdAt: dateFromMillis(1_767_225_600_000),
      }),
    ]
    const tokens = estimateTokens(messages)
    const expectedChars = encodeJson({ key: "value" }).length
    expect(tokens).toBe(Math.ceil(expectedChars / 4))
  })

  test("tool-result parts use JSON.stringify of output", () => {
    const messages = [
      Message.cases.regular.make({
        id: MessageId.make("m1"),
        sessionId: SessionId.make("s"),
        branchId: BranchId.make("b"),
        role: "tool",
        parts: [
          Prompt.toolResultPart({
            id: ToolCallId.make("tc1"),
            name: "test",
            isFailure: false,
            providerExecuted: false,
            result: { data: "hello" },
          }),
        ],
        createdAt: dateFromMillis(1_767_225_600_000),
      }),
    ]
    const tokens = estimateTokens(messages)
    expect(tokens).toBeGreaterThan(0)
  })

  test("image parts estimate ~250 tokens", () => {
    const messages = [
      Message.cases.regular.make({
        id: MessageId.make("m1"),
        sessionId: SessionId.make("s"),
        branchId: BranchId.make("b"),
        role: "user",
        parts: [Prompt.filePart({ data: "data:image/png;base64,abc", mediaType: "image/png" })],
        createdAt: dateFromMillis(1_767_225_600_000),
      }),
    ]
    expect(estimateTokens(messages)).toBe(250) // 1000/4
  })

  test("a spilled tool result counts at its model-facing size, not its stored size", () => {
    const messages = [
      Message.cases.regular.make({
        id: MessageId.make("m1"),
        sessionId: SessionId.make("s"),
        branchId: BranchId.make("b"),
        role: "tool",
        parts: [
          Prompt.toolResultPart({
            id: ToolCallId.make("tc1"),
            name: "cell",
            isFailure: false,
            providerExecuted: false,
            result: { display: "x".repeat(40_000) },
          }),
        ],
        createdAt: dateFromMillis(1_767_225_600_000),
      }),
    ]
    // The stored result is ~10,000 tokens; the model sees 8,000 chars plus a locator.
    const tokens = estimateTokens(messages)
    expect(tokens).toBeLessThan(2_200)
    expect(tokens).toBeGreaterThan(2_000)
  })

  test("multiple messages sum correctly", () => {
    const messages = [
      Message.cases.regular.make({
        id: MessageId.make("m1"),
        sessionId: SessionId.make("s"),
        branchId: BranchId.make("b"),
        role: "user",
        parts: [Prompt.textPart({ text: "x".repeat(100) })],
        createdAt: dateFromMillis(1_767_225_600_000),
      }),
      Message.cases.regular.make({
        id: MessageId.make("m2"),
        sessionId: SessionId.make("s"),
        branchId: BranchId.make("b"),
        role: "assistant",
        parts: [Prompt.textPart({ text: "y".repeat(200) })],
        createdAt: dateFromMillis(1_767_225_600_000),
      }),
    ]
    expect(estimateTokens(messages)).toBe(75) // (100+200)/4
  })
})

// ── agent/turn-window.test ──────────────────────────────────────────────────

const modelIdTurnWindow = ModelId.make("test/window-model")
/** A publisher that keeps what the projection publishes, so a test can read the notice. */
const recordingPublisher = Effect.map(Ref.make<ReadonlyArray<AgentEvent>>([]), (published) => ({
  published,
  layer: Layer.succeed(
    EventPublisher,
    EventPublisher.of({
      append: (event) =>
        Effect.map(Clock.currentTimeMillis, (at) =>
          EventEnvelope.make({ id: EventId.make(0), event, createdAt: at }),
        ),
      deliver: () => Effect.void,
      publish: (event) => Ref.update(published, (events) => [...events, event]),
    }),
  ),
}))

/** `resolveTurnSource` projects the same way: a projection failure becomes the typed error. */
const projectWith = (budget: ModelContextBudget) => (messages: ReadonlyArray<Message>) =>
  Effect.gen(function* () {
    const projection = projectModelContext(messages, budget)
    if (Result.isFailure(projection)) {
      return yield* new ModelContextProjectionError({
        modelId: modelIdTurnWindow,
        failure: projection.failure,
      })
    }
    return projection.success
  })

const summaryModel: CompactionRequest["summaryModel"] = () =>
  Effect.die("the summary model is not resolved in these tests")

describe("turn window projection", () => {
  it.scopedLive("a turn whose own steps overflow hands off at a step boundary", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("mid-turn-session")
      const branchId = BranchId.make("mid-turn-branch")
      const prompt = Message.cases.regular.make({
        id: MessageId.make("mid-prompt"),
        sessionId,
        branchId,
        role: "user",
        parts: [Prompt.textPart({ text: "mid-turn prompt" })],
        createdAt,
      })
      // Four completed steps of ~700 tokens each after the only user message.
      const steps = Array.from({ length: 4 }, (_, index) => {
        const id = ToolCallId.make(`mid-call-${index + 1}`)
        const call = Message.cases.regular.make({
          id: MessageId.make(`mid-call-${index + 1}`),
          sessionId,
          branchId,
          role: "assistant",
          parts: [
            Prompt.toolCallPart({
              id,
              name: "read",
              params: { path: id },
              providerExecuted: false,
            }),
          ],
          createdAt: dateFromMillis(createdAt.getTime() + index * 2 + 1),
        })
        const result = Message.cases.regular.make({
          id: MessageId.make(`mid-result-${index + 1}`),
          sessionId,
          branchId,
          role: "tool",
          parts: [
            Prompt.toolResultPart({
              id,
              name: "read",
              isFailure: false,
              providerExecuted: false,
              result: { value: `mid-result-${index + 1} ${"x".repeat(2_800)}` },
            }),
          ],
          createdAt: dateFromMillis(createdAt.getTime() + index * 2 + 2),
        })
        return [call, result]
      }).flat()
      // A 6k window minus the output reserve: one step fits, the turn does not.
      const budget = ModelContextBudget.make({
        contextLimitTokens: 6_000,
        reservedSystemTokens: 0,
        reservedToolTokens: 0,
        reservedOutputTokens: MODEL_OUTPUT_RESERVE_TOKENS,
      })
      const requests: Array<CompactionRequest> = []
      const compactor = Layer.succeed(
        ModelContextCompactor,
        ModelContextCompactor.of({
          compact: (request) => {
            requests.push(request)
            return Effect.succeed({
              notice: "mid-turn bounded summary",
              modelId: modelIdTurnWindow,
            })
          },
        }),
      )
      const persisted: Array<Message> = []
      const publisher = yield* recordingPublisher

      const { durableMessages, compacted } = yield* projectContextWindow({
        sessionId,
        branchId,
        modelId: modelIdTurnWindow,
        messages: [prompt, ...steps],
        budget,
        directive: Option.none(),
        project: projectWith(budget),
        persist: (message) => {
          persisted.push(message)
          return Effect.succeed(message)
        },
        summaryModel,
        // oxlint-disable-next-line effect/noInlineProvide -- The compactor and publisher are created by this test.
      }).pipe(Effect.provide(Layer.mergeAll(compactor, publisher.layer)))

      expect(compacted).toBe(true)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.history.map((message) => message.id)).toEqual([
        prompt.id,
        ...steps.slice(0, 6).map((message) => message.id),
      ])
      expect(requests[0]?.kept.map((message) => message.id)).toEqual([
        MessageId.make("mid-call-4"),
        MessageId.make("mid-result-4"),
      ])

      const markers = durableMessages.filter(
        (message) => message.metadata?.customType === "context-window",
      )
      expect(markers).toHaveLength(1)
      expect(persisted).toEqual(markers)
      const marker = markers[0]
      if (Predicate.isUndefined(marker)) return yield* Effect.die("marker missing")
      const details = Option.getOrThrow(windowDetails(marker))
      expect(details.keepFromMessageId).toBe(MessageId.make("mid-call-4"))
      expect(details.summarized?.firstMessageId).toBe(prompt.id)
      expect(details.summarized?.lastMessageId).toBe(MessageId.make("mid-result-3"))
      expect(details.summarized?.count).toBe(7)
      // Every message stays durable; the model view starts at the marker.
      expect(durableMessages.slice(0, -1)).toEqual([prompt, ...steps])
      const view = yield* projectWith(budget)(messagesInCurrentWindow(durableMessages))
      const callIds = view.messages.flatMap((message) =>
        message.parts.filter((part) => part.type === "tool-call").map((part) => part.id),
      )
      expect(callIds).toEqual([ToolCallId.make("mid-call-4")])
      expect(
        view.messages.some((message) =>
          message.parts.some(
            (part) => part.type === "text" && part.text.includes("mid-turn bounded summary"),
          ),
        ),
      ).toBe(true)
      expect(yield* Ref.get(publisher.published)).toEqual([])
    }),
  )

  it.scopedLive("a failing compactor truncates the window and names the omission", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("degrade-session")
      const branchId = BranchId.make("degrade-branch")
      const roles: ReadonlyArray<"user" | "assistant"> = ["user", "assistant"]
      // Older history that overflows the small window several times over.
      const history = Array.from({ length: 12 }, (_, ordinal) =>
        Message.cases.regular.make({
          id: MessageId.make(`old-${ordinal}`),
          sessionId,
          branchId,
          role: Option.getOrElse(Option.fromUndefinedOr(roles[ordinal % 2]), () => "user"),
          parts: [Prompt.textPart({ text: `old-${ordinal} ${"x".repeat(40_000)}` })],
          createdAt: dateFromMillis(1_000 + ordinal),
        }),
      )
      const current = Message.cases.regular.make({
        id: MessageId.make("continue"),
        sessionId,
        branchId,
        role: "user",
        parts: [Prompt.textPart({ text: "continue" })],
        createdAt,
      })
      const budget = ModelContextBudget.make({
        contextLimitTokens: 40_000,
        reservedSystemTokens: 0,
        reservedToolTokens: 0,
        reservedOutputTokens: MODEL_OUTPUT_RESERVE_TOKENS,
      })
      /** A compactor whose summary model is down; the seam contract says the turn degrades. */
      const failingCompactor = Layer.succeed(
        ModelContextCompactor,
        ModelContextCompactor.of({
          compact: (request) =>
            Effect.fail(
              new ModelCompactionError({
                modelId: request.modelId,
                reason: "SummaryGenerationFailed",
              }),
            ),
        }),
      )
      const persisted: Array<Message> = []
      const publisher = yield* recordingPublisher

      const messages = [...history, current]
      const { durableMessages, compacted } = yield* projectContextWindow({
        sessionId,
        branchId,
        modelId: modelIdTurnWindow,
        messages,
        budget,
        directive: Option.none(),
        project: projectWith(budget),
        persist: (message) => {
          persisted.push(message)
          return Effect.succeed(message)
        },
        summaryModel,
        // oxlint-disable-next-line effect/noInlineProvide -- The compactor and publisher are created by this test.
      }).pipe(Effect.provide(Layer.mergeAll(failingCompactor, publisher.layer)))

      expect(compacted).toBe(false)
      expect(persisted).toEqual([])
      expect(durableMessages).toEqual(messages)
      expect(
        durableMessages.some((message) => message.metadata?.customType === "context-window"),
      ).toBe(false)
      const omitted = (yield* projectWith(budget)(messages)).omittedMessageIds.length
      expect(omitted).toBeGreaterThan(0)
      const notices = (yield* Ref.get(publisher.published)).filter(
        (event) => event._tag === "ErrorOccurred",
      )
      expect(notices).toHaveLength(1)
      expect(notices[0]?.error).toContain("Context compaction failed (SummaryGenerationFailed)")
      expect(notices[0]?.error).toContain(`continuing with ${omitted} older messages omitted`)
    }),
  )
})

// ── ../providers/ai-transcript.test ─────────────────────────────────────────

const BoundedToolResult = Schema.Struct({
  truncated: Schema.Boolean,
  totalChars: Schema.Finite,
  read: Schema.String,
  text: Schema.String,
})

const baseMessage = (
  message: Omit<Parameters<typeof Message.cases.regular.make>[0], "createdAt">,
) =>
  Message.cases.regular.make({
    ...message,
    createdAt: dateFromMillis(0),
  })

const baseInterjectionMessage = (
  message: Omit<Parameters<typeof Message.cases.interjection.make>[0], "createdAt">,
) =>
  Message.cases.interjection.make({
    ...message,
    createdAt: dateFromMillis(0),
  })

describe("AI transcript projection", () => {
  test("oversized tool results reach the model as head-plus-tail text while the message keeps the full result", () => {
    const full = "x".repeat(maximumModelToolResultChars + 500)
    const part = Prompt.toolResultPart({
      id: ToolCallId.make("tc-big"),
      name: "bash",
      isFailure: false,
      providerExecuted: false,
      result: { output: full },
    })
    const message = baseMessage({
      id: MessageId.make("tool-big"),
      sessionId: SessionId.make("session"),
      branchId: BranchId.make("branch"),
      role: "tool",
      parts: [part],
    })

    const [promptMessage] = toPromptMessages([message])
    expect(promptMessage).toMatchObject({
      role: "tool",
      content: [{ id: "tc-big", name: "bash", result: { truncated: true } }],
    })
    const bounded = boundToolResultForModel(part)
    const boundedResult = Schema.decodeUnknownSync(BoundedToolResult)(bounded.result)
    expect(boundedResult.truncated).toBe(true)
    expect(boundedResult.totalChars).toBe(full.length + '{"output":""}'.length)
    expect(boundedResult.text).toContain("characters truncated")
    expect(boundedResult.read).toBe('context.read("tc-big", { offset, limit })')
    expect(maximumModelToolResultChars).toBe(8_000)
    expect(boundedResult.text.length).toBeLessThan(full.length)
    // The stored part is unchanged and small results pass through untouched.
    expect(message.parts[0]).toEqual(part)
    const small = Prompt.toolResultPart({ ...part, result: { output: "short" } })
    expect(boundToolResultForModel(small)).toEqual(small)
  })

  test("a bounded command result keeps its head and its tail", () => {
    const lineCount = 4000
    const stdout = Array.from({ length: lineCount }, (_, index) => `line ${index + 1}`).join("\n")
    const bounded = boundToolResultForModel(
      Prompt.toolResultPart({
        id: ToolCallId.make("tc-bash"),
        name: "bash",
        isFailure: false,
        providerExecuted: false,
        result: { stdout, stderr: "", exitCode: 0 },
      }),
    )
    const boundedResult = Schema.decodeUnknownSync(BoundedToolResult)(bounded.result)
    expect(boundedResult.truncated).toBe(true)
    expect(boundedResult.read).toBe('context.read("tc-bash", { offset, limit })')
    expect(boundedResult.text.length).toBeLessThan(stdout.length)
    expect(boundedResult.text).toContain('{"stdout":"line 1\\nline 2')
    expect(boundedResult.text).toContain(`line ${lineCount}`)
  })

  test("converts visible Gent messages to Effect Prompt messages without Gent metadata", () => {
    const prompt = toPrompt(
      [
        baseMessage({
          id: MessageId.make("system-msg"),
          sessionId: SessionId.make("session"),
          branchId: BranchId.make("branch"),
          role: "system",
          parts: [Prompt.textPart({ text: "Be precise." })],
        }),
        baseInterjectionMessage({
          id: MessageId.make("user-msg"),
          sessionId: SessionId.make("session"),
          branchId: BranchId.make("branch"),
          role: "user",
          metadata: { hidden: false, extensionId: ExtensionId.make("inline-image") },
          parts: [
            Prompt.textPart({ text: "What is this?" }),
            Prompt.filePart({
              data: "data:image/jpeg;base64,abc",
              mediaType: "image/jpeg",
            }),
          ],
        }),
        baseMessage({
          id: MessageId.make("assistant-msg"),
          sessionId: SessionId.make("session"),
          branchId: BranchId.make("branch"),
          role: "assistant",
          turnDurationMs: 12,
          parts: [
            Prompt.reasoningPart({ text: "Inspect image first." }),
            Prompt.textPart({ text: "I see it." }),
            Prompt.filePart({
              data: "data:image/png;base64,assistant-image",
              mediaType: "image/png",
            }),
            Prompt.toolCallPart({
              id: ToolCallId.make("tc-1"),
              name: "describe",
              params: { image: true },
              providerExecuted: false,
            }),
          ],
        }),
        baseMessage({
          id: MessageId.make("tool-msg"),
          sessionId: SessionId.make("session"),
          branchId: BranchId.make("branch"),
          role: "tool",
          parts: [
            Prompt.toolResultPart({
              id: ToolCallId.make("tc-1"),
              name: "describe",
              isFailure: false,
              providerExecuted: false,
              result: { label: "diagram" },
            }),
            Prompt.toolApprovalResponsePart({
              approvalId: "approval-1",
              approved: true,
            }),
          ],
        }),
      ],
      { systemPrompt: "Global policy." },
    )

    expect(prompt.content.map((message) => message.role)).toEqual([
      "system",
      "system",
      "user",
      "assistant",
      "tool",
    ])
    expect(prompt.content[0]?.content).toBe("Global policy.")
    expect(prompt.content[1]?.content).toBe("Be precise.")

    const userMessage = prompt.content[2]
    expect(userMessage?.role).toBe("user")
    if (userMessage?.role === "user") {
      expect(userMessage.content[1]).toEqual(
        expect.objectContaining({
          type: "file",
          data: "data:image/jpeg;base64,abc",
          mediaType: "image/jpeg",
        }),
      )
    }

    const assistantMessage = prompt.content[3]
    expect(assistantMessage?.role).toBe("assistant")
    if (assistantMessage?.role === "assistant") {
      expect(assistantMessage.content.map((part) => part.type)).toEqual([
        "reasoning",
        "text",
        "file",
        "tool-call",
      ])
      expect(assistantMessage.content[2]).toEqual(
        expect.objectContaining({
          type: "file",
          data: "data:image/png;base64,assistant-image",
          mediaType: "image/png",
        }),
      )
    }

    const toolMessage = prompt.content[4]
    expect(toolMessage?.role).toBe("tool")
    if (toolMessage?.role === "tool") {
      expect(toolMessage.content.map((part) => part.type)).toEqual([
        "tool-result",
        "tool-approval-response",
      ])
      expect(toolMessage.content[1]).toEqual(
        expect.objectContaining({
          type: "tool-approval-response",
          approvalId: "approval-1",
          approved: true,
        }),
      )
    }
  })

  test("hidden metadata excludes messages from model context unless explicitly included", () => {
    const visible = baseMessage({
      id: MessageId.make("visible"),
      sessionId: SessionId.make("session"),
      branchId: BranchId.make("branch"),
      role: "user",
      parts: [Prompt.textPart({ text: "send this" })],
    })
    const hidden = baseMessage({
      id: MessageId.make("hidden"),
      sessionId: SessionId.make("session"),
      branchId: BranchId.make("branch"),
      role: "user",
      parts: [Prompt.textPart({ text: "hide this" })],
      metadata: { hidden: true },
    })

    expect(toPromptMessages([visible, hidden]).length).toBe(1)
    expect(toPromptMessages([visible, hidden], { includeHidden: true }).length).toBe(2)
  })

  test("converts Effect Response parts back to persisted assistant and tool parts", () => {
    const parts = projectResponsePartsToMessageParts([
      Response.makePart("text", { text: "Done." }),
      Response.makePart("reasoning", { text: "Need a tool." }),
      Response.makePart("tool-call", {
        id: MessageId.make("tc-2"),
        name: "read",
        params: { path: "README.md" },
        providerExecuted: false,
      }),
      Response.makePart("file", {
        mediaType: "image/png",
        data: new Uint8Array([104, 105]),
      }),
      Response.makePart("tool-result", {
        id: MessageId.make("tc-2"),
        name: "read",
        isFailure: false,
        result: { ok: true },
        encodedResult: { ok: true },
        providerExecuted: false,
        preliminary: false,
      }),
    ])

    expect(parts.assistant.map((part) => part.type)).toEqual([
      "text",
      "reasoning",
      "tool-call",
      "file",
    ])
    expect(parts.assistant[3]).toEqual(
      expect.objectContaining({
        type: "file",
        data: "data:image/png;base64,aGk=",
        mediaType: "image/png",
      }),
    )
    expect(parts.tool).toHaveLength(1)
    expect(parts.tool[0]).toEqual(
      expect.objectContaining({
        type: "tool-result",
        id: ToolCallId.make("tc-2"),
        name: "read",
        isFailure: false,
        result: { ok: true },
      }),
    )
  })

  test("keeps Response parts canonical while deriving storage projections", () => {
    const responseParts = normalizeResponseParts([
      Response.makePart("text", { text: "Need confirmation." }),
      Response.makePart("tool-call", {
        id: MessageId.make("tc-approval"),
        name: "write_file",
        params: { path: "PLAN.md" },
        providerExecuted: false,
      }),
      Response.makePart("tool-approval-request", {
        approvalId: "approval-1",
        toolCallId: ToolCallId.make("tc-approval"),
      }),
      Response.makePart("finish", {
        reason: "tool-calls",
        usage: new Response.Usage({
          inputTokens: {
            // oxlint-disable-next-line effect/noNullish -- Keep the absent field in this schema boundary fixture.
            uncached: undefined,
            total: 12,
            // oxlint-disable-next-line effect/noNullish -- Keep the absent field in this schema boundary fixture.
            cacheRead: undefined,
            // oxlint-disable-next-line effect/noNullish -- Keep the absent field in this schema boundary fixture.
            cacheWrite: undefined,
          },
          outputTokens: {
            total: 4,
            // oxlint-disable-next-line effect/noNullish -- Keep the absent field in this schema boundary fixture.
            text: undefined,
            // oxlint-disable-next-line effect/noNullish -- Keep the absent field in this schema boundary fixture.
            reasoning: undefined,
          },
        }),
        // oxlint-disable-next-line effect/noNullish -- Keep the absent field in this schema boundary fixture.
        response: undefined,
      }),
    ])

    expect(responseParts.map((part) => part.type)).toEqual([
      "text",
      "tool-call",
      "tool-approval-request",
      "finish",
    ])

    const projection = projectResponsePartsToMessageParts(responseParts)
    expect(projection.assistant.map((part) => part.type)).toEqual([
      "text",
      "tool-call",
      "tool-approval-request",
    ])
    expect(projection.tool).toEqual([])
  })

  test("normalizes streaming deltas and round-trips assistant/tool replay with images", () => {
    const responseParts = normalizeResponseParts([
      Response.makePart("text-delta", { id: MessageId.make("text-1"), delta: "hel" }),
      Response.makePart("text-delta", { id: MessageId.make("text-2"), delta: "lo" }),
      Response.makePart("reasoning-delta", { id: MessageId.make("reason-1"), delta: "thin" }),
      Response.makePart("reasoning-delta", { id: MessageId.make("reason-2"), delta: "king" }),
      Response.makePart("tool-call", {
        id: MessageId.make("tc-3"),
        name: "inspect",
        params: { deep: true },
        providerExecuted: false,
      }),
      Response.makePart("tool-approval-request", {
        approvalId: "approval-1",
        toolCallId: ToolCallId.make("tc-3"),
      }),
      Response.makePart("file", {
        mediaType: "image/png",
        data: new Uint8Array([104, 105]),
      }),
      Response.makePart("tool-result", {
        id: MessageId.make("tc-3"),
        name: "inspect",
        isFailure: false,
        result: { ok: true },
        encodedResult: { ok: true },
        providerExecuted: false,
        preliminary: false,
      }),
    ])

    expect(responseParts.map((part) => part.type)).toEqual([
      "text",
      "reasoning",
      "tool-call",
      "tool-approval-request",
      "file",
      "tool-result",
    ])

    const projection = projectResponsePartsToMessageParts(responseParts)
    expect(projection.assistant.map((part) => part.type)).toEqual([
      "text",
      "reasoning",
      "tool-call",
      "tool-approval-request",
      "file",
    ])
    expect(projection.tool.map((part) => part.type)).toEqual(["tool-result"])
  })
})
