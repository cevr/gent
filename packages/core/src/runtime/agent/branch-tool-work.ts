/**
 * Cancellation for tool work that outlives a single call.
 *
 * A tool holding a branch-scoped process or session must be told when the loop
 * is interrupted; the turn's fiber interrupt alone does not reach it. A tool
 * with nothing to cancel does not provide this, and interruption is a no-op.
 *
 * Branch-scoped: built with the branch context, torn down with it.
 */

import { Context, type Effect } from "effect"

export interface BranchToolWorkApi {
  /** Cancel in-flight work. Must be safe to call when nothing is running. */
  readonly cancel: Effect.Effect<void>
}

export class BranchToolWork extends Context.Service<BranchToolWork, BranchToolWorkApi>()(
  "@gent/core/src/runtime/agent/branch-tool-work/BranchToolWork",
) {}
