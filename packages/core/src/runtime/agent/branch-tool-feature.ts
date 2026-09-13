/**
 * Everything a branch-tool feature contributes to the runtime it plugs into.
 *
 * A feature whose tools hold branch-scoped state — a worker process, a
 * namespace, a dispatch log — installs three things that only work together:
 * the migrations creating its tables, the storage tags reading them, and the
 * factory building its per-branch services. Install one without the others and
 * the failure is silent until first use: tables with no migrations fail on
 * read, storage with no branch layer leaves the tools unbuilt.
 *
 * Binding them into one value makes that impossible to get half-right, and
 * gives composition roots a single thing to name. Core takes the feature as
 * input and never looks inside it; `noBranchTools` is the honest value for a
 * deployment whose tools are all stateless.
 */

import { Context, type Effect, Layer } from "effect"
import type { BranchId, SessionId } from "../../domain/ids.js"
import type { ExtraRepositories } from "../../storage/sqlite-storage.js"
import type { FeatureMigrations } from "../../storage/schema.js"
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
 * Per-branch services a tool needs built with the loop and torn down with it:
 * a worker process, a session, a namespace. What the layer provides is erased
 * on purpose: the loop merges it into the branch context and reads only what
 * it knows to look for, such as `BranchToolWork`.
 */
export type BranchToolLayerFactory = (input: BranchToolLayerInput) => ErasedResourceLayer

interface BranchToolWorkApi {
  /** Cancel in-flight work. Must be safe to call when nothing is running. */
  readonly cancel: Effect.Effect<void>
}

/**
 * Cancellation for tool work that outlives a single call. A tool holding a
 * branch-scoped process must be told when the loop is interrupted; the turn's
 * fiber interrupt alone does not reach it. A tool with nothing to cancel does
 * not provide this, and interruption is a no-op.
 */
export class BranchToolWork extends Context.Service<BranchToolWork, BranchToolWorkApi>()(
  "@gent/core/src/runtime/agent/branch-tool-feature/BranchToolWork",
) {}

export interface BranchToolFeature<A> {
  /** Migrations creating the feature's tables, merged into core's chain. */
  readonly migrations: FeatureMigrations
  /**
   * The feature's storage tags, layered over core's SQL client. Generic in
   * the error and requirement channels so one feature serves the live,
   * memory, and test storage entries alike.
   */
  readonly storage: <E, R>(
    ...args: Parameters<ExtraRepositories<A, E, R>>
  ) => ReturnType<ExtraRepositories<A, E, R>>
  /** Per-branch services, built with the loop and torn down with it. */
  readonly branchLayer: BranchToolLayerFactory
}

/** The feature a deployment installs when its tools hold no branch state. */
export const noBranchTools: BranchToolFeature<never> = {
  migrations: {},
  storage: () => Layer.empty,
  branchLayer: () => emptyErasedResourceLayer,
}

/**
 * The branch-tool feature this runtime installs.
 *
 * A `Context.Reference`, not a required service: `noBranchTools` is a real
 * deployment (all tools stateless), not a stub that dies when used. A root
 * shipping a feature binds it; core reads it and merges what it gets.
 */
export const CurrentBranchToolFeature = Context.Reference<BranchToolFeature<never>>(
  "@gent/core/src/runtime/agent/branch-tool-feature/CurrentBranchToolFeature",
  { defaultValue: () => noBranchTools },
)
