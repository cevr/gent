import { test } from "bun:test"
import { Effect } from "effect"

test("scoped cleanup is allowed", () =>
  Effect.gen(function* () {
    const value = yield* Effect.acquireRelease(
      Effect.succeed("work"),
      () => Effect.sync(() => cleanup()),
    )
    return value
  }).pipe(Effect.scoped))

declare const cleanup: () => void
