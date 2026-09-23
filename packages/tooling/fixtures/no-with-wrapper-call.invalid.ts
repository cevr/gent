import { Effect } from "effect"

declare const withBoundary: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
declare const withNamedBoundary: (
  name: string,
) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
declare const withLabel: <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  label: string,
) => Effect.Effect<A, E, R>
declare const withPath: <A>(use: (path: string) => A) => A
declare const withConnection: <A>(url: string, use: (conn: string) => A) => A
declare const makeEffect: () => Effect.Effect<void>

withBoundary(makeEffect())
withNamedBoundary("tool")(makeEffect())
withLabel(makeEffect(), "tool")
withPath((path) => path)
withConnection("url", function (conn) {
  return conn
})

export const withThing = <A, E, R>(effect: Effect.Effect<A, E, R>, value: string) =>
  effect.pipe(Effect.annotateLogs({ value }))

export const withCurriedThing =
  (value: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.annotateLogs({ value }))

export const withCallbackThing = <A>(use: (thing: string) => A) => use("thing")
