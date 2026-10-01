// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-with-wrapper-helper-in-test-code` fires 5 times. An
// integration tree is test code outside a `tests/` tree, where upstream skips
// its callback and definition checks.
import { Effect } from "effect"

declare const withPath: <A>(use: (path: string) => A) => A
declare const withConnection: <A>(url: string, use: (conn: string) => A) => A

// Calls: a callback, and a callback after an argument.
withPath((path) => path)
withConnection("url", function (conn) {
  return conn
})

// Definitions: an Effect parameter, a callback parameter, an Effect inside Effect.fn.
export const withThing = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect
export const withCallbackThing = <A>(use: (thing: string) => A) => use("thing")
export const withScope = Effect.fn("withScope")(function* (effect: Effect.Effect<void>) {
  return yield* effect
})
