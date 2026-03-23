import type { BranchId, SessionId } from "@gent/core/domain/ids.js"
import type { PromptSearchEvent, PromptSearchState } from "../components/prompt-search-state"
import {
  PromptSearchState as PromptSearchStateFactory,
  transitionPromptSearch,
} from "../components/prompt-search-state"

export type HomeState =
  | {
      readonly _tag: "idle"
      readonly showWelcome: boolean
      readonly promptSearch: PromptSearchState
    }
  | {
      readonly _tag: "pending"
      readonly prompt: string
      readonly showWelcome: boolean
      readonly promptSearch: PromptSearchState
    }

export const HomeState = {
  idle: (
    showWelcome = false,
    promptSearch: PromptSearchState = PromptSearchStateFactory.closed(),
  ): HomeState => ({
    _tag: "idle",
    showWelcome,
    promptSearch,
  }),
  pending: (prompt: string, showWelcome: boolean, promptSearch: PromptSearchState): HomeState => ({
    _tag: "pending",
    prompt,
    showWelcome,
    promptSearch,
  }),
} as const

export type HomeEvent =
  | { readonly _tag: "SetShowWelcome"; readonly showWelcome: boolean }
  | {
      readonly _tag: "PromptSearch"
      readonly event: PromptSearchEvent
      readonly entries: readonly string[]
    }
  | { readonly _tag: "SubmitPrompt"; readonly prompt: string }
  | { readonly _tag: "InitialPrompt"; readonly prompt: string }
  | {
      readonly _tag: "SessionActivated"
      readonly sessionId: SessionId
      readonly branchId: BranchId
    }

export type HomeEffect =
  | { readonly _tag: "RestoreComposer"; readonly text: string }
  | { readonly _tag: "CreateSession" }
  | {
      readonly _tag: "NavigateToSession"
      readonly sessionId: SessionId
      readonly branchId: BranchId
      readonly prompt: string
    }

export interface HomeTransitionResult {
  readonly state: HomeState
  readonly effects: readonly HomeEffect[]
}

const updatePromptSearch = (state: HomeState, promptSearch: PromptSearchState): HomeState =>
  state._tag === "pending"
    ? HomeState.pending(state.prompt, state.showWelcome, promptSearch)
    : HomeState.idle(state.showWelcome, promptSearch)

export function transitionHome(state: HomeState, event: HomeEvent): HomeTransitionResult {
  switch (event._tag) {
    case "SetShowWelcome":
      return {
        state:
          state._tag === "pending"
            ? HomeState.pending(state.prompt, event.showWelcome, state.promptSearch)
            : HomeState.idle(event.showWelcome, state.promptSearch),
        effects: [],
      }

    case "PromptSearch": {
      const result = transitionPromptSearch(state.promptSearch, event.event, event.entries)
      return {
        state: updatePromptSearch(state, result.state),
        effects: result.effects
          .filter((effect) => effect._tag === "Preview")
          .map((effect) => ({
            _tag: "RestoreComposer" as const,
            text: effect.text,
          })),
      }
    }

    case "SubmitPrompt":
    case "InitialPrompt":
      return {
        state: HomeState.pending(event.prompt, state.showWelcome, state.promptSearch),
        effects: [{ _tag: "CreateSession" }],
      }

    case "SessionActivated":
      if (state._tag !== "pending") {
        return { state, effects: [] }
      }
      return {
        state: HomeState.idle(state.showWelcome, state.promptSearch),
        effects: [
          {
            _tag: "NavigateToSession",
            sessionId: event.sessionId,
            branchId: event.branchId,
            prompt: state.prompt,
          },
        ],
      }
  }
}
