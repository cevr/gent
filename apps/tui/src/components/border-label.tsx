/**
 * BorderLabel — horizontal line with embedded left/right labels.
 *
 * Renders: ── $0.14 ──────────── claude-opus-4-5 ──
 *
 * Labels are dimmed, fill is border-colored ─ characters.
 */

import { Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../theme/index"

export interface BorderLabelProps {
  left?: string
  right?: string
}

export function BorderLabel(props: BorderLabelProps) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  const render = () => {
    const width = dimensions().width
    const left = props.left ?? ""
    const right = props.right ?? ""

    // Calculate fill: width - left label - right label - spacing
    const leftPad = left.length > 0 ? 3 : 0 // "── " before + " " after
    const rightPad = right.length > 0 ? 3 : 0 // " " before + " ──" after
    const labelWidth = left.length + right.length + leftPad + rightPad
    const fill = Math.max(0, width - labelWidth)

    return { left, right, fill }
  }

  return (
    <box flexShrink={0}>
      <text>
        <Show when={render().left.length > 0}>
          <span style={{ fg: theme.border }}>{"── "}</span>
          <span style={{ fg: theme.textMuted }}>{render().left}</span>
          <span style={{ fg: theme.border }}> </span>
        </Show>
        <span style={{ fg: theme.border }}>{"─".repeat(render().fill)}</span>
        <Show when={render().right.length > 0}>
          <span style={{ fg: theme.border }}> </span>
          <span style={{ fg: theme.textMuted }}>{render().right}</span>
          <span style={{ fg: theme.border }}>{" ──"}</span>
        </Show>
      </text>
    </box>
  )
}
