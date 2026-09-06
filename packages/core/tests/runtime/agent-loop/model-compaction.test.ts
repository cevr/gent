import { describe, expect, it } from "effect-bun-test"
import { Effect, Option, Predicate, Schema, Stream } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { BranchId, MessageId, SessionId } from "@gent/core-internal/domain/ids"
import { Message, dateFromMillis } from "@gent/core-internal/domain/message"
import {
  LanguageModelLayers,
  finishPart,
  textDeltaPart,
} from "@gent/core-internal/test-utils/language-model"
import { MessageStorage } from "@gent/core-internal/storage/message-storage"
import { ensureStorageParents } from "@gent/core-internal/test-utils"
import { ModelCompactionDetails } from "../../../src/runtime/model-compaction"
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
  it.live("summarizes a bounded old range before the native provider turn", () => {
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
        expect(promptText(mainPrompt.value)).toContain("Historical context summary")
        expect(promptText(mainPrompt.value)).toContain("native current turn")

        const durable = yield* storage.listMessages(branchId)
        expect(
          durable.filter((message) => message.metadata?.customType === "model-compaction"),
        ).toHaveLength(1)
        const summary = durable.find(
          (message) => message.metadata?.customType === "model-compaction",
        )
        expect(Predicate.isNotUndefined(summary)).toBe(true)
        if (Predicate.isUndefined(summary)) return yield* Effect.die("summary missing")
        expect(Schema.is(ModelCompactionDetails)(summary.metadata?.details)).toBe(true)
        expect(durable.some((message) => message.id === oldMessages[0]?.id)).toBe(true)
      }),
    ).pipe(Effect.provide(makeLayer(providerLayer)), Effect.timeout("15 seconds"))
  })
})
