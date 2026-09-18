import { describe, expect, it } from "effect-bun-test"
import { Effect, Layer } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { EventPublisherLive, MessageReceived, ToolCallSucceeded } from "../../../src/domain/event"
import { BranchId, MessageId, SessionId, ToolCallId } from "../../../src/domain/ids"
import { assistantMessageIdForTurn, dateFromMillis, Message } from "../../../src/domain/message"
import { EventStorage } from "../../../src/storage/event-storage"
import { MessageStorage } from "../../../src/storage/message-storage"
import { SqliteStorage } from "../../../src/storage/sqlite-storage"
import { EventStoreLive } from "../../../src/runtime/event-store-live"
import { noBranchTools } from "../../../src/runtime/agent/tools"
import { recordToolOutcome } from "../../../src/runtime/agent/turn-persistence"
import { toolResultMessageIdForTurn } from "../../../src/runtime/agent/agent-loop.utils"
import { ensureStorageParents } from "../../../src/test-utils"

const FIXED_NOW = dateFromMillis(1_767_225_600_000)

const storage = SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations)
const layer = Layer.provideMerge(
  Layer.provide(EventPublisherLive, Layer.provide(EventStoreLive, storage)),
  storage,
)

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
