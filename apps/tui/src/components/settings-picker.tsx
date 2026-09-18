import { createSignal, Show } from "solid-js"
import { Option } from "effect"
import { ReasoningEffort, type Model } from "@gent/core/protocol"
import { useTheme } from "../theme"
import { useTerminalDimensions } from "../terminal-dimensions"
import { PickerFrame, pickerHeight, usePickerGeometry } from "./picker-frame"
import { truncate } from "../utils"
import { SelectList, selectable, type SelectListRow } from "./select-list"

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

export const filterRows = (rows: readonly PickerRow[], query: string): readonly PickerRow[] => {
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
  const dimensions = useTerminalDimensions()

  // The query row draws above the list, so the pane spends one line more than
  // it has rows; `pickerHeight` budgets one body row per item.
  const paneHeight = () => pickerHeight(visible().length + 1, dimensions().height)

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
        height={paneHeight()}
        title={`${props.title} · ${visible().length}`}
        footer={"type to filter · ↑↓ move · ↵ select · esc close"}
      >
        <SelectList
          id="settings-picker"
          open={props.open}
          rows={rows}
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
