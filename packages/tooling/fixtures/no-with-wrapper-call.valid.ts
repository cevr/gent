import { Effect } from "effect"

declare const withBoundary: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
declare const withNamedBoundary: (
  name: string,
) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
declare const makeEffect: () => Effect.Effect<void>
declare const value: Effect.Effect<void>

makeEffect().pipe(withBoundary)
makeEffect().pipe(withNamedBoundary("tool"))
withBoundary(value)
withNamedBoundary("tool")(value)
