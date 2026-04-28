import { Schema } from "effect"
import type { Accessor } from "solid-js"
import { TaggedEnumClass } from "@gent/core/domain/schema-tagged-enum-class"

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
  readonly source: Accessor<readonly PaletteItem[] | undefined>
  readonly onEnter?: () => void
}

export interface CommandPaletteState {
  readonly levelStack: readonly PaletteLevel[]
  readonly selectedIndex: number
  readonly searchQuery: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const PaletteLevelSchema = Schema.declare<PaletteLevel>(
  (value): value is PaletteLevel =>
    isRecord(value) &&
    typeof value["id"] === "string" &&
    typeof value["title"] === "string" &&
    typeof value["source"] === "function" &&
    (value["onEnter"] === undefined || typeof value["onEnter"] === "function"),
)

export const CommandPaletteEvent = TaggedEnumClass("CommandPaletteEvent", {
  Open: { rootLevel: PaletteLevelSchema },
  Close: {},
  PushLevel: { level: PaletteLevelSchema },
  PopLevel: {},
  SearchTyped: { char: Schema.String },
  SearchBackspaced: {},
  ClearSearch: {},
  MoveUp: { itemCount: Schema.Number },
  MoveDown: { itemCount: Schema.Number },
})
export type CommandPaletteEvent = Schema.Schema.Type<typeof CommandPaletteEvent>

const initial = (): CommandPaletteState => ({
  levelStack: [],
  selectedIndex: 0,
  searchQuery: "",
})

const currentLevel = (state: CommandPaletteState): PaletteLevel | undefined =>
  state.levelStack[state.levelStack.length - 1]

const pushLevel = (state: CommandPaletteState, level: PaletteLevel): CommandPaletteState => ({
  ...state,
  levelStack: [...state.levelStack, level],
  selectedIndex: 0,
  searchQuery: "",
})

const popLevel = (state: CommandPaletteState): CommandPaletteState =>
  state.levelStack.length <= 1
    ? state
    : {
        ...state,
        levelStack: state.levelStack.slice(0, -1),
        selectedIndex: 0,
        searchQuery: "",
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
    return {
      ...state,
      selectedIndex: state.selectedIndex > 0 ? state.selectedIndex - 1 : itemCount - 1,
    }
  }
  return {
    ...state,
    selectedIndex: state.selectedIndex < itemCount - 1 ? state.selectedIndex + 1 : 0,
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
  switch (event._tag) {
    case "Open":
      return { ...initial(), levelStack: [event.rootLevel] }
    case "Close":
      return initial()
    case "PushLevel":
      return pushLevel(state, event.level)
    case "PopLevel":
      return popLevel(state)
    case "SearchTyped":
      return setSearchQuery(state, state.searchQuery + event.char)
    case "SearchBackspaced":
      return setSearchQuery(state, state.searchQuery.slice(0, -1))
    case "ClearSearch":
      return setSearchQuery(state, "")
    case "MoveUp":
      return moveSelection(state, event.itemCount, "up")
    case "MoveDown":
      return moveSelection(state, event.itemCount, "down")
  }
}
