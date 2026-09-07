import { describe, expect, it } from "effect-bun-test"
import { Effect, Ref, Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { tool } from "@gent/core/extensions/api"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { textStep } from "@gent/core-internal/debug/provider"
import { dateFromMillis, Message } from "@gent/core-internal/domain/message"
import { ToolCallStarted, type AgentEvent } from "@gent/core-internal/domain/event"
import { EventStorage } from "@gent/core-internal/storage/event-storage"
import { MessageStorage } from "@gent/core-internal/storage/message-storage"
import { ensureStorageParents } from "@gent/core-internal/test-utils"
import { BranchId, SessionId, ToolCallId } from "@gent/core-internal/domain/ids"
import {
  assistantMessageIdForTurn,
  toolResultMessageIdForTurn,
} from "../../../src/runtime/agent/agent-loop.utils"
import { makeAgentLoopService, makeLayerWithEvents, makeMessage, runAgentLoop } from "./helpers"

describe("tool projection reconciliation", () => {
  const echoTool = tool({
    id: "echo",
    description: "Echoes input",
    params: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
    execute: (params) => Effect.succeed({ text: params.text }),
  })

  it.live("fails a stale running tool projection before any new model work", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("orphan-session")
      const branchId = BranchId.make("orphan-branch")
      const toolCallId = ToolCallId.make("orphan-call")
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        textStep("never reached"),
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const messageStorage = yield* MessageStorage
          const eventStorage = yield* EventStorage
          yield* ensureStorageParents({ sessionId, branchId })
          const turn = makeMessage(sessionId, branchId, "resume me")
          const assistantMessageId = assistantMessageIdForTurn(turn.id, 1)
          // A previous host died after admitting the call: the assistant message
          // holds the tool call, the start event exists, and no result was stored.
          yield* messageStorage.createMessage(
            Message.cases.regular.make({
              id: assistantMessageId,
              sessionId,
              branchId,
              role: "assistant",
              parts: [
                Prompt.toolCallPart({
                  id: toolCallId,
                  name: "echo",
                  params: { text: "stale" },
                  providerExecuted: false,
                }),
              ],
              createdAt: dateFromMillis(1_767_225_600_000),
            }),
          )
          yield* eventStorage.appendEvent(
            ToolCallStarted.make({
              sessionId,
              branchId,
              toolCallId,
              toolName: "echo",
              input: { text: "stale" },
              assistantMessageId,
            }),
          )

          const agentLoop = yield* makeAgentLoopService
          yield* Effect.exit(runAgentLoop(agentLoop, turn))

          // The binding cannot be replayed, so the projection is closed as failed
          // and the model is not called again for this turn.
          const events = yield* Ref.get(eventsRef)
          const failed = events.find((event) => event._tag === "ToolCallFailed")
          expect(failed).toMatchObject({
            _tag: "ToolCallFailed",
            toolCallId,
            toolName: "echo",
            assistantMessageId,
          })
          expect(events.some((event) => event._tag === "StreamStarted")).toBe(false)
          expect(yield* controls.callCount).toBe(0)
          const result = yield* messageStorage.getMessage(toolResultMessageIdForTurn(turn.id, 1))
          expect(result?.parts).toMatchObject([
            { type: "tool-result", id: toolCallId, isFailure: true },
          ])
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool]))),
      )
    }),
  )
})
