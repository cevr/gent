/**
 * Reducer for a filtered, keyboard-navigated list.
 *
 * Nothing here knows what the list holds: it is a search query plus a wrapped
 * selection index. Shared by the session tree and the agents view so the two
 * overlays cannot drift on wrap-around or reset-on-type behavior.
 *
 * @module
 */

import { Match, Schema } from "effect"

export interface FilterListState {
  readonly query: string
  readonly selectedIndex: number
}

export const FilterListState = {
  initial: (selectedIndex = 0): FilterListState => ({
    query: "",
    selectedIndex,
  }),
}

export const FilterListEvent = Schema.TaggedUnion({
  Open: { selectedIndex: Schema.Finite },
  Backspace: {},
  MoveUp: { itemCount: Schema.Finite },
  MoveDown: { itemCount: Schema.Finite },
  TypeChar: { char: Schema.String },
})
export type FilterListEvent = Schema.Schema.Type<typeof FilterListEvent>

const wrapIndex = (selectedIndex: number, itemCount: number, direction: -1 | 1): number => {
  if (itemCount <= 0) return 0
  if (direction === -1) {
    if (selectedIndex > 0) return selectedIndex - 1
    return itemCount - 1
  }
  if (selectedIndex < itemCount - 1) return selectedIndex + 1
  return 0
}

export function transitionFilterList(
  state: FilterListState,
  event: FilterListEvent,
): FilterListState {
  const transitionEvent: (event: FilterListEvent) => FilterListState =
    Match.type<FilterListEvent>().pipe(
      Match.tagsExhaustive({
        Open: (event) => FilterListState.initial(event.selectedIndex),
        Backspace: () => ({
          query: state.query.slice(0, -1),
          selectedIndex: 0,
        }),
        MoveUp: (event) => ({
          ...state,
          selectedIndex: wrapIndex(state.selectedIndex, event.itemCount, -1),
        }),
        MoveDown: (event) => ({
          ...state,
          selectedIndex: wrapIndex(state.selectedIndex, event.itemCount, 1),
        }),
        TypeChar: (event) => ({
          query: state.query + event.char,
          selectedIndex: 0,
        }),
      }),
    )
  return transitionEvent(event)
}
