import { Effect, type Exit } from "effect"

export const runEffectBoundary = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(effect)

export const runRuntimeEffectBoundary = <A, E, R>(
  runtime: {
    readonly runPromise: (effect: Effect.Effect<A, E, R>) => Promise<A>
  },
  effect: Effect.Effect<A, E, R>,
): Promise<A> => runtime.runPromise(effect)

export const runRuntimeExitBoundary = <A, E, R>(
  runtime: {
    readonly runPromiseExit: (effect: Effect.Effect<A, E, R>) => Promise<Exit.Exit<A, E>>
  },
  effect: Effect.Effect<A, E, R>,
): Promise<Exit.Exit<A, E>> => runtime.runPromiseExit(effect)
