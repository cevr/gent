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
 * The columns a picker row may use.
 *
 * A picker rules off top and bottom only, so unlike a docked pane it spends
 * no columns on side borders or margins: a row loses its own left pad and
 * nothing else. Budgeting the Dock's allowance here would truncate every row
 * five columns short of the rule.
 */
export interface PickerGeometry {
  /** Columns a row may use: the row's own left pad is all it spends. */
  readonly rowWidth: () => number
  /** A `Section` pads both sides, so it has one column less than a row. */
  readonly sectionWidth: () => number
}

export const usePickerGeometry = (): PickerGeometry => {
  const dimensions = useTerminalDimensions()
  return {
    rowWidth: () => Math.max(0, dimensions().width - 1),
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
