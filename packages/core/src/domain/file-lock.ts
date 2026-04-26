import { Context, Effect, Layer, Path, Ref, Semaphore } from "effect"

interface LockEntry {
  readonly sem: Semaphore.Semaphore
  refcount: number
}

export interface FileLockShape {
  readonly withLock: <A, E, R>(
    path: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
  /** Number of paths currently locked or queued for lock. Refcount-bounded —
   *  drops back to 0 once all callers release. Exposed for diagnostics +
   *  regression-locking the eviction invariant. */
  readonly currentSize: () => Effect.Effect<number>
}

export class FileLockService extends Context.Service<FileLockService, FileLockShape>()(
  "@gent/core/src/domain/file-lock/FileLockService",
) {
  static layer = Layer.effect(
    FileLockService,
    Effect.gen(function* () {
      // Refcount-bounded map: an entry exists only while at least one
      // caller holds (or is waiting on) the lock. Last release evicts.
      // Map size is bounded by concurrent in-flight lock holders, not
      // by total distinct paths ever touched.
      const locks = yield* Ref.make(new Map<string, LockEntry>())
      const pathService = yield* Path.Path

      const acquireEntry = (resolved: string) =>
        Ref.modify(locks, (m) => {
          const existing = m.get(resolved)
          if (existing !== undefined) {
            existing.refcount += 1
            return [existing.sem, m] as const
          }
          // Defer Semaphore.make to the caller — it's an Effect; we
          // can't yield inside Ref.modify. Signal "needs creation"
          // with undefined and let the surrounding Effect create it.
          return [undefined, m] as const
        })

      const installEntry = (resolved: string, sem: Semaphore.Semaphore) =>
        Ref.modify(locks, (m) => {
          const existing = m.get(resolved)
          if (existing !== undefined) {
            existing.refcount += 1
            return [existing.sem, m] as const
          }
          const next = new Map(m)
          next.set(resolved, { sem, refcount: 1 })
          return [sem, next] as const
        })

      const releaseEntry = (resolved: string) =>
        Ref.update(locks, (m) => {
          const existing = m.get(resolved)
          if (existing === undefined) return m
          existing.refcount -= 1
          if (existing.refcount > 0) return m
          const next = new Map(m)
          next.delete(resolved)
          return next
        })

      const acquire = Effect.fn("FileLockService.acquire")(function* (filePath: string) {
        const resolved = pathService.resolve(filePath)
        const cached = yield* acquireEntry(resolved)
        if (cached !== undefined) return { sem: cached, resolved }
        const fresh = yield* Semaphore.make(1)
        const sem = yield* installEntry(resolved, fresh)
        return { sem, resolved }
      })

      return FileLockService.of({
        withLock: (path, effect) =>
          Effect.acquireUseRelease(
            acquire(path),
            ({ sem }) => sem.withPermits(1)(effect),
            ({ resolved }) => releaseEntry(resolved),
          ),
        currentSize: () => Ref.get(locks).pipe(Effect.map((m) => m.size)),
      })
    }),
  )
}
