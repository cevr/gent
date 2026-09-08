import { Option, Predicate, Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { type BranchId, MessageId, type SessionId } from "../domain/ids.js"
import { Message } from "../domain/message.js"

/** Custom type of the durable marker `context.newWindow()` leaves in the transcript. */
export const CONTEXT_WINDOW_MESSAGE_TYPE = "context-window"

export const ContextWindowDetails = Schema.TaggedStruct(CONTEXT_WINDOW_MESSAGE_TYPE, {
  /** The first durable message the model still sees; everything earlier leaves the projection. */
  keepFromMessageId: MessageId,
})
export type ContextWindowDetails = typeof ContextWindowDetails.Type

const isWindowDetails = Schema.is(ContextWindowDetails)

const WINDOW_NOTICE =
  "Earlier context was dropped from the model view by context.newWindow(). It stays durable: use context.read(messageId) or context.read(toolCallId) to recover any of it."

/** The marker is a user message so every provider accepts it at the head of the window. */
export const windowMarkerMessage = (params: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly keepFromMessageId: MessageId
  readonly createdAt: Date
}) =>
  Message.cases.regular.make({
    id: MessageId.make(`context-window:${params.branchId}:${params.keepFromMessageId}`),
    sessionId: params.sessionId,
    branchId: params.branchId,
    role: "user",
    parts: [Prompt.textPart({ text: WINDOW_NOTICE })],
    metadata: {
      customType: CONTEXT_WINDOW_MESSAGE_TYPE,
      details: ContextWindowDetails.make({ keepFromMessageId: params.keepFromMessageId }),
    },
    createdAt: params.createdAt,
  })

const windowDetails = (message: Message): Option.Option<ContextWindowDetails> => {
  if (message.metadata?.customType !== CONTEXT_WINDOW_MESSAGE_TYPE) return Option.none()
  const details = message.metadata.details
  if (!isWindowDetails(details)) return Option.none()
  return Option.some(details)
}

/** The newest user message anchors a window: the model keeps that unit and loses what came before. */
export const latestUserMessageId = (messages: ReadonlyArray<Message>): Option.Option<MessageId> => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (Predicate.isNotUndefined(message) && message.role === "user") {
      if (Option.isSome(windowDetails(message))) continue
      return Option.some(message.id)
    }
  }
  return Option.none()
}

/**
 * Applies the newest valid window marker: the marker leads, then every message from
 * the anchor onward. A marker whose anchor is missing is ignored so nothing is lost.
 */
export const messagesInCurrentWindow = (
  messages: ReadonlyArray<Message>,
): ReadonlyArray<Message> => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const marker = messages[index]
    if (Predicate.isUndefined(marker)) continue
    const details = windowDetails(marker)
    if (Option.isNone(details)) continue
    const anchor = messages.findIndex((message) => message.id === details.value.keepFromMessageId)
    if (anchor < 0) continue
    return [marker, ...messages.slice(anchor).filter((message) => message.id !== marker.id)]
  }
  return messages
}
