import { Match, Schema } from "effect"
import {
  Session as SessionSchema,
  SessionTreeNode,
} from "@gent/core-internal/server/transport-contract"
import type { DomainSession, SessionTreeNode as DomainSessionTreeNode } from "../client/index"
import type { PromptSearchState } from "../components/prompt-search-state"
import {
  PromptSearchEvent as PromptSearchEventSchema,
  PromptSearchState as PromptSearchStateFactory,
} from "../components/prompt-search-state"
import { transitionPromptSearchRoute } from "./prompt-search-flow"

interface PromptSearchOverlayState {
  readonly _tag: "prompt-search"
  readonly draftBeforeOpen: string
  readonly query: string
  readonly selectedIndex: number
  readonly hasInteracted: boolean
}

export type SessionOverlayState =
  | { readonly _tag: "none" }
  | {
      readonly _tag: "tree"
      readonly tree: DomainSessionTreeNode
      readonly sessions: readonly DomainSession[]
    }
  | { readonly _tag: "fork" }
  | { readonly _tag: "mermaid" }
  | { readonly _tag: "auth"; readonly enforceAuth: boolean }
  | { readonly _tag: "permissions" }
  | { readonly _tag: "extension"; readonly overlayId: string }
  | PromptSearchOverlayState

export interface SessionUiState {
  readonly toolsExpanded: boolean
  readonly overlay: SessionOverlayState
}

export const SessionUiState = {
  initial: (): SessionUiState => ({
    toolsExpanded: false,
    overlay: { _tag: "none" },
  }),
}

export const SessionUiEvent = Schema.TaggedUnion({
  ToggleTools: {},
  OpenTree: {
    tree: SessionTreeNode,
    sessions: Schema.Array(SessionSchema),
  },
  OpenFork: {},
  OpenMermaid: {},
  OpenAuth: { enforceAuth: Schema.Boolean },
  OpenPermissions: {},
  OpenExtensionOverlay: { overlayId: Schema.String },
  CloseOverlay: {},
  PromptSearch: {
    event: PromptSearchEventSchema,
    entries: Schema.Array(Schema.String),
  },
})
export type SessionUiEvent = Schema.Schema.Type<typeof SessionUiEvent>

export type SessionUiEffect = { readonly _tag: "RestoreComposer"; readonly text: string }

export interface SessionUiTransitionResult {
  readonly state: SessionUiState
  readonly effects: readonly SessionUiEffect[]
}

export const getPromptSearchState = (state: SessionUiState): PromptSearchState => {
  if (state.overlay._tag === "prompt-search") {
    return {
      _tag: "open",
      draftBeforeOpen: state.overlay.draftBeforeOpen,
      query: state.overlay.query,
      selectedIndex: state.overlay.selectedIndex,
      hasInteracted: state.overlay.hasInteracted,
    }
  }
  return PromptSearchStateFactory.closed()
}

export const promptSearchOpen = (state: SessionUiState): boolean =>
  getPromptSearchState(state)._tag === "open"

export function transitionSessionUi(
  state: SessionUiState,
  event: SessionUiEvent,
): SessionUiTransitionResult {
  return Match.value(event).pipe(
    Match.tagsExhaustive({
      ToggleTools: (): SessionUiTransitionResult => ({
        state: {
          ...state,
          toolsExpanded: !state.toolsExpanded,
        },
        effects: [],
      }),
      OpenTree: (event): SessionUiTransitionResult => ({
        state: {
          ...state,
          overlay: {
            _tag: "tree",
            tree: event.tree,
            sessions: event.sessions,
          },
        },
        effects: [],
      }),
      OpenFork: (): SessionUiTransitionResult => ({
        state: {
          ...state,
          overlay: { _tag: "fork" },
        },
        effects: [],
      }),
      OpenMermaid: (): SessionUiTransitionResult => ({
        state: {
          ...state,
          overlay: { _tag: "mermaid" },
        },
        effects: [],
      }),
      OpenAuth: (event): SessionUiTransitionResult => ({
        state: {
          ...state,
          overlay: { _tag: "auth", enforceAuth: event.enforceAuth },
        },
        effects: [],
      }),
      OpenPermissions: (): SessionUiTransitionResult => ({
        state: {
          ...state,
          overlay: { _tag: "permissions" },
        },
        effects: [],
      }),
      OpenExtensionOverlay: (event): SessionUiTransitionResult => ({
        state: {
          ...state,
          overlay: { _tag: "extension", overlayId: event.overlayId },
        },
        effects: [],
      }),
      CloseOverlay: (): SessionUiTransitionResult => ({
        state: {
          ...state,
          overlay: { _tag: "none" },
        },
        effects: [],
      }),
      PromptSearch: (event): SessionUiTransitionResult => {
        const promptState = getPromptSearchState(state)
        const result = transitionPromptSearchRoute(promptState, event.event, event.entries)
        let nextOverlay: SessionOverlayState = { _tag: "none" }
        if (result.state._tag === "open") {
          nextOverlay = {
            _tag: "prompt-search",
            draftBeforeOpen: result.state.draftBeforeOpen,
            query: result.state.query,
            selectedIndex: result.state.selectedIndex,
            hasInteracted: result.state.hasInteracted,
          }
        }
        return {
          state: {
            ...state,
            overlay: nextOverlay,
          },
          effects: result.effects,
        }
      },
    }),
  )
}
