import { createEffect, createSignal, For, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { Option } from "effect"
import { ReasoningEffort, type Model } from "@gent/core/protocol"
import { useTerminalDimensions } from "../terminal-dimensions"
import { useTheme } from "../theme/index"
import { ChromePanel } from "./chrome-panel"
import { useScrollSync } from "../hooks/use-scroll-sync"
import { useScopedKeyboard } from "../keyboard/context"
import { truncate } from "../utils/format-tool"
import { FilterListEvent, FilterListState, transitionFilterList } from "./filter-list-state"

/** One selectable row: the id goes back to the caller, name and detail render. */
export interface PickerRow {
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

export const filterRows = (rows: readonly PickerRow[], query: string): readonly PickerRow[] => {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return rows
  return rows.filter(
    (row) => row.id.toLowerCase().includes(needle) || row.name.toLowerCase().includes(needle),
  )
}

export interface SettingsPickerProps {
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
 * A pane, not a modal: it spans the width and keeps a fixed row budget so a
 * short terminal does not collapse the list.
 */
export function SettingsPicker(props: SettingsPickerProps) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [state, setState] = createSignal(FilterListState.initial())
  let scrollRef = Option.none<ScrollBoxRenderable>()

  const visible = () => filterRows(props.rows, state().query)

  useScrollSync(() => `settings-picker-${state().selectedIndex}`, {
    getRef: () => Option.getOrUndefined(scrollRef),
  })

  createEffect(() => {
    if (!props.open) return
    const index = props.rows.findIndex((row) => Option.exists(props.current, (id) => id === row.id))
    setState(FilterListState.initial(Math.max(0, index)))
  })

  useScopedKeyboard(
    (event) => {
      if (event.name === "escape") {
        props.onClose()
        return true
      }
      if (event.name === "backspace") {
        setState((current) =>
          transitionFilterList(current, FilterListEvent.cases.Backspace.make({})),
        )
        return true
      }
      const rows = visible()
      if (event.name === "return") {
        const selected = Option.fromNullishOr(rows[state().selectedIndex])
        if (Option.isSome(selected)) props.onSelect(selected.value.id)
        return true
      }
      if (event.name === "up" || (event.ctrl === true && event.name === "p")) {
        setState((current) =>
          transitionFilterList(
            current,
            FilterListEvent.cases.MoveUp.make({ itemCount: rows.length }),
          ),
        )
        return true
      }
      if (event.name === "down" || (event.ctrl === true && event.name === "n")) {
        setState((current) =>
          transitionFilterList(
            current,
            FilterListEvent.cases.MoveDown.make({ itemCount: rows.length }),
          ),
        )
        return true
      }
      const sequence = Option.fromNullishOr(event.sequence)
      if (Option.isSome(sequence) && sequence.value.length === 1) {
        const char = sequence.value
        if (char.charCodeAt(0) >= 32 && char.charCodeAt(0) <= 126) {
          setState((current) =>
            transitionFilterList(current, FilterListEvent.cases.TypeChar.make({ char })),
          )
          return true
        }
      }
      return false
    },
    { when: () => props.open },
  )

  const panelWidth = () => Math.max(0, dimensions().width - 2)
  // Border 2, body padding 2, row padding 1.
  const rowWidth = () => Math.max(0, panelWidth() - 5)
  const BODY_ROWS = 10
  const CHROME_ROWS = 5
  const paneHeight = () => Math.max(5, Math.min(BODY_ROWS + CHROME_ROWS, dimensions().height - 4))

  return (
    <Show when={props.open}>
      <box
        height={paneHeight()}
        alignSelf="stretch"
        marginLeft={1}
        marginRight={1}
        backgroundColor={theme.backgroundMenu}
        border
        borderStyle="rounded"
        borderColor={theme.borderSubtle}
        flexDirection="column"
        title={`${props.title} · ${visible().length}`}
      >
        <ChromePanel.Section>
          <text style={{ fg: theme.text }}>
            <span style={{ fg: theme.textMuted }}>› </span>
            {state().query}
            <span style={{ fg: theme.primary }}>│</span>
          </text>
        </ChromePanel.Section>

        <ChromePanel.Body ref={(value) => (scrollRef = Option.some(value))}>
          <Show
            when={visible().length > 0}
            fallback={<text style={{ fg: theme.textMuted }}> nothing matches</text>}
          >
            <For each={visible()}>
              {(row, index) => {
                const isSelected = () => state().selectedIndex === index()
                const isCurrent = () => Option.exists(props.current, (id) => id === row.id)
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
                  return truncate(
                    `${marker()}${row.name}${" ".repeat(gap)}${row.detail}`,
                    rowWidth(),
                  )
                }
                return (
                  <box
                    id={`settings-picker-${index()}`}
                    backgroundColor={backgroundColor()}
                    paddingLeft={1}
                  >
                    <text style={{ fg: textColor() }}>{label()}</text>
                  </box>
                )
              }}
            </For>
          </Show>
        </ChromePanel.Body>

        <ChromePanel.Footer>type to filter · ↑↓ move · ↵ select · esc close</ChromePanel.Footer>
      </box>
    </Show>
  )
}
