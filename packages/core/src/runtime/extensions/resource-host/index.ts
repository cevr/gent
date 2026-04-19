/**
 * ResourceHost — substrate for the long-lived state declared by extension
 * Resources.
 *
 * Sequencing per `migrate-callers-then-delete-legacy-apis`:
 *
 *   - C3.1: SubscriptionEngine shipped; Resource shape in the contribution
 *     union.
 *   - C3.2: layer migration. `collectProcessLayers` is the only path for
 *     Resource layers; legacy `extractLayer` deleted.
 *   - C3.3: schedule engine arrives + `Resource.schedule`. Legacy
 *     `scheduler.ts` deleted.
 *   - C3.4 (here): `withLifecycle` weave consumes `Resource.start/stop`.
 *     Legacy `LifecycleContribution` + activation.ts lifecycle phase
 *     deleted.
 *   - C3.5: stub. workflow-runtime.ts retained as a Context.Service shim.
 *   - B11.3a (this commit): MachineEngine extracted into
 *     resource-host/machine-engine.ts; workflow-runtime.ts delegates.
 *   - B11.3c (later): WorkflowRuntime Tag deleted; MachineEngine becomes
 *     internal-only.
 *   - C3.6: bus-subscription / `ExtensionEventBus` deleted (only test
 *     callers remain by then).
 *
 * Each commit ships gate-green and counsel-reviewed.
 *
 * @module
 */

import { Effect, Exit, Layer } from "effect"
import type { LoadedExtension } from "../../../domain/extension.js"
import type {
  AnyResourceContribution,
  ResourceScope,
  ResourceSubscription,
} from "../../../domain/resource.js"
// Inline reader — `LoadedExtension.contributions.resources` is the source of
// truth after C8. Returns the raw bucket (or empty array for narrow consumers).
const extractResources = (ext: LoadedExtension): ReadonlyArray<AnyResourceContribution> =>
  ext.contributions.resources ?? []

// ── Re-exports ──

export {
  SubscriptionEngine,
  type SubscriptionHandler,
  type SubscriptionEngineService,
} from "./subscription-engine.js"

export {
  reconcileScheduledJobs,
  collectSchedules,
  type ScheduledJobCommand,
  type SchedulerFailure,
} from "./schedule-engine.js"

// ── Public host helpers ──

/**
 * Collect every subscription declared by every Resource matching one of
 * the requested scopes. Used by composition roots:
 *
 *   - server / per-cwd: `scope ∈ {"process"}` (and later `"cwd"` for cwd
 *     composer).
 *   - ephemeral (per-run): `scope ∈ {"session", "branch"}`.
 *
 * Routing by scope at the collector boundary mirrors `collectProcessLayers`
 * — session/branch subscriptions must not be installed at process scope or
 * they outlive their owning Resource.
 */
export const collectSubscriptions = (
  extensions: ReadonlyArray<LoadedExtension>,
  scopes: ReadonlyArray<ResourceScope> = ["process"],
): ReadonlyArray<ResourceSubscription> => {
  const allowed = new Set(scopes)
  return extensions.flatMap((ext) =>
    extractResources(ext)
      .filter((r) => allowed.has(r.scope))
      .flatMap((r) => r.subscriptions ?? []),
  )
}

/**
 * Build the process-scope Resource layer for a set of loaded extensions.
 *
 * Composition strategy (addresses two correctness invariants):
 *
 * 1. **Service layers in parallel** — every Resource's `layer` is merged
 *    via `Layer.mergeAll` so consumers can request any Resource's service
 *    independently. This is the parallel build path Effect uses by default.
 *
 * 2. **Lifecycle in sequence** — `start` and `stop` for each Resource are
 *    threaded through ONE sequential lifecycle layer (`Layer.effectDiscard`
 *    over an `Effect.gen` for-loop). This guarantees:
 *
 *    - Start order: declaration order across extensions, then within the
 *      Resource list of each extension.
 *    - Stop order: reverse of successful-start order, by virtue of
 *      `Effect.addFinalizer` being LIFO within a single scope.
 *    - **No `stop` for failed `start`** — if `start` returns a failed Exit,
 *      the cause is logged, the Resource is skipped, and its `stop` (if
 *      any) is NOT registered as a finalizer. Avoids `stop` running against
 *      half-initialized state — the bug pattern codex flagged in the
 *      pre-fix C3.4 review.
 *
 *    Per-Resource failure isolation: failing-start does not bring down
 *    the host. Surfacing failed-start to extension health is a follow-up
 *    (memory: project_resource_lifecycle_health_surface).
 *
 * The lifecycle layer is provided to the merged service layer via
 * `Layer.provideMerge`, so lifecycle effects observe the services they own
 * (their `A` is in the lifecycle layer's requirements channel, satisfied by
 * the merged service context).
 *
 * Today only `scope: "process"` Resources flow through here. cwd / session /
 * branch Resources route through the per-cwd / ephemeral composers (added
 * in later commits).
 */
export const buildResourceLayer = (
  extensions: ReadonlyArray<LoadedExtension>,
  scope: ResourceScope = "process",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Layer.Layer<any> => {
  const resources = extensions.flatMap((ext) =>
    extractResources(ext)
      .filter((r) => r.scope === scope)
      .map((r) => ({ extensionId: ext.manifest.id, resource: r })),
  )

  if (resources.length === 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion
    return Layer.empty as Layer.Layer<any>
  }

  // Service layers — built in parallel via `Layer.merge` reduce. R/E erased
  // to `any` to absorb heterogeneous Resource shapes; this is the same
  // convention every contribution-host uses at the merge boundary.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnyLayer = Layer.Layer<any>
  const serviceLayers = resources.reduce<AnyLayer>(
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off — heterogeneous Resource service layers; channels merged here for parallel availability.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    (acc, { resource }) => Layer.merge(acc, resource.layer as AnyLayer),
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    Layer.empty as AnyLayer,
  )

  const hasLifecycle = resources.some(
    ({ resource }) => resource.start !== undefined || resource.stop !== undefined,
  )
  if (!hasLifecycle) return serviceLayers

  // @effect-diagnostics-next-line anyUnknownInErrorContext:off — lifecycle effect threads heterogeneous Resource A/E channels; service A's are provided by serviceLayers via provideMerge below.
  const lifecycleLayer = Layer.effectDiscard(
    Effect.gen(function* () {
      // start in declaration order; track which started so stop registers only on success.
      const successfullyStarted: Array<{
        readonly extensionId: string
        readonly resource: AnyResourceContribution
      }> = []
      for (const entry of resources) {
        const { resource, extensionId } = entry
        if (resource.start !== undefined) {
          // @effect-diagnostics-next-line anyUnknownInErrorContext:off — Resource start may carry any E; failure is converted to a log + skip below.
          const exit = yield* Effect.exit(resource.start as Effect.Effect<void, unknown, unknown>)
          if (Exit.isFailure(exit)) {
            yield* Effect.logError("resource.start.failed").pipe(
              Effect.annotateLogs({ extensionId, cause: String(exit.cause) }),
            )
            continue
          }
        }
        successfullyStarted.push(entry)
      }
      // Register finalizers in start order; Scope runs them LIFO at teardown,
      // yielding reverse-of-successful-start order — the property stateful
      // teardown needs.
      for (const { resource } of successfullyStarted) {
        if (resource.stop !== undefined) {
          yield* Effect.addFinalizer(() =>
            // @effect-diagnostics-next-line anyUnknownInErrorContext:off — Resource stop A is heterogeneous; provided by serviceLayers via provideMerge.
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            (resource.stop as Effect.Effect<void, never, unknown>).pipe(
              Effect.catchCause(() => Effect.void),
            ),
          )
        }
      }
    }),
  )

  // @effect-diagnostics-next-line anyUnknownInErrorContext:off — lifecycleLayer's `unknown` requirements are satisfied by serviceLayers via provideMerge.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion
  return Layer.provideMerge(lifecycleLayer, serviceLayers) as Layer.Layer<any>
}
