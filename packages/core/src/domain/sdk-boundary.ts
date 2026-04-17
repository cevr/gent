/**
 * `SdkBoundary<A, E>` — typed crossing into untyped JS.
 *
 * The "Effect-first, no escape hatches" rule has a small number of legitimate
 * exceptions where Effects must cross into Promise-returning callers (anthropic
 * fetch, openai loader, ACP `runTool` codemode sandbox, TUI top-level resource
 * construction, SDK client). Today those crossings are marked `R = never` by
 * comment, not by type — there is nothing stopping a future contributor from
 * `runPromise`-ing an arbitrary Effect with ambient services.
 *
 * `SdkBoundary<A, E>` brands an Effect as "intended to be consumed by
 * `runSdkBoundary` at a known SDK edge". The lint rule
 * `gent/no-runpromise-outside-boundary` enforces:
 *
 *   - `Effect.runPromise(...)` and `Effect.runPromiseWith(...)` may be called
 *     ONLY inside files whose path matches `*-boundary.ts`, OR
 *   - on a value of type `SdkBoundary<A, E>`.
 *
 * The `E` parameter must extend `Schema.TaggedError` (enforced via
 * `gent/all-errors-are-tagged`); the `R` channel must be `never` (closed-over
 * dependencies — the boundary is not a way to launder ambient services).
 *
 * NOTE: this module is **type-only** scaffolding. C0 introduces the brand and
 * factories; downstream batches migrate the five known boundaries
 * (`anthropic-boundary.ts`, `openai-boundary.ts`, `acp-boundary.ts`,
 * `tui-resource-boundary.ts`, `sdk-client-boundary.ts`) to use it.
 *
 * @module
 */

import { Effect } from "effect"

declare const BoundaryBrand: unique symbol

/**
 * An Effect tagged for crossing into untyped JS at a known SDK boundary.
 *
 * `R = never` is structural: closed-over dependencies must be provided before
 * branding. `E` must be a `Schema.TaggedError` subclass so the boundary surfaces
 * a typed failure shape to its Promise consumer.
 */
export type SdkBoundary<A, E> = Effect.Effect<A, E, never> & {
  readonly [BoundaryBrand]: true
}

/**
 * Brand an `Effect<A, E, never>` as an {@link SdkBoundary}.
 *
 * The `label` is a human-readable name surfaced in tracing and lint diagnostics.
 * Lint will reject a `runPromise` outside `*-boundary.ts` on a non-branded Effect.
 */
export const sdkBoundary = <A, E>(
  _label: string,
  effect: Effect.Effect<A, E, never>,
): SdkBoundary<A, E> =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  effect as SdkBoundary<A, E>

/**
 * Run an `SdkBoundary<A, E>` to a Promise.
 *
 * This is the *only* sanctioned `runPromise` call site outside `*-boundary.ts`
 * files. Lint rule `gent/no-runpromise-outside-boundary` enforces the
 * restriction.
 */
export const runSdkBoundary = <A, E>(boundary: SdkBoundary<A, E>): Promise<A> =>
  Effect.runPromise(boundary)
