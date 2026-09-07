import { DateTime, Effect, Option, Predicate, Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import type { AgentName as AgentNameType } from "../../domain/agent.js"
import {
  MessageReceived,
  ToolCallFailed,
  ToolCallSucceeded,
  type AgentEvent,
  type EventEnvelope,
} from "../../domain/event.js"
import { EventPublisher } from "../../domain/event-publisher.js"
import { MessageId, ToolCallId, type BranchId, type SessionId } from "../../domain/ids.js"
import { Message } from "../../domain/message.js"
import {
  decodeToolOutput,
  encodeToolOutput,
  summarizeToolOutput,
  stringifyOutput,
} from "../../domain/tool-output.js"
import { EventStorage } from "../../storage/event-storage.js"
import { MessageStorage } from "../../storage/message-storage.js"
import { makeStorageTransaction, type StorageTransaction } from "../../storage/sqlite-storage.js"
import { ToolCallBindingStorage } from "../../storage/tool-call-binding-storage.js"
import type { ResolvedToolCapability } from "./tool-runner.js"

type ToolTerminalEvent = Extract<
  AgentEvent,
  { readonly _tag: "ToolCallSucceeded" | "ToolCallFailed" }
>

export class ToolResultReplayError extends Schema.TaggedError<ToolResultReplayError>()(
  "ToolResultReplayError",
  {
    assistantMessageId: MessageId,
    toolCallId: ToolCallId,
    toolName: Schema.String,
    message: Schema.String,
  },
) {}

const isToolTerminalEvent: (event: AgentEvent) => event is ToolTerminalEvent = Predicate.or(
  Predicate.and(Predicate.isTagged("ToolCallSucceeded"), Schema.is(ToolCallSucceeded)),
  Predicate.and(Predicate.isTagged("ToolCallFailed"), Schema.is(ToolCallFailed)),
)

const replayResult = (event: ToolTerminalEvent): Option.Option<Prompt.ToolResultPart["result"]> => {
  if (Predicate.isNotUndefined(event.resultJson)) {
    const decoded = decodeToolOutput(event.resultJson)
    return decoded
  }
  if (Predicate.isNotUndefined(event.output)) return Option.some(event.output)
  if (Predicate.isNotUndefined(event.summary)) return Option.some(event.summary)
  return Option.some("")
}

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

export const findPersistedToolResults = Effect.fn("TurnHelpers.findPersistedToolResults")(
  function* (params: {
    sessionId: SessionId
    branchId: BranchId
    assistantMessageId: MessageId
    toolCalls: ReadonlyArray<Prompt.ToolCallPart>
  }) {
    const eventStorage = yield* EventStorage
    const events = yield* eventStorage.listEvents({
      sessionId: params.sessionId,
      branchId: params.branchId,
    })
    let assistantIndex = -1
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]?.event
      if (event?._tag === "MessageReceived" && event.message.id === params.assistantMessageId) {
        assistantIndex = index
        break
      }
    }
    if (assistantIndex === -1) return new Map<string, Prompt.ToolResultPart>()

    let nextAssistantIndex = events.length
    for (let index = assistantIndex + 1; index < events.length; index += 1) {
      const event = events[index]?.event
      if (event?._tag === "MessageReceived" && event.message.role === "assistant") {
        nextAssistantIndex = index
        break
      }
    }

    const terminalEvents = events
      .slice(assistantIndex + 1, nextAssistantIndex)
      .map((envelope) => envelope.event)
      .filter(isToolTerminalEvent)
    const results = new Map<string, Prompt.ToolResultPart>()
    for (const toolCall of params.toolCalls) {
      const event = terminalEvents.find(
        (candidate) => candidate.toolCallId === toolCall.id && candidate.toolName === toolCall.name,
      )
      if (Predicate.isUndefined(event)) continue
      const result = replayResult(event)
      if (Option.isNone(result)) {
        return yield* new ToolResultReplayError({
          assistantMessageId: params.assistantMessageId,
          toolCallId: ToolCallId.make(toolCall.id),
          toolName: toolCall.name,
          message: `Stored tool result for ${toolCall.name} has invalid structured output`,
        })
      }
      results.set(
        toolCall.id,
        Prompt.toolResultPart({
          id: toolCall.id,
          name: toolCall.name,
          isFailure: event._tag === "ToolCallFailed",
          providerExecuted: false,
          result: result.value,
        }),
      )
    }
    return results
  },
)

export const commitWithEvent = Effect.fn("TurnHelpers.commitWithEvent")(function* <A, E, R>(
  mutation: Effect.Effect<CommittedMutation<A>, E, R>,
) {
  const eventPublisher = yield* EventPublisher
  const storageTransaction = yield* makeStorageTransaction
  const committed = yield* storageTransaction(mutation)
  if (!Predicate.isUndefined(committed.envelope)) {
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
        if (!Predicate.isUndefined(existing)) {
          const envelope = yield* findPersistedEvent({
            sessionId: params.message.sessionId,
            branchId: params.message.branchId,
            match: (candidate) =>
              candidate.event._tag === "MessageReceived" &&
              candidate.event.message.id === params.message.id,
          })
          return {
            result: existing,
            envelope,
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

/**
 * Close stale running tool projections. A stored result without a terminal
 * tool event (a recovered cell, a replay failure, a host that died mid-call)
 * gets its terminal event here, before any new model work reads the transcript.
 */
export const reconcileToolProjections = Effect.fn("TurnHelpers.reconcileToolProjections")(
  function* (params: {
    sessionId: SessionId
    branchId: BranchId
    assistantMessageId: MessageId
    parts: ReadonlyArray<Prompt.ToolResultPart>
  }) {
    if (params.parts.length === 0) return
    const eventStorage = yield* EventStorage
    const eventPublisher = yield* EventPublisher
    const events = yield* eventStorage.listEvents({
      sessionId: params.sessionId,
      branchId: params.branchId,
    })
    const closed = new Set(
      events.flatMap((envelope) => {
        if (!isToolTerminalEvent(envelope.event)) return []
        return [envelope.event.toolCallId]
      }),
    )
    for (const part of params.parts) {
      const toolCallId = ToolCallId.make(part.id)
      if (closed.has(toolCallId)) continue
      const fields = {
        sessionId: params.sessionId,
        branchId: params.branchId,
        toolCallId,
        toolName: part.name,
        summary: summarizeToolOutput(part),
        output: stringifyOutput(part.result),
        resultJson: encodeToolOutput(part.result),
        assistantMessageId: params.assistantMessageId,
      }
      let terminal: AgentEvent = ToolCallSucceeded.make(fields)
      if (part.isFailure) terminal = ToolCallFailed.make(fields)
      yield* eventPublisher.publish(terminal)
      closed.add(toolCallId)
    }
  },
)

export const recordToolResult = Effect.fn("TurnHelpers.recordToolResult")(function* (params: {
  toolResultMessageId: MessageId
  assistantMessageId?: MessageId
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
    providerExecuted: false,
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
    resultJson: encodeToolOutput(part.result),
    assistantMessageId: params.assistantMessageId,
  }

  yield* commitWithEvent(
    Effect.gen(function* () {
      const existing = yield* messageStorage.getMessage(message.id)
      if (!Predicate.isUndefined(existing)) {
        const envelope = yield* findPersistedEvent({
          sessionId: params.sessionId,
          branchId: params.branchId,
          match: (candidate) =>
            isToolTerminalEvent(candidate.event) &&
            candidate.event.toolCallId === params.toolCallId,
        })
        return {
          result: existing,
          envelope,
        }
      }

      const result = yield* messageStorage.createMessageIfAbsent(message)
      let terminalEvent: AgentEvent = ToolCallSucceeded.make(toolCallFields)
      if (isError) terminalEvent = ToolCallFailed.make(toolCallFields)
      const envelope = yield* eventPublisher.append(terminalEvent)
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
  if (params.parts.length === 0) return Option.none<Message>()

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
  if (!Predicate.isUndefined(existing)) return Option.some(existing)

  return yield* persistMessageReceived({ message }).pipe(Effect.asSome)
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

/** Persist an assistant tool-call message and its immutable bindings together. */
export const persistAssistantPartsWithBindings = Effect.fn(
  "TurnHelpers.persistAssistantPartsWithBindings",
)(function* (params: {
  sessionId: SessionId
  branchId: BranchId
  messageId: MessageId
  parts: ReadonlyArray<AssistantResponsePart>
  toolBindings: ReadonlyMap<string, ResolvedToolCapability>
  storageTransaction: StorageTransaction
  createdAt?: Date
  agentName: AgentNameType
}) {
  if (params.parts.length === 0) {
    return Option.none<{ readonly message: Message; readonly inserted: boolean }>()
  }

  const messageStorage = yield* MessageStorage
  const bindingStorage = yield* ToolCallBindingStorage
  const eventPublisher = yield* EventPublisher
  const message = Message.cases.regular.make({
    id: params.messageId,
    sessionId: params.sessionId,
    branchId: params.branchId,
    role: "assistant",
    parts: [...params.parts],
    createdAt: params.createdAt ?? (yield* DateTime.nowAsDate),
  })
  const toolCalls = params.parts.filter(
    (part): part is Prompt.ToolCallPart => part.type === "tool-call",
  )
  const committed = yield* params.storageTransaction(
    Effect.gen(function* () {
      const existing = yield* messageStorage.getMessage(message.id)
      let stored: Message = message
      let inserted = false
      let envelope = Option.none<EventEnvelope>()
      if (Predicate.isUndefined(existing)) {
        stored = yield* messageStorage.createMessageIfAbsent(message)
        inserted = true
        envelope = Option.some(
          yield* eventPublisher.append(MessageReceived.make({ message: stored })),
        )
      } else {
        stored = existing
        envelope = Option.fromUndefinedOr(
          yield* findPersistedEvent({
            sessionId: params.sessionId,
            branchId: params.branchId,
            match: (candidate) =>
              candidate.event._tag === "MessageReceived" &&
              candidate.event.message.id === message.id,
          }),
        )
      }

      if (Predicate.isUndefined(existing)) {
        for (const toolCall of toolCalls) {
          const entry = params.toolBindings.get(toolCall.name)
          if (Predicate.isUndefined(entry) || Predicate.isUndefined(entry.binding)) continue
          yield* bindingStorage.save({
            assistantMessageId: message.id,
            toolCallId: ToolCallId.make(toolCall.id),
            sessionId: params.sessionId,
            branchId: params.branchId,
            binding: entry.binding,
          })
        }
      }
      return { result: { message: stored, inserted }, envelope }
    }),
  )
  if (Option.isSome(committed.envelope)) {
    yield* eventPublisher.deliver(committed.envelope.value)
  }
  return Option.some(committed.result)
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
