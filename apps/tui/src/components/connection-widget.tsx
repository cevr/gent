import { Show } from "solid-js"
import { Option } from "effect"
import { useTheme } from "../theme/index"
import { InlineChrome } from "./inline-chrome"
import { useClient } from "../client/index"

export function ConnectionWidget() {
  const client = useClient()
  const { theme } = useTheme()
  const disconnectedReason = () => {
    const state = Option.fromNullishOr(client.connectionState())
    if (Option.isNone(state)) return Option.none<string>()
    if (state.value._tag !== "disconnected" || state.value.reason === "stopped") {
      return Option.none<string>()
    }
    return Option.some(state.value.reason)
  }
  const connectionIssue = () => Option.fromNullishOr(client.connectionIssue())
  const degradedExtensions = () => {
    const health = client.extensionHealth()
    if (health._tag === "degraded") return health.degradedExtensions
    return []
  }
  const failedExtensions = () =>
    degradedExtensions()
      .filter((extension) => extension.issues.some((issue) => issue._tag === "activation-failed"))
      .map((extension) => extension.manifest.id)
  const failedScheduledJobs = () =>
    degradedExtensions().flatMap((extension) => {
      const jobs: string[] = []
      for (const issue of extension.issues) {
        if (issue._tag === "scheduled-job-failed") {
          jobs.push(`${extension.manifest.id}:${issue.jobId}`)
        }
      }
      return jobs
    })
  const hasFailedExtensions = () => failedExtensions().length > 0
  const hasFailedScheduledJobs = () => failedScheduledJobs().length > 0
  const visible = () =>
    client.isReconnecting() ||
    Option.isSome(connectionIssue()) ||
    Option.isSome(disconnectedReason()) ||
    hasFailedExtensions() ||
    hasFailedScheduledJobs()
  const accent = () => {
    if (client.isReconnecting()) return theme.warning
    if (hasFailedExtensions() || hasFailedScheduledJobs()) return theme.warning
    return theme.error
  }
  const subtitle = () => {
    if (client.isReconnecting()) return "worker reconnect in progress"
    if (hasFailedExtensions()) return "extension activation degraded"
    if (hasFailedScheduledJobs()) return "scheduled jobs degraded"
    if (Option.isSome(disconnectedReason())) return "runtime unavailable"
    return Option.getOrElse(connectionIssue(), () => "")
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
          <Show when={Option.isSome(connectionIssue())}>
            <text>
              <span style={{ fg: accent() }}>{"│ "}</span>
              <span style={{ fg: theme.text }}>{Option.getOrUndefined(connectionIssue())}</span>
            </text>
          </Show>
          <Show when={Option.isSome(disconnectedReason())}>
            <text>
              <span style={{ fg: accent() }}>{"│ "}</span>
              <span style={{ fg: theme.text }}>{Option.getOrUndefined(disconnectedReason())}</span>
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
