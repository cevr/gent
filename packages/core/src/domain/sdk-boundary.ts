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
 * The `E` parameter is structurally constrained as `TaggedErrorLike` (carries
 * a `_tag` discriminator and extends `Error`) — the structural shape that
 * every `Schema.TaggedErrorClass` instance satisfies. Pairing this constraint
 * with `gent/all-errors-are-tagged` gives both type-level and source-level
 * enforcement. The `R` channel must be `never` (closed-over dependencies —
 * the boundary is not a way to launder ambient services).
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
 * Structural constraint on `SdkBoundary`'s error channel — must carry a `_tag`
 * discriminator. `Schema.TaggedErrorClass` produces classes that satisfy this
 * shape (each instance has `_tag: string`); plain `Error` subclasses do not.
 *
 * The constraint is structural rather than nominal because `Schema` does not
 * export a public `TaggedError` interface, only the `TaggedErrorClass` factory.
 * Pairing this constraint with the `gent/all-errors-are-tagged` lint rule
 * gives both type-level and source-level enforcement.
 */
export type TaggedErrorLike = Error & { readonly _tag: string }

/**
 * An Effect tagged for crossing into untyped JS at a known SDK boundary.
 *
 * `R = never` is structural: closed-over dependencies must be provided before
 * branding. `E extends TaggedErrorLike` requires the error channel to carry a
 * `_tag` discriminator — surfacing a typed failure shape to its Promise consumer.
 */
export type SdkBoundary<A, E extends TaggedErrorLike> = Effect.Effect<A, E, never> & {
  readonly [BoundaryBrand]: true
}

/**
 * Brand an `Effect<A, E, never>` as an {@link SdkBoundary}.
 *
 * The `label` is a human-readable name surfaced in tracing and lint diagnostics.
 * Lint will reject a `runPromise` outside `*-boundary.ts` on a non-branded Effect.
 */
export const sdkBoundary = <A, E extends TaggedErrorLike>(
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
export const runSdkBoundary = <A, E extends TaggedErrorLike>(
  boundary: SdkBoundary<A, E>,
): Promise<A> => Effect.runPromise(boundary)
