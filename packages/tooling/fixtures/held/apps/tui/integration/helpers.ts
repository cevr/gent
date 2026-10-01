// @ts-nocheck — held-shapes fixture
// An `integration/` helper is test code. Retired: no-promise-control-flow-in-tests
// (01c98e897), no-with-wrapper-helper-in-test-code (d586ae8b1).
import { Effect } from "effect"

declare const work: () => Promise<string>
declare const withPath: <A>(use: (path: string) => A) => A

export const settled = () => work().then((value) => value) // held-by: effect/noPromiseChainsInTests
export const scoped = withPath((path) => path) // held-by: effect/noWithWrapperCall
export const withThing = <A>(effect: Effect.Effect<A>) => effect // held-by: effect/noWithWrapperCall
