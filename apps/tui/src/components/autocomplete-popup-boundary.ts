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
  ClientRuntimeServices,
  ClientRuntime,
} from "../extensions/client-facets.js"

const toAutocompleteEffect = (
  items:
    | ReadonlyArray<AutocompleteItem>
    | Effect.Effect<ReadonlyArray<AutocompleteItem>, Error, ClientRuntimeServices>,
): Effect.Effect<ReadonlyArray<AutocompleteItem>, string, ClientRuntimeServices> => {
  if (Effect.isEffect(items)) return items.pipe(Effect.mapError(String))
  return Effect.succeed(items)
}

export const runAutocompleteItems = (
  contribution: AutocompleteContribution,
  filter: string,
  clientRuntime: ClientRuntime,
): Promise<readonly AutocompleteItem[]> => {
  const out = contribution.items(filter)
  if (Effect.isEffect(out)) {
    return clientRuntime.runPromise(out)
  }
  return clientRuntime.runPromise(Effect.succeed(out))
}

export const runAutocompleteContributions = (
  contributions: ReadonlyArray<AutocompleteContribution>,
  filter: string,
  clientRuntime: ClientRuntime,
  onFailure: (prefix: string, reason: string) => void,
): Promise<AutocompleteItem[]> =>
  clientRuntime.runPromise(
    Effect.forEach(
      contributions,
      (contribution) =>
        Effect.try({
          try: () => contribution.items(filter),
          catch: String,
        }).pipe(
          Effect.flatMap(toAutocompleteEffect),
          Effect.catch((reason) =>
            Effect.sync(() => {
              onFailure(contribution.prefix, reason)
              return [] satisfies AutocompleteItem[]
            }),
          ),
        ),
      { concurrency: 16 },
    ).pipe(
      Effect.map((results) => {
        const seen = new Set<string>()
        const deduped: AutocompleteItem[] = []
        for (const batch of results) {
          for (const item of batch) {
            if (seen.has(item.id)) continue
            seen.add(item.id)
            deduped.push(item)
          }
        }
        return deduped
      }),
    ),
  )
