import { Schema } from "effect"
import { TaggedEnumClass } from "@gent/core/domain/schema-tagged-enum-class"
import type { SessionInfo, SessionTreeNode } from "../client/index"
import type { PromptSearchEvent, PromptSearchState } from "../components/prompt-search-state"
import { PromptSearchState as PromptSearchStateFactory } from "../components/prompt-search-state"
import { transitionPromptSearchRoute } from "./prompt-search-flow"

// Schema.Any cast for types lacking canonical schemas
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- runtime internal owns erased generic boundary
const SessionTreeNodeSchema = Schema.Any as unknown as Schema.Schema<SessionTreeNode>
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- runtime internal owns erased generic boundary
const SessionInfoSchema = Schema.Any as unknown as Schema.Schema<SessionInfo>
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- runtime internal owns erased generic boundary
const PromptSearchEventSchema = Schema.Any as unknown as Schema.Schema<PromptSearchEvent>

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
      readonly tree: SessionTreeNode
      readonly sessions: readonly SessionInfo[]
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
} as const

export const SessionUiEvent = TaggedEnumClass("SessionUiEvent", {
  ToggleTools: {},
  OpenTree: {
    tree: SessionTreeNodeSchema,
    sessions: Schema.Array(SessionInfoSchema),
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

export const getPromptSearchState = (state: SessionUiState): PromptSearchState =>
  state.overlay._tag === "prompt-search"
    ? {
        _tag: "open",
        draftBeforeOpen: state.overlay.draftBeforeOpen,
        query: state.overlay.query,
        selectedIndex: state.overlay.selectedIndex,
        hasInteracted: state.overlay.hasInteracted,
      }
    : PromptSearchStateFactory.closed()

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

    case "OpenAuth":
      return {
        state: {
          ...state,
          overlay: { _tag: "auth", enforceAuth: event.enforceAuth },
        },
        effects: [],
      }

    case "OpenPermissions":
      return {
        state: {
          ...state,
          overlay: { _tag: "permissions" },
        },
        effects: [],
      }

    case "OpenExtensionOverlay":
      return {
        state: {
          ...state,
          overlay: { _tag: "extension", overlayId: event.overlayId },
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
      const result = transitionPromptSearchRoute(promptState, event.event, event.entries)
      const nextOverlay =
        result.state._tag === "open"
          ? {
              _tag: "prompt-search" as const,
              draftBeforeOpen: result.state.draftBeforeOpen,
              query: result.state.query,
              selectedIndex: result.state.selectedIndex,
              hasInteracted: result.state.hasInteracted,
            }
          : { _tag: "none" as const }
      return {
        state: {
          ...state,
          overlay: nextOverlay,
        },
        effects: result.effects,
      }
    }
  }
}
