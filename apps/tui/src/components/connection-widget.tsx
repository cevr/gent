import { Show } from "solid-js"
import { useTheme } from "../theme/index"
import { InlineChrome } from "./inline-chrome"
import { useClient } from "../client/index"

export function ConnectionWidget() {
  const client = useClient()
  const { theme } = useTheme()

  const visible = () => client.isReconnecting() || client.connectionIssue() !== null
  const accent = () => (client.isReconnecting() ? theme.warning : theme.error)
  const subtitle = () => {
    if (client.isReconnecting()) return "worker reconnect in progress"
    return client.connectionIssue() ?? ""
  }
  const restartCount = () => client.connectionGeneration()

  return (
    <Show when={visible()}>
      <InlineChrome.Root paddingLeft={2} marginTop={1} marginBottom={1}>
        <InlineChrome.Header
          accentColor={accent()}
          leading={<span style={{ fg: accent() }}>•</span>}
          title={<span style={{ fg: accent(), bold: true }}>connection</span>}
          subtitle={subtitle()}
          subtitleColor={theme.textMuted}
        />
        <InlineChrome.Body accentColor={accent()}>
          <Show when={client.isReconnecting()}>
            <text>
              <span style={{ fg: accent() }}>{"│ "}</span>
              <span style={{ fg: theme.text }}>reconnecting to worker...</span>
            </text>
          </Show>
          <Show when={restartCount() > 0}>
            <text>
              <span style={{ fg: accent() }}>{"│ "}</span>
              <span style={{ fg: theme.textMuted }}>restart count: {restartCount()}</span>
            </text>
          </Show>
          <Show when={client.connectionIssue() !== null}>
            <text>
              <span style={{ fg: accent() }}>{"│ "}</span>
              <span style={{ fg: theme.text }}>{client.connectionIssue()}</span>
            </text>
          </Show>
        </InlineChrome.Body>
        <InlineChrome.Footer accentColor={accent()} />
      </InlineChrome.Root>
    </Show>
  )
}
