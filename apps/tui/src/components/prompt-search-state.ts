import { Match, Option, Schema } from "effect"
import { matchSorter } from "match-sorter"

/**
 * Prompt search — the state behind the `ctrl+r` palette over prompt history.
 *
 * The palette's list owns the query and the cursor. This owns what the list
 * cannot see: the draft the palette opened over, and the entry under the
 * cursor once the reader has moved it. The composer previews that entry as
 * the cursor moves, keeps it on accept, and gets the draft back on cancel.
 */
export type PromptSearchState =
  | { readonly _tag: "closed" }
  | {
      readonly _tag: "open"
      readonly draftBeforeOpen: string
      /**
       * The entry under the cursor. `None` until the reader moves or types —
       * the list sits on the first entry when it opens, but the composer
       * keeps the draft until they choose — and `None` again when nothing
       * matches the query.
       */
      readonly highlighted: Option.Option<string>
    }

export const PromptSearchState = {
  closed: (): PromptSearchState => ({ _tag: "closed" }),
  open: (draftBeforeOpen: string): PromptSearchState => ({
    _tag: "open",
    draftBeforeOpen,
    highlighted: Option.none(),
  }),
}

export const PromptSearchEvent = Schema.TaggedUnion({
  Open: { draftBeforeOpen: Schema.String },
  /** The reader moved the cursor or narrowed the list; `None` when it emptied. */
  Highlight: { entry: Schema.Option(Schema.String) },
  Accept: {},
  Cancel: {},
})
export type PromptSearchEvent = Schema.Schema.Type<typeof PromptSearchEvent>

const PromptSearchEffect = Schema.TaggedUnion({
  Preview: { text: Schema.String },
  Close: {},
})
type PromptSearchEffect = Schema.Schema.Type<typeof PromptSearchEffect>

interface PromptSearchTransitionResult {
  readonly state: PromptSearchState
  readonly effects: readonly PromptSearchEffect[]
}

/** The history entries a query keeps, best match first; all of them for no query. */
export const filterPromptEntries = (
  entries: readonly string[],
  query: string,
): readonly string[] => {
  const needle = query.trim()
  if (needle.length === 0) return entries
  return matchSorter(entries, needle)
}

/** What the composer shows for an open palette: the highlighted entry, else the draft. */
const getPromptSearchPreview = (state: PromptSearchState): Option.Option<string> => {
  if (state._tag !== "open") return Option.none()
  return Option.some(Option.getOrElse(state.highlighted, () => state.draftBeforeOpen))
}

const preview = (state: PromptSearchState): PromptSearchEffect =>
  PromptSearchEffect.cases.Preview.make({
    text: Option.getOrElse(getPromptSearchPreview(state), () => ""),
  })

export function transitionPromptSearch(
  state: PromptSearchState,
  event: PromptSearchEvent,
): PromptSearchTransitionResult {
  const unchanged: PromptSearchTransitionResult = { state, effects: [] }
  return Match.value(event).pipe(
    Match.tagsExhaustive({
      Open: (event): PromptSearchTransitionResult => ({
        state: PromptSearchState.open(event.draftBeforeOpen),
        effects: [],
      }),
      Highlight: (event): PromptSearchTransitionResult => {
        if (state._tag !== "open") return unchanged
        const next: PromptSearchState = { ...state, highlighted: event.entry }
        return { state: next, effects: [preview(next)] }
      },
      Accept: (): PromptSearchTransitionResult => {
        if (state._tag !== "open") return unchanged
        return {
          state: PromptSearchState.closed(),
          effects: [preview(state), PromptSearchEffect.cases.Close.make({})],
        }
      },
      Cancel: (): PromptSearchTransitionResult => {
        if (state._tag !== "open") return unchanged
        return {
          state: PromptSearchState.closed(),
          effects: [
            PromptSearchEffect.cases.Preview.make({ text: state.draftBeforeOpen }),
            PromptSearchEffect.cases.Close.make({}),
          ],
        }
      },
    }),
  )
}
