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

import type { JSX } from "solid-js"
import { useTerminalDimensions } from "../terminal-dimensions"
import { useTheme } from "../theme/index"

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
export interface PickerGeometry {
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

export function PickerFrame(props: {
  height: number
  /** The muted heading row. A picker that carries counts puts them in here. */
  title: string
  children: JSX.Element
  footer: JSX.Element
}) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" flexShrink={0} width="100%" height={props.height}>
      <box
        flexDirection="column"
        flexGrow={1}
        border={["top", "bottom"]}
        borderColor={theme.border}
      >
        <box height={1} flexShrink={0} overflow="hidden">
          <text wrapMode="none" truncate style={{ fg: theme.textMuted }}>
            {props.title}
          </text>
        </box>
        {props.children}
      </box>
      <text height={1} flexShrink={0} wrapMode="none" truncate style={{ fg: theme.textMuted }}>
        {props.footer}
      </text>
    </box>
  )
}
