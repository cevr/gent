import { Array, Match, type Option, Predicate, Schema } from "effect"
import type { Accessor } from "solid-js"

/** A menu item in the command palette. */
export interface PaletteItem {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly category?: string
  readonly shortcut?: string
  readonly disabled?: boolean
  readonly onSelect: () => void
}

/** A structural level in the palette stack.
 *
 *  `source` is a Solid accessor — can be a plain function for sync levels
 *  or a `Resource` for async levels. Returns `undefined` while loading. */
export interface PaletteLevel {
  readonly id: string
  readonly title: string
  // eslint-disable-next-line effect/noNullish -- Solid Resource returns undefined while its request is pending.
  readonly source: Accessor<readonly PaletteItem[] | undefined>
  readonly onEnter?: () => void
}

export interface CommandPaletteState {
  readonly levelStack: readonly PaletteLevel[]
  readonly selectedIndex: number
  readonly searchQuery: string
  readonly category: string
}

const PaletteSourceSchema = Schema.declare<PaletteLevel["source"]>(
  (value): value is PaletteLevel["source"] => Predicate.isFunction(value),
)
const PaletteOnEnterSchema = Schema.declare<() => void>((value): value is () => void =>
  Predicate.isFunction(value),
)
const PaletteLevelSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  source: PaletteSourceSchema,
  onEnter: Schema.optionalKey(PaletteOnEnterSchema),
})

export const CommandPaletteEvent = Schema.TaggedUnion({
  Open: { rootLevel: PaletteLevelSchema },
  Close: {},
  PushLevel: { level: PaletteLevelSchema },
  PopLevel: {},
  SearchTyped: { char: Schema.String },
  SearchBackspaced: {},
  ClearSearch: {},
  SelectCategory: { category: Schema.String },
  MoveUp: { itemCount: Schema.Finite },
  MoveDown: { itemCount: Schema.Finite },
})
export type CommandPaletteEvent = Schema.Schema.Type<typeof CommandPaletteEvent>

const initial = (): CommandPaletteState => ({
  levelStack: [],
  selectedIndex: 0,
  searchQuery: "",
  category: "",
})

const currentLevel = (state: CommandPaletteState): Option.Option<PaletteLevel> =>
  Array.last(state.levelStack)

const pushLevel = (state: CommandPaletteState, level: PaletteLevel): CommandPaletteState => ({
  ...state,
  levelStack: [...state.levelStack, level],
  category: "",
  selectedIndex: 0,
  searchQuery: "",
})

const popLevel = (state: CommandPaletteState): CommandPaletteState => {
  if (state.levelStack.length <= 1) return state
  return {
    ...state,
    levelStack: state.levelStack.slice(0, -1),
    category: "",
    selectedIndex: 0,
    searchQuery: "",
  }
}

const setSearchQuery = (state: CommandPaletteState, searchQuery: string): CommandPaletteState => ({
  ...state,
  searchQuery,
  selectedIndex: 0,
})

const moveSelection = (
  state: CommandPaletteState,
  itemCount: number,
  direction: "up" | "down",
): CommandPaletteState => {
  if (itemCount <= 0) return state
  if (direction === "up") {
    let selectedIndex = itemCount - 1
    if (state.selectedIndex > 0) selectedIndex = state.selectedIndex - 1
    return {
      ...state,
      selectedIndex,
    }
  }
  let selectedIndex = 0
  if (state.selectedIndex < itemCount - 1) selectedIndex = state.selectedIndex + 1
  return {
    ...state,
    selectedIndex,
  }
}

export const CommandPaletteState = {
  initial,
  currentLevel,
}

export function transitionCommandPalette(
  state: CommandPaletteState,
  event: CommandPaletteEvent,
): CommandPaletteState {
  return Match.value(event).pipe(
    Match.tagsExhaustive({
      Open: (event) => ({ ...initial(), levelStack: [event.rootLevel] }),
      Close: () => initial(),
      PushLevel: (event) => pushLevel(state, event.level),
      PopLevel: () => popLevel(state),
      SearchTyped: (event) => setSearchQuery(state, state.searchQuery + event.char),
      SearchBackspaced: () => setSearchQuery(state, state.searchQuery.slice(0, -1)),
      ClearSearch: () => setSearchQuery(state, ""),
      SelectCategory: (event) => ({ ...state, category: event.category, selectedIndex: 0 }),
      MoveUp: (event) => moveSelection(state, event.itemCount, "up"),
      MoveDown: (event) => moveSelection(state, event.itemCount, "down"),
    }),
  )
}
