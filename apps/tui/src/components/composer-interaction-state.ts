import type { AutocompleteState, AutocompleteType } from "./autocomplete-popup"

export interface ComposerInteractionState {
  readonly draft: string
  readonly mode: "editing" | "shell"
  readonly autocomplete: AutocompleteState | null
}

export const ComposerInteractionState = {
  initial: (): ComposerInteractionState => ({
    draft: "",
    mode: "editing",
    autocomplete: null,
  }),
} as const

export type ComposerInteractionEvent =
  | { readonly _tag: "DraftChanged"; readonly text: string }
  | { readonly _tag: "RestoreDraft"; readonly text: string }
  | { readonly _tag: "ClearDraft" }
  | { readonly _tag: "EnterShell" }
  | { readonly _tag: "ExitShell" }
  | { readonly _tag: "OpenAutocomplete"; readonly autocomplete: AutocompleteState }
  | { readonly _tag: "CloseAutocomplete" }

const deriveAutocomplete = (
  state: ComposerInteractionState,
  text: string,
): AutocompleteState | null => {
  if (state.mode === "shell") return null

  if (state.autocomplete !== null && state.autocomplete.type === "/") {
    return text.startsWith("/") ? { type: "/", filter: text.slice(1), triggerPos: 0 } : null
  }

  const match = text.match(/(?:^|[\s])([$@])([^\s]*)$/)
  if (match === null) return null
  const [fullMatch, prefix, filter] = match
  if (prefix === undefined || prefix.length === 0) return null
  const triggerPos = text.length - fullMatch.length + (fullMatch.startsWith(" ") ? 1 : 0)
  return {
    type: prefix as AutocompleteType,
    filter: filter ?? "",
    triggerPos,
  }
}

export function transitionComposerInteraction(
  state: ComposerInteractionState,
  event: ComposerInteractionEvent,
): ComposerInteractionState {
  switch (event._tag) {
    case "DraftChanged":
      return {
        ...state,
        draft: event.text,
        autocomplete: deriveAutocomplete(state, event.text),
      }

    case "RestoreDraft":
      return {
        ...state,
        draft: event.text,
        autocomplete: null,
      }

    case "ClearDraft":
      return {
        ...state,
        draft: "",
        autocomplete: null,
      }

    case "EnterShell":
      return {
        ...state,
        mode: "shell",
        autocomplete: null,
      }

    case "ExitShell":
      return {
        ...state,
        mode: "editing",
        autocomplete: null,
      }

    case "OpenAutocomplete":
      return {
        ...state,
        autocomplete: event.autocomplete,
      }

    case "CloseAutocomplete":
      return {
        ...state,
        autocomplete: null,
      }
  }
}
