import type { Effect } from "effect"

export const narrowR = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> =>
  // oxlint-disable-next-line effect/noAs -- The test runner provides this environment at the outer layer boundary.
  effect as Effect.Effect<A, E, never>
