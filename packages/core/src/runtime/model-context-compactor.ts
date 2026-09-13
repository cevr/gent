/**
 * The context compaction seam.
 *
 * The loop keeps the window check and the plain omission fallback. Whether
 * older history is summarised, with what prompt, and what the summary records
 * belongs to whichever extension installs a `ModelContextCompactor` as a
 * process resource. With none installed, an overflowing transcript is simply
 * truncated. The shape of the durable summary record belongs to the
 * extension; the loop reads only the result and the error's `recoverable` flag.
 *
 * @module
 */

import { Context, type Effect, Schema, type Scope } from "effect"
import type { LanguageModel } from "effect/unstable/ai"
import type { ProviderAuthError } from "../domain/driver.js"
import type { EventStoreError } from "../domain/event.js"
import type { BranchId, SessionId } from "../domain/ids.js"
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

/** Why a summary was not produced; `recoverable` says whether the loop may go on without it. */
export class ModelCompactionError extends Schema.TaggedError<ModelCompactionError>()(
  "ModelCompactionError",
  {
    modelId: ModelId,
    reason: Schema.NonEmptyString,
    recoverable: Schema.Boolean,
  },
) {}

export const ModelCompactionResult = Schema.Struct({
  messages: Schema.Array(Message),
  projection: ModelContextProjection,
  compacted: Schema.Boolean,
  /** Newest summary revision left in the window, for status reporting. */
  revision: Schema.optional(Schema.String),
})
export type ModelCompactionResult = typeof ModelCompactionResult.Type

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
