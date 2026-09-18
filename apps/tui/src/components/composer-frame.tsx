import { createMemo, For, Show, type JSX } from "solid-js"
import type { BorderLabelItem } from "../session"
import { useTheme } from "../theme"
import { useTerminalDimensions } from "../terminal"
import { textWidth } from "../platform/text-width-adapter"
import { truncate } from "../utils"

interface ComposerFrameProps {
  labels: readonly BorderLabelItem[]
  /**
   * How many of `labels`, counted from the end, are laid out from the right
   * edge inward instead of after the left group.
   *
   * The row had one left-to-right budget, so a label added anywhere earlier
   * pushed the last ones off the end and they vanished with no indication —
   * adding the cwd silently dropped the effort, context and cost. The reader
   * glances at the right-hand labels without reading the row, so their
   * position has to be fixed and the left group is what gives way.
   */
  rightLabels?: number
  children: JSX.Element
}

const SEPARATOR_WIDTH = 3

/** Joins labels with the separator, measuring the columns they occupy. */
const layout = (labels: readonly BorderLabelItem[], budget: number) => {
  const shown: BorderLabelItem[] = []
  let used = 0
  for (const label of labels) {
    if (label.text.length === 0) continue
    let separator = 0
    if (shown.length > 0) separator = SEPARATOR_WIDTH
    const remaining = budget - used - separator
    if (remaining <= 0) break
    const text = truncate(label.text, remaining)
    if (text.length === 0) break
    shown.push({ ...label, text })
    used += separator + textWidth(text)
    if (textWidth(label.text) > remaining) break
  }
  return { shown, used }
}

export function ComposerFrame(props: ComposerFrameProps) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  const groups = createMemo(() => {
    const all = props.labels.filter((label) => label.text.length > 0)
    const reserved = Math.min(props.rightLabels ?? 0, all.length)
    const leftLabels = all.slice(0, all.length - reserved)
    const rightLabels = all.slice(all.length - reserved)
    const width = dimensions().width

    // The right group is laid out first and keeps its columns; the left group
    // spends what is left. A right group that cannot fit the row on its own
    // still truncates rather than pushing the left group to nothing.
    const right = layout(rightLabels, width)
    let rightGap = 0
    if (right.shown.length > 0) rightGap = SEPARATOR_WIDTH
    const leftBudget = Math.max(0, width - right.used - rightGap)
    const left = layout(leftLabels, leftBudget)
    const gap = Math.max(0, width - left.used - right.used)
    return { left: left.shown, right: right.shown, gap }
  })

  return (
    <box flexDirection="column" flexShrink={0} paddingTop={1}>
      <box flexDirection="column">{props.children}</box>
      <box height={1} flexShrink={0} marginTop={1} overflow="hidden">
        <text wrapMode="none">
          <For each={groups().left}>
            {(label, index) => (
              <>
                <Show when={index() > 0}>
                  <span style={{ fg: theme.textMuted }}> · </span>
                </Show>
                <span style={{ fg: label.color }}>{label.text}</span>
              </>
            )}
          </For>
          <Show when={groups().right.length > 0}>
            <span>{" ".repeat(groups().gap)}</span>
          </Show>
          <For each={groups().right}>
            {(label, index) => (
              <>
                <Show when={index() > 0}>
                  <span style={{ fg: theme.textMuted }}> · </span>
                </Show>
                <span style={{ fg: label.color }}>{label.text}</span>
              </>
            )}
          </For>
        </text>
      </box>
    </box>
  )
}
