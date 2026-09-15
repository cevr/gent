/**
 * The failure type the process tests map RPC errors into.
 *
 * `server-lifecycle.test.ts` drives a real `gent` server over HTTP, so every
 * client call carries the full RPC error union. One tagged error keeps the
 * assertions readable without widening each test's error type.
 */
import { Schema } from "effect"

export class TestFailure extends Schema.TaggedError<TestFailure>()("@gent/e2e/tests/TestFailure", {
  message: Schema.String,
}) {}

export const toTestFailure = (cause: unknown) => {
  if (cause instanceof Error) return new TestFailure({ message: cause.message })
  return new TestFailure({ message: String(cause) })
}
