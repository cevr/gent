import { Show, For } from "solid-js"
import type { TodoStatusType } from "@gent/extensions/client.js"
import { useSpinnerClock } from "../hooks/use-spinner-clock"
import { useTheme } from "../theme/index"
import { useTerminalDimensions } from "../terminal-dimensions"
import { pickerText } from "./picker-text"

const STATUS_ICONS = {
  pending: "◻",
  in_progress: "◰",
  completed: "✔",
  failed: "✗",
  stopped: "◼",
} satisfies Record<TodoStatusType, string>

const IN_PROGRESS_SPINNER = ["◰", "◳", "◲", "◱"] satisfies ReadonlyArray<string>

export interface TodoPreview {
  subject: string
  status: TodoStatusType
}

export function TodoWidget(props: { previewTodos: readonly TodoPreview[] }) {
  const { theme } = useTheme()
  const tick = useSpinnerClock()
  const dimensions = useTerminalDimensions()
  const displayLimit = () => Math.max(1, Math.min(4, Math.floor(dimensions().height / 4) - 2))

  const summary = () => {
    const t = props.previewTodos
    const pending = t.filter((x) => x.status === "pending").length
    const active = t.filter((x) => x.status === "in_progress").length
    const done = t.filter((x) => x.status === "completed").length
    const failed = t.filter((x) => x.status === "failed").length
    const stopped = t.filter((x) => x.status === "stopped").length

    const parts: string[] = []
    if (done > 0) parts.push(`${done} done`)
    if (active > 0) parts.push(`${active} active`)
    if (pending > 0) parts.push(`${pending} pending`)
    if (failed > 0) parts.push(`${failed} failed`)
    if (stopped > 0) parts.push(`${stopped} stopped`)
    return `${t.length} todos (${parts.join(", ")})`
  }

  const displayTodos = () => props.previewTodos.slice(0, displayLimit())

  const overflow = () => Math.max(0, props.previewTodos.length - displayLimit())

  const statusIcon = (status: TodoStatusType) => {
    if (status !== "in_progress") {
      return STATUS_ICONS[status] ?? "?"
    }
    return IN_PROGRESS_SPINNER[tick() % IN_PROGRESS_SPINNER.length] ?? STATUS_ICONS["in_progress"]
  }

  const statusColor = (status: TodoStatusType) => {
    switch (status) {
      case "in_progress":
        return theme.warning
      case "completed":
        return theme.success
      case "failed":
        return theme.error
      case "pending":
      case "stopped":
        return theme.textMuted
    }
  }

  return (
    <Show when={props.previewTodos.length > 0}>
      <box paddingLeft={2} marginTop={1} flexDirection="column">
        <text height={1} wrapMode="none" truncate style={{ fg: theme.textMuted }}>
          ● {pickerText(summary(), dimensions().width - 4)}
        </text>
        <For each={displayTodos()}>
          {(todo) => (
            <text height={1} wrapMode="none" truncate>
              <span style={{ fg: statusColor(todo.status) }}>{statusIcon(todo.status)}</span>
              <span style={{ fg: theme.textMuted }}>
                {" "}
                {pickerText(todo.subject, dimensions().width - 4)}
              </span>
            </text>
          )}
        </For>
        <text height={1} wrapMode="none" truncate style={{ fg: theme.textMuted }}>
          <Show when={overflow() > 0}>+{overflow()} more · </Show>Ctrl+Shift+T details
        </text>
      </box>
    </Show>
  )
}
