import { Schema } from "effect"
import { matchSorter } from "match-sorter"

export type PromptSearchState =
  | { readonly _tag: "closed" }
  | {
      readonly _tag: "open"
      readonly draftBeforeOpen: string
      readonly query: string
      readonly selectedIndex: number
      readonly hasInteracted: boolean
    }

export const PromptSearchState = {
  closed: (): PromptSearchState => ({ _tag: "closed" }),
  open: (draftBeforeOpen: string): PromptSearchState => ({
    _tag: "open",
    draftBeforeOpen,
    query: "",
    selectedIndex: 0,
    hasInteracted: false,
  }),
} as const

export const PromptSearchEvent = Schema.TaggedUnion({
  Open: { draftBeforeOpen: Schema.String },
  TypeChar: { char: Schema.String },
  Backspace: {},
  MoveUp: {},
  MoveDown: {},
  Accept: {},
  Cancel: {},
})
export type PromptSearchEvent = Schema.Schema.Type<typeof PromptSearchEvent>

export const PromptSearchEffect = Schema.TaggedUnion({
  Preview: { text: Schema.String },
  Close: {},
})
export type PromptSearchEffect = Schema.Schema.Type<typeof PromptSearchEffect>

export interface PromptSearchTransitionResult {
  readonly state: PromptSearchState
  readonly effects: readonly PromptSearchEffect[]
}

export const getPromptSearchItems = (
  state: PromptSearchState,
  entries: readonly string[],
): readonly string[] => {
  if (state._tag !== "open") return []
  const currentQuery = state.query.trim()
  if (currentQuery.length === 0) return entries
  return matchSorter(entries, currentQuery)
}

const clampSelectedIndex = (selectedIndex: number, itemCount: number): number => {
  if (itemCount <= 0) return 0
  return Math.min(selectedIndex, itemCount - 1)
}

export const getPromptSearchPreview = (
  state: PromptSearchState,
  entries: readonly string[],
): string | undefined => {
  if (state._tag !== "open") return undefined
  if (state.hasInteracted === false) return state.draftBeforeOpen

  const items = getPromptSearchItems(state, entries)
  if (items.length === 0) return state.draftBeforeOpen

  const index = clampSelectedIndex(state.selectedIndex, items.length)
  return items[index] ?? state.draftBeforeOpen
}

export function transitionPromptSearch(
  state: PromptSearchState,
  event: PromptSearchEvent,
  entries: readonly string[],
): PromptSearchTransitionResult {
  switch (event._tag) {
    case "Open":
      return {
        state: PromptSearchState.open(event.draftBeforeOpen),
        effects: [],
      }

    case "Accept":
      if (state._tag !== "open") return { state, effects: [] }
      return {
        state: PromptSearchState.closed(),
        effects: [
          PromptSearchEffect.cases.Preview.make({
            text: getPromptSearchPreview(state, entries) ?? state.draftBeforeOpen,
          }),
          PromptSearchEffect.cases.Close.make({}),
        ],
      }

    case "Cancel":
      if (state._tag !== "open") return { state, effects: [] }
      return {
        state: PromptSearchState.closed(),
        effects: [
          PromptSearchEffect.cases.Preview.make({ text: state.draftBeforeOpen }),
          PromptSearchEffect.cases.Close.make({}),
        ],
      }
  }

  if (state._tag !== "open") {
    return { state, effects: [] }
  }

  const moveSelection = (selectedIndex: number, itemCount: number, direction: -1 | 1) => {
    if (itemCount <= 0) return 0
    if (direction === -1) {
      return selectedIndex > 0 ? selectedIndex - 1 : itemCount - 1
    }
    return selectedIndex < itemCount - 1 ? selectedIndex + 1 : 0
  }

  let nextState = state

  switch (event._tag) {
    case "TypeChar":
      nextState = {
        ...state,
        query: state.query + event.char,
        selectedIndex: 0,
        hasInteracted: true,
      }
      break
    case "Backspace":
      nextState = {
        ...state,
        query: state.query.slice(0, -1),
        selectedIndex: 0,
        hasInteracted: true,
      }
      break
    case "MoveUp": {
      const items = getPromptSearchItems(state, entries)
      nextState = {
        ...state,
        selectedIndex: moveSelection(
          clampSelectedIndex(state.selectedIndex, items.length),
          items.length,
          -1,
        ),
        hasInteracted: true,
      }
      break
    }
    case "MoveDown": {
      const items = getPromptSearchItems(state, entries)
      nextState = {
        ...state,
        selectedIndex: moveSelection(
          clampSelectedIndex(state.selectedIndex, items.length),
          items.length,
          1,
        ),
        hasInteracted: true,
      }
      break
    }
  }

  return {
    state: nextState,
    effects: [
      PromptSearchEffect.cases.Preview.make({
        text: getPromptSearchPreview(nextState, entries) ?? "",
      }),
    ],
  }
}
