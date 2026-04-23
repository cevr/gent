/**
 * Boundary helper for {@link AutocompletePopup}.
 *
 * The popup's `createResource` callback consumes `Promise<readonly
 * AutocompleteItem[]>` (Solid's signal lane). When a contribution returns an
 * `Effect`, we exit Effect-land via `clientRuntime.runPromise(...)` — the only
 * sanctioned form is from a `*-boundary.ts` module per
 * `gent/no-runpromise-outside-boundary`.
 */

import { Effect } from "effect"
import type {
  AutocompleteContribution,
  AutocompleteItem,
  ClientRuntime,
} from "../extensions/client-facets.js"

export const runAutocompleteItems = (
  contribution: AutocompleteContribution,
  filter: string,
  clientRuntime: ClientRuntime,
): Promise<readonly AutocompleteItem[]> => {
  const out = contribution.items(filter)
  if (Effect.isEffect(out)) {
    return clientRuntime.runPromise(out)
  }
  return Promise.resolve(out)
}
