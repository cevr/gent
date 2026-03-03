/**
 * GutterText — line-numbered content display.
 *
 * Renders content with line numbers in a gutter column:
 *   42 │ const foo = "bar"
 *   43 │ const baz = "qux"
 *
 * Supports:
 * - Optional highlight ranges (base color vs dim)
 * - Start line offset for file excerpts
 * - Optional max lines with head/tail truncation
 */

import { For } from "solid-js"
import { useTheme } from "../theme/index"

export interface GutterTextProps {
  /** Lines to display */
  lines: string[]
  /** Starting line number (1-based). Default: 1 */
  startLine?: number
  /** Line numbers to highlight (1-based). If empty/undefined, all highlighted */
  highlightLines?: Set<number>
  /** Max gutter width. Auto-computed if not provided */
  gutterWidth?: number
}

export function GutterText(props: GutterTextProps) {
  const { theme } = useTheme()

  const startLine = () => props.startLine ?? 1
  const gutterWidth = () =>
    props.gutterWidth ?? Math.max(3, String(startLine() + props.lines.length - 1).length)

  const isHighlighted = (lineNum: number) => {
    if (!props.highlightLines || props.highlightLines.size === 0) return true
    return props.highlightLines.has(lineNum)
  }

  return (
    <box flexDirection="column">
      <For each={props.lines}>
        {(line, index) => {
          const lineNum = () => startLine() + index()
          const gutter = () => String(lineNum()).padStart(gutterWidth())
          const highlighted = () => isHighlighted(lineNum())

          return (
            <text>
              <span style={{ fg: highlighted() ? theme.textMuted : theme.border }}>
                {gutter()} │{" "}
              </span>
              <span style={{ fg: highlighted() ? theme.text : theme.textMuted }}>{line}</span>
            </text>
          )
        }}
      </For>
    </box>
  )
}
