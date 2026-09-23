import { test } from "bun:test"
import { Effect, Layer, Stream } from "effect"

test("scoped cleanup is allowed", () =>
  Effect.gen(function* () {
    const value = yield* Effect.acquireRelease(
      Effect.succeed("work"),
      () => Effect.sync(() => cleanup()),
    )
    return value
  }).pipe(Effect.scoped))

// A module namespace's `catch` is an Effect combinator, not a Promise chain.
export const recovered = [
  Stream.catch(Stream.empty, () => Stream.empty),
  Layer.catch(Layer.empty, () => Layer.empty),
  Effect.catch(Effect.void, () => Effect.void),
]

declare const cleanup: () => void
