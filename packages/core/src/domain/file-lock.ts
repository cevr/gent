import { Context, Effect, HashMap, Layer, Path, TxRef, TxSemaphore } from "effect"

interface LockEntry {
  readonly sem: TxSemaphore.TxSemaphore
  readonly refcount: number
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
      const locksRef = yield* TxRef.make(HashMap.empty<string, LockEntry>())
      const pathService = yield* Path.Path

      const acquire = Effect.fn("FileLockService.acquire")(function* (filePath: string) {
        const resolved = pathService.resolve(filePath)
        // Speculative TxSemaphore allocation outside the transaction;
        // only the winner gets installed, the loser is discarded.
        const fresh = yield* TxSemaphore.make(1)
        const sem = yield* TxRef.modify(locksRef, (current) => {
          const found = HashMap.get(current, resolved)
          if (found._tag === "Some") {
            const bumped: LockEntry = { sem: found.value.sem, refcount: found.value.refcount + 1 }
            return [found.value.sem, HashMap.set(current, resolved, bumped)] as const
          }
          const entry: LockEntry = { sem: fresh, refcount: 1 }
          return [fresh, HashMap.set(current, resolved, entry)] as const
        })
        return { sem, resolved }
      })

      const release = (resolved: string) =>
        TxRef.update(locksRef, (current) => {
          const found = HashMap.get(current, resolved)
          if (found._tag === "None") return current
          const next = found.value.refcount - 1
          if (next <= 0) return HashMap.remove(current, resolved)
          return HashMap.set(current, resolved, { sem: found.value.sem, refcount: next })
        })

      return FileLockService.of({
        withLock: (path, effect) =>
          Effect.acquireUseRelease(
            acquire(path),
            ({ sem }) => TxSemaphore.withPermits(sem, 1, effect),
            ({ resolved }) => release(resolved),
          ),
        currentSize: () => TxRef.get(locksRef).pipe(Effect.map((m) => HashMap.size(m))),
      })
    }),
  )
}
