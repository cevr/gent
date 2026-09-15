import { Array, Match, type Option, Predicate, Schema } from "effect"
import type { Accessor } from "solid-js"

/** A menu item in the command palette. */
export interface PaletteItem {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly category?: string
  readonly shortcut?: string
  readonly disabled?: boolean
  readonly onSelect: () => void
}

/** A structural level in the palette stack.
 *
 *  `source` is a Solid accessor — can be a plain function for sync levels
 *  or a `Resource` for async levels. Returns `undefined` while loading. */
export interface PaletteLevel {
  readonly id: string
  readonly title: string
  // eslint-disable-next-line effect/noNullish -- Solid Resource returns undefined while its request is pending.
  readonly source: Accessor<readonly PaletteItem[] | undefined>
  readonly onEnter?: () => void
}

/**
 * What the palette owns beyond its list: the level stack and the category
 * lens on the current level. The query and the cursor belong to the
 * `SelectList` it mounts.
 */
export interface CommandPaletteState {
  readonly levelStack: readonly PaletteLevel[]
  readonly category: string
}

const PaletteSourceSchema = Schema.declare<PaletteLevel["source"]>(
  (value): value is PaletteLevel["source"] => Predicate.isFunction(value),
)
const PaletteOnEnterSchema = Schema.declare<() => void>((value): value is () => void =>
  Predicate.isFunction(value),
)
const PaletteLevelSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  source: PaletteSourceSchema,
  onEnter: Schema.optionalKey(PaletteOnEnterSchema),
})

export const CommandPaletteEvent = Schema.TaggedUnion({
  Open: { rootLevel: PaletteLevelSchema },
  Close: {},
  PushLevel: { level: PaletteLevelSchema },
  PopLevel: {},
  SelectCategory: { category: Schema.String },
})
export type CommandPaletteEvent = Schema.Schema.Type<typeof CommandPaletteEvent>

const initial = (): CommandPaletteState => ({
  levelStack: [],
  category: "",
})

const currentLevel = (state: CommandPaletteState): Option.Option<PaletteLevel> =>
  Array.last(state.levelStack)

const pushLevel = (state: CommandPaletteState, level: PaletteLevel): CommandPaletteState => ({
  levelStack: [...state.levelStack, level],
  category: "",
})

const popLevel = (state: CommandPaletteState): CommandPaletteState => {
  if (state.levelStack.length <= 1) return state
  return {
    levelStack: state.levelStack.slice(0, -1),
    category: "",
  }
}

export const CommandPaletteState = {
  initial,
  currentLevel,
}

export function transitionCommandPalette(
  state: CommandPaletteState,
  event: CommandPaletteEvent,
): CommandPaletteState {
  return Match.value(event).pipe(
    Match.tagsExhaustive({
      Open: (event) => ({ ...initial(), levelStack: [event.rootLevel] }),
      Close: () => initial(),
      PushLevel: (event) => pushLevel(state, event.level),
      PopLevel: () => popLevel(state),
      SelectCategory: (event) => ({ ...state, category: event.category }),
    }),
  )
}
