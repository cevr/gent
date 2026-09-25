/** @jsxImportSource @opentui/solid */
import { Effect, Match, Option, Schema } from "effect"
import { matchSorter } from "match-sorter"
import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { PickerFrame, selectable, SelectList, type SelectListRow, usePickerGeometry } from "./ui"
import { useTheme } from "./theme"
import { formatError, shortId, truncate } from "./utils"
import { useClient, useRuntime } from "./client"
import {
  type BranchId,
  type Message,
  MessageId,
  messagePartsImages,
  messagePartsText,
  type Model,
  ReasoningEffort,
  type SessionId,
  type Branch,
  type BranchTreeNode,
} from "@gent/core/protocol"

// ── prompt search state ─────────────────────────────────────────────────────

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

/** One history entry as the search lists it, with a key no other row shares. */
interface PromptSearchItem {
  readonly text: string
  readonly key: string
}

/**
 * The history as search rows. History is newest first and dedupes only the
 * newest entry, so a text can repeat. A key counts the entry among the older
 * entries with its text, so a newer write never moves a key to another row.
 */
export const promptSearchItems = (entries: readonly string[]): readonly PromptSearchItem[] => {
  const seen = new Map<string, number>()
  const items: PromptSearchItem[] = []
  for (let index = entries.length - 1; index >= 0; index--) {
    const text = entries[index] ?? ""
    const count = seen.get(text) ?? 0
    seen.set(text, count + 1)
    items.push({ text, key: `${count}:${text}` })
  }
  return items.reverse()
}

/** The history entries a query keeps, best match first; all of them for no query. */
const filterPromptEntries = (
  entries: readonly string[],
  query: string,
): readonly PromptSearchItem[] => {
  const items = promptSearchItems(entries)
  const needle = query.trim()
  if (needle.length === 0) return items
  return matchSorter(items, needle, { keys: ["text"] })
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

// ── prompt search palette ───────────────────────────────────────────────────

/**
 * Prompt search palette — the `ctrl+r` list over prompt history.
 *
 * A docked pane in the session's pane slot, drawn in the `PickerFrame` every
 * pane draws, so a short terminal takes its rows as it takes any pane's.
 *
 * The list owns the query and the cursor and reports the entry under the
 * cursor; the palette turns those reports into the events the session's
 * prompt-search state understands. The composer previews the highlighted
 * entry, so the palette holds the first report back: the list opens on the
 * first entry, but the reader has not chosen it until they move or type.
 */

interface PromptSearchPaletteProps {
  state: PromptSearchState
  entries: readonly string[]
  onEvent: (event: PromptSearchEvent) => void
}

export function PromptSearchPalette(props: PromptSearchPaletteProps) {
  const { theme } = useTheme()
  const { rowWidth } = usePickerGeometry()

  const emptyRow = () => (
    <box paddingLeft={1}>
      <text style={{ fg: theme.textMuted }}>No prompt matches</text>
    </box>
  )

  return (
    <Show when={props.state._tag === "open"}>
      {(_open) => {
        // Per opening: the query and the touched flag start over each time.
        const [query, setQuery] = createSignal("")
        let touched = false
        const items = createMemo(() => filterPromptEntries(props.entries, query()))

        const rows = (): ReadonlyArray<SelectListRow<PromptSearchItem>> =>
          items().map((entry) =>
            selectable(entry, (isSelected, id) => {
              const backgroundColor = () => {
                if (isSelected()) return theme.primary
                return "transparent"
              }
              const textColor = () => {
                if (isSelected()) return theme.selectedListItemText
                return theme.text
              }
              return (
                <box id={id} backgroundColor={backgroundColor()} paddingLeft={1}>
                  <text wrapMode="none" style={{ fg: textColor() }}>
                    {truncate(entry.text.replace(/\s+/g, " "), rowWidth())}
                  </text>
                </box>
              )
            }),
          )

        return (
          <PickerFrame
            // The query row draws above the list, and the frame counts it.
            lines={items().length}
            queryRow
            title={`Prompt search · ${items().length}`}
            footer={"type to filter · ↑↓ move · ↵ accept · esc cancel"}
          >
            <SelectList
              id="prompt-search"
              open={true}
              rows={rows}
              rowKey={(entry) => entry.key}
              filter={{ onQueryChange: setQuery }}
              empty={emptyRow}
              extraKeys={(event) => {
                // Enter accepts whatever the composer previews, an empty list
                // included; the list would swallow it with nothing selected.
                if (event.name === "return" || event.name === "linefeed") {
                  props.onEvent(PromptSearchEvent.cases.Accept.make({}))
                  return true
                }
                touched = true
                return false
              }}
              onCursor={(entry) => {
                if (!touched) return
                props.onEvent(
                  PromptSearchEvent.cases.Highlight.make({
                    entry: Option.map(entry, (item) => item.text),
                  }),
                )
              }}
              onSelect={() => props.onEvent(PromptSearchEvent.cases.Accept.make({}))}
              onDismiss={() => props.onEvent(PromptSearchEvent.cases.Cancel.make({}))}
            />
          </PickerFrame>
        )
      }}
    </Show>
  )
}

// ── branch picker ───────────────────────────────────────────────────────────

/**
 * Branch picker — one docked pane for choosing which loop of a session to
 * resume.
 *
 * The session underneath is already mounted on its active branch, so the pane
 * only has to say which branch to switch to. It opens at boot when the resumed
 * session has more than one branch, and on `/branches` after that. While it is
 * open the startup prompt waits, so a reader never sends a `-p` prompt into a
 * branch they did not choose.
 *
 * It draws the `PickerFrame` every docked pane draws — ruled off top and
 * bottom under the composer, not a bordered box — so its height and its
 * columns come from the picker's budget rather than a dialect of its own.
 *
 * @module
 */

interface BranchPickerProps {
  readonly open: boolean
  readonly sessionId: SessionId
  readonly sessionName: string
  readonly branches: readonly Branch[]
  readonly onSelect: (branchId: BranchId) => void
  readonly onClose: () => void
}

const formatBranchLabel = (
  branch: Branch,
  messageCount: Option.Option<number> = Option.none(),
): string => {
  const name = Option.getOrElse(Option.fromNullishOr(branch.name), () => shortId(branch.id))
  const count = Option.match(messageCount, {
    onNone: () => "",
    onSome: (value) => ` (${value})`,
  })
  return `${name}${count}`
}

const collectCounts = (nodes: readonly BranchTreeNode[]): Map<string, number> => {
  const map = new Map<string, number>()
  const walk = (list: readonly BranchTreeNode[]) => {
    for (const node of list) {
      map.set(node.branch.id, node.messageCount)
      if (node.children.length > 0) walk(node.children)
    }
  }
  walk(nodes)
  return map
}

export function BranchPicker(props: BranchPickerProps) {
  const { theme } = useTheme()
  const client = useClient()
  const { cast } = useRuntime()

  const [messageCounts, setMessageCounts] = createSignal(new Map<string, number>())
  const [error, setError] = createSignal(Option.none<string>())

  createEffect(() => {
    if (!props.open) return
    cast(
      client.client.branch.getTree({ sessionId: props.sessionId }).pipe(
        Effect.tap((tree) =>
          Effect.sync(() => {
            setMessageCounts(collectCounts(tree))
            setError(Option.none())
          }),
        ),
        Effect.catchEager((err) => Effect.sync(() => setError(Option.some(formatError(err))))),
      ),
    )
  })

  const { rowWidth } = usePickerGeometry()

  const rows = (): ReadonlyArray<SelectListRow<Branch>> =>
    props.branches.map((branch) =>
      selectable(branch, (isSelected, id) => {
        const count = () => Option.fromNullishOr(messageCounts().get(branch.id))
        const backgroundColor = () => {
          if (isSelected()) return theme.primary
          return "transparent"
        }
        const foregroundColor = () => {
          if (isSelected()) return theme.selectedListItemText
          return theme.text
        }
        const line = () => formatBranchLabel(branch, count())
        return (
          <box id={id} backgroundColor={backgroundColor()} paddingLeft={1}>
            <text
              style={{
                fg: foregroundColor(),
              }}
            >
              {truncate(line(), rowWidth())}
            </text>
          </box>
        )
      }),
    )

  return (
    <Show when={props.open}>
      {/* One line per branch: no heading opens a group and no detail line
          follows the list. */}
      <PickerFrame
        lines={props.branches.length}
        title={`Resume: ${props.sessionName}`}
        footer={"↑↓ move   ↵ resume branch   esc close"}
        error={error()}
      >
        <SelectList
          id="branch-picker"
          open={props.open}
          rows={rows}
          rowKey={(branch) => branch.id}
          onSelect={(branch) => props.onSelect(branch.id)}
          onDismiss={props.onClose}
        />
      </PickerFrame>
    </Show>
  )
}

// ── message picker ──────────────────────────────────────────────────────────

interface PickerItem {
  id: string
  label: string
}

interface MessagePickerProps {
  open: boolean
  messages: readonly Message[]
  onSelect: (messageId: MessageId) => void
  onClose: () => void
}

const buildItems = (messages: readonly Message[]): PickerItem[] =>
  messages.map((m) => {
    let rolePrefix = "A"
    if (m.role === "user") rolePrefix = "U"
    let labelContent = messagePartsText(m.parts).replace(/\s+/g, " ")
    const images = messagePartsImages(m.parts)
    if (labelContent.length === 0 && images.length > 0) {
      let imageCount = ""
      if (images.length > 1) imageCount = ` x${images.length}`
      labelContent = `[Image${imageCount}]`
    }
    return {
      id: m.id,
      label: `${rolePrefix}: ${labelContent}`,
    }
  })

/**
 * The `/fork` message picker: a docked pane in the session's pane slot, in
 * the `PickerFrame` every pane draws. One line per message.
 */
export function MessagePicker(props: MessagePickerProps) {
  const { theme } = useTheme()
  const { rowWidth } = usePickerGeometry()

  const items = () => buildItems(props.messages)
  const rows = (): ReadonlyArray<SelectListRow<PickerItem>> =>
    items().map((item) =>
      selectable(item, (isSelected, id) => {
        const backgroundColor = () => {
          if (isSelected()) return theme.primary
          return "transparent"
        }
        const textColor = () => {
          if (isSelected()) return theme.selectedListItemText
          return theme.text
        }
        return (
          <box id={id} backgroundColor={backgroundColor()} paddingLeft={1}>
            <text wrapMode="none" style={{ fg: textColor() }}>
              {truncate(item.label, rowWidth())}
            </text>
          </box>
        )
      }),
    )

  return (
    <Show when={props.open}>
      <PickerFrame
        lines={items().length}
        title={`Fork from message · ${items().length}`}
        footer={"↑↓ move · ↵ fork here · esc close"}
      >
        <SelectList
          id="message-picker"
          open={props.open}
          rows={rows}
          rowKey={(item) => item.id}
          // SAFETY: PickerItem.id originates from domain Message.id which is a MessageId
          onSelect={(item) => props.onSelect(MessageId.make(item.id))}
          onDismiss={props.onClose}
        />
      </PickerFrame>
    </Show>
  )
}

// ── settings picker ─────────────────────────────────────────────────────────

/** One selectable row: the id goes back to the caller, name and detail render. */
interface PickerRow {
  readonly id: string
  readonly name: string
  readonly detail: string
}

export const modelRows = (models: readonly Model[]): readonly PickerRow[] =>
  models.map((model) => ({ id: model.id, name: model.name, detail: model.id }))

/** The row id that clears the session override and falls back to config/agent. */
export const DEFAULT_ROW_ID = "default"

export const reasoningRows = (resolved: Option.Option<ReasoningEffort>): readonly PickerRow[] => [
  {
    id: DEFAULT_ROW_ID,
    name: DEFAULT_ROW_ID,
    detail: Option.match(resolved, {
      onNone: () => "agent or config default",
      onSome: (level) => `agent or config default (${level})`,
    }),
  },
  ...ReasoningEffort.literals.map((level) => ({ id: level, name: level, detail: "" })),
]

const filterRows = (rows: readonly PickerRow[], query: string): readonly PickerRow[] => {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return rows
  return rows.filter(
    (row) => row.id.toLowerCase().includes(needle) || row.name.toLowerCase().includes(needle),
  )
}

interface SettingsPickerProps {
  open: boolean
  title: string
  rows: readonly PickerRow[]
  /** The row the next turn would use; rendered with a marker and preselected. */
  current: Option.Option<string>
  onSelect: (id: string) => void
  onClose: () => void
}

/**
 * A docked filter list under the composer, shared by `/model` and `/think`.
 *
 * A pane, not a modal: it is ruled off top and bottom under the composer, the
 * same framing the slash-command popup and the agents pane draw, so the
 * columns come from the picker's budget rather than a bordered box.
 */
export function SettingsPicker(props: SettingsPickerProps) {
  const { theme } = useTheme()
  const [query, setQuery] = createSignal("")

  const visible = () => filterRows(props.rows, query())

  const { rowWidth } = usePickerGeometry()

  const rows = (): ReadonlyArray<SelectListRow<PickerRow>> =>
    visible().map((row) =>
      selectable(row, (isSelected, id) => {
        const isCurrent = () => Option.exists(props.current, (value) => value === row.id)
        const backgroundColor = () => {
          if (isSelected()) return theme.primary
          return "transparent"
        }
        const textColor = () => {
          if (isSelected()) return theme.selectedListItemText
          return theme.text
        }
        const marker = () => {
          if (isCurrent()) return "● "
          return "  "
        }
        const label = () => {
          const gap = Math.max(1, rowWidth() - 2 - row.name.length - row.detail.length)
          return truncate(`${marker()}${row.name}${" ".repeat(gap)}${row.detail}`, rowWidth())
        }
        return (
          <box id={id} backgroundColor={backgroundColor()} paddingLeft={1}>
            <text style={{ fg: textColor() }}>{label()}</text>
          </box>
        )
      }),
    )

  /** Open on the row the next turn would use. */
  const sticky = (values: ReadonlyArray<PickerRow>): Option.Option<number> => {
    const index = values.findIndex((row) => Option.exists(props.current, (id) => id === row.id))
    if (index < 0) return Option.some(0)
    return Option.some(index)
  }

  return (
    <Show when={props.open}>
      <PickerFrame
        // The query row draws above the list, and the frame counts it.
        lines={visible().length}
        queryRow
        title={`${props.title} · ${visible().length}`}
        footer={"type to filter · ↑↓ move · ↵ select · esc close"}
      >
        <SelectList
          id="settings-picker"
          open={props.open}
          rows={rows}
          rowKey={(row) => row.id}
          filter={{ onQueryChange: setQuery }}
          sticky={sticky}
          empty={() => <text style={{ fg: theme.textMuted }}> nothing matches</text>}
          onSelect={(row) => props.onSelect(row.id)}
          onDismiss={props.onClose}
        />
      </PickerFrame>
    </Show>
  )
}
