import { Effect } from "effect"

export const runEffectBoundary = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(effect)
