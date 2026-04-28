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
 *   - `withNeeds([{ tag, access: "read" }])` acquires one read permit.
 *   - `withNeeds([{ tag, access: "write" }])` acquires the full write lock.
 *   - Multi-need acquisition is ordered by tag to avoid deadlock.
 *
 * Replaces string resources and replay booleans with explicit needs.
 *
 * @module
 */
import { Context, Effect, Layer, Ref, Semaphore } from "effect"
import type { ToolNeed } from "../domain/tool.js"

const READ_PERMITS = 1_000_000

/** Service interface — opaque to tools, only `withNeeds` is used. */
export interface ResourceManagerService {
  readonly withNeeds: <A, E, R>(
    needs: ReadonlyArray<ToolNeed>,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
}

export class ResourceManager extends Context.Service<ResourceManager, ResourceManagerService>()(
  "@gent/core/src/runtime/resource-manager/ResourceManager",
) {}

/** Build a fresh resource manager — one per session/loop. */
export const makeResourceManager: Effect.Effect<ResourceManagerService> = Effect.gen(function* () {
  const semaphoresRef = yield* Ref.make<ReadonlyMap<string, Semaphore.Semaphore>>(new Map())

  const acquire = (tag: string): Effect.Effect<Semaphore.Semaphore> =>
    Effect.gen(function* () {
      const existing = (yield* Ref.get(semaphoresRef)).get(tag)
      if (existing !== undefined) return existing
      const fresh = yield* Semaphore.make(READ_PERMITS)
      // Race-safe install: re-check, install only if still missing.
      const installed = yield* Ref.modify(semaphoresRef, (current) => {
        const found = current.get(tag)
        if (found !== undefined) return [found, current]
        const next = new Map(current)
        next.set(tag, fresh)
        return [fresh, next]
      })
      return installed
    })

  const normalizeNeeds = (needs: ReadonlyArray<ToolNeed>): ReadonlyArray<ToolNeed> => {
    const byTag = new Map<string, ToolNeed>()
    for (const need of needs) {
      const existing = byTag.get(need.tag)
      if (existing?.access === "write") continue
      byTag.set(need.tag, need)
    }
    return [...byTag.values()].sort((a, b) => a.tag.localeCompare(b.tag))
  }

  const withNeeds = <A, E, R>(
    needs: ReadonlyArray<ToolNeed>,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => {
    if (needs.length === 0) return effect
    const sorted = normalizeNeeds(needs)
    return Effect.gen(function* () {
      const locks: Array<readonly [Semaphore.Semaphore, ToolNeed]> = []
      for (const need of sorted) locks.push([yield* acquire(need.tag), need])
      // Nest withPermits acquisitions so all are held for the duration.
      let wrapped: Effect.Effect<A, E, R> = effect
      for (const [sem, need] of locks) {
        wrapped = sem.withPermits(need.access === "write" ? READ_PERMITS : 1)(wrapped)
      }
      return yield* wrapped
    })
  }

  return { withNeeds } satisfies ResourceManagerService
})

/** Live layer — fresh ResourceManager per scope. */
export const ResourceManagerLive = Layer.effect(ResourceManager, makeResourceManager)
