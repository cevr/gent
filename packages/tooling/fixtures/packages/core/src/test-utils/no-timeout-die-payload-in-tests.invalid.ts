// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-timeout-die-payload-in-tests` fires 3 times. The
// harness is test code, and upstream reads a die's message only from string
// literals, templates and constructor arguments, not from an object payload.
import { Effect, Schema } from "effect"

class WaitForError extends Schema.TaggedError<WaitForError>()("WaitForError", {
  message: Schema.String,
}) {}

export const typedPayload = Effect.die(
  new WaitForError({ message: "timed out waiting for server" }),
)
export const plainPayload = Effect.die({ reason: "gave up on the socket" })
export const nestedPayload = Effect.die(new Error("stuck", { cause: { why: `timeout` } }))
