import type { SessionInfo } from "../client"

export type CommandPaletteLevel = "root" | "sessions" | "theme"

export type CommandPaletteSessionsState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "loading" }
  | { readonly _tag: "loaded"; readonly items: readonly SessionInfo[] }
  | { readonly _tag: "failed"; readonly message: string }

export interface CommandPaletteState {
  readonly levelStack: readonly Exclude<CommandPaletteLevel, "root">[]
  readonly selectedIndex: number
  readonly searchQuery: string
  readonly sessions: CommandPaletteSessionsState
}

export type CommandPaletteSelectionOutcome =
  | { readonly _tag: "PushLevel"; readonly level: Exclude<CommandPaletteLevel, "root"> }
  | { readonly _tag: "Close" }
  | { readonly _tag: "Stay" }

export type CommandPaletteEvent =
  | { readonly _tag: "Open" }
  | { readonly _tag: "Close" }
  | { readonly _tag: "LoadSessions" }
  | { readonly _tag: "SessionsLoaded"; readonly sessions: readonly SessionInfo[] }
  | { readonly _tag: "SessionsFailed"; readonly message: string }
  | { readonly _tag: "PushLevel"; readonly level: Exclude<CommandPaletteLevel, "root"> }
  | { readonly _tag: "PopLevel" }
  | { readonly _tag: "SearchTyped"; readonly char: string }
  | { readonly _tag: "SearchBackspaced" }
  | { readonly _tag: "ClearSearch" }
  | { readonly _tag: "MoveUp"; readonly itemCount: number }
  | { readonly _tag: "MoveDown"; readonly itemCount: number }
  | { readonly _tag: "ActivateSelection"; readonly outcome: CommandPaletteSelectionOutcome }

const initial = (): CommandPaletteState => ({
  levelStack: [],
  selectedIndex: 0,
  searchQuery: "",
  sessions: { _tag: "idle" },
})

const currentLevel = (state: CommandPaletteState): CommandPaletteLevel =>
  state.levelStack[state.levelStack.length - 1] ?? "root"

const pushLevel = (
  state: CommandPaletteState,
  level: Exclude<CommandPaletteLevel, "root">,
): CommandPaletteState => ({
  ...state,
  levelStack: [...state.levelStack, level],
  selectedIndex: 0,
  searchQuery: "",
})

const setSessionsLoading = (state: CommandPaletteState): CommandPaletteState => ({
  ...state,
  sessions: { _tag: "loading" },
})

const setSessionsLoaded = (
  state: CommandPaletteState,
  sessions: readonly SessionInfo[],
): CommandPaletteState => ({
  ...state,
  sessions: { _tag: "loaded", items: [...sessions] },
})

const setSessionsFailed = (state: CommandPaletteState, message: string): CommandPaletteState => ({
  ...state,
  sessions: { _tag: "failed", message },
})

const popLevel = (state: CommandPaletteState): CommandPaletteState =>
  state.levelStack.length === 0
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

const applySelectionOutcome = (
  state: CommandPaletteState,
  outcome: CommandPaletteSelectionOutcome,
): CommandPaletteState => {
  switch (outcome._tag) {
    case "PushLevel":
      return pushLevel(state, outcome.level)
    case "Close":
    case "Stay":
      return state
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
    case "Close":
      return initial()
    case "LoadSessions":
      return setSessionsLoading(state)
    case "SessionsLoaded":
      return setSessionsLoaded(state, event.sessions)
    case "SessionsFailed":
      return setSessionsFailed(state, event.message)
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
    case "ActivateSelection":
      return applySelectionOutcome(state, event.outcome)
  }
}
