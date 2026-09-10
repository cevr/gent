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

import { Context, Layer } from "effect"
import type { ExtraRepositories } from "../../storage/sqlite-storage.js"
import type { FeatureMigrations } from "../../storage/schema.js"
import type { BranchToolLayerFactory } from "./branch-tool-layer.js"
import { emptyErasedResourceLayer } from "../extensions/extension-effect-membrane.js"

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
