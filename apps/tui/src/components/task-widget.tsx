import { Effect } from "effect"
import { createSignal, createEffect, onCleanup, Show, For } from "solid-js"
import type { Task } from "@gent/core/domain/task.js"
import type { SessionId, BranchId } from "@gent/core/domain/ids.js"
import { useClient } from "../client/context"
import { useRuntime } from "../hooks/use-runtime"
import { useTheme } from "../theme/index"

const STATUS_ICONS: Record<string, string> = {
  pending: "◻",
  in_progress: "✳",
  completed: "✔",
  failed: "✗",
}

const MAX_DISPLAY = 10

export interface TaskPreview {
  subject: string
  status: Task["status"]
}

type TaskWidgetProps =
  | {
      sessionId: SessionId
      branchId: BranchId
      previewTasks?: undefined
    }
  | {
      previewTasks: readonly TaskPreview[]
      sessionId?: undefined
      branchId?: undefined
    }

export function TaskWidget(props: TaskWidgetProps) {
  const client = useClient()
  const { cast } = useRuntime(client.client.services)
  const { theme } = useTheme()

  const [tasks, setTasks] = createSignal<Task[]>([])
  const currentTasks = () => props.previewTasks ?? tasks()

  const loadTasks = () => {
    if (props.previewTasks !== undefined) return
    cast(
      client.client.listTasks(props.sessionId, props.branchId).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            setTasks([...result])
          }),
        ),
        Effect.catchEager(() => Effect.void),
      ),
    )
  }

  // Initial load
  createEffect(() => {
    if (props.previewTasks !== undefined) return
    loadTasks()
  })

  // Subscribe to task events for live updates
  createEffect(() => {
    if (props.previewTasks !== undefined) return
    if (!client.isActive()) return

    const unsub = client.subscribeEvents((event) => {
      switch (event._tag) {
        case "TaskCreated":
        case "TaskUpdated":
        case "TaskCompleted":
        case "TaskFailed":
          loadTasks()
          break
      }
    })

    onCleanup(unsub)
  })

  const summary = () => {
    const t = currentTasks()
    const pending = t.filter((x) => x.status === "pending").length
    const active = t.filter((x) => x.status === "in_progress").length
    const done = t.filter((x) => x.status === "completed").length
    const failed = t.filter((x) => x.status === "failed").length

    const parts: string[] = []
    if (done > 0) parts.push(`${done} done`)
    if (active > 0) parts.push(`${active} active`)
    if (pending > 0) parts.push(`${pending} pending`)
    if (failed > 0) parts.push(`${failed} failed`)
    return `${t.length} tasks (${parts.join(", ")})`
  }

  const displayTasks = () => currentTasks().slice(0, MAX_DISPLAY)

  const overflow = () => Math.max(0, currentTasks().length - MAX_DISPLAY)

  const statusColor = (status: Task["status"]) => {
    switch (status) {
      case "in_progress":
        return theme.warning
      case "completed":
        return theme.success
      case "failed":
        return theme.error
      case "pending":
        return theme.textMuted
    }
  }

  return (
    <Show when={currentTasks().length > 0}>
      <box flexDirection="column" paddingLeft={1} marginBottom={1}>
        <text>
          <span style={{ fg: theme.border }}>{"·· "}</span>
          <span style={{ fg: theme.info, bold: true }}>tasks</span>
          <span style={{ fg: theme.textMuted }}> {summary()}</span>
        </text>
        <For each={displayTasks()}>
          {(task) => (
            <text>
              <span style={{ fg: theme.border }}>{"   │ "}</span>
              <span style={{ fg: statusColor(task.status) }}>
                {STATUS_ICONS[task.status] ?? "?"}
              </span>
              <span style={{ fg: theme.text }}> {task.subject}</span>
            </text>
          )}
        </For>
        <Show when={overflow() > 0}>
          <text>
            <span style={{ fg: theme.border }}>{"   ╰─ "}</span>
            <span style={{ fg: theme.textMuted }}>+{overflow()} more</span>
          </text>
        </Show>
      </box>
    </Show>
  )
}
