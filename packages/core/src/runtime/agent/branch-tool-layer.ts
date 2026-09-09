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

import { Context, type Ref } from "effect"
import type { BranchId, SessionId } from "../../domain/ids.js"
import {
  emptyErasedResourceLayer,
  type ErasedResourceLayer,
} from "../extensions/extension-effect-membrane.js"

export interface BranchToolLayerInput {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  /** Set when the loop is interrupted, so branch work can notice and stop. */
  readonly interruptedRef: Ref.Ref<boolean>
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
