// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-timeout-die-payload-in-tests` does NOT fire. A
// timeout spelled where upstream `effect/noTimeoutDieInTests` reads it is
// upstream's to report, and a die on an impossible state is a real defect.
import { Effect, Schema } from "effect"

class MissingFixture extends Schema.TaggedError<MissingFixture>()("MissingFixture", {
  name: Schema.String,
}) {}

export const upstreamCase = Effect.die(new Error("timed out waiting for server"))
export const upstreamMessage = Effect.dieMessage(`timeout after ${5} seconds`)
export const impossible = Effect.die(new MissingFixture({ name: "model driver" }))
