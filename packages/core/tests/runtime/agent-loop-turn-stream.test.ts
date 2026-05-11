import { describe, expect, it } from "effect-bun-test"
import { Effect, Ref } from "effect"
import {
  finishPart,
  reasoningDeltaPart,
  textDeltaPart,
} from "@gent/core-internal/test-utils/language-model"
import type { AgentEvent } from "@gent/core-internal/domain/event"
import { BranchId, SessionId } from "@gent/core-internal/domain/ids"
import { MessageStorage } from "@gent/core-internal/storage/message-storage"
import {
  assistantDraftFromMessage,
  assistantMessageIdForTurn,
} from "../../src/runtime/agent/agent-loop.utils"
import {
  makeAgentLoopService,
  makeExternalLayerWithEvents,
  makeLayerWithEvents,
  makeMessage,
  runAgentLoop,
  scriptedProvider,
} from "./agent-loop/helpers"

describe("turn stream parity", () => {
  it.live("model and external turns produce the same assistant draft and lifecycle tags", () =>
    Effect.gen(function* () {
      const expectedTags = [
        "MessageReceived",
        "StreamStarted",
        "StreamChunk",
        "StreamEnded",
        "MessageReceived",
        "TurnCompleted",
      ] as const
      const modelEventsRef = yield* Ref.make<AgentEvent[]>([])
      const externalEventsRef = yield* Ref.make<AgentEvent[]>([])
      const modelDraft = yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const messageStorage = yield* MessageStorage
        const message = makeMessage(
          SessionId.make("model-parity-session"),
          BranchId.make("model-parity-branch"),
          "hello",
        )
        yield* runAgentLoop(agentLoop, message)
        const assistant = yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(assistant).toBeDefined()
        return assistantDraftFromMessage(assistant!)
      }).pipe(
        Effect.provide(
          makeLayerWithEvents(
            scriptedProvider([
              [
                reasoningDeltaPart("thinking"),
                textDeltaPart("hello from parity"),
                finishPart({
                  finishReason: "stop",
                  usage: { inputTokens: 3, outputTokens: 5 },
                }),
              ],
            ]),
            modelEventsRef,
          ),
        ),
      )
      const externalDraft = yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const messageStorage = yield* MessageStorage
        const message = makeMessage(
          SessionId.make("external-parity-session"),
          BranchId.make("external-parity-branch"),
          "hello",
        )
        yield* runAgentLoop(agentLoop, message, { agentOverride: "test-external-parity" as never })
        const assistant = yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(assistant).toBeDefined()
        return assistantDraftFromMessage(assistant!)
      }).pipe(
        Effect.provide(
          makeExternalLayerWithEvents(
            [
              reasoningDeltaPart("thinking"),
              textDeltaPart("hello from parity"),
              finishPart({
                finishReason: "stop",
                usage: { inputTokens: 3, outputTokens: 5 },
              }),
            ],
            externalEventsRef,
          ),
        ),
      )
      expect(modelDraft).toEqual(externalDraft)
      expect((yield* Ref.get(modelEventsRef)).map((event) => event._tag as string)).toEqual([
        ...expectedTags,
      ])
      expect((yield* Ref.get(externalEventsRef)).map((event) => event._tag as string)).toEqual([
        ...expectedTags,
      ])
    }),
  )
})
