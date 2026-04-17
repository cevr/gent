/**
 * ResourceManager — named, lazily-created semaphores for cross-tool exclusion.
 *
 * Tools declare which named resources they need (e.g. `resources: ["bash"]`,
 * `resources: ["fs-write", "git"]`). The runtime serializes execution against
 * each named resource: any two effects asking for the same name run serially,
 * effects with disjoint resource sets run in parallel.
 *
 * Pre-Phase 6 the runtime had two parallel `bashSemaphore` instances (one in
 * `actor-process.ts`, one inside `AgentLoop`) and only the bash tool's
 * `concurrency: "serial"` flag triggered them — so `edit`/`write` (also
 * declared serial) accidentally shared the bash lock instead of having their
 * own. This service replaces the boolean flag with a composable name-based
 * model:
 *
 *   - One ResourceManager per session/loop (or shared across actor + loop).
 *   - Locks are created lazily on first request — no upfront enumeration.
 *   - `withResources([])` is a no-op (parallel by default).
 *   - `withResources([name])` acquires one named permit for the duration.
 *   - `withResources([a, b])` acquires both, ordered by name to avoid deadlock.
 *
 * Replaces `concurrency: "serial" | "parallel"` (the boolean flag — violates
 * `composability-not-flags`) with `resources?: ReadonlyArray<string>`
 * (composable named locks).
 *
 * @module
 */
import { Context, Effect, Layer, Ref, Semaphore } from "effect"

/** Service interface — opaque to tools, only `withResources` is used. */
export interface ResourceManagerService {
  readonly withResources: <A, E, R>(
    names: ReadonlyArray<string>,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
}

export class ResourceManager extends Context.Service<ResourceManager, ResourceManagerService>()(
  "@gent/core/src/runtime/resource-manager/ResourceManager",
) {}

/** Build a fresh resource manager — one per session/loop. */
export const makeResourceManager: Effect.Effect<ResourceManagerService> = Effect.gen(function* () {
  const semaphoresRef = yield* Ref.make<ReadonlyMap<string, Semaphore.Semaphore>>(new Map())

  const acquire = (name: string): Effect.Effect<Semaphore.Semaphore> =>
    Effect.gen(function* () {
      const existing = (yield* Ref.get(semaphoresRef)).get(name)
      if (existing !== undefined) return existing
      const fresh = yield* Semaphore.make(1)
      // Race-safe install: re-check, install only if still missing.
      const installed = yield* Ref.modify(semaphoresRef, (current) => {
        const found = current.get(name)
        if (found !== undefined) return [found, current]
        const next = new Map(current)
        next.set(name, fresh)
        return [fresh, next]
      })
      return installed
    })

  const withResources = <A, E, R>(
    names: ReadonlyArray<string>,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => {
    if (names.length === 0) return effect
    // Sort by name to make multi-resource acquisition deadlock-free.
    const sorted = [...names].sort()
    return Effect.gen(function* () {
      const sems: Semaphore.Semaphore[] = []
      for (const name of sorted) sems.push(yield* acquire(name))
      // Nest withPermits acquisitions so all are held for the duration.
      let wrapped: Effect.Effect<A, E, R> = effect
      for (const sem of sems) wrapped = sem.withPermits(1)(wrapped)
      return yield* wrapped
    })
  }

  return { withResources } satisfies ResourceManagerService
})

/** Live layer — fresh ResourceManager per scope. */
export const ResourceManagerLive = Layer.effect(ResourceManager, makeResourceManager)
