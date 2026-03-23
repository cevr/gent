import type { SessionInfo, SessionTreeNode } from "../client/index"
import type { PromptSearchEvent, PromptSearchState } from "../components/prompt-search-state"
import {
  PromptSearchState as PromptSearchStateFactory,
  transitionPromptSearch,
} from "../components/prompt-search-state"

export type SessionOverlayState =
  | { readonly _tag: "none" }
  | {
      readonly _tag: "tree"
      readonly tree: SessionTreeNode
      readonly sessions: readonly SessionInfo[]
    }
  | { readonly _tag: "fork" }
  | { readonly _tag: "mermaid" }
  | {
      readonly _tag: "prompt-search"
      readonly state: Extract<PromptSearchState, { readonly _tag: "open" }>
    }

export interface SessionUiState {
  readonly toolsExpanded: boolean
  readonly overlay: SessionOverlayState
}

export const SessionUiState = {
  initial: (): SessionUiState => ({
    toolsExpanded: false,
    overlay: { _tag: "none" },
  }),
} as const

export type SessionUiEvent =
  | { readonly _tag: "ToggleTools" }
  | {
      readonly _tag: "OpenTree"
      readonly tree: SessionTreeNode
      readonly sessions: readonly SessionInfo[]
    }
  | { readonly _tag: "OpenFork" }
  | { readonly _tag: "OpenMermaid" }
  | { readonly _tag: "CloseOverlay" }
  | {
      readonly _tag: "PromptSearch"
      readonly event: PromptSearchEvent
      readonly entries: readonly string[]
    }

export type SessionUiEffect = { readonly _tag: "RestoreComposer"; readonly text: string }

export interface SessionUiTransitionResult {
  readonly state: SessionUiState
  readonly effects: readonly SessionUiEffect[]
}

export const getPromptSearchState = (state: SessionUiState): PromptSearchState =>
  state.overlay._tag === "prompt-search" ? state.overlay.state : PromptSearchStateFactory.closed()

export const promptSearchOpen = (state: SessionUiState): boolean =>
  getPromptSearchState(state)._tag === "open"

export function transitionSessionUi(
  state: SessionUiState,
  event: SessionUiEvent,
): SessionUiTransitionResult {
  switch (event._tag) {
    case "ToggleTools":
      return {
        state: {
          ...state,
          toolsExpanded: !state.toolsExpanded,
        },
        effects: [],
      }

    case "OpenTree":
      return {
        state: {
          ...state,
          overlay: {
            _tag: "tree",
            tree: event.tree,
            sessions: event.sessions,
          },
        },
        effects: [],
      }

    case "OpenFork":
      return {
        state: {
          ...state,
          overlay: { _tag: "fork" },
        },
        effects: [],
      }

    case "OpenMermaid":
      return {
        state: {
          ...state,
          overlay: { _tag: "mermaid" },
        },
        effects: [],
      }

    case "CloseOverlay":
      return {
        state: {
          ...state,
          overlay: { _tag: "none" },
        },
        effects: [],
      }

    case "PromptSearch": {
      const promptState = getPromptSearchState(state)
      const result = transitionPromptSearch(promptState, event.event, event.entries)
      const nextOverlay =
        result.state._tag === "open"
          ? {
              _tag: "prompt-search" as const,
              state: result.state,
            }
          : { _tag: "none" as const }
      return {
        state: {
          ...state,
          overlay: nextOverlay,
        },
        effects: result.effects
          .filter((effect) => effect._tag === "Preview")
          .map((effect) => ({
            _tag: "RestoreComposer" as const,
            text: effect.text,
          })),
      }
    }
  }
}
