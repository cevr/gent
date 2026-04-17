/**
 * ResourceHost — substrate for the long-lived state declared by extension
 * Resources.
 *
 * Sequencing per `migrate-callers-then-delete-legacy-apis`:
 *
 *   - C3.1 (here): SubscriptionEngine ships; Resource shape is in the
 *     contribution union; legacy hosts (event-bus, scheduler, activation
 *     lifecycle, workflow-runtime) untouched and authoritative.
 *   - C3.2: layer migration. `collectProcessLayers` becomes the only path
 *     for Resource layers; legacy `extractLayer` deleted.
 *   - C3.3: schedule engine arrives + `Resource.schedule`. Legacy
 *     `scheduler.ts` deleted.
 *   - C3.4: lifecycle engine arrives + `Resource.start/stop`. Legacy
 *     activation.ts lifecycle path deleted.
 *   - C3.5: machine engine arrives + `Resource.machine`. Legacy
 *     workflow-runtime.ts deleted.
 *   - C3.6: bus-subscription / `ExtensionEventBus` deleted (only test
 *     callers remain by then).
 *
 * Each commit ships gate-green and counsel-reviewed.
 *
 * @module
 */

import type { Layer } from "effect"
import type { LoadedExtension } from "../../../domain/extension.js"
import type { ResourceScope, ResourceSubscription } from "../../../domain/resource.js"
import { extractResources } from "../../../domain/contribution.js"

// ── Re-exports ──

export {
  SubscriptionEngine,
  type SubscriptionHandler,
  type SubscriptionEngineService,
} from "./subscription-engine.js"

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
 * Collect every Resource layer declared by every extension. Used by the
 * server composition root to merge Resource layers into the process-scope
 * Layer.
 *
 * Today only `scope: "process"` Resources contribute to this collection;
 * cwd / session / branch Resources are routed through the per-cwd /
 * ephemeral composers (added in later commits).
 *
 * Returned layers have R/E channels erased to `never` at the boundary —
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
      .map(
        (r) =>
          // @effect-diagnostics-next-line anyUnknownInErrorContext:off — Resource layers carry their own R/E; consumers responsible for satisfying.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion
          r.layer as Layer.Layer<any>,
      ),
  )
