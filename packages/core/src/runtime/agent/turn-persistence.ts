import { DateTime, Effect } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import type { AgentName as AgentNameType } from "../../domain/agent.js"
import {
  MessageReceived,
  ToolCallFailed,
  ToolCallSucceeded,
  type EventEnvelope,
} from "../../domain/event.js"
import { EventPublisher } from "../../domain/event-publisher.js"
import type { BranchId, MessageId, SessionId, ToolCallId } from "../../domain/ids.js"
import { Message } from "../../domain/message.js"
import { summarizeToolOutput, stringifyOutput } from "../../domain/tool-output.js"
import { EventStorage } from "../../storage/event-storage.js"
import { MessageStorage } from "../../storage/message-storage.js"
import { makeStorageTransaction } from "../../storage/sqlite-storage.js"

interface CommittedMutation<A> {
  readonly result: A
  readonly envelope?: EventEnvelope
}

export type AssistantResponsePart =
  | Prompt.TextPart
  | Prompt.ReasoningPart
  | Prompt.FilePart
  | Prompt.ToolCallPart
  | Prompt.ToolApprovalRequestPart

export type ToolResponsePart = Prompt.ToolResultPart | Prompt.ToolApprovalResponsePart

export const findPersistedEvent = Effect.fn("TurnHelpers.findPersistedEvent")(function* (params: {
  sessionId: SessionId
  branchId: BranchId
  match: (envelope: EventEnvelope) => boolean
}) {
  const eventStorage = yield* EventStorage
  const events = yield* eventStorage.listEvents({
    sessionId: params.sessionId,
    branchId: params.branchId,
  })
  return [...events].reverse().find(params.match)
})

export const commitWithEvent = Effect.fn("TurnHelpers.commitWithEvent")(function* <A, E, R>(
  mutation: Effect.Effect<CommittedMutation<A>, E, R>,
) {
  const eventPublisher = yield* EventPublisher
  const storageTransaction = yield* makeStorageTransaction
  const committed = yield* storageTransaction(mutation)
  if (committed.envelope !== undefined) {
    yield* eventPublisher.deliver(committed.envelope)
  }
  return committed.result
})

export const persistMessageReceived = Effect.fn("TurnHelpers.persistMessageReceived")(
  function* (params: { message: Message }) {
    const messageStorage = yield* MessageStorage
    const eventPublisher = yield* EventPublisher
    return yield* commitWithEvent(
      Effect.gen(function* () {
        const existing = yield* messageStorage.getMessage(params.message.id)
        if (existing !== undefined) {
          const envelope = yield* findPersistedEvent({
            sessionId: params.message.sessionId,
            branchId: params.message.branchId,
            match: (candidate) =>
              candidate.event._tag === "MessageReceived" &&
              candidate.event.message.id === params.message.id,
          })
          return {
            result: existing,
            ...(envelope !== undefined ? { envelope } : {}),
          }
        }

        yield* messageStorage.createMessageIfAbsent(params.message)
        const envelope = yield* eventPublisher.append(
          MessageReceived.make({
            message: params.message,
          }),
        )
        return { result: params.message, envelope }
      }),
    )
  },
)

export const recordToolResult = Effect.fn("TurnHelpers.recordToolResult")(function* (params: {
  toolResultMessageId: MessageId
  sessionId: SessionId
  branchId: BranchId
  toolCallId: ToolCallId
  toolName: string
  output: unknown
  isError?: boolean
}) {
  const messageStorage = yield* MessageStorage
  const eventPublisher = yield* EventPublisher
  const part = Prompt.toolResultPart({
    id: params.toolCallId,
    name: params.toolName,
    isFailure: params.isError === true,
    result: params.output,
  })

  const message = Message.cases.regular.make({
    id: params.toolResultMessageId,
    sessionId: params.sessionId,
    branchId: params.branchId,
    role: "tool",
    parts: [part],
    createdAt: yield* DateTime.nowAsDate,
  })

  const isError = params.isError ?? false
  const toolCallFields = {
    sessionId: params.sessionId,
    branchId: params.branchId,
    toolCallId: params.toolCallId,
    toolName: params.toolName,
    summary: summarizeToolOutput(part),
    output: stringifyOutput(part.result),
  }

  yield* commitWithEvent(
    Effect.gen(function* () {
      const existing = yield* messageStorage.getMessage(message.id)
      if (existing !== undefined) {
        const envelope = yield* findPersistedEvent({
          sessionId: params.sessionId,
          branchId: params.branchId,
          match: (candidate) =>
            (candidate.event._tag === "ToolCallSucceeded" ||
              candidate.event._tag === "ToolCallFailed") &&
            candidate.event.toolCallId === params.toolCallId,
        })
        return {
          result: existing,
          ...(envelope !== undefined ? { envelope } : {}),
        }
      }

      const result = yield* messageStorage.createMessageIfAbsent(message)
      const envelope = yield* eventPublisher.append(
        isError ? ToolCallFailed.make(toolCallFields) : ToolCallSucceeded.make(toolCallFields),
      )
      return { result, envelope }
    }),
  )
})

export const persistMessageParts = Effect.fn("TurnHelpers.persistMessageParts")(function* (params: {
  sessionId: SessionId
  branchId: BranchId
  messageId: MessageId
  role: "assistant" | "tool"
  parts: ReadonlyArray<Message["parts"][number]>
  createdAt?: Date
}) {
  if (params.parts.length === 0) return undefined

  const messageStorage = yield* MessageStorage
  const message = Message.cases.regular.make({
    id: params.messageId,
    sessionId: params.sessionId,
    branchId: params.branchId,
    role: params.role,
    parts: [...params.parts],
    createdAt: params.createdAt ?? (yield* DateTime.nowAsDate),
  })

  const existing = yield* messageStorage.getMessage(message.id)
  if (existing !== undefined) return existing

  return yield* persistMessageReceived({ message })
})

export const persistAssistantParts = (params: {
  sessionId: SessionId
  branchId: BranchId
  messageId: MessageId
  parts: ReadonlyArray<AssistantResponsePart>
  createdAt?: Date
  agentName: AgentNameType
}) =>
  persistMessageParts({
    sessionId: params.sessionId,
    branchId: params.branchId,
    messageId: params.messageId,
    role: "assistant",
    parts: params.parts,
    createdAt: params.createdAt,
  })

export const persistToolParts = (params: {
  sessionId: SessionId
  branchId: BranchId
  messageId: MessageId
  parts: ReadonlyArray<ToolResponsePart>
  createdAt?: Date
}) =>
  persistMessageParts({
    sessionId: params.sessionId,
    branchId: params.branchId,
    messageId: params.messageId,
    role: "tool",
    parts: params.parts,
    createdAt: params.createdAt,
  })
