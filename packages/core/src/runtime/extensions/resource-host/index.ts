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
 *   - C3.5: machine engine arrives + `Resource.machine`. Legacy
 *     workflow-runtime.ts deleted.
 *   - C3.6: bus-subscription / `ExtensionEventBus` deleted (only test
 *     callers remain by then).
 *
 * Each commit ships gate-green and counsel-reviewed.
 *
 * @module
 */

import { Effect, Layer } from "effect"
import type { LoadedExtension } from "../../../domain/extension.js"
import type {
  AnyResourceContribution,
  ResourceScope,
  ResourceSubscription,
} from "../../../domain/resource.js"
import { extractResources } from "../../../domain/contribution.js"

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
    extractResources(ext.contributions)
      .filter((r) => allowed.has(r.scope))
      .flatMap((r) => r.subscriptions ?? []),
  )
}

/**
 * Wrap a Resource's `layer` with its `start` / `stop` lifecycle effects.
 *
 * Lifecycle effects can yield the Resource's owned service `A`. To give them
 * access, we compose a `Layer.effectDiscard` that depends on the Resource's
 * layer:
 *
 *   - `start` runs once when the wrapped layer is built (sequentially in
 *     the surrounding scope), with `A` provided. Start failures are logged
 *     and swallowed so the lifecycle layer carries no failure channel —
 *     this matches the pre-C3.4 `activateLoadedExtensions` behavior of
 *     isolating per-extension startup errors. Resources that need a hard
 *     failure on startup should put the failing logic in their `layer`
 *     (which fails the layer build) rather than in `start`.
 *   - `stop` is registered as a `Scope.addFinalizer` in the same scope, so
 *     it runs at scope teardown with `A` still available. Finalizer
 *     failures are swallowed via `catchCause` per Effect finalizer
 *     contract.
 *
 * If the Resource declares neither `start` nor `stop`, returns the layer
 * unchanged.
 */
const withLifecycle = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  r: AnyResourceContribution,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Layer.Layer<any> => {
  const { start, stop } = r
  if (start === undefined && stop === undefined) {
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off — Resource layers carry their own R/E.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion
    return r.layer as Layer.Layer<any>
  }
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off — lifecycle weave preserves Resource's R/E.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion
  const baseLayer = r.layer as Layer.Layer<any>
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off — heterogeneous `A`/`E` per Resource; lifecycle effect operates on `unknown` channels and is provided by `baseLayer` below.
  const lifecycleLayer = Layer.effectDiscard(
    Effect.gen(function* () {
      if (start !== undefined) {
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off — Resource start may carry any E; failures are logged + swallowed below.
        yield* (start as Effect.Effect<void, unknown, unknown>).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("resource.start.failed").pipe(
              Effect.annotateLogs({ cause: String(cause) }),
            ),
          ),
        )
      }
      if (stop !== undefined) {
        yield* Effect.addFinalizer(() =>
          // @effect-diagnostics-next-line anyUnknownInErrorContext:off — `A` is heterogeneous across Resources; lifecycle layer is provided by `baseLayer` below.
          (stop as Effect.Effect<void, never, unknown>).pipe(Effect.catchCause(() => Effect.void)),
        )
      }
    }),
  )
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off — lifecycleLayer's `unknown` requirements are satisfied by `baseLayer` via `provideMerge`.
  return Layer.provideMerge(lifecycleLayer, baseLayer)
}

/**
 * Collect every Resource layer declared by every extension, with each
 * layer's `start`/`stop` lifecycle woven in. Used by the server composition
 * root to merge Resource layers into the process-scope Layer.
 *
 * Today only `scope: "process"` Resources contribute to this collection;
 * cwd / session / branch Resources are routed through the per-cwd /
 * ephemeral composers (added in later commits).
 *
 * Returned layers have R/E channels erased to `any` at the boundary —
 * the same convention `buildExtensionLayers` uses for legacy
 * `extractLayer` results. Resources whose layers have unmet requirements
 * fail at Layer.build time (same behaviour as the legacy path).
 */
export const collectProcessLayers = (
  extensions: ReadonlyArray<LoadedExtension>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): ReadonlyArray<Layer.Layer<any>> =>
  extensions.flatMap((ext) =>
    extractResources(ext.contributions)
      .filter((r) => r.scope === "process")
      .map((r) => withLifecycle(r)),
  )
