import { Schema } from "effect"
import { TaggedEnumClass } from "@gent/core/domain/schema-tagged-enum-class"

export interface SessionTreeState {
  readonly query: string
  readonly selectedIndex: number
}

export const SessionTreeState = {
  initial: (selectedIndex = 0): SessionTreeState => ({
    query: "",
    selectedIndex,
  }),
} as const

export const SessionTreeEvent = TaggedEnumClass("SessionTreeEvent", {
  Open: { selectedIndex: Schema.Number },
  Backspace: {},
  MoveUp: { itemCount: Schema.Number },
  MoveDown: { itemCount: Schema.Number },
  TypeChar: { char: Schema.String },
})
export type SessionTreeEvent = Schema.Schema.Type<typeof SessionTreeEvent>

const wrapIndex = (selectedIndex: number, itemCount: number, direction: -1 | 1): number => {
  if (itemCount <= 0) return 0
  if (direction === -1) {
    return selectedIndex > 0 ? selectedIndex - 1 : itemCount - 1
  }
  return selectedIndex < itemCount - 1 ? selectedIndex + 1 : 0
}

export function transitionSessionTree(
  state: SessionTreeState,
  event: SessionTreeEvent,
): SessionTreeState {
  switch (event._tag) {
    case "Open":
      return SessionTreeState.initial(event.selectedIndex)
    case "Backspace":
      return {
        query: state.query.slice(0, -1),
        selectedIndex: 0,
      }
    case "MoveUp":
      return {
        ...state,
        selectedIndex: wrapIndex(state.selectedIndex, event.itemCount, -1),
      }
    case "MoveDown":
      return {
        ...state,
        selectedIndex: wrapIndex(state.selectedIndex, event.itemCount, 1),
      }
    case "TypeChar":
      return {
        query: state.query + event.char,
        selectedIndex: 0,
      }
  }
}
