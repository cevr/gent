/** @jsxImportSource @opentui/solid */
/**
 * SelectList — the one selectable list in the TUI.
 *
 * Every pane that lets a reader move a cursor down rows and press enter is
 * this component. It owns the whole block those panes used to hand-write:
 * the selection index and its wrap-around, the query string, the key table
 * (up/down, ^p/^n, enter, escape, backspace, printable characters), the
 * scroll sync that keeps the cursor row in view, the sticky selection that
 * re-anchors when the data arrives, and the empty fallback.
 *
 * A caller supplies four things: the rows, how to draw one, what to do with
 * the chosen row, and what to do on escape. Everything else is optional and
 * everything else is hidden.
 *
 * The component draws rows only. Its chrome — the border, the title, the
 * detail line, the footer — stays with the pane, because no two panes agree
 * on it. What they do agree on is the interaction, and that is what lives
 * here.
 *
 * @module
 */

import { Match, Option, Schema } from "effect"
import { createEffect, createSignal, For, on, onCleanup, Show, type JSX } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useScrollSync } from "../hooks/use-scroll-sync"
import { useScopedKeyboard, type ScopedKeyboardEvent } from "../keyboard/context"
import { ChromePanel } from "./chrome-panel"
import { useTheme } from "../theme/index"

// ── State ─────────────────────────────────────────────────────────
//
// A search query plus a wrapped selection index. Nothing here knows what the
// list holds.

export interface SelectListState {
  readonly query: string
  readonly selectedIndex: number
}

export const SelectListState = {
  initial: (selectedIndex = 0): SelectListState => ({
    query: "",
    selectedIndex,
  }),
}

export const SelectListEvent = Schema.TaggedUnion({
  /** The pane opened: clear the query and sit on a row. */
  Open: { selectedIndex: Schema.Finite },
  /** Move the cursor without disturbing the query: the pane's data arrived. */
  Anchor: { selectedIndex: Schema.Finite },
  Backspace: {},
  MoveUp: { itemCount: Schema.Finite },
  MoveDown: { itemCount: Schema.Finite },
  TypeChar: { char: Schema.String },
  /** Keep the cursor inside a list that shrank under it. */
  Clamp: { itemCount: Schema.Finite },
})
export type SelectListEvent = Schema.Schema.Type<typeof SelectListEvent>

const wrapIndex = (selectedIndex: number, itemCount: number, direction: -1 | 1): number => {
  if (itemCount <= 0) return 0
  if (direction === -1) {
    if (selectedIndex > 0) return selectedIndex - 1
    return itemCount - 1
  }
  if (selectedIndex < itemCount - 1) return selectedIndex + 1
  return 0
}

export function transitionSelectList(
  state: SelectListState,
  event: SelectListEvent,
): SelectListState {
  const transitionEvent: (event: SelectListEvent) => SelectListState =
    Match.type<SelectListEvent>().pipe(
      Match.tagsExhaustive({
        Open: (event) => SelectListState.initial(event.selectedIndex),
        Anchor: (event) => ({ ...state, selectedIndex: event.selectedIndex }),
        Backspace: () => ({
          query: state.query.slice(0, -1),
          selectedIndex: 0,
        }),
        MoveUp: (event) => ({
          ...state,
          selectedIndex: wrapIndex(state.selectedIndex, event.itemCount, -1),
        }),
        MoveDown: (event) => ({
          ...state,
          selectedIndex: wrapIndex(state.selectedIndex, event.itemCount, 1),
        }),
        TypeChar: (event) => ({
          query: state.query + event.char,
          selectedIndex: 0,
        }),
        Clamp: (event) => {
          if (event.itemCount <= 0) return { ...state, selectedIndex: 0 }
          if (state.selectedIndex < event.itemCount) return state
          return { ...state, selectedIndex: event.itemCount - 1 }
        },
      }),
    )
  return transitionEvent(event)
}

// ── Component ─────────────────────────────────────────────────────

/** A printable ASCII character is filter input; anything else is a key. */
const printableChar = (event: ScopedKeyboardEvent): Option.Option<string> =>
  Option.filter(Option.fromNullishOr(event.sequence), (sequence) => {
    if (sequence.length !== 1) return false
    const code = sequence.charCodeAt(0)
    return code >= 32 && code <= 126
  })

/**
 * What the pane draws for one row.
 *
 * `selected` is the only thing the list tells the row about itself; the rest
 * is the pane's own data. A row that renders headings alongside its entries
 * returns them from {@link SelectListProps.rows} instead, which is why the
 * list indexes its rows rather than its rendered lines.
 */
export interface SelectListRow<A> {
  /** The value handed back to `onSelect`; a heading has none. */
  readonly value: Option.Option<A>
  /**
   * Draws the row. `selected` is an accessor, not a boolean: the row is drawn
   * once and re-reads it as the cursor moves, so reading it outside JSX freezes
   * the highlight. `id` must go on the row's own outermost box, which is what
   * the scroll sync looks for. A decoration is never selected and needs no id.
   */
  readonly render: (selected: () => boolean, id: string) => JSX.Element
}

/** A selectable entry: the common case, where every row can be chosen. */
export const selectable = <A,>(
  value: A,
  render: (selected: () => boolean, id: string) => JSX.Element,
): SelectListRow<A> => ({ value: Option.some(value), render })

/** A row that draws but cannot be chosen — a section heading, a separator. */
export const decoration = <A,>(render: () => JSX.Element): SelectListRow<A> => ({
  value: Option.none(),
  render: () => render(),
})

export interface SelectListFilter {
  /**
   * Called on every query change. A pane that filters its own rows locally
   * reads the query back from {@link SelectListApi.query}; a pane whose
   * server owns the search refetches here.
   */
  readonly onQueryChange: (query: string) => void
  /** Draw the `› query│` row above the list. Defaults to true. */
  readonly showInput?: boolean
}

export interface SelectListProps<A> {
  /** Unique among mounted lists: it keys the scroll-sync row ids. */
  readonly id: string
  /** Mount but hide when false; keys stay unbound. */
  readonly open: boolean
  readonly rows: () => ReadonlyArray<SelectListRow<A>>
  readonly onSelect: (value: A) => void
  readonly onDismiss: () => void
  readonly filter?: SelectListFilter
  /**
   * The row to sit on when the pane opens or its data arrives. Returning
   * `None` keeps the first row. Re-runs whenever the rows change, so a pane
   * whose fetch resolves after it mounts still lands on the right row.
   */
  readonly sticky?: (values: ReadonlyArray<A>) => Option.Option<number>
  /** Drawn in place of the list when it holds nothing selectable. */
  readonly empty?: () => JSX.Element
  /**
   * Keys the pane claims before the list sees them. Return true to consume.
   * The value under the cursor is passed so a pane need not track it.
   */
  readonly extraKeys?: (event: ScopedKeyboardEvent, selected: Option.Option<A>) => boolean
  /**
   * The row under the cursor, reported whenever it changes. A pane that draws
   * a detail line for the selected row, or fetches one, reads it here rather
   * than keeping a second index of its own.
   */
  readonly onCursor?: (selected: Option.Option<A>) => void
}

/**
 * The list body, plus the query row when a filter is configured. A pane wraps
 * this in its own `ChromePanel` chrome.
 */
export function SelectList<A>(props: SelectListProps<A>) {
  const { theme } = useTheme()
  const [state, setState] = createSignal(SelectListState.initial())
  let scrollRef = Option.none<ScrollBoxRenderable>()

  const rows = () => props.rows()
  /** Selectable values, in row order: the index the cursor counts in. */
  const values = (): ReadonlyArray<A> =>
    rows().flatMap((row) =>
      Option.match(row.value, {
        onNone: (): ReadonlyArray<A> => [],
        onSome: (value) => [value],
      }),
    )
  const selected = (): Option.Option<A> => Option.fromNullishOr(values()[state().selectedIndex])

  /** Where the sticky rule wants the cursor, if the pane has one. */
  const anchor = (entries: ReadonlyArray<A>): Option.Option<number> =>
    Option.map(
      Option.flatMap(Option.fromNullishOr(props.sticky), (sticky) => sticky(entries)),
      (index) => Math.max(0, index),
    )

  // Opening resets the pane: the query goes, and the sticky rule picks the row.
  // The reset reaches the filter owner too. A pane that keeps the query itself
  // would otherwise reopen showing an empty input over a still-filtered list.
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return
        const index = Option.getOrElse(anchor(values()), () => 0)
        setState(SelectListState.initial(index))
        if (props.filter) props.filter.onQueryChange("")
      },
    ),
  )

  // A pane that unmounts its list on close never sees `open` go false, so the
  // reset runs from cleanup as well: the filter owner is told the query is gone
  // whichever way the list leaves the screen.
  onCleanup(() => {
    if (props.filter) props.filter.onQueryChange("")
    if (props.onCursor) props.onCursor(Option.none())
  })

  // A pane whose fetch resolves after it opens re-anchors when the rows land.
  // Typing ends that: once the reader has a query, the rows change because they
  // asked them to, and moving their cursor for them would fight the filter. A
  // pane with no sticky rule still clamps, so a list that shrinks cannot leave
  // the cursor past its end.
  createEffect(
    on(values, (entries) => {
      if (!props.open) return
      const typed = state().query.length > 0
      setState((current) =>
        Option.match(
          Option.filter(anchor(entries), () => !typed),
          {
            onNone: () =>
              transitionSelectList(
                current,
                SelectListEvent.cases.Clamp.make({ itemCount: entries.length }),
              ),
            onSome: (index) =>
              transitionSelectList(
                current,
                SelectListEvent.cases.Anchor.make({ selectedIndex: index }),
              ),
          },
        ),
      )
    }),
  )

  useScrollSync(() => `${props.id}-row-${state().selectedIndex}`, {
    getRef: () => Option.getOrUndefined(scrollRef),
  })

  // Report the cursor, closed panes included: a pane that fetches for the
  // selected row has to be told to stop when it closes. A pane that unmounts
  // instead of closing is covered by the cleanup above.
  createEffect(
    on([() => props.open, selected], ([open, value]) => {
      if (!props.onCursor) return
      if (!open) {
        props.onCursor(Option.none())
        return
      }
      props.onCursor(value)
    }),
  )

  const applyQuery = (next: SelectListState) => {
    setState(next)
    if (props.filter) props.filter.onQueryChange(next.query)
  }

  useScopedKeyboard(
    (event) => {
      if (props.extraKeys && props.extraKeys(event, selected())) return true

      if (event.name === "escape") {
        props.onDismiss()
        return true
      }

      const count = values().length

      if (event.name === "return") {
        Option.match(selected(), {
          onNone: () => {},
          onSome: props.onSelect,
        })
        return true
      }

      if (event.name === "up" || (event.ctrl === true && event.name === "p")) {
        setState((current) =>
          transitionSelectList(current, SelectListEvent.cases.MoveUp.make({ itemCount: count })),
        )
        return true
      }

      if (event.name === "down" || (event.ctrl === true && event.name === "n")) {
        setState((current) =>
          transitionSelectList(current, SelectListEvent.cases.MoveDown.make({ itemCount: count })),
        )
        return true
      }

      if (!props.filter) return false

      if (event.name === "backspace") {
        applyQuery(transitionSelectList(state(), SelectListEvent.cases.Backspace.make({})))
        return true
      }

      const char = printableChar(event)
      if (Option.isSome(char)) {
        applyQuery(
          transitionSelectList(state(), SelectListEvent.cases.TypeChar.make({ char: char.value })),
        )
        return true
      }
      return false
    },
    { when: () => props.open },
  )

  const showInput = () =>
    Option.match(Option.fromNullishOr(props.filter), {
      onNone: () => false,
      onSome: (filter) => filter.showInput !== false,
    })

  // Values are indexed independently of rows, so the row loop counts its own.
  const indexed = () => {
    let cursor = 0
    return rows().map((row) => {
      if (Option.isNone(row.value)) return { row, index: Option.none<number>() }
      const index = cursor
      cursor += 1
      return { row, index: Option.some(index) }
    })
  }

  return (
    <>
      <Show when={showInput()}>
        <ChromePanel.Section>
          <text style={{ fg: theme.text }}>
            <span style={{ fg: theme.textMuted }}>› </span>
            {state().query}
            <span style={{ fg: theme.primary }}>│</span>
          </text>
        </ChromePanel.Section>
      </Show>

      <ChromePanel.Body ref={(value) => (scrollRef = Option.some(value))}>
        <Show when={values().length > 0} fallback={props.empty?.()}>
          <For each={indexed()}>
            {(entry) =>
              Option.match(entry.index, {
                onNone: () => entry.row.render(() => false, ""),
                onSome: (index) =>
                  entry.row.render(
                    () => state().selectedIndex === index,
                    `${props.id}-row-${index}`,
                  ),
              })
            }
          </For>
        </Show>
      </ChromePanel.Body>
    </>
  )
}
