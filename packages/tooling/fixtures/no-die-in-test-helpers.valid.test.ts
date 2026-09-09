// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-die-in-test-helpers` does NOT fire for dies that
// model a genuine impossible state, nor when a well-formed carveout is present,
// nor for a typed timeout failure (the shape the rule steers toward).

import { Effect, Schema } from "effect"

class WaitTimeout extends Schema.TaggedError<WaitTimeout>()("WaitTimeout", {
  label: Schema.String,
}) {}

// The shape this rule steers toward: a timeout as a typed, attributable failure.
export const typedTimeout = () =>
  Effect.gen(function* () {
    return yield* new WaitTimeout({ label: "runtime state" })
  })

// Impossible state, not a timeout — dying is correct and must stay unflagged.
export const missingFixture = () => Effect.die(new Error("no model driver registered"))

export const outOfRange = (index: number) =>
  Effect.die(new Error(`waitForCall: index ${index} out of range`))

export const missingRpc = (key: string) => Effect.dieMessage(`Missing RPC ${key}`)

// gent/no-die-in-test-helpers: allow fixture asserts defect-channel behavior itself
export const deliberateTimeoutDefect = () => Effect.die(new Error("timed out on purpose"))

// A non-Effect `.die(...)` on an unrelated object must not be flagged.
export const unrelated = (game: { die: (n: number) => number }) => game.die(6)
