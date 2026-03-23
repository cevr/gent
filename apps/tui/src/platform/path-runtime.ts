import { Effect, ManagedRuntime, Path } from "effect"

const runtime = ManagedRuntime.make(Path.layer)

const withPath = <A>(f: (path: Path.Path) => A): A =>
  runtime.runSync(
    Effect.gen(function* () {
      return f(yield* Path.Path)
    }),
  )

export const joinPath = (...parts: ReadonlyArray<string>): string =>
  withPath((path) => path.join(...parts))

export const dirnamePath = (value: string): string => withPath((path) => path.dirname(value))

export const resolvePath = (...parts: ReadonlyArray<string>): string =>
  withPath((path) => path.resolve(...parts))

export const relativePath = (from: string, to: string): string =>
  withPath((path) => path.relative(from, to))
