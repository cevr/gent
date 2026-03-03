/**
 * ToolBox — box chrome wrapper for tool output.
 *
 * Provides visual framing with:
 * - Status icon (spinner/check/error)
 * - Tool name + input summary
 * - Optional duration
 * - Expandable content area
 *
 * Layout:
 *   ╭─[tool-name input-summary]
 *   │ content...
 *   ╰── 1.2s
 */

import { Show, type JSX } from "solid-js"
import { useTheme } from "../theme/index"

export interface ToolBoxProps {
  /** Tool display name */
  title: string
  /** Input summary shown after title */
  subtitle?: string
  /** Status: drives icon */
  status: "running" | "completed" | "error"
  /** Duration in ms */
  durationMs?: number
  /** Whether box content is expanded */
  expanded: boolean
  /** Box content */
  children?: JSX.Element
  /** Collapsed summary (shown when not expanded) */
  collapsedContent?: JSX.Element
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  const mins = Math.floor(secs / 60)
  const remainingSecs = Math.round(secs % 60)
  return `${mins}m ${remainingSecs}s`
}

export function ToolBox(props: ToolBoxProps) {
  const { theme } = useTheme()

  const statusIcon = () => (props.status === "running" ? "⋯" : props.status === "error" ? "✕" : "✓")

  const statusColor = () =>
    props.status === "running"
      ? theme.warning
      : props.status === "error"
        ? theme.error
        : theme.success

  const footer = () => {
    if (props.durationMs === undefined) return undefined
    return formatDuration(props.durationMs)
  }

  return (
    <box flexDirection="column" paddingLeft={2}>
      {/* Header: ╭─[icon title subtitle] */}
      <text>
        <span style={{ fg: theme.border }}>{"╭─["}</span>
        <span style={{ fg: statusColor() }}>{statusIcon()}</span>
        <span style={{ fg: theme.border }}> </span>
        <span style={{ fg: theme.info, bold: true }}>{props.title}</span>
        <Show when={props.subtitle}>
          <span style={{ fg: theme.textMuted }}> {props.subtitle}</span>
        </Show>
        <span style={{ fg: theme.border }}>{"]"}</span>
        <Show when={footer()}>
          <span style={{ fg: theme.textMuted }}> {footer()}</span>
        </Show>
      </text>

      {/* Content area */}
      <Show
        when={props.expanded}
        fallback={
          <Show when={props.collapsedContent}>
            <box paddingLeft={2}>
              <text>
                <span style={{ fg: theme.border }}>{"│ "}</span>
              </text>
              {props.collapsedContent}
            </box>
          </Show>
        }
      >
        <Show when={props.children}>
          <box paddingLeft={2} flexDirection="column">
            <text>
              <span style={{ fg: theme.border }}>{"│"}</span>
            </text>
            {props.children}
          </box>
        </Show>
      </Show>

      {/* Footer */}
      <text>
        <span style={{ fg: theme.border }}>{"╰────"}</span>
      </text>
    </box>
  )
}
