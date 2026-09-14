/**
 * What compaction asks of the tools on a branch.
 *
 * A tool that holds state between calls carries names the model expects to
 * still be bound on the next turn; a handoff records what they hold so it
 * does not strand them. Which tool holds state, and how it stores the answer,
 * is that tool's business: it provides this Tag from its branch layer. No
 * implementation means nothing is retained.
 */

import { Context, type Effect } from "effect"
import type { BranchId, SessionId } from "@gent/core/extensions/api"
import type { StorageError } from "@gent/core/extensions/branch-tools"

interface RetainedBindingsApi {
  readonly list: (params: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
  }) => Effect.Effect<ReadonlyArray<string>, StorageError>
}

export class RetainedBindings extends Context.Service<RetainedBindings, RetainedBindingsApi>()(
  "@gent/extensions/src/compaction/tool-contracts/RetainedBindings",
) {}
