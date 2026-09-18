import { Option, Predicate, Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { UsageSchema } from "../domain/event.js"
import { type BranchId, MessageId, type SessionId } from "../domain/ids.js"
import { Message, type RuntimeUserMessageType } from "../domain/message.js"
import { ModelId } from "../domain/agent.js"

/** Custom type of the durable marker that starts a context window. */
export const CONTEXT_WINDOW_MESSAGE_TYPE: RuntimeUserMessageType = "context-window"

/** The history a handoff marker summarizes; every message in it stays durable and readable by id. */
const ContextHandoffSummary = Schema.Struct({
  firstMessageId: MessageId,
  lastMessageId: MessageId,
  count: Schema.Natural,
  modelId: Schema.optional(ModelId),
  usage: Schema.optional(UsageSchema),
})
type ContextHandoffSummary = typeof ContextHandoffSummary.Type

const ContextWindowDetails = Schema.TaggedStruct(CONTEXT_WINDOW_MESSAGE_TYPE, {
  /** The first durable message the model still sees; everything earlier leaves the projection. */
  keepFromMessageId: MessageId,
  /** Present when the marker's notice carries a summary of what left the window. */
  summarized: Schema.optional(ContextHandoffSummary),
})
type ContextWindowDetails = typeof ContextWindowDetails.Type

const isWindowDetails = Schema.is(ContextWindowDetails)

/**
 * The marker is a user message so every provider accepts it at the head of the
 * window. A bare window carries the issuer's notice; a handoff carries the
 * summary and the ids that let the model read what it replaced.
 */
export const windowMarkerMessage = (params: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly keepFromMessageId: MessageId
  readonly notice: string
  readonly summarized?: ContextHandoffSummary
  readonly createdAt: Date
}) => {
  let kind = "context-window"
  if (Predicate.isNotUndefined(params.summarized)) kind = "context-handoff"
  return Message.cases.regular.make({
    id: MessageId.make(`${kind}:${params.branchId}:${params.keepFromMessageId}`),
    sessionId: params.sessionId,
    branchId: params.branchId,
    role: "user",
    parts: [Prompt.textPart({ text: params.notice })],
    metadata: {
      customType: CONTEXT_WINDOW_MESSAGE_TYPE,
      details: ContextWindowDetails.make({
        keepFromMessageId: params.keepFromMessageId,
        summarized: params.summarized,
      }),
    },
    createdAt: params.createdAt,
  })
}

export const windowDetails = (message: Message): Option.Option<ContextWindowDetails> => {
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

/** The id of the handoff marker leading a window, when the window starts with a summary. */
export const currentHandoffId = (window: ReadonlyArray<Message>): Option.Option<MessageId> => {
  const first = Option.fromUndefinedOr(window[0])
  return Option.flatMap(first, (marker) =>
    Option.flatMap(windowDetails(marker), (details) => {
      if (Predicate.isUndefined(details.summarized)) return Option.none()
      return Option.some(marker.id)
    }),
  )
}
