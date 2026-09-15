import { Match, Schema } from "effect"
import { Branch, Message } from "@gent/core/protocol"
import type { PromptSearchState } from "../components/prompt-search-state"
import {
  PromptSearchEvent as PromptSearchEventSchema,
  PromptSearchState as PromptSearchStateFactory,
  transitionPromptSearch,
} from "../components/prompt-search-state"

interface PromptSearchOverlayState {
  readonly _tag: "prompt-search"
  readonly draftBeforeOpen: string
  readonly query: string
  readonly selectedIndex: number
  readonly hasInteracted: boolean
}

export type SessionOverlayState =
  | { readonly _tag: "none" }
  | { readonly _tag: "fork"; readonly messages: readonly Message[] }
  | { readonly _tag: "mermaid" }
  | { readonly _tag: "auth"; readonly enforceAuth: boolean }
  | { readonly _tag: "model" }
  | { readonly _tag: "reasoning" }
  | { readonly _tag: "extension"; readonly overlayId: string }
  /**
   * The branch picker. The boot flow is the only thing that opens it, so
   * escape quits: a reader who never chose a branch has nowhere to fall back
   * to, which is what the old boot route did too.
   */
  | { readonly _tag: "branches"; readonly branches: readonly Branch[] }
  | PromptSearchOverlayState

/** How much of each tool group the inline transcript shows. `ctrl+o` cycles; `esc` collapses. */
export type DisclosureLevel = "collapsed" | "preview" | "full"

const DISCLOSURE_CYCLE: readonly DisclosureLevel[] = ["collapsed", "preview", "full"]

export const nextDisclosure = (level: DisclosureLevel): DisclosureLevel =>
  DISCLOSURE_CYCLE[(DISCLOSURE_CYCLE.indexOf(level) + 1) % DISCLOSURE_CYCLE.length] ?? "collapsed"

export interface SessionUiState {
  readonly disclosure: DisclosureLevel
  readonly transcriptExpanded: boolean
  readonly displayRevision: number
  readonly overlay: SessionOverlayState
}

export const SessionUiState = {
  initial: (): SessionUiState => ({
    disclosure: "collapsed",
    transcriptExpanded: false,
    displayRevision: 0,
    overlay: { _tag: "none" },
  }),
}

export const SessionUiEvent = Schema.TaggedUnion({
  CycleDisclosure: {},
  CollapseDisclosure: {},
  ToggleTranscript: {},
  ClearDisplay: {},
  OpenFork: { messages: Schema.Array(Message) },
  OpenMermaid: {},
  OpenAuth: { enforceAuth: Schema.Boolean },
  OpenSettingsPicker: { picker: Schema.Literals(["model", "reasoning"]) },
  OpenExtensionOverlay: { overlayId: Schema.String },
  OpenBranches: { branches: Schema.Array(Branch) },
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

export function transitionSessionUi(
  state: SessionUiState,
  event: SessionUiEvent,
): SessionUiTransitionResult {
  return Match.value(event).pipe(
    Match.tagsExhaustive({
      ClearDisplay: (): SessionUiTransitionResult => ({
        state: { ...state, displayRevision: state.displayRevision + 1, transcriptExpanded: false },
        effects: [],
      }),
      ToggleTranscript: (): SessionUiTransitionResult => ({
        state: { ...state, transcriptExpanded: !state.transcriptExpanded },
        effects: [],
      }),
      CycleDisclosure: (): SessionUiTransitionResult => ({
        state: { ...state, disclosure: nextDisclosure(state.disclosure) },
        effects: [],
      }),
      CollapseDisclosure: (): SessionUiTransitionResult => ({
        state: { ...state, disclosure: "collapsed" },
        effects: [],
      }),
      OpenFork: (event): SessionUiTransitionResult => ({
        state: {
          ...state,
          overlay: { _tag: "fork", messages: event.messages },
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
      OpenSettingsPicker: (event): SessionUiTransitionResult => ({
        state: {
          ...state,
          overlay: { _tag: event.picker },
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
      OpenBranches: (event): SessionUiTransitionResult => ({
        state: {
          ...state,
          overlay: { _tag: "branches", branches: event.branches },
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
        const result = transitionPromptSearch(promptState, event.event, event.entries)
        // Only a preview reaches the composer; the palette closes through the overlay.
        const effects = result.effects
          .filter((effect) => effect._tag === "Preview")
          .map((effect): SessionUiEffect => ({ _tag: "RestoreComposer", text: effect.text }))
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
          effects,
        }
      },
    }),
  )
}
