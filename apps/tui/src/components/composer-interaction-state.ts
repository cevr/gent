import { Option, Schema } from "effect"
import type { AutocompleteContribution } from "../extensions/client-facets.js"

export interface AutocompleteState {
  type: string
  filter: string
  triggerPos: number
}

export interface ComposerInteractionState {
  readonly draft: string
  readonly mode: "editing" | "shell"
  readonly autocomplete: Option.Option<AutocompleteState>
}

export const ComposerInteractionState = {
  initial: (): ComposerInteractionState => ({
    draft: "",
    mode: "editing",
    autocomplete: Option.none(),
  }),
}

export const ComposerInteractionEvent = Schema.TaggedUnion({
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
): Option.Option<AutocompleteState> => {
  if (_state.mode === "shell") return Option.none()

  const prefixes = contributions.map((c) => c.prefix)
  if (prefixes.length === 0) return Option.none()

  const escaped = prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  const regex = new RegExp(`(?:^|[\\s])([${escaped.join("")}])([^\\s]*)$`)
  return Option.fromNullishOr(regex.exec(text)).pipe(
    Option.flatMap((match) =>
      Option.all([
        Option.fromNullishOr(match[0]),
        Option.fromNullishOr(match[1]),
        Option.fromNullishOr(match[2]),
      ]),
    ),
    Option.flatMap(([fullMatch, prefix, filter]) => {
      if (prefix.length === 0) return Option.none()
      let leadingWhitespaceLength = 0
      if (fullMatch.startsWith(" ")) leadingWhitespaceLength = 1
      const triggerPos = text.length - fullMatch.length + leadingWhitespaceLength

      if (prefix === "/" && triggerPos !== 0) return Option.none()
      return Option.some({ type: prefix, filter, triggerPos })
    }),
  )
}

export function transitionComposerInteraction(
  state: ComposerInteractionState,
  event: ComposerInteractionEvent,
  contributions: ReadonlyArray<AutocompleteContribution> = [],
): ComposerInteractionState {
  if (event._tag === "DraftChanged") {
    return {
      ...state,
      draft: event.text,
      autocomplete: deriveAutocomplete(state, event.text, contributions),
    }
  }

  if (event._tag === "RestoreDraft") {
    return { ...state, draft: event.text, autocomplete: Option.none() }
  }

  if (event._tag === "ClearDraft") {
    return { ...state, draft: "", autocomplete: Option.none() }
  }

  if (event._tag === "EnterShell") {
    return { ...state, mode: "shell", autocomplete: Option.none() }
  }

  if (event._tag === "ExitShell") {
    return { ...state, mode: "editing", autocomplete: Option.none() }
  }

  return { ...state, autocomplete: Option.none() }
}
