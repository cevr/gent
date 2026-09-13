/**
 * The context compaction seam.
 *
 * The loop keeps the window check and the plain omission fallback. Whether
 * older history is summarised, with what prompt, and what the summary records
 * belongs to whichever extension installs a `ModelContextCompactor` as a
 * process resource. With none installed, an overflowing transcript is simply
 * truncated. Core still owns the shape of a durable summary record, because
 * status reporting and the TUI read it.
 *
 * @module
 */

import { Context, type Effect, Option, Predicate, Schema, type Scope } from "effect"
import type { LanguageModel } from "effect/unstable/ai"
import type * as Prompt from "effect/unstable/ai/Prompt"
import type { ProviderAuthError } from "../domain/driver.js"
import { UsageSchema, type EventStoreError } from "../domain/event.js"
import { type BranchId, MessageId, type SessionId } from "../domain/ids.js"
import { Message } from "../domain/message.js"
import { ModelId } from "../domain/model.js"
import type { ProviderError } from "../domain/provider-error.js"
import type { StorageError } from "../domain/storage-error.js"
import type { MessageStorage } from "../storage/message-storage.js"
import {
  type ModelContextBudget,
  ModelContextProjection,
  type ModelContextProjectionError,
} from "./model-context.js"

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

export class ModelCompactionError extends Schema.TaggedError<ModelCompactionError>()(
  "ModelCompactionError",
  {
    modelId: ModelId,
    failure: ModelCompactionFailure,
  },
) {}

export const ModelCompactionResult = Schema.Struct({
  messages: Schema.Array(Message),
  projection: ModelContextProjection,
  compacted: Schema.Boolean,
})
export type ModelCompactionResult = typeof ModelCompactionResult.Type

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

/** Newest summary revision in a projection, for status reporting. */
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

/** Stable digest of a message range; the loop supplies the platform hash. */
export type RevisionHash = (input: string) => string

/** Persists one summary record once and delivers its event; the loop owns the transaction. */
export type SummaryPersister = (
  message: Message,
) => Effect.Effect<Message, StorageError | EventStoreError>

export interface CompactionRequest {
  readonly modelId: ModelId
  readonly sessionId: SessionId
  readonly branchId: BranchId
  /** The current window, oldest first, with earlier summaries in place. */
  readonly messages: ReadonlyArray<Message>
  readonly budget: ModelContextBudget
  readonly hash: RevisionHash
  readonly persistSummary: SummaryPersister
  /** Summarize even when the projection fits; the model asked for it. */
  readonly force?: { readonly instructions?: string }
  /** The admitted model for a summary bounded to `maxOutputTokens`. */
  readonly summaryModel: (
    maxOutputTokens: number,
  ) => Effect.Effect<LanguageModel.Service, ProviderError | ProviderAuthError, Scope.Scope>
}

interface ModelContextCompactorService {
  readonly compact: (
    request: CompactionRequest,
  ) => Effect.Effect<
    ModelCompactionResult,
    ModelCompactionError | ModelContextProjectionError | StorageError | EventStoreError,
    MessageStorage | Scope.Scope
  >
}

/** Installed by an extension as a process resource; absent when nothing summarises. */
export class ModelContextCompactor extends Context.Service<
  ModelContextCompactor,
  ModelContextCompactorService
>()("@gent/core/src/runtime/model-context-compactor/ModelContextCompactor") {}
