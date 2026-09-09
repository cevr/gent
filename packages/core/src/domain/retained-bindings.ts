/**
 * Names a stateful tool keeps across turns on one branch.
 *
 * A tool that holds state between calls — a namespace, a session, a workspace
 * — carries names the model expects to still be bound on the next turn.
 * Compaction records what those names hold, so a summary does not strand them.
 *
 * Core asks the question; which tool holds state, and what it calls its names,
 * is not core's business. No implementation means nothing is retained.
 */

import { Context, type Effect } from "effect"
import type { StorageError } from "./storage-error.js"
import type { BranchId, SessionId } from "./ids.js"

export interface RetainedBindingsApi {
  readonly list: (params: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
  }) => Effect.Effect<ReadonlyArray<string>, StorageError>
}

export class RetainedBindings extends Context.Service<RetainedBindings, RetainedBindingsApi>()(
  "@gent/core/src/domain/retained-bindings/RetainedBindings",
) {}
