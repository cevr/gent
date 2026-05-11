/**
 * ResourceManager — lazily-created read/write locks for cross-tool exclusion.
 *
 * Tools declare which service/resource needs they touch. Reads for the same
 * tag can run together; writes exclude both reads and writes for that tag.
 *
 * Replaces the prior bash-only semaphore plus boolean serial flag with a
 * composable tag-based model:
 *
 *   - Fresh ResourceManager per ephemeral run; subagents get their own budget.
 *   - Locks are created lazily on first request — no upfront enumeration.
 *   - `withNeeds([])` is a no-op (parallel by default).
 *   - `withNeeds([{ tag, access: "read" }])` acquires a shared read lock.
 *   - `withNeeds([{ tag, access: "write" }])` acquires an exclusive write lock.
 *   - Multi-need acquisition is ordered by tag to avoid deadlock.
 *
 * Replaces string resources and replay booleans with explicit needs.
 *
 * @module
 */
import { Context, Effect, HashMap, Layer, TxReentrantLock, TxRef } from "effect"

type ResourceNeed = {
  readonly tag: string
  readonly access: "read" | "write"
}

/** Service interface — opaque to tools, only `withNeeds` is used. */
export interface ResourceManagerService {
  readonly withNeeds: <A, E, R>(
    needs: ReadonlyArray<ResourceNeed>,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
}

export class ResourceManager extends Context.Service<ResourceManager, ResourceManagerService>()(
  "@gent/core/src/runtime/resource-manager/ResourceManager",
) {}

/** Build a fresh resource manager — one per session/loop. */
export const makeResourceManager: Effect.Effect<ResourceManagerService> = Effect.gen(function* () {
  const locksRef = yield* TxRef.make(HashMap.empty<string, TxReentrantLock.TxReentrantLock>())

  const acquire = (tag: string): Effect.Effect<TxReentrantLock.TxReentrantLock> =>
    Effect.gen(function* () {
      const existing = HashMap.get(yield* TxRef.get(locksRef), tag)
      if (existing._tag === "Some") return existing.value
      const fresh = yield* TxReentrantLock.make()
      // Race-safe install: re-check, install only if still missing.
      const installed = yield* TxRef.modify(locksRef, (current) => {
        const found = HashMap.get(current, tag)
        if (found._tag === "Some") return [found.value, current]
        return [fresh, HashMap.set(current, tag, fresh)]
      })
      return installed
    })

  const normalizeNeeds = (needs: ReadonlyArray<ResourceNeed>): ReadonlyArray<ResourceNeed> => {
    const byTag = new Map<string, ResourceNeed>()
    for (const need of needs) {
      const existing = byTag.get(need.tag)
      if (existing?.access === "write") continue
      byTag.set(need.tag, need)
    }
    return [...byTag.values()].sort((a, b) => a.tag.localeCompare(b.tag))
  }

  const withNeeds = <A, E, R>(
    needs: ReadonlyArray<ResourceNeed>,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => {
    if (needs.length === 0) return effect
    const sorted = normalizeNeeds(needs)
    return Effect.gen(function* () {
      const locks: Array<readonly [TxReentrantLock.TxReentrantLock, ResourceNeed]> = []
      for (const need of sorted) locks.push([yield* acquire(need.tag), need])
      // Nest acquisitions so all locks are held for the duration.
      let wrapped: Effect.Effect<A, E, R> = effect
      for (const [sem, need] of locks) {
        wrapped =
          need.access === "write"
            ? TxReentrantLock.withWriteLock(sem, wrapped)
            : TxReentrantLock.withReadLock(sem, wrapped)
      }
      return yield* wrapped
    })
  }

  return { withNeeds } satisfies ResourceManagerService
})

/** Live layer — fresh ResourceManager per scope. */
export const ResourceManagerLive = Layer.effect(ResourceManager, makeResourceManager)
