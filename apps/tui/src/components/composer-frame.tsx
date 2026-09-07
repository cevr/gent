import { createMemo, For, Show, type JSX } from "solid-js"
import type { BorderLabelItem } from "../utils/border-segments"
import { useTheme } from "../theme/index"
import { useTerminalDimensions } from "../terminal-dimensions"
import { textWidth } from "../platform/text-width-adapter"
import { pickerText } from "./picker-text"

interface ComposerFrameProps {
  labels: readonly BorderLabelItem[]
  children: JSX.Element
}

export function ComposerFrame(props: ComposerFrameProps) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const visibleLabels = createMemo(() => {
    const labels: BorderLabelItem[] = []
    let remaining = dimensions().width
    for (const label of props.labels) {
      if (label.text.length === 0) continue
      if (labels.length > 0) remaining -= 3
      if (remaining <= 0) break
      const text = pickerText(label.text, remaining)
      labels.push({ ...label, text })
      if (textWidth(label.text) > remaining) break
      remaining -= textWidth(text)
    }
    return labels
  })
  return (
    <box flexDirection="column" flexShrink={0} paddingTop={1}>
      <box flexDirection="column">{props.children}</box>
      <box height={1} flexShrink={0} marginTop={1} overflow="hidden">
        <text wrapMode="none">
          <For each={visibleLabels()}>
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
