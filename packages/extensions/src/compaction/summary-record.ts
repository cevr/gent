/**
 * The durable summary record a compaction leaves in the transcript, and the
 * failure taxonomy of producing one. Owned here: the loop only sees the
 * compactor's result and an error that says whether the turn may go on.
 *
 * @module
 */

import { Option, Predicate, Schema } from "effect"
import type * as Prompt from "effect/unstable/ai/Prompt"
import { MessageId, ModelId } from "@gent/core/extensions/api"
import { type Message, UsageSchema } from "@gent/core/extensions/branch-tools"

/** `metadata.customType` of a durable summary record. */
export const MODEL_COMPACTION_MESSAGE_TYPE = "model-compaction"

/** Files the summarized history touched, carried forward across revisions. */
export const CompactionPaths = Schema.Struct({
  read: Schema.Array(Schema.String),
  modified: Schema.Array(Schema.String),
})
export type CompactionPaths = typeof CompactionPaths.Type

export const ModelCompactionDetails = Schema.TaggedStruct(MODEL_COMPACTION_MESSAGE_TYPE, {
  sourceMessageIds: Schema.Array(MessageId),
  sourceRevision: Schema.NonEmptyString,
  modelId: Schema.optional(ModelId),
  usage: Schema.optional(UsageSchema),
  paths: Schema.optional(CompactionPaths),
})
export type ModelCompactionDetails = typeof ModelCompactionDetails.Type

export const ModelCompactionFailure = Schema.TaggedUnion({
  SourceChanged: {
    expectedRevision: Schema.String,
    actualRevision: Schema.String,
  },
  SummaryGenerationFailed: {
    message: Schema.String,
  },
  SummaryEmpty: {},
  SummaryOversize: {
    estimatedTokens: Schema.Natural,
    maxTokens: Schema.Natural,
  },
  SummaryDidNotFit: {
    messageIds: Schema.Array(MessageId),
  },
  SummaryConflict: {
    messageId: MessageId,
  },
})
export type ModelCompactionFailure = typeof ModelCompactionFailure.Type

/** A summary the model could not produce is recoverable; a moved source or a conflicting summary is not. */
export const isRecoverableCompactionFailure = (failure: ModelCompactionFailure): boolean =>
  failure._tag !== "SourceChanged" && failure._tag !== "SummaryConflict"

export const isCompactionDetails = Schema.is(ModelCompactionDetails)

export const isCompactionMessage = (message: Message): boolean =>
  Predicate.isNotUndefined(message.metadata) &&
  message.metadata.customType === MODEL_COMPACTION_MESSAGE_TYPE

export const summaryText = (message: Message): string =>
  message.parts
    .filter((part): part is Prompt.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim()

/** A durable assistant record carrying valid details and a non-empty summary. */
export const isSummaryMessage = (message: Message): boolean => {
  if (!isCompactionMessage(message) || message.role !== "assistant") return false
  return isCompactionDetails(message.metadata?.details) && summaryText(message).length > 0
}

/** Newest summary revision in a window, reported to the loop for status. */
export const latestCompactionRevision = (
  messages: ReadonlyArray<Message>,
): Option.Option<string> => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (Predicate.isUndefined(message) || !isSummaryMessage(message)) continue
    const details = message.metadata?.details
    if (isCompactionDetails(details)) return Option.some(details.sourceRevision)
  }
  return Option.none()
}
