import { Effect } from "effect"

declare const withBoundary: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
declare const withNamedBoundary: (
  name: string,
) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
declare const withAdapter: (
  boundary: string,
) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
declare const withHeaders: (request: string, headers: string) => string
declare const makeEffect: () => Effect.Effect<void>
declare const makeBoundary: () => string
declare const value: Effect.Effect<void>
declare const request: string

makeEffect().pipe(withBoundary)
makeEffect().pipe(withNamedBoundary("tool"))
makeEffect().pipe(withAdapter(makeBoundary()))
withBoundary(value)
withNamedBoundary("tool")(value)
export const withBody = withHeaders(request, "x")

export const provideThing =
  (label: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.annotateLogs({ label }))

export const withFallback = (primary: string, fallback: string): string => primary || fallback

export const withRetries = Effect.fn("withRetries")(function* (count: number) {
  return yield* Effect.succeed(count)
})
