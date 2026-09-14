import { describe, expect, it } from "effect-bun-test"
import { Effect, Layer, Option, Predicate, Stream } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { BranchId, MessageId, SessionId, ToolCallId } from "../../../src/domain/ids"
import { Message, dateFromMillis } from "../../../src/domain/message"
import { windowDetails } from "../../../src/runtime/model-context-window"
import {
  LanguageModelLayers,
  finishPart,
  textDeltaPart,
} from "../../../src/test-utils/language-model"
import { MessageStorage } from "../../../src/storage/message-storage"
import { ensureStorageParents } from "../../../src/test-utils"
import { ModelContextCompactorLive } from "../../../../extensions/tests/helpers/test-preset"
import { makeAgentLoopService, makeLayer, makeMessage, runAgentLoop } from "./helpers"

const promptText = (prompt: Prompt.Prompt): string =>
  prompt.content
    .flatMap((message) => {
      if (Predicate.isString(message.content)) return [message.content]
      return message.content
        .filter((part): part is Prompt.TextPart => part.type === "text")
        .map((part) => part.text)
    })
    .join("\n")

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
        expect(main).toContain("Context handoff")
        expect(main).toContain("native bounded summary")
        expect(main).toContain(`Session ${sessionId}, branch ${branchId}`)
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
      Effect.provide(makeLayer(providerLayer).pipe(Layer.provideMerge(ModelContextCompactorLive))),
      Effect.timeout("15 seconds"),
    )
  })

  it.live("a smaller agent context window hands off history the catalog window would keep", () => {
    const sessionId = SessionId.make("small-window-session")
    const branchId = BranchId.make("small-window-branch")
    // ~3,000 tokens: far under the 128k test catalog limit, over a 6k window minus reserves.
    const oldMessages = Array.from({ length: 12 }, (_, index) =>
      Message.cases.regular.make({
        id: MessageId.make(`small-old-${index + 1}`),
        sessionId,
        branchId,
        role: "assistant",
        parts: [Prompt.textPart({ text: `small-old-${index + 1} ${"x".repeat(1_000)}` })],
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
        yield* ensureStorageParents({ sessionId, branchId })
        const storage = yield* MessageStorage
        yield* Effect.forEach(oldMessages, (message) => storage.createMessage(message), {
          discard: true,
        })
        yield* runAgentLoop(agentLoop, makeMessage(sessionId, branchId, "small current turn"), {
          runSpec: { overrides: { contextLength: 6_000 } },
        })

        expect(providerCalls).toBe(2)
        const durable = yield* storage.listMessages(branchId)
        const markers = durable.filter(
          (message) => message.metadata?.customType === "context-window",
        )
        expect(markers).toHaveLength(1)
      }),
    ).pipe(
      Effect.provide(makeLayer(providerLayer).pipe(Layer.provideMerge(ModelContextCompactorLive))),
      Effect.timeout("15 seconds"),
    )
  })

  it.live("a turn whose own steps overflow hands off at a step boundary", () => {
    const sessionId = SessionId.make("mid-turn-session")
    const branchId = BranchId.make("mid-turn-branch")
    const prompt = makeMessage(sessionId, branchId, "mid-turn prompt")
    // Four completed steps of ~700 tokens each after the only user message.
    const steps = Array.from({ length: 4 }, (_, index) => {
      const id = ToolCallId.make(`mid-call-${index + 1}`)
      const call = Message.cases.regular.make({
        id: MessageId.make(`mid-call-${index + 1}`),
        sessionId,
        branchId,
        role: "assistant",
        parts: [
          Prompt.toolCallPart({ id, name: "read", params: { path: id }, providerExecuted: false }),
        ],
        createdAt: dateFromMillis(prompt.createdAt.getTime() + index * 2 + 1),
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
        createdAt: dateFromMillis(prompt.createdAt.getTime() + index * 2 + 2),
      })
      return [call, result]
    }).flat()
    let providerCalls = 0
    let mainPrompt = Option.none<Prompt.Prompt>()
    const providerLayer = LanguageModelLayers.testStream((options) => {
      providerCalls += 1
      if (providerCalls === 2) mainPrompt = Option.some(Prompt.make(options.prompt))
      let text = "mid-turn response"
      if (providerCalls === 1) text = "mid-turn bounded summary"
      return Effect.succeed(
        Stream.fromIterable([textDeltaPart(text), finishPart({ finishReason: "stop" })]),
      )
    })

    return Effect.scoped(
      Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* ensureStorageParents({ sessionId, branchId })
        const storage = yield* MessageStorage
        yield* storage.createMessage(prompt)
        yield* Effect.forEach(steps, (message) => storage.createMessage(message), {
          discard: true,
        })
        // Resumes the incomplete turn: the prompt is the newest user message.
        yield* runAgentLoop(agentLoop, prompt, {
          runSpec: { overrides: { contextLength: 6_000 } },
        })

        expect(providerCalls).toBe(2)
        if (Option.isNone(mainPrompt)) return yield* Effect.die("main prompt missing")
        const main = promptText(mainPrompt.value)
        expect(main).toContain("mid-turn bounded summary")
        const callIds = mainPrompt.value.content.flatMap((message) => {
          if (Predicate.isString(message.content)) return []
          return message.content.filter((part) => part.type === "tool-call").map((part) => part.id)
        })
        expect(callIds).toEqual(["mid-call-4"])

        const durable = yield* storage.listMessages(branchId)
        const markers = durable.filter(
          (message) => message.metadata?.customType === "context-window",
        )
        expect(markers).toHaveLength(1)
        const marker = markers[0]
        if (Predicate.isUndefined(marker)) return yield* Effect.die("marker missing")
        const details = Option.getOrThrow(windowDetails(marker))
        expect(details.keepFromMessageId).toBe(MessageId.make("mid-call-4"))
        expect(details.summarized?.firstMessageId).toBe(prompt.id)
      }),
    ).pipe(
      Effect.provide(makeLayer(providerLayer).pipe(Layer.provideMerge(ModelContextCompactorLive))),
      Effect.timeout("15 seconds"),
    )
  })
})
