import type { Effect } from "effect"

export const narrowR = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> =>
  effect as Effect.Effect<A, E, never>
