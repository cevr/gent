import { Effect } from "effect"

export const runMcpToolHandler = <A>(effect: Effect.Effect<A>): Promise<A> =>
  Effect.runPromise(effect)

export const runMcpFetchHandler = <A>(effect: Effect.Effect<A>): Promise<A> =>
  Effect.runPromise(effect)
