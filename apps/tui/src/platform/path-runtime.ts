import { Effect, ManagedRuntime, Path } from "effect"

const runtime = ManagedRuntime.make(Path.layer)

const runPath = <A>(effect: Effect.Effect<A, never, Path.Path>): A => runtime.runSync(effect)

export const joinPath = (...parts: ReadonlyArray<string>): string =>
  runPath(
    Effect.gen(function* () {
      const path = yield* Path.Path
      return path.join(...parts)
    }),
  )

export const dirnamePath = (value: string): string =>
  runPath(
    Effect.gen(function* () {
      const path = yield* Path.Path
      return path.dirname(value)
    }),
  )

export const resolvePath = (...parts: ReadonlyArray<string>): string =>
  runPath(
    Effect.gen(function* () {
      const path = yield* Path.Path
      return path.resolve(...parts)
    }),
  )

export const relativePath = (from: string, to: string): string =>
  runPath(
    Effect.gen(function* () {
      const path = yield* Path.Path
      return path.relative(from, to)
    }),
  )
