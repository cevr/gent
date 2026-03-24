import type { PromptSearchEvent, PromptSearchState } from "../components/prompt-search-state"
import { transitionPromptSearch } from "../components/prompt-search-state"

export type PromptSearchRouteEffect = { readonly _tag: "RestoreComposer"; readonly text: string }

export interface PromptSearchRouteTransition {
  readonly state: PromptSearchState
  readonly effects: readonly PromptSearchRouteEffect[]
}

export function transitionPromptSearchRoute(
  state: PromptSearchState,
  event: PromptSearchEvent,
  entries: readonly string[],
): PromptSearchRouteTransition {
  const result = transitionPromptSearch(state, event, entries)
  return {
    state: result.state,
    effects: result.effects
      .filter((effect) => effect._tag === "Preview")
      .map((effect) => ({
        _tag: "RestoreComposer" as const,
        text: effect.text,
      })),
  }
}
