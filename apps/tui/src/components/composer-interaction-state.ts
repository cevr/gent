import type { AutocompleteContribution } from "@gent/core/domain/extension-client.js"

export interface AutocompleteState {
  type: string
  filter: string
  triggerPos: number
}

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
  | { readonly _tag: "CloseAutocomplete" }

/**
 * Derive autocomplete state from text and registered contributions.
 * Inline triggers (like $ and @) detected anywhere after whitespace.
 * Start triggers (like /) detected only at text position 0.
 */
const deriveAutocomplete = (
  _state: ComposerInteractionState,
  text: string,
  contributions: ReadonlyArray<AutocompleteContribution>,
): AutocompleteState | null => {
  if (_state.mode === "shell") return null

  // Check startOnly prefixes — only match at position 0
  for (const c of contributions) {
    if (c.startOnly !== true) continue
    if (text.startsWith(c.prefix)) {
      return { type: c.prefix, filter: text.slice(c.prefix.length), triggerPos: 0 }
    }
  }

  // Inline prefixes — detected anywhere after whitespace or at start
  const inlinePrefixes = contributions.filter((c) => c.startOnly !== true).map((c) => c.prefix)
  if (inlinePrefixes.length > 0) {
    const escaped = inlinePrefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    const regex = new RegExp(`(?:^|[\\s])([${escaped.join("")}])([^\\s]*)$`)
    const match = text.match(regex)
    if (match !== null) {
      const [fullMatch, prefix, filter] = match
      if (prefix !== undefined && prefix.length > 0) {
        const triggerPos = text.length - fullMatch.length + (fullMatch.startsWith(" ") ? 1 : 0)
        return { type: prefix, filter: filter ?? "", triggerPos }
      }
    }
  }

  return null
}

export function transitionComposerInteraction(
  state: ComposerInteractionState,
  event: ComposerInteractionEvent,
  contributions: ReadonlyArray<AutocompleteContribution> = [],
): ComposerInteractionState {
  switch (event._tag) {
    case "DraftChanged":
      return {
        ...state,
        draft: event.text,
        autocomplete: deriveAutocomplete(state, event.text, contributions),
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

    case "CloseAutocomplete":
      return {
        ...state,
        autocomplete: null,
      }
  }
}
