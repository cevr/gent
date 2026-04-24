import { Show } from "solid-js"
import { useTheme } from "../theme/index"
import { InlineChrome } from "./inline-chrome"
import { useClient } from "../client/index"

export function ConnectionWidget() {
  const client = useClient()
  const { theme } = useTheme()
  const disconnectedReason = () => {
    const state = client.connectionState()
    if (state?._tag !== "disconnected" || state.reason === "stopped") return null
    return state.reason
  }
  const healthSummary = () => client.extensionHealth().summary
  const failedExtensions = () => {
    const summary = healthSummary()
    return summary._tag === "degraded" ? summary.failedExtensions : []
  }
  const failedActors = () => {
    const summary = healthSummary()
    return summary._tag === "degraded" ? summary.failedActors : []
  }
  const failedScheduledJobs = () => {
    const summary = healthSummary()
    return summary._tag === "degraded" ? summary.failedScheduledJobs : []
  }
  const hasFailedExtensions = () => failedExtensions().length > 0
  const hasFailedActors = () => failedActors().length > 0
  const hasFailedScheduledJobs = () => failedScheduledJobs().length > 0
  const visible = () =>
    client.isReconnecting() ||
    client.connectionIssue() !== null ||
    disconnectedReason() !== null ||
    hasFailedExtensions() ||
    hasFailedActors() ||
    hasFailedScheduledJobs()
  const accent = () => {
    if (client.isReconnecting()) return theme.warning
    if (hasFailedExtensions() || hasFailedActors() || hasFailedScheduledJobs()) return theme.warning
    return theme.error
  }
  const subtitle = () => {
    if (client.isReconnecting()) return "worker reconnect in progress"
    const summary = healthSummary()
    if (summary._tag === "degraded" && summary.subtitle !== undefined) return summary.subtitle
    if (disconnectedReason() !== null) return "runtime unavailable"
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
          <Show when={disconnectedReason() !== null}>
            <text>
              <span style={{ fg: accent() }}>{"│ "}</span>
              <span style={{ fg: theme.text }}>{disconnectedReason()}</span>
            </text>
          </Show>
          <Show when={hasFailedExtensions()}>
            <text>
              <span style={{ fg: accent() }}>{"│ "}</span>
              <span style={{ fg: theme.text }}>
                failed extensions: {failedExtensions().join(", ")}
              </span>
            </text>
          </Show>
          <Show when={hasFailedActors()}>
            <text>
              <span style={{ fg: accent() }}>{"│ "}</span>
              <span style={{ fg: theme.text }}>
                failed session actors: {failedActors().join(", ")}
              </span>
            </text>
          </Show>
          <Show when={hasFailedScheduledJobs()}>
            <text>
              <span style={{ fg: accent() }}>{"│ "}</span>
              <span style={{ fg: theme.text }}>
                failed scheduled jobs: {failedScheduledJobs().join(", ")}
              </span>
            </text>
          </Show>
        </InlineChrome.Body>
        <InlineChrome.Footer accentColor={accent()} />
      </InlineChrome.Root>
    </Show>
  )
}
