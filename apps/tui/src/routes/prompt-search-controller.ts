import { PromptSearchEvent, type PromptSearchState } from "../pickers"

export interface PromptSearchController {
  readonly state: () => PromptSearchState
  /** The history the palette searches, newest first. */
  readonly entries: () => readonly string[]
  readonly isOpen: () => boolean
  readonly open: () => void
  readonly onEvent: (event: PromptSearchEvent) => void
}

export function createPromptSearchController(params: {
  readonly state: () => PromptSearchState
  readonly entries: () => readonly string[]
  readonly draft: () => string
  readonly dispatch: (event: PromptSearchEvent) => void
}): PromptSearchController {
  return {
    state: params.state,
    entries: params.entries,
    isOpen: () => params.state()._tag === "open",
    open: () => {
      params.dispatch(PromptSearchEvent.cases.Open.make({ draftBeforeOpen: params.draft() }))
    },
    onEvent: params.dispatch,
  }
}
