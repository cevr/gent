import { ServiceMap, Effect, Layer, Ref, Semaphore, Path } from "effect"

export interface FileLockShape {
  readonly withLock: <A, E, R>(
    path: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
}

export class FileLockService extends ServiceMap.Service<FileLockService, FileLockShape>()(
  "@gent/core/src/domain/file-lock/FileLockService",
) {
  static layer = Layer.effect(
    FileLockService,
    Effect.gen(function* () {
      const locks = yield* Ref.make(new Map<string, Semaphore.Semaphore>())
      const pathService = yield* Path.Path

      const getLock = Effect.fn("FileLockService.getLock")(function* (filePath: string) {
        const resolved = pathService.resolve(filePath)
        const map = yield* Ref.get(locks)
        const existing = map.get(resolved)
        if (existing !== undefined) return existing
        const sem = yield* Semaphore.make(1)
        yield* Ref.update(locks, (m) => new Map([...m, [resolved, sem]]))
        return sem
      })

      return FileLockService.of({
        withLock: (path, effect) =>
          getLock(path).pipe(Effect.andThen((sem) => sem.withPermits(1)(effect))),
      })
    }),
  )
}
