import { Match, Schema } from "effect"

export interface SessionTreeState {
  readonly query: string
  readonly selectedIndex: number
}

export const SessionTreeState = {
  initial: (selectedIndex = 0): SessionTreeState => ({
    query: "",
    selectedIndex,
  }),
}

export const SessionTreeEvent = Schema.TaggedUnion({
  Open: { selectedIndex: Schema.Finite },
  Backspace: {},
  MoveUp: { itemCount: Schema.Finite },
  MoveDown: { itemCount: Schema.Finite },
  TypeChar: { char: Schema.String },
})
export type SessionTreeEvent = Schema.Schema.Type<typeof SessionTreeEvent>

const wrapIndex = (selectedIndex: number, itemCount: number, direction: -1 | 1): number => {
  if (itemCount <= 0) return 0
  if (direction === -1) {
    if (selectedIndex > 0) return selectedIndex - 1
    return itemCount - 1
  }
  if (selectedIndex < itemCount - 1) return selectedIndex + 1
  return 0
}

export function transitionSessionTree(
  state: SessionTreeState,
  event: SessionTreeEvent,
): SessionTreeState {
  const transitionEvent: (event: SessionTreeEvent) => SessionTreeState =
    Match.type<SessionTreeEvent>().pipe(
      Match.tagsExhaustive({
        Open: (event) => SessionTreeState.initial(event.selectedIndex),
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
