import { Effect } from "effect"

export const runTestCleanupBoundary = <E>(cleanup: Effect.Effect<void, E>) =>
  Effect.runPromise(cleanup)
