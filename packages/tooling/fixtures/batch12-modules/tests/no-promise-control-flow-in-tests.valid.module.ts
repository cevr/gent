import { test } from "bun:test"
import { Effect } from "effect"

test("batch12 module effect control flow is allowed", () =>
  Effect.gen(function* () {
    yield* Effect.void
  }))
