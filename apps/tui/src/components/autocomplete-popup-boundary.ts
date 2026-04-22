/**
 * Boundary helper for {@link AutocompletePopup}.
 *
 * The popup's `createResource` callback consumes `Promise<readonly
 * AutocompleteItem[]>` (Solid's signal lane). When a contribution returns an
 * `Effect`, we exit Effect-land via `clientRuntime.runPromise(...)` — the only
 * sanctioned form is from a `*-boundary.ts` module per
 * `gent/no-runpromise-outside-boundary`.
 */

import { Effect, type ManagedRuntime } from "effect"
import type { AutocompleteContribution, AutocompleteItem } from "../extensions/client-facets.js"

export const runAutocompleteItems = (
  contribution: AutocompleteContribution,
  filter: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapter boundary; the popup's runtime layer is opaque to this helper
  clientRuntime: ManagedRuntime.ManagedRuntime<any, any>,
): Promise<readonly AutocompleteItem[]> => {
  const out = contribution.items(filter)
  if (Effect.isEffect(out)) {
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off — adapter boundary; AutocompleteContribution.items intentionally accepts any-typed Effects so contribution authors don't have to spell their full E/R union, and the popup normalizes failures to []
    return clientRuntime.runPromise(out)
  }
  return Promise.resolve(out)
}
