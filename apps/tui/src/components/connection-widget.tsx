import { Show } from "solid-js"
import { useTheme } from "../theme/index"
import { InlineChrome } from "./inline-chrome"

export interface ConnectionWidgetProps {
  issue: string | null
  reconnecting: boolean
  restartCount?: number | null
}

export function ConnectionWidget(props: ConnectionWidgetProps) {
  const { theme } = useTheme()

  const visible = () => props.reconnecting || props.issue !== null
  const accent = () => (props.reconnecting ? theme.warning : theme.error)
  const subtitle = () => {
    if (props.reconnecting) return "worker reconnect in progress"
    return props.issue ?? ""
  }

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
          <Show when={props.reconnecting}>
            <text>
              <span style={{ fg: accent() }}>{"│ "}</span>
              <span style={{ fg: theme.text }}>reconnecting to worker...</span>
            </text>
          </Show>
          <Show
            when={
              props.restartCount !== null &&
              props.restartCount !== undefined &&
              props.restartCount > 0
            }
          >
            <text>
              <span style={{ fg: accent() }}>{"│ "}</span>
              <span style={{ fg: theme.textMuted }}>restart count: {props.restartCount}</span>
            </text>
          </Show>
          <Show when={props.issue !== null}>
            <text>
              <span style={{ fg: accent() }}>{"│ "}</span>
              <span style={{ fg: theme.text }}>{props.issue}</span>
            </text>
          </Show>
        </InlineChrome.Body>
        <InlineChrome.Footer accentColor={accent()} />
      </InlineChrome.Root>
    </Show>
  )
}
