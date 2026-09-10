/**
 * Branch-scoped services a tool needs built per loop.
 *
 * A tool holding state for the life of a branch — a worker process, a session,
 * a namespace — needs its layer built with the loop and torn down with it. The
 * loop builds whatever it is given here alongside its own branch services; it
 * does not know what the layer contains.
 *
 * The default builds nothing, which is correct for a deployment whose tools
 * are all stateless.
 */

import { Context } from "effect"
import type { BranchId, SessionId } from "../../domain/ids.js"
import {
  emptyErasedResourceLayer,
  type ErasedResourceLayer,
} from "../extensions/extension-effect-membrane.js"
import type { TurnInterruptionStatus } from "./turn-interruption.js"

interface BranchToolLayerInput {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  /** Lets branch work notice that the turn was interrupted, and stop. */
  readonly turnInterruption: TurnInterruptionStatus
}

/**
 * What the layer provides is erased on purpose: the loop merges it into the
 * branch context and reads only what it knows to look for, such as
 * `BranchToolWork`. Naming the services here would defeat the seam.
 */
export type BranchToolLayerFactory = (input: BranchToolLayerInput) => ErasedResourceLayer

export const BranchToolLayer = Context.Reference<BranchToolLayerFactory>(
  "@gent/core/src/runtime/agent/branch-tool-layer/BranchToolLayer",
  { defaultValue: (): BranchToolLayerFactory => () => emptyErasedResourceLayer },
)
