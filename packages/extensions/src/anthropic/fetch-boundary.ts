/**
 * Boundary helper for {@link createAnthropicKeychainFetch}.
 *
 * The Anthropic AI SDK invokes our `typeof fetch` replacement as a
 * Promise-returning function. The retry-on-beta logic is built as an
 * `Effect<Response>` (closed over the request inputs); the boundary runs
 * it via `Effect.runPromise` and returns the Promise.
 *
 * Per `gent/no-runpromise-outside-boundary`, that call lives here. The
 * input type is pinned (`Effect<Response, never, never>`) — callers
 * cannot launder additional services or alternative result shapes.
 */

import { Effect } from "effect"

/** Run an Anthropic-fetcher Effect and surface its `Promise<Response>`. */
export const runAnthropicFetcher = <E>(
  effect: Effect.Effect<Response, E, never>,
): Promise<Response> => Effect.runPromise(effect)
