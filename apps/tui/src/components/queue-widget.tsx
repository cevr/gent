import { For, Show } from "solid-js"
import { useTheme } from "../theme/index"
import { InlineChrome } from "./inline-chrome"

export interface PendingQueueMessage {
  content: string
  createdAt: number
}

export interface QueueWidgetProps {
  queuedMessage: PendingQueueMessage | null
  steerMessages: readonly PendingQueueMessage[]
}

function summaryText(text: string): string {
  const lines = text.split("\n")
  const first = lines[0] ?? ""
  if (lines.length <= 1) return first
  return `${first} +${lines.length - 1} lines`
}

export function QueueWidget(props: QueueWidgetProps) {
  const { theme } = useTheme()

  const hasItems = () => props.queuedMessage !== null || props.steerMessages.length > 0

  return (
    <Show when={hasItems()}>
      <InlineChrome.Root paddingLeft={2} marginBottom={1}>
        <InlineChrome.Header
          accentColor={theme.warning}
          leading={<span style={{ fg: theme.warning }}>•</span>}
          title={<span style={{ fg: theme.warning, bold: true }}>queue</span>}
          subtitle="pending messages"
          subtitleColor={theme.textMuted}
        />
        <InlineChrome.Body accentColor={theme.warning}>
          <For each={props.steerMessages}>
            {(message, index) => (
              <text>
                <span style={{ fg: theme.warning }}>{"│ "}</span>
                <span style={{ fg: theme.warning }}>[steer {index() + 1}]</span>
                <span style={{ fg: theme.text }}> {summaryText(message.content)}</span>
              </text>
            )}
          </For>
          <Show when={props.queuedMessage} keyed>
            {(message) => (
              <text>
                <span style={{ fg: theme.warning }}>{"│ "}</span>
                <span style={{ fg: theme.textMuted }}>[queued]</span>
                <span style={{ fg: theme.text }}> {summaryText(message.content)}</span>
              </text>
            )}
          </Show>
        </InlineChrome.Body>
        <InlineChrome.Footer
          accentColor={theme.warning}
          trailing={<span style={{ fg: theme.textMuted }}>cmd+up restore</span>}
        />
      </InlineChrome.Root>
    </Show>
  )
}
