import { For, Show } from "solid-js"
import type { QueueEntryInfo } from "@gent/sdk"
import { useTheme } from "../theme/index"

export interface QueueWidgetProps {
  queuedMessages: readonly QueueEntryInfo[]
  steerMessages: readonly QueueEntryInfo[]
}

function summaryText(text: string): string {
  const lines = text.split("\n")
  const first = lines[0] ?? ""
  if (lines.length <= 1) return first
  return `${first} +${lines.length - 1} lines`
}

export function QueueWidget(props: QueueWidgetProps) {
  const { theme } = useTheme()

  const hasItems = () => props.queuedMessages.length > 0 || props.steerMessages.length > 0

  return (
    <Show when={hasItems()}>
      <box flexDirection="column" paddingLeft={2} marginBottom={1}>
        <For each={props.steerMessages}>
          {(message, index) => (
            <text>
              <span style={{ fg: theme.textMuted }}>┋ [steer {index() + 1}]</span>
              <span style={{ fg: theme.text }}> {summaryText(message.content)}</span>
            </text>
          )}
        </For>
        <For each={props.queuedMessages}>
          {(message, index) => (
            <text>
              <span style={{ fg: theme.textMuted }}>┋ [queued {index() + 1}]</span>
              <span style={{ fg: theme.text }}> {summaryText(message.content)}</span>
            </text>
          )}
        </For>
        <text style={{ fg: theme.textMuted }}> cmd+up restore</text>
      </box>
    </Show>
  )
}
