/** @jsxImportSource @opentui/solid */
import {
  type Accessor,
  createContext,
  createEffect,
  createRoot,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup,
  Show,
  useContext,
} from "solid-js"
import { Clock, Effect, Fiber, Match, Option, Schedule, Schema } from "effect"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { type ScopedKeyboardEvent, useScopedKeyboard, useTerminalDimensions } from "./terminal"
import { useTheme } from "./theme"
import type { MessageRowProps } from "./extensions/client-facets"

// ── spinner clock ───────────────────────────────────────────────────────────

const ticker = createRoot(() => {
  const [tick, setTick] = createSignal(0)
  const fiber = Effect.runFork(
    Effect.sync(() => {
      setTick((current) => current + 1)
    }).pipe(Effect.repeat(Schedule.spaced("60 millis"))),
  )
  onCleanup(() => {
    Effect.runFork(Fiber.interrupt(fiber))
  })
  return tick
})

export const useSpinnerClock = (): Accessor<number> => ticker

// ── wait helper ─────────────────────────────────────────────────────────────

class WaitForTimeout extends Schema.TaggedError<WaitForTimeout>()("WaitForTimeout", {
  label: Schema.String,
}) {
  override get message(): string {
    return `timed out waiting for ${this.label}`
  }
}

/**
 * Poll a synchronous probe until it returns a defined value or the deadline
 * elapses. Production-side equivalent of the test-utils `waitFor` helper.
 * Suitable for DOM-shaped retries (frame N may not have rendered the element
 * yet; frame N+1 will) where there is no event signal to subscribe to.
 */
const waitFor = <A,>(
  probe: () => Option.Option<A>,
  options: { label: string; intervalMs?: number; timeoutMs?: number },
): Effect.Effect<A, WaitForTimeout> =>
  Effect.gen(function* () {
    const interval = options.intervalMs ?? 30
    const deadline = (yield* Clock.currentTimeMillis) + (options.timeoutMs ?? 500)
    const loop: Effect.Effect<A, WaitForTimeout> = Effect.gen(function* () {
      const value = probe()
      if (Option.isSome(value)) return value.value
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        return yield* new WaitForTimeout({ label: options.label })
      }
      yield* Effect.sleep(`${interval} millis`)
      return yield* loop
    })
    return yield* loop
  })

// ── scroll sync ─────────────────────────────────────────────────────────────

/**
 * useScrollSync Hook
 *
 * Provides ID-based scroll synchronization for scrollbox components.
 * Finds elements by ID and scrolls to keep them visible in the viewport.
 */

interface ScrollSyncOptions {
  /** Synchronize only while the target list is mounted. */
  enabled?: Accessor<boolean>
  /** The scrollbox ref getter */
  // eslint-disable-next-line effect/noNullish -- OpenTUI refs are absent before attachment and after cleanup.
  getRef: () => ScrollBoxRenderable | undefined
  /** Number of retries when element not found (default: 15) */
  retries?: number
  /** Delay between retries in ms (default: 30) */
  retryDelay?: number
}

/**
 * ID-based scroll sync - finds element by ID and scrolls to keep it visible
 */
function useScrollSync(selectedId: Accessor<string>, options: ScrollSyncOptions) {
  const { getRef, retries = 15, retryDelay = 30 } = options
  const renderer = useRenderer()

  const syncScroll = (id: string): Option.Option<true> => {
    const scrollRef = Option.fromNullishOr(getRef())
    if (Option.isNone(scrollRef)) return Option.none()

    const children = scrollRef.value.getChildren()
    const target = Option.fromNullishOr(children.find((child) => child.id === id))
    if (Option.isNone(target)) return Option.none()

    const relativeY = target.value.y - scrollRef.value.y
    const viewportHeight = scrollRef.value.height

    // Scroll if element is outside viewport
    if (relativeY < 0) {
      scrollRef.value.scrollBy(relativeY)
    } else if (relativeY + target.value.height > viewportHeight) {
      scrollRef.value.scrollBy(relativeY + target.value.height - viewportHeight)
    }
    return Option.some(true)
  }

  createEffect(() => {
    if (options.enabled && !options.enabled()) return
    const id = selectedId()
    let fiber = Option.none<Fiber.Fiber<void>>()
    const afterLayout = () => {
      fiber = Option.some(
        Effect.runFork(
          waitFor(() => syncScroll(id), {
            label: `scroll-target ${id}`,
            intervalMs: retryDelay,
            timeoutMs: retries * retryDelay,
          }).pipe(Effect.ignore),
        ),
      )
    }
    renderer.once("frame", afterLayout)
    renderer.requestRender()
    onCleanup(() => {
      renderer.off("frame", afterLayout)
      if (Option.isSome(fiber)) Effect.runFork(Fiber.interrupt(fiber.value))
    })
  })
}

// ── chrome panel ────────────────────────────────────────────────────────────

/**
 * ChromePanel — compound component for overlay panels with rounded chrome borders.
 *
 * `Root` floats at a position and size the caller gives it. The rows inside —
 * `Body`, `Section`, `Error`, `Footer` — are shared with the ruled
 * `PickerFrame` the docked panes draw.
 *
 * Usage:
 *   <ChromePanel.Root title="Commands" width={50} height={14} left={10} top={5}>
 *     <ChromePanel.Body>
 *       {scrollable content}
 *     </ChromePanel.Body>
 *     <ChromePanel.Footer>
 *       ↑↓ navigate · enter select · esc close
 *     </ChromePanel.Footer>
 *   </ChromePanel.Root>
 *
 * Root renders the positioned box with rounded borders, backdrop, and title.
 * Body is a flexGrow scrollbox for the main content.
 * Footer is a flexShrink text row at the bottom.
 */

// ── Root ──────────────────────────────────────────────────────────

interface ChromePanelRootProps {
  title?: string
  width: number
  height: number
  left: number
  top?: number
  children: JSX.Element
}

function ChromePanelRoot(props: ChromePanelRootProps) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  return (
    <>
      {/* Transparent backdrop */}
      <box
        position="absolute"
        left={0}
        top={0}
        width={dimensions().width}
        height={dimensions().height}
        backgroundColor="transparent"
      />

      {/* Panel */}
      <box
        position="absolute"
        left={props.left}
        top={props.top}
        width={props.width}
        height={props.height}
        backgroundColor={theme.backgroundMenu}
        border
        borderStyle="rounded"
        borderColor={theme.borderSubtle}
        flexDirection="column"
        title={props.title}
      >
        {props.children}
      </box>
    </>
  )
}

// ── Body ──────────────────────────────────────────────────────────

interface ChromePanelBodyProps {
  ref?: (el: ScrollBoxRenderable) => void
  /** Hold the view on the last row as rows arrive, so a squeezed body shows the newest. */
  stickToBottom?: boolean
  paddingLeft?: number
  paddingRight?: number
  children: JSX.Element
}

function ChromePanelBody(props: ChromePanelBodyProps) {
  const sticky = () => props.stickToBottom === true
  const stickyStart = () => Option.filter(Option.some<"bottom">("bottom"), sticky)
  return (
    <scrollbox
      ref={props.ref}
      flexGrow={1}
      stickyScroll={sticky()}
      stickyStart={Option.getOrUndefined(stickyStart())}
      verticalScrollbarOptions={{ visible: false }}
      horizontalScrollbarOptions={{ visible: false }}
      paddingLeft={props.paddingLeft ?? 1}
      paddingRight={props.paddingRight ?? 1}
    >
      {props.children}
    </scrollbox>
  )
}

// ── Footer ────────────────────────────────────────────────────────

interface ChromePanelFooterProps {
  children: JSX.Element
}

function ChromePanelFooter(props: ChromePanelFooterProps) {
  const { theme } = useTheme()

  return (
    <box flexShrink={0} paddingLeft={1}>
      <text style={{ fg: theme.textMuted }}>{props.children}</text>
    </box>
  )
}

// ── Section ───────────────────────────────────────────────────────

interface ChromePanelSectionProps {
  children: JSX.Element
}

function ChromePanelSection(props: ChromePanelSectionProps) {
  return (
    <box paddingLeft={1} paddingRight={1} flexShrink={0}>
      {props.children}
    </box>
  )
}

// ── Error ─────────────────────────────────────────────────────────

interface ChromePanelErrorProps {
  error?: string
}

function ChromePanelError(props: ChromePanelErrorProps) {
  const { theme } = useTheme()

  return (
    <Show when={props.error}>
      {(error) => (
        <box paddingLeft={1} paddingRight={1} flexShrink={0}>
          <text style={{ fg: theme.error }}>{error()}</text>
        </box>
      )}
    </Show>
  )
}

// ── Success ───────────────────────────────────────────────────────

interface ChromePanelSuccessProps {
  message?: string
}

function ChromePanelSuccess(props: ChromePanelSuccessProps) {
  const { theme } = useTheme()

  return (
    <Show when={props.message}>
      {(message) => (
        <box paddingLeft={1} paddingRight={1} flexShrink={0}>
          <text style={{ fg: theme.primary }}>✓ {message()}</text>
        </box>
      )}
    </Show>
  )
}

// ── Compound export ───────────────────────────────────────────────

export const ChromePanel = {
  Root: ChromePanelRoot,
  Body: ChromePanelBody,
  Section: ChromePanelSection,
  Footer: ChromePanelFooter,
  Error: ChromePanelError,
  Success: ChromePanelSuccess,
}

// ── picker frame ────────────────────────────────────────────────────────────

/**
 * PickerFrame — the presentation every picker under the composer shares.
 *
 * A picker is a title row, a body, and one muted footer line, inside a frame
 * ruled off top and bottom. The composer's autocomplete popup, the command
 * palette, and the docked panes all draw exactly that, so it lives here once
 * rather than being hand-rolled per pane: a pane supplies the title text, the
 * rows, and the hint, and agrees to the height rule by construction.
 *
 * The frame rules rather than boxes: a picker sits directly under the
 * composer's label line and a full border would read as a floating dialog
 * over the transcript instead of a continuation of the input.
 *
 * @module
 */

/**
 * Rows the frame occupies: the items it shows, capped at six, plus its own
 * chrome, and never more than half the terminal. A picker that grew with its
 * list would push the transcript off a short screen.
 */
export const pickerHeight = (itemCount: number, terminalRows: number): number =>
  Math.min(Math.min(Math.max(itemCount, 1), 6) + 5, Math.max(6, Math.floor(terminalRows / 2) + 1))

/**
 * The rule counted in lines a pane actually draws, not items it holds.
 *
 * {@link pickerHeight} budgets one body line per item, which is right for a
 * flat list. A pane that opens each group with a heading, or draws a detail
 * line under the list, spends more lines than it has items: counting items
 * alone starves the body, so the last rows fall past the rule and the detail
 * line overprints them.
 *
 * `extraLines` is what the pane draws beyond its selectable rows — headings
 * already counted among `drawnItems`, plus any trailing chrome.
 */
export const pickerLines = (drawnItems: number, extraLines: number): number => {
  if (drawnItems === 0) return 0
  return drawnItems + extraLines
}

/**
 * The columns a picker row may use.
 *
 * A picker rules off top and bottom only, so unlike a docked pane it spends
 * nothing on side borders or margins. What it does spend sits inside: a row
 * is drawn in the list body, and `ChromePanel.Body` pads one column each
 * side, so a row keeps its own left pad on top of those two.
 *
 * Budgeting only the row's own pad leaves a line exactly as wide as the
 * terminal, and a row that fills its last column wraps the tail — a
 * right-aligned age lands on a line of its own.
 */
interface PickerGeometry {
  /**
   * Columns a row may use: the list body pads 1 each side and the row itself
   * pads 1 more on the left, so a row spends 3 of the rule's columns.
   */
  readonly rowWidth: () => number
  /**
   * A `Section` sits outside the body's padding and pads 1 each side, and
   * carries no extra row pad — one column more than {@link rowWidth}.
   */
  readonly sectionWidth: () => number
}

export const usePickerGeometry = (): PickerGeometry => {
  const dimensions = useTerminalDimensions()
  return {
    rowWidth: () => Math.max(0, dimensions().width - 3),
    sectionWidth: () => Math.max(0, dimensions().width - 2),
  }
}

// ── docked panes ────────────────────────────────────────────────────────────

/**
 * Which docked panes are open. `DockProvider` wraps the whole app; a
 * `PickerFrame` counts itself while it is mounted, and a `TrayFrame` hides
 * while any is open. Without a provider nothing is counted and trays show.
 */
interface DockState {
  readonly paneOpen: () => boolean
  /** Counts one open pane; the returned release uncounts it. */
  readonly open: () => () => void
}

const DockContext = createContext<Option.Option<DockState>>(Option.none())

/** The app's dock: the panes the reader opened win the footer's rows over the trays. */
export function DockProvider(props: { children: JSX.Element }) {
  const [panes, setPanes] = createSignal(0)
  const dock: DockState = {
    paneOpen: () => panes() > 0,
    open: () => {
      setPanes((count) => count + 1)
      return () => setPanes((count) => count - 1)
    },
  }
  return <DockContext.Provider value={Option.some(dock)}>{props.children}</DockContext.Provider>
}

/**
 * The rows a `PickerFrame` body has between its title and its bottom rule,
 * once the frame is measured. A pane whose fixed lines can outnumber them
 * drops its optional lines against this count.
 */
const PickerBodyRowsContext = createContext<() => Option.Option<number>>(() => Option.none())

export const usePickerBodyRows = (): (() => Option.Option<number>) =>
  useContext(PickerBodyRowsContext)

/** Two rules, the title and one body row: below this the title gives way. */
const PICKER_ROWS_WITH_TITLE = 4

export function PickerFrame(props: {
  height: number
  /** The muted heading row. A picker that carries counts puts them in here. */
  title: string
  children: JSX.Element
  footer: JSX.Element
}) {
  const { theme } = useTheme()
  const dock = useContext(DockContext)
  if (Option.isSome(dock)) onCleanup(dock.value.open())
  // The height is what the frame asks for. When the footer it docks in runs
  // out of rows, the trays are already hidden (`TrayFrame`) and the frame is
  // the one box that gives way, in whole rows. Squeezed, it drops its key
  // hint, then its title, before its body's last row: the rows the reader
  // opened it for win. A change of either the measured or the requested
  // height re-decides it. The body reads the rows it has from
  // `usePickerBodyRows`, so a pane can drop its own optional lines to fit.
  const [measured, setMeasured] = createSignal(Option.none<number>())
  const squeezed = () => Option.exists(measured(), (rows) => rows < props.height)
  const titled = () => !Option.exists(measured(), (rows) => rows < PICKER_ROWS_WITH_TITLE)
  const bodyRows = () =>
    Option.map(measured(), (rows) => {
      let chrome = 2
      if (titled()) chrome += 1
      if (!squeezed()) chrome += 1
      return Math.max(0, rows - chrome)
    })
  return (
    <box
      flexDirection="column"
      flexShrink={1}
      width="100%"
      // A basis, not a height: OpenTUI turns shrinking off on a box whose height is set.
      flexBasis={props.height}
      onSizeChange={function () {
        setMeasured(Option.some(this.height))
      }}
    >
      <box
        flexDirection="column"
        flexGrow={1}
        border={["top", "bottom"]}
        borderColor={theme.border}
      >
        <Show when={titled()}>
          <box height={1} flexShrink={0} overflow="hidden">
            <text wrapMode="none" truncate style={{ fg: theme.textMuted }}>
              {props.title}
            </text>
          </box>
        </Show>
        <PickerBodyRowsContext.Provider value={bodyRows}>
          {props.children}
        </PickerBodyRowsContext.Provider>
      </box>
      <Show when={!squeezed()}>
        <text height={1} flexShrink={0} wrapMode="none" truncate style={{ fg: theme.textMuted }}>
          {props.footer}
        </text>
      </Show>
    </box>
  )
}

// ── tray frame ──────────────────────────────────────────────────────────────

/**
 * TrayFrame — ambient rows under the status line: children that work on their
 * own, wakes still pending. A tray is chrome about background work: it hides
 * while a docked pane is open, so the pane the reader opened gets the rows.
 */
export function TrayFrame(props: { children: JSX.Element }) {
  const dock = useContext(DockContext)
  const paneOpen = () => Option.exists(dock, (current) => current.paneOpen())
  return (
    <Show when={!paneOpen()}>
      <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1}>
        {props.children}
      </box>
    </Show>
  )
}

// ── select list ─────────────────────────────────────────────────────────────

/**
 * SelectList — the one selectable list in the TUI.
 *
 * Every pane that lets a reader move a cursor down rows and press enter is
 * this component. It owns the whole block of list behavior:
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
        Backspace: () => {
          if (state.query.length === 0) return state
          return { query: state.query.slice(0, -1), selectedIndex: 0 }
        },
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

/**
 * The two moves a pane makes on the list from outside a key press.
 *
 * A pane that swaps the rows under the reader — a level pushed, a category
 * cycled — wants the cursor back at the top, and sometimes the query gone
 * with it. Neither is a key the list can see, so the pane asks through this.
 */
export interface SelectListApi {
  /** As if the pane opened again: query cleared, cursor on the sticky row. */
  readonly reset: () => void
  /** Move the cursor without touching the query. */
  readonly moveTo: (index: number) => void
}

interface SelectListFilter {
  /**
   * Called on every query change. A pane that filters its own rows locally
   * keeps the query it was handed; a pane whose server owns the search
   * refetches here.
   */
  readonly onQueryChange: (query: string) => void
  /** Draw the `› query│` row above the list. Defaults to true. */
  readonly showInput?: boolean
}

interface SelectListProps<A> {
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
  /** Handed the list's {@link SelectListApi} once, on mount. */
  readonly api?: (api: SelectListApi) => void
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
  const reset = () => {
    const index = Option.getOrElse(anchor(values()), () => 0)
    setState(SelectListState.initial(index))
    if (props.filter) props.filter.onQueryChange("")
  }
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (open) reset()
      },
    ),
  )

  if (props.api) {
    props.api({
      reset,
      moveTo: (index) =>
        setState((current) =>
          transitionSelectList(
            current,
            SelectListEvent.cases.Anchor.make({ selectedIndex: Math.max(0, index) }),
          ),
        ),
    })
  }

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

// ── gutter text ─────────────────────────────────────────────────────────────

/**
 * GutterText — line-numbered content display.
 *
 * Renders content with line numbers in a gutter column:
 *   42 │ const foo = "bar"
 *   43 │ const baz = "qux"
 *
 * `startLine` offsets the numbers for a file excerpt.
 */

interface GutterTextProps {
  /** Lines to display */
  lines: string[]
  /** Starting line number (1-based). Default: 1 */
  startLine?: number
}

export function GutterText(props: GutterTextProps) {
  const { theme } = useTheme()

  const startLine = () => props.startLine ?? 1
  const gutterWidth = () => Math.max(3, String(startLine() + props.lines.length - 1).length)

  return (
    <box flexDirection="column">
      <For each={props.lines}>
        {(line, index) => {
          const lineNum = () => startLine() + index()
          const gutter = () => String(lineNum()).padStart(gutterWidth())
          return (
            <text>
              <span style={{ fg: theme.textMuted }}>{gutter()} │ </span>
              <span style={{ fg: theme.text }}>{line}</span>
            </text>
          )
        }}
      </For>
    </box>
  )
}

// ── tool frame ──────────────────────────────────────────────────────────────

/** Tool status header with expandable, indented output. */

const ToolCallIdentityContext = createContext<Option.Option<string>>(Option.none())

interface ToolCallIdentityProviderProps {
  id: string
  children: JSX.Element
}

export function ToolCallIdentityProvider(props: ToolCallIdentityProviderProps) {
  return (
    <ToolCallIdentityContext.Provider value={Option.some(props.id)}>
      {props.children}
    </ToolCallIdentityContext.Provider>
  )
}

const ToolFrameBodyContext = createContext(false)

/**
 * The transcript row owns the header; registered renderers supply its body.
 * It holds for one frame: a frame nested in that body (a cell's op) draws its
 * own header again.
 */
export function ToolFrameBody(props: { children: JSX.Element }) {
  return (
    <ToolFrameBodyContext.Provider value={true}>{props.children}</ToolFrameBodyContext.Provider>
  )
}

interface ToolFrameProps {
  /** Tool display name */
  title: string
  /** Input summary shown after title */
  subtitle?: string
  /** OSC8 hyperlink href for the subtitle */
  subtitleHref?: string
  /** Status: drives icon */
  status: "running" | "completed" | "error"
  /** Whether box content is expanded */
  expanded: boolean
  /** Box content */
  children?: JSX.Element
  /** Collapsed summary (shown when not expanded) */
  collapsedContent?: JSX.Element
}

export function formatToolCallIdentity(identity: string): string {
  if (identity.length <= 14) return identity
  return `${identity.slice(0, 8)}…${identity.slice(-4)}`
}

/**
 * A frame draws no margin outside itself. The transcript block that holds it
 * owns the gap to the next block, so each block ends where its last row does.
 */
export function ToolFrame(props: ToolFrameProps) {
  const { theme } = useTheme()
  const callIdentity = useContext(ToolCallIdentityContext)
  const bodyOnly = useContext(ToolFrameBodyContext)
  const [localExpanded, setLocalExpanded] = createSignal(props.expanded)

  createEffect(() => {
    setLocalExpanded(props.expanded)
  })

  const statusIcon = () => {
    if (props.status === "running") return "⋯"
    if (props.status === "error") return "✕"
    return "●"
  }

  const statusColor = () => {
    if (props.status === "error") return theme.error
    return theme.textMuted
  }

  const expandIndicator = () => {
    if (localExpanded()) return "▾"
    return "▸"
  }

  const callIdentityLabel = () =>
    Option.map(callIdentity, (identity) => `#${formatToolCallIdentity(identity)}`).pipe(
      Option.getOrUndefined,
    )

  return (
    <box flexDirection="column">
      <Show when={!bodyOnly}>
        <box flexDirection="row" onMouseDown={() => setLocalExpanded((prev) => !prev)}>
          <text flexGrow={1} flexShrink={1}>
            <span style={{ fg: statusColor() }}>{statusIcon()} </span>
            <Show when={props.status === "error"}>
              <span style={{ fg: theme.error }}>failed </span>
            </Show>
            <span style={{ fg: theme.text, bold: true }}>{props.title}</span>
            <Show when={props.subtitle}>
              <Show
                when={props.subtitleHref}
                fallback={<span style={{ fg: theme.textMuted }}> {props.subtitle}</span>}
              >
                {(href) => (
                  <a href={href()}>
                    <span style={{ fg: theme.textMuted }}> {props.subtitle}</span>
                  </a>
                )}
              </Show>
            </Show>
          </text>
          <text flexShrink={0} wrapMode="none">
            <Show when={callIdentityLabel()}>
              {(identity) => <span style={{ fg: theme.textMuted }}> {identity()}</span>}
            </Show>
            <span style={{ fg: theme.textMuted }}> {expandIndicator()}</span>
          </text>
        </box>
      </Show>

      <Show
        when={localExpanded()}
        fallback={
          <Show when={props.collapsedContent}>
            <box paddingLeft={2} flexDirection="column">
              <ToolFrameBodyContext.Provider value={false}>
                {props.collapsedContent}
              </ToolFrameBodyContext.Provider>
            </box>
          </Show>
        }
      >
        <Show when={props.children}>
          <box paddingLeft={2} flexDirection="column">
            <ToolFrameBodyContext.Provider value={false}>
              {props.children}
            </ToolFrameBodyContext.Provider>
          </box>
        </Show>
      </Show>
    </box>
  )
}

// ── message rows ────────────────────────────────────────────────────────────

/**
 * The rows a user-role message draws: the plain rail row, and the one-line
 * row a harness message collapses to. The transcript draws them by default,
 * and a message renderer composes them for its own custom type.
 */

/** The rail row: images, the pending label, then the text; `header` is a muted line above it. */
export function UserRow(props: MessageRowProps & { readonly header?: string }) {
  const { theme } = useTheme()
  const textColor = () => {
    if (props.interjection) return theme.warning
    return theme.text
  }
  const labelColor = () => {
    if (props.interjection) return theme.warning
    return theme.textMuted
  }
  const railColor = () => {
    if (props.interjection) return theme.warning
    return theme.primary
  }
  return (
    <box
      marginTop={1}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
      border={["left"]}
      borderStyle="heavy"
      borderColor={railColor()}
    >
      <Show when={props.images.length > 0}>
        <For each={props.images}>
          {(img) => (
            <text style={{ fg: theme.info }}>[Image: {img.mediaType.replace("image/", "")}]</text>
          )}
        </For>
      </Show>
      <Show when={props.content.length > 0}>
        <box flexDirection="column">
          <Show when={props.header}>
            {(header) => <text style={{ fg: theme.textMuted }}>{header()}</text>}
          </Show>
          <Show when={props.pendingMode}>
            {(value) => (
              <text>
                <span style={{ fg: labelColor(), bold: true }}>[{value()}]</span>
              </text>
            )}
          </Show>
          <text style={{ fg: textColor() }}>
            <span style={{ bold: true }}>{props.content}</span>
          </text>
        </box>
      </Show>
    </box>
  )
}

/** One muted line behind the rail glyph, in place of the whole message. */
export function CollapsedRow(props: { readonly label: string }) {
  const { theme } = useTheme()
  return (
    <box marginTop={1} flexDirection="row">
      <text width={1} flexShrink={0} style={{ fg: theme.textMuted }}>
        ┃
      </text>
      <text paddingLeft={1} style={{ fg: theme.textMuted }}>
        {props.label}
      </text>
    </box>
  )
}
