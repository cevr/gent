import { test } from "bun:test"
import { Clock, Effect, Layer, Option, Predicate, Ref, Result, Schema, Stream } from "effect"
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
  modelChangeNotice,
  MODEL_OUTPUT_RESERVE_TOKENS,
  ModelCompactionError,
  ModelContextBudget,
  ModelContextCompactor,
  ModelContextError,
  type ModelContextError as ModelContextErrorValue,
  ModelContextLedger,
  ModelContextProjectionError,
  type ModelContextProjection as ModelContextProjectionValue,
  projectContextWindow,
  projectCurrentWindow,
  projectModelContext,
  toPrompt,
  toPromptMessages,
  windowDetails,
  settledMessages,
  windowMarkerMessage,
  estimateTextTokens,
} from "../../src/runtime/model-context"
import { describe, expect, it } from "effect-bun-test"
import { AgentDefinition, AgentName, Model, ModelId, ProviderId } from "../../src/domain/agent"
import {
  LanguageModelLayers,
  type SequenceStep,
  textStep,
} from "../../src/test-utils/language-model"
import { finishPart, ModelRegistry, textDeltaPart } from "../../src/runtime/provider"
import { SessionRuntime } from "../../src/runtime/session"
import { getSessionSnapshot } from "../../src/server/server"
import {
  BranchStorage,
  EventStorage,
  MessageStorage,
  SessionStorage,
} from "../../src/storage/storage"
import { baseLocalLayerWithProvider } from "../../src/test-utils/harness"
import { type AgentEvent, EventEnvelope, EventId, EventStore } from "../../src/domain/event"
import * as Response from "effect/unstable/ai/Response"

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

/** The text of each reasoning part, in order. */
const messagePartsReasoningTexts = (parts: ReadonlyArray<MessagePart>): ReadonlyArray<string> =>
  parts.flatMap((part) => {
    if (part.type !== "reasoning") return []
    return [part.text]
  })

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

  test("the prompt reuses the estimate's bound: a projection keeps the stored message objects", () => {
    const call = ToolCallId.make("big")
    const messages = [
      message("user", "user", [text("go")]),
      message("call", "assistant", [
        Prompt.toolCallPart({ id: call, name: "t", params: {}, providerExecuted: false }),
      ]),
      message("result", "tool", [
        Prompt.toolResultPart({
          id: call,
          name: "t",
          isFailure: false,
          providerExecuted: false,
          result: { stdout: "x".repeat(maximumModelToolResultChars * 4) },
        }),
      ]),
    ]
    const projection = success(projectModelContext(messages, budget(1_000_000)))
    // The bound is memoized by part object, so a copy would bound it again.
    expect(projection.messages.map((each, index) => each === messages[index])).toEqual([
      true,
      true,
      true,
    ])
    const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
    const sizes = toPrompt(projection.messages).content.flatMap((each) => {
      if (each.role !== "tool") return []
      return each.content.flatMap((part) => {
        if (part.type !== "tool-result") return []
        return [encode(part.result).length]
      })
    })
    expect(sizes).toHaveLength(1)
    expect(sizes[0]).toBeLessThanOrEqual(maximumModelToolResultChars)
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
})

// ── input cap and measured size ─────────────────────────────────────────────

describe("model input cap and measured size", () => {
  const u1 = message("u1", "user", [text("a".repeat(400))])
  const a1 = message("a1", "assistant", [text("b".repeat(400))])
  const u2 = message("u2", "user", [text("c".repeat(40))])
  const history = [u1, a1, u2]

  test("a model whose input cap is below its window projects against the cap", () => {
    const window = ModelContextBudget.make({
      contextLimitTokens: 1_000,
      reservedSystemTokens: 0,
      reservedToolTokens: 0,
      reservedOutputTokens: 100,
    })
    const capped = { ...window, inputLimitTokens: 100 }

    const uncapped = success(projectModelContext(history, window))
    const underCap = success(projectModelContext(history, capped))

    expect(uncapped.availableInputTokens).toBe(900)
    expect(uncapped.omittedMessageIds).toEqual([])
    expect(underCap.availableInputTokens).toBe(100)
    expect(underCap.omittedMessageIds).toEqual([MessageId.make("u1"), MessageId.make("a1")])
  })

  test("the messages before a measured reply count at the provider's size", () => {
    const measure = Option.some({
      replyId: MessageId.make("a1"),
      inputTokens: 2_000,
      overheadTokens: 0,
    })

    const estimated = success(projectModelContext(history, budget(10_000)))
    const measured = success(projectModelContext(history, budget(10_000), measure))

    // chars/4: 100 + 100 + 10. Measured: u1, all the request held, takes the
    // 2,000 the provider reported; the reply and what follows keep chars/4.
    expect(estimated.estimatedTokens).toBe(210)
    expect(measured.estimatedTokens).toBe(2_110)
    const tight = success(projectModelContext(history, budget(1_500), measure))
    expect(tight.omittedMessageIds).toEqual([MessageId.make("u1")])
  })

  test("a measure is taken against the overhead its own request carried", () => {
    // The measured step ran an agent with a 49,000-token system prompt; the
    // current one has none. Only the 1,000 left over were the messages before
    // the reply, so the current window counts u1 at 1,000, not 50,000.
    const measure = Option.some({
      replyId: MessageId.make("a1"),
      inputTokens: 50_000,
      overheadTokens: 49_000,
    })
    const measured = success(projectModelContext(history, budget(10_000), measure))
    // u1 at the measured 1,000; a1 (the reply, output) and u2 at chars/4.
    expect(measured.estimatedTokens).toBe(1_110)
  })

  test("a measure below the chars/4 estimate leaves the estimate as it is", () => {
    const measure = Option.some({
      replyId: MessageId.make("a1"),
      inputTokens: 10,
      overheadTokens: 0,
    })
    expect(success(projectModelContext(history, budget(10_000), measure)).estimatedTokens).toBe(210)
  })

  it.effect("a measure taken before the newest window marker is not applied", () =>
    Effect.gen(function* () {
      const marker = (keepFrom: string) =>
        windowMarkerMessage({
          sessionId,
          branchId,
          keepFromMessageId: MessageId.make(keepFrom),
          notice: "fresh window",
          createdAt,
        })
      const measure = Option.some({
        replyId: MessageId.make("a1"),
        inputTokens: 2_000,
        overheadTokens: 0,
      })
      const project = (messages: ReadonlyArray<Message>) =>
        projectCurrentWindow({
          modelId: "test/model",
          messages,
          budget: budget(10_000),
          measure,
        })

      const replyAfterMarker = yield* project([u1, marker("u1"), a1, u2])
      const replyBeforeMarker = yield* project([u1, a1, marker("a1"), u2])

      // Stored after the marker, the reply measured the marker's window.
      expect(replyAfterMarker.estimatedTokens).toBeGreaterThan(2_000)
      // Stored before it, the reply measured history the marker replaced.
      expect(replyBeforeMarker.estimatedTokens).toBeLessThan(200)
    }),
  )
})

// ── context compaction degrade ──────────────────────────────────────────────

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
      admission: { agent: agent.name },
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
      const result = yield* Effect.gen(function* () {
        yield* seedOverflowingHistory
        const runtime = yield* SessionRuntime
        yield* runtime.sendUserMessage({
          sessionId: sessionIdModelContextDegrade,
          branchId: branchIdModelContextDegrade,
          commandId: ActorCommandId.make("turn:continue"),
          content: "continue",
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
      }).pipe(Effect.provide(layer), Effect.timeout("8 seconds"))
      expect(yield* controls.callCount).toBe(1)
      // The notice text is the projection's; tests/runtime/agent/turn-window.test.ts reads it.
      // The notice is marked as one: the turn went on and completed.
      expect(result.events.filter((event) => event._tag === "ErrorOccurred")).toEqual([
        expect.objectContaining({ notice: true }),
      ])
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

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

// ── provider overflow and input cap ─────────────────────────────────────────

const wideModelId = ModelId.make("test/wide-window")
const wideAgent = AgentDefinition.make({
  name: AgentName.make("cowork"),
  model: wideModelId,
})
const sessionIdOverflow = SessionId.make("overflow-session")
const branchIdOverflow = BranchId.make("overflow-branch")
const OLD_HISTORY_MARK = "old-history-text"

/** A session with four older messages, each `size` characters of text past its mark. */
const seedHistory = (size: number) =>
  Effect.gen(function* () {
    const now = dateFromMillis(1_767_225_600_000)
    yield* (yield* SessionStorage).createSession(
      new Session({
        id: sessionIdOverflow,
        name: "Overflow Test",
        admission: { agent: wideAgent.name },
        createdAt: now,
        updatedAt: now,
      }),
    )
    yield* (yield* BranchStorage).createBranch(
      new Branch({
        id: branchIdOverflow,
        sessionId: sessionIdOverflow,
        createdAt: now,
      }),
    )
    const roles: ReadonlyArray<"user" | "assistant"> = ["user", "assistant", "user", "assistant"]
    for (const [ordinal, role] of roles.entries()) {
      yield* (yield* MessageStorage).createMessage(
        Message.cases.regular.make({
          id: MessageId.make(`short-${ordinal}`),
          sessionId: sessionIdOverflow,
          branchId: branchIdOverflow,
          role,
          parts: [Prompt.textPart({ text: `${OLD_HISTORY_MARK} ${ordinal} ${"x".repeat(size)}` })],
          createdAt: dateFromMillis(1_000 + ordinal),
        }),
      )
    }
  })

/** How OpenAI's Responses stream reports a request past the model's input cap. */
const overflowStep: SequenceStep = {
  parts: [
    Response.makePart("error", {
      error: {
        code: "context_length_exceeded",
        message:
          "Your input exceeds the context window of this model. Please adjust your input and try again.",
      },
    }),
  ],
}

/**
 * How Anthropic ends a reply the window cut off (Sonnet 4.5 and later): a
 * normal finish whose raw stop reason Effect AI maps to `"unknown"`.
 */
const windowFullStep: SequenceStep = {
  parts: [
    textDeltaPart("the first half of the"),
    finishPart({ finishReason: "unknown", usage: { inputTokens: 1_000, outputTokens: 10 } }),
  ],
  stopReason: "model_context_window_exceeded",
}

const stubCompactor = Layer.succeed(
  ModelContextCompactor,
  ModelContextCompactor.of({
    compact: (request) =>
      Effect.succeed({
        notice: "summary of the earlier work",
        modelId: request.modelId,
      }),
  }),
)

/** One turn on the seeded session; returns its events, stored messages and the requests' text. */
const runOverflowTurn = (params: {
  readonly steps: ReadonlyArray<SequenceStep>
  readonly model: Model
  readonly extraLayers: ReadonlyArray<Layer.Layer<never>>
  /** One user message per turn, sent in order. */
  readonly prompts?: ReadonlyArray<string>
  /** Characters of text in each seeded message; none come near the window by default. */
  readonly seedSize?: number
}) =>
  Effect.gen(function* () {
    const requests: Array<string> = []
    const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence(
      params.steps.map((step) => ({
        ...step,
        assertOptions: (options) => {
          requests.push(encodeJson(options.prompt.content))
        },
      })),
    )
    const layer = baseLocalLayerWithProvider(providerLayer, {
      agents: [wideAgent],
      extraLayers: [ModelRegistry.Test([params.model]), ...params.extraLayers],
    })
    const result = yield* Effect.gen(function* () {
      yield* seedHistory(params.seedSize ?? 0)
      for (const [index, content] of (params.prompts ?? ["continue"]).entries()) {
        yield* (yield* SessionRuntime).sendUserMessage({
          sessionId: sessionIdOverflow,
          branchId: branchIdOverflow,
          commandId: ActorCommandId.make(`turn:overflow:${index}`),
          content,
        })
      }
      const events = (yield* (yield* EventStorage).listEvents({
        sessionId: sessionIdOverflow,
        branchId: branchIdOverflow,
      })).map((envelope) => envelope.event)
      const durable = yield* (yield* MessageStorage).listMessages(branchIdOverflow)
      return { events, durable }
    }).pipe(Effect.provide(layer), Effect.timeout("8 seconds"))
    return { ...result, requests, calls: yield* controls.callCount }
  })

/** A 20,000-token window: the seeded 40,000-character messages overflow it. */
const smallWideModel = new Model({
  id: wideModelId,
  name: "Small Wide",
  provider: ProviderId.make("test"),
  contextLength: 20_000,
})

const wideModel = new Model({
  id: wideModelId,
  name: "Wide Window",
  provider: ProviderId.make("test"),
  contextLength: 1_000_000,
})

/** What the last turn's receipt says of its stream; none when no turn completed. */
const streamFailed = (events: ReadonlyArray<AgentEvent>) =>
  Option.fromUndefinedOr(events.findLast((event) => event._tag === "TurnCompleted")).pipe(
    Option.map((receipt) => receipt._tag === "TurnCompleted" && receipt.streamFailed === true),
  )

describe("provider overflow recovery", () => {
  it.live("a request refused as too long hands the window off once and the step runs again", () =>
    Effect.gen(function* () {
      const result = yield* runOverflowTurn({
        steps: [overflowStep, textStep("reply after handoff")],
        model: wideModel,
        extraLayers: [stubCompactor],
      })

      expect(result.calls).toBe(2)
      // The refused request carried the old history; the retry carries the summary instead.
      expect(result.requests[0]).toContain(OLD_HISTORY_MARK)
      expect(result.requests[1]).not.toContain(OLD_HISTORY_MARK)
      expect(result.requests[1]).toContain("summary of the earlier work")
      const handoff = result.durable.find((message) =>
        Option.exists(windowDetails(message), (details) =>
          Predicate.isNotUndefined(details.summarized),
        ),
      )
      expect(handoff).toBeDefined()
      // The refusal is a notice: the turn went on and answered.
      expect(result.events.filter((event) => event._tag === "ErrorOccurred")).toEqual([
        expect.objectContaining({ notice: true }),
      ])
      expect(streamFailed(result.events)).toEqual(Option.some(false))
      expect(result.durable.at(-1)?.role).toBe("assistant")
    }),
  )

  it.live("with no compactor the refused history is dropped behind a marker that says so", () =>
    Effect.gen(function* () {
      const result = yield* runOverflowTurn({
        steps: [overflowStep, textStep("reply after truncation")],
        model: wideModel,
        extraLayers: [],
      })

      expect(result.calls).toBe(2)
      expect(result.requests[1]).not.toContain(OLD_HISTORY_MARK)
      expect(result.requests[1]).toContain("provider refused the request")
      expect(streamFailed(result.events)).toEqual(Option.some(false))
    }),
  )

  it.live("a second refusal after the handoff fails the turn", () =>
    Effect.gen(function* () {
      const result = yield* runOverflowTurn({
        steps: [overflowStep, overflowStep],
        model: wideModel,
        extraLayers: [stubCompactor],
      })

      expect(result.calls).toBe(2)
      expect(streamFailed(result.events)).toEqual(Option.some(true))
      const errors = result.events.filter((event) => event._tag === "ErrorOccurred")
      expect(errors).toEqual([
        expect.objectContaining({ notice: true }),
        expect.not.objectContaining({ notice: true }),
      ])
    }),
  )

  it.live("a reply the full window cut off hands the window off and continues", () =>
    Effect.gen(function* () {
      const result = yield* runOverflowTurn({
        steps: [windowFullStep, textStep("the rest of the reply")],
        model: wideModel,
        extraLayers: [stubCompactor],
      })

      expect(result.calls).toBe(2)
      // The cut reply stays, the continuation asks for the rest, and the
      // retry carries the summary instead of the old history.
      expect(result.requests[1]).toContain("the first half of the")
      expect(result.requests[1]).toContain("full context window")
      expect(result.requests[1]).not.toContain(OLD_HISTORY_MARK)
      expect(result.requests[1]).toContain("summary of the earlier work")
      expect(result.events.filter((event) => event._tag === "ErrorOccurred")).toEqual([
        expect.objectContaining({ notice: true }),
      ])
      expect(streamFailed(result.events)).toEqual(Option.some(false))
      expect(result.durable.at(-1)?.role).toBe("assistant")
    }),
  )

  it.live("an unknown finish with no raw reason is a finished answer", () =>
    Effect.gen(function* () {
      const result = yield* runOverflowTurn({
        steps: [{ parts: windowFullStep.parts }],
        model: wideModel,
        extraLayers: [stubCompactor],
      })

      expect(result.calls).toBe(1)
      expect(result.events.some((event) => event._tag === "ErrorOccurred")).toBe(false)
    }),
  )

  it.live("a model whose input cap is below its window is budgeted against the cap", () =>
    Effect.gen(function* () {
      const capped = new Model({
        id: wideModelId,
        name: "GPT-5 shaped",
        provider: ProviderId.make("test"),
        contextLength: 400_000,
        inputLimit: 272_000,
      })
      const result = yield* runOverflowTurn({
        steps: [textStep("reply")],
        model: capped,
        extraLayers: [],
      })
      const projected = result.events.find((event) => event._tag === "ModelContextProjected")
      const available =
        projected?._tag === "ModelContextProjected" && projected.availableInputTokens
      expect(available).toBeLessThanOrEqual(272_000)
      expect(available).toBeGreaterThan(260_000)
    }),
  )

  it.live("a step's hidden output does not count toward the next request", () =>
    Effect.gen(function* () {
      const result = yield* runOverflowTurn({
        steps: [
          {
            parts: [
              textDeltaPart("short reply"),
              // 60,000 tokens of reasoning the provider never stores back.
              finishPart({
                finishReason: "stop",
                usage: { inputTokens: 1_000, outputTokens: 60_000 },
              }),
            ],
          },
          textStep("second reply"),
        ],
        model: wideModel,
        extraLayers: [],
        prompts: ["first", "second"],
      })
      const ended = result.events.find(
        (event) => event._tag === "StreamEnded" && Predicate.isNotUndefined(event.usage),
      )
      // The step records the overhead its request carried, so a later agent
      // switch cannot change what the measure means.
      expect(ended?._tag === "StreamEnded" && ended.requestOverheadTokens).toBeGreaterThan(0)
      const projected = result.events.filter((event) => event._tag === "ModelContextProjected")
      const second = projected.at(1)
      expect(second?._tag === "ModelContextProjected" && second.estimatedTokens).toBeLessThan(2_000)
    }),
  )

  it.live("a refusal after a handoff at the latest message drops the summary and runs again", () =>
    Effect.gen(function* () {
      // The seeded history overflows a 20,000-token window, so the first
      // projection hands off at the new message; the provider still refuses.
      const result = yield* runOverflowTurn({
        steps: [overflowStep, textStep("reply after the summary is dropped")],
        model: smallWideModel,
        extraLayers: [stubCompactor],
        seedSize: 40_000,
      })

      expect(result.calls).toBe(2)
      expect(result.requests[0]).toContain("summary of the earlier work")
      expect(result.requests[1]).not.toContain("summary of the earlier work")
      expect(result.requests[1]).toContain("provider refused the request")
      expect(streamFailed(result.events)).toEqual(Option.some(false))
    }),
  )

  it.live("a refusal with nothing left to drop fails the turn and says so", () =>
    Effect.gen(function* () {
      const result = yield* runOverflowTurn({
        steps: [overflowStep, overflowStep],
        model: smallWideModel,
        extraLayers: [stubCompactor],
        seedSize: 40_000,
      })

      expect(result.calls).toBe(2)
      expect(streamFailed(result.events)).toEqual(Option.some(true))
      const last = result.events.findLast((event) => event._tag === "ErrorOccurred")
      expect(last?._tag === "ErrorOccurred" && last.notice).not.toBe(true)
      expect(last?._tag === "ErrorOccurred" && last.error).toContain(
        "refused the context as too long again",
      )
    }),
  )

  it.live("the next turn counts the window at the size the provider reported", () =>
    Effect.gen(function* () {
      const result = yield* runOverflowTurn({
        steps: [
          {
            parts: [
              textDeltaPart("first reply"),
              finishPart({
                finishReason: "stop",
                usage: { inputTokens: 50_000, outputTokens: 20 },
              }),
            ],
          },
          textStep("second reply"),
        ],
        model: wideModel,
        extraLayers: [],
        prompts: ["first", "second"],
      })
      const projected = result.events.filter((event) => event._tag === "ModelContextProjected")
      expect(projected).toHaveLength(2)
      const [first, second] = projected
      // chars/4 of a short history, then the provider's 50,000 for the same messages.
      expect(first?._tag === "ModelContextProjected" && first.estimatedTokens).toBeLessThan(1_000)
      expect(second?._tag === "ModelContextProjected" && second.estimatedTokens).toBeGreaterThan(
        40_000,
      )
    }),
  )
})

// ── model context ledger ────────────────────────────────────────────────────

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

// ── model context window ────────────────────────────────────────────────────

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

  test("a line the runtime writes after the user's prompt never anchors the window", () => {
    const prompt = messageModelContextWindow("u2", "user", 3)
    const history = [
      messageModelContextWindow("u1", "user", 1),
      messageModelContextWindow("a1", "assistant", 2),
      prompt,
    ]
    const runtimeLine = (
      id: string,
      metadata: { readonly customType?: string; readonly joinedTurn?: boolean },
    ) =>
      Message.cases.regular.make({
        ...messageModelContextWindow(id, "user", 4),
        metadata,
      })
    const lines = [
      runtimeLine("notice", { customType: "model-change" }),
      runtimeLine("final", { customType: "max-steps" }),
      runtimeLine("continue", { customType: "continuation" }),
      runtimeLine("legacy-steer", { customType: "steering" }),
      runtimeLine("steer", { customType: "wake", joinedTurn: true }),
    ]
    for (const line of lines) {
      expect(latestUserMessageId([...history, line])).toEqual(Option.some(prompt.id))
    }
    expect(latestUserMessageId([...history, ...lines])).toEqual(Option.some(prompt.id))
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

// ── token estimation ────────────────────────────────────────────────────────

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
    // The stored result is ~10,000 tokens; the model sees at most 8,000 chars, locator included.
    const tokens = estimateTokens(messages)
    expect(tokens).toBeLessThanOrEqual(2_000)
    expect(tokens).toBeGreaterThan(1_900)
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

// ── turn window ─────────────────────────────────────────────────────────────

const modelIdTurnWindow = ModelId.make("test/window-model")
/** A publisher that keeps what the projection publishes, so a test can read the notice. */
const recordingPublisher = Effect.map(Ref.make<ReadonlyArray<AgentEvent>>([]), (published) => ({
  published,
  layer: Layer.succeed(
    EventStore,
    EventStore.of({
      subscribe: () => Stream.empty,
      removeSession: () => Effect.void,
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
        measure: Option.none(),
        overflowed: false,
        persist: (message) => {
          persisted.push(message)
          return Effect.succeed(message)
        },
        summaryModel,
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

  it.scopedLive(
    "a second compaction with only the marker behind the anchor asks for no summary",
    () =>
      Effect.gen(function* () {
        const sessionId = SessionId.make("recompact-session")
        const branchId = BranchId.make("recompact-branch")
        const line = (id: string, role: "user" | "assistant", ordinal: number) =>
          Message.cases.regular.make({
            id: MessageId.make(id),
            sessionId,
            branchId,
            role,
            parts: [Prompt.textPart({ text: id })],
            createdAt: dateFromMillis(1_000 + ordinal),
          })
        const prompt = line("recompact-prompt", "user", 2)
        const budget = ModelContextBudget.make({
          contextLimitTokens: 40_000,
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
              return Effect.succeed({ notice: "summary", modelId: modelIdTurnWindow })
            },
          }),
        )
        const publisher = yield* recordingPublisher
        const compact = (messages: ReadonlyArray<Message>) =>
          projectContextWindow({
            sessionId,
            branchId,
            modelId: modelIdTurnWindow,
            messages,
            budget,
            directive: Option.some(ContextDirective.cases.Compact.make({})),
            measure: Option.none(),
            overflowed: false,
            persist: (message) => Effect.succeed(message),
            summaryModel,
          }).pipe(Effect.provide(Layer.mergeAll(compactor, publisher.layer)))

        const first = yield* compact([
          line("recompact-old-0", "user", 0),
          line("recompact-old-1", "assistant", 1),
          prompt,
        ])
        expect(first.compacted).toBe(true)
        expect(requests).toHaveLength(1)
        // The same turn asks again: behind its anchor sits only the marker.
        const second = yield* compact([
          ...first.durableMessages,
          line("recompact-step", "assistant", 3),
        ])
        expect(requests).toHaveLength(1)
        expect(second.compacted).toBe(false)
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
        measure: Option.none(),
        overflowed: false,
        persist: (message) => {
          persisted.push(message)
          return Effect.succeed(message)
        },
        summaryModel,
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
      expect(notices[0]?.notice).toBe(true)
    }),
  )
})

// ── ai transcript projection ────────────────────────────────────────────────

const BoundedToolResultFields = {
  truncated: Schema.Boolean,
  totalChars: Schema.Finite,
  omittedChars: Schema.Finite,
  read: Schema.String,
}
/** A bounded result that keeps the result's shape, its long strings cut. */
const BoundedToolResult = Schema.Struct({ ...BoundedToolResultFields, result: Schema.Json })
/** A bounded result cut as JSON text. */
const BoundedToolResultText = Schema.Struct({ ...BoundedToolResultFields, text: Schema.String })
const BoundedOutput = Schema.Struct({ output: Schema.String })
const BoundedCommand = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.String,
  exitCode: Schema.Finite,
})
/** What a provider sends for a tool result: its value, JSON-encoded once. */
const encodeWire = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

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
  test("oversized tool results reach the model as head-plus-tail strings while the message keeps the full result", () => {
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
    expect(boundedResult.read).toBe('context.read("tc-big", { offset, limit })')
    expect(maximumModelToolResultChars).toBe(8_000)
    const { output } = Schema.decodeUnknownSync(BoundedOutput)(boundedResult.result)
    expect(output).toContain(`[${boundedResult.omittedChars} characters truncated]`)
    expect(encodeWire(boundedResult.result).length).toBeLessThanOrEqual(maximumModelToolResultChars)
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
    const command = Schema.decodeUnknownSync(BoundedCommand)(boundedResult.result)
    expect(command.stdout.startsWith("line 1\nline 2\n")).toBe(true)
    expect(command.stdout.endsWith(`line ${lineCount}`)).toBe(true)
    expect(command).toMatchObject({ stderr: "", exitCode: 0 })
  })

  test("a bounded result's text is encoded once on the wire, as an unbounded one is", () => {
    // Newlines, quotes and backslashes: each costs one escape per encoding.
    const line = 'const path = "C:\\\\gent"; // a "quoted" name\n'
    const stdout = line.repeat(Math.ceil((maximumModelToolResultChars * 2) / line.length))
    const part = Prompt.toolResultPart({
      id: ToolCallId.make("tc-escapes"),
      name: "bash",
      isFailure: false,
      providerExecuted: false,
      result: { stdout, stderr: "", exitCode: 0 },
    })
    const bounded = Schema.decodeUnknownSync(BoundedToolResult)(
      boundToolResultForModel(part).result,
    )
    const wire = encodeWire(bounded)
    const kept = Schema.decodeUnknownSync(BoundedCommand)(bounded.result).stdout
    expect(kept.length).toBeGreaterThan(maximumModelToolResultChars / 2)
    // The wire holds the kept text as one encoding writes it, and no second
    // encoding of it.
    expect(wire).toContain(encodeWire(kept).slice(1, -1))
    expect(wire).not.toContain('\\\\"')
    expect(wire.length).toBeLessThan(maximumModelToolResultChars + 200)
    // The locator pages the stored result's JSON text; the cut count is exact.
    expect(bounded.totalChars).toBe(encodeWire({ stdout, stderr: "", exitCode: 0 }).length)
    expect(bounded.omittedChars).toBe(
      stdout.length - kept.replace(/\n\n\.\.\. \[\d+ characters truncated\] \.\.\.\n\n/, "").length,
    )
  })

  test("a result of many short strings is cut as JSON text", () => {
    // Too long whole, yet each name far shorter than a cut can keep.
    const names = Array.from({ length: 600 }, (_, index) => `src/module-${index}/index.ts`)
    const bounded = boundToolResultForModel(
      Prompt.toolResultPart({
        id: ToolCallId.make("tc-glob"),
        name: "glob",
        isFailure: false,
        providerExecuted: false,
        result: names,
      }),
    )
    const boundedResult = Schema.decodeUnknownSync(BoundedToolResultText)(bounded.result)
    expect(boundedResult.text.startsWith('["src/module-0/index.ts","src/module-1/index.ts"')).toBe(
      true,
    )
    expect(boundedResult.text).toContain(`[${boundedResult.omittedChars} characters truncated]`)
    expect(boundedResult.text.length).toBeLessThanOrEqual(maximumModelToolResultChars)
  })

  test("the whole bounded result the model sees, paging fields included, fits the bound", () => {
    let nested: Schema.Json = { level: 0 }
    for (let level = 1; level < 800; level += 1) nested = { level, next: nested }
    const quoted = 'say "hi"\n\tthen \\leave\n'
    const results: ReadonlyArray<readonly [string, Schema.Json]> = [
      ["one long string", { output: "x".repeat(maximumModelToolResultChars * 3) }],
      ["a long escaped string", { output: quoted.repeat(maximumModelToolResultChars) }],
      ["a string result", "y".repeat(maximumModelToolResultChars * 2)],
      ["numbers", Array.from({ length: 5_000 }, (_, index) => index * 1_000)],
      ["short escaped strings", Array.from({ length: 1_000 }, () => quoted)],
      ["deep nesting", nested],
      [
        "many keys",
        Object.fromEntries(Array.from({ length: 3_000 }, (_, index) => [`key${index}`, index])),
      ],
    ]
    for (const [name, result] of results) {
      const bounded = boundToolResultForModel(
        Prompt.toolResultPart({
          id: ToolCallId.make("tc-whole-bound"),
          name: "t",
          isFailure: false,
          providerExecuted: false,
          result,
        }),
      )
      const wire = encodeWire(Schema.decodeUnknownSync(Schema.Json)(bounded.result))
      expect({ name, fits: wire.length <= maximumModelToolResultChars }).toEqual({
        name,
        fits: true,
      })
      // The bound is spent, not wasted.
      expect({ name, used: wire.length > maximumModelToolResultChars - 400 }).toEqual({
        name,
        used: true,
      })
    }
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
      { systemPrompt: ["Global policy."] },
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

  test("reasoning keeps the provider state a later step sends back", () => {
    const thinking = (signature: string): Response.ReasoningDeltaPartMetadata => ({
      anthropic: { info: { type: "thinking", signature } },
    })
    const projection = projectResponsePartsToMessageParts([
      // Anthropic: the signature arrives on a delta. Two blocks keep two signatures.
      Response.makePart("reasoning-start", { id: "0" }),
      Response.makePart("reasoning-delta", { id: "0", delta: "plan" }),
      Response.makePart("reasoning-delta", { id: "0", delta: "", metadata: thinking("sig-a") }),
      Response.makePart("reasoning-end", { id: "0" }),
      Response.makePart("reasoning-start", { id: "1" }),
      Response.makePart("reasoning-delta", { id: "1", delta: "check" }),
      Response.makePart("reasoning-delta", { id: "1", delta: "", metadata: thinking("sig-b") }),
      Response.makePart("reasoning-end", { id: "1" }),
      // OpenAI: an item with no summary text; its encrypted content arrives at the end.
      Response.makePart("reasoning-start", {
        id: "rs_1:0",
        metadata: { openai: { itemId: "rs_1" } },
      }),
      Response.makePart("reasoning-end", {
        id: "rs_1:0",
        metadata: { openai: { itemId: "rs_1", encryptedContent: "enc-1" } },
      }),
      Response.makePart("tool-call", {
        id: "call_1",
        name: "cell",
        params: {},
        providerExecuted: false,
        metadata: { openai: { itemId: "fc_1" } },
      }),
    ])
    expect(projection.assistant.map((part) => [part.type, part.options])).toEqual([
      ["reasoning", thinking("sig-a")],
      ["reasoning", thinking("sig-b")],
      ["reasoning", { openai: { itemId: "rs_1", encryptedContent: "enc-1" } }],
      ["tool-call", { openai: { itemId: "fc_1" } }],
    ])
    expect(messagePartsReasoningTexts(projection.assistant)).toEqual(["plan", "check", ""])
  })

  test("reasoning without provider state still joins into one part", () => {
    const projection = projectResponsePartsToMessageParts([
      Response.makePart("reasoning-delta", { id: "a", delta: "thin" }),
      Response.makePart("reasoning-delta", { id: "b", delta: "king" }),
      Response.makePart("reasoning-start", { id: "c" }),
      Response.makePart("reasoning-end", { id: "c" }),
    ])
    expect(projection.assistant).toEqual([Prompt.reasoningPart({ text: "thinking" })])
  })

  test("reasoning state from before a model change is not sent to the new model", () => {
    const reasoning = (label: string) =>
      Prompt.reasoningPart({
        text: label,
        options: { anthropic: { info: { type: "thinking", signature: `sig-${label}` } } },
      })
    const assistant = (id: string, label: string) =>
      message(id, "assistant", [reasoning(label), text(`${label} answer`)])
    const prompt = toPrompt([
      assistant("a-old", "old"),
      modelChangeNotice({
        sessionId,
        branchId,
        turnMessageId: MessageId.make("turn"),
        step: 2,
        previousModelId: ModelId.make("anthropic/claude-opus-5"),
        nextModelId: ModelId.make("anthropic/claude-sonnet-5"),
        createdAt,
      }),
      assistant("a-new", "new"),
    ])
    const replayed: Array<Prompt.ReasoningPart> = []
    for (const promptMessage of prompt.content) {
      if (promptMessage.role !== "assistant") continue
      for (const part of promptMessage.content) {
        if (part.type === "reasoning") replayed.push(part)
      }
    }
    expect(replayed.map((part) => [part.text, part.options])).toEqual([
      ["old", {}],
      ["new", { anthropic: { info: { type: "thinking", signature: "sig-new" } } }],
    ])
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
