import { Schema } from "effect"
import { TaggedEnumClass } from "@gent/core/domain/schema-tagged-enum-class"
import type { AutocompleteContribution } from "../extensions/client-facets.js"

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

export const ComposerInteractionEvent = TaggedEnumClass("ComposerInteractionEvent", {
  DraftChanged: { text: Schema.String },
  RestoreDraft: { text: Schema.String },
  ClearDraft: {},
  EnterShell: {},
  ExitShell: {},
  CloseAutocomplete: {},
})
export type ComposerInteractionEvent = Schema.Schema.Type<typeof ComposerInteractionEvent>

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

  const prefixes = contributions.map((c) => c.prefix)
  if (prefixes.length === 0) return null

  const escaped = prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  const regex = new RegExp(`(?:^|[\\s])([${escaped.join("")}])([^\\s]*)$`)
  const match = text.match(regex)
  if (match === null) return null

  const [fullMatch, prefix, filter] = match
  if (prefix === undefined || prefix.length === 0) return null

  const triggerPos = text.length - fullMatch.length + (fullMatch.startsWith(" ") ? 1 : 0)

  // "/" only activates at position 0 — skip mid-text matches like file paths
  if (prefix === "/" && triggerPos !== 0) return null

  return { type: prefix, filter: filter ?? "", triggerPos }
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
