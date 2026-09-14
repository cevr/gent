/**
 * The context compaction seam.
 *
 * The loop decides when a window hands off: on overflow, or when the model
 * asks. It gives the history that leaves the window to whichever extension
 * installs a `ModelContextCompactor` as a process resource and gets back the
 * notice the handoff marker carries. With none installed, an overflowing
 * transcript is simply truncated. The loop owns the marker, its ids, and the
 * transaction; the extension owns the summary prompt and the notice text.
 *
 * @module
 */

import { Context, type Effect, Schema, type Scope } from "effect"
import type { LanguageModel } from "effect/unstable/ai"
import type { ProviderAuthError } from "../domain/driver.js"
import { UsageSchema } from "../domain/event.js"
import type { BranchId, SessionId } from "../domain/ids.js"
import type { Message } from "../domain/message.js"
import { ModelId } from "../domain/model.js"
import type { ProviderError } from "../domain/provider-error.js"
import type { ModelContextBudget } from "./model-context.js"

/** Why a summary was not produced. Every failure degrades to a truncated window. */
export class ModelCompactionError extends Schema.TaggedError<ModelCompactionError>()(
  "ModelCompactionError",
  {
    modelId: ModelId,
    reason: Schema.NonEmptyString,
  },
) {}

/** What the handoff marker carries: the notice the model reads, and the receipt of producing it. */
export const CompactionSummary = Schema.Struct({
  notice: Schema.NonEmptyString,
  modelId: ModelId,
  usage: Schema.optional(UsageSchema),
})
export type CompactionSummary = typeof CompactionSummary.Type

export interface CompactionRequest {
  readonly modelId: ModelId
  readonly sessionId: SessionId
  readonly branchId: BranchId
  /** The history leaving the window, oldest first, an earlier handoff marker included. */
  readonly history: ReadonlyArray<Message>
  readonly budget: ModelContextBudget
  /** What the model asked the summary to focus on, when it asked. */
  readonly instructions?: string
  /** The admitted model for a summary bounded to `maxOutputTokens`. */
  readonly summaryModel: (
    maxOutputTokens: number,
  ) => Effect.Effect<LanguageModel.Service, ProviderError | ProviderAuthError, Scope.Scope>
}

interface ModelContextCompactorService {
  readonly compact: (
    request: CompactionRequest,
  ) => Effect.Effect<CompactionSummary, ModelCompactionError, Scope.Scope>
}

/** Installed by an extension as a process resource; absent when nothing summarises. */
export class ModelContextCompactor extends Context.Service<
  ModelContextCompactor,
  ModelContextCompactorService
>()("@gent/core/src/runtime/model-context-compactor/ModelContextCompactor") {}
