import type { ScopedKeyboardEvent } from "../keyboard/context"
import {
  getPromptSearchItems,
  PromptSearchEvent,
  type PromptSearchState,
} from "../components/prompt-search-state"
import { promptSearchEventFromKey } from "../components/prompt-search-palette"

export interface PromptSearchController {
  readonly state: () => PromptSearchState
  readonly isOpen: () => boolean
  readonly open: () => void
  readonly onEvent: (event: PromptSearchEvent) => void
  readonly handleKey: (event: ScopedKeyboardEvent) => boolean
}

export function createPromptSearchController(params: {
  readonly state: () => PromptSearchState
  readonly entries: () => readonly string[]
  readonly draft: () => string
  readonly dispatch: (event: PromptSearchEvent, entries: readonly string[]) => void
}): PromptSearchController {
  const onEvent = (event: PromptSearchEvent) => {
    params.dispatch(event, params.entries())
  }

  return {
    state: params.state,
    isOpen: () => params.state()._tag === "open",
    open: () => {
      onEvent(PromptSearchEvent.Open.make({ draftBeforeOpen: params.draft() }))
    },
    onEvent,
    handleKey: (event) => {
      if (params.state()._tag !== "open") return false
      const promptEvent = promptSearchEventFromKey(
        event,
        getPromptSearchItems(params.state(), params.entries()).length > 0,
      )
      if (promptEvent === undefined) return false
      onEvent(promptEvent)
      return true
    },
  }
}
