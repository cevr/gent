// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-with-wrapper-helper-in-test-code` does NOT fire. A
// `tests/` tree may keep a local `withX` fixture helper, and a wrapped
// invocation is upstream `effect/noWithWrapperCall`'s to report everywhere.
import { Effect } from "effect"

declare const withPath: <A>(use: (path: string) => A) => A
declare const withBoundary: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
declare const makeEffect: () => Effect.Effect<void>

withPath((path) => path)
withBoundary(makeEffect())

export const withThing = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect
