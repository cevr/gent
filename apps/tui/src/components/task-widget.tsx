import { Effect, Fiber, Stream } from "effect"
import { createSignal, createEffect, onCleanup, Show, For } from "solid-js"
import type { Task } from "@gent/core/domain/task.js"
import type { SessionId, BranchId } from "@gent/core/domain/ids.js"
import { useClient } from "../client/context"
import { useRuntime } from "../hooks/use-runtime"
import { useSpinnerClock } from "../hooks/use-spinner-clock"
import { useTheme } from "../theme/index"
import { runWithReconnect } from "../utils/run-with-reconnect"
import { InlineChrome } from "./inline-chrome"

const STATUS_ICONS: Record<string, string> = {
  pending: "◻",
  in_progress: "◰",
  completed: "✔",
  failed: "✗",
}

const IN_PROGRESS_SPINNER = ["◰", "◳", "◲", "◱"] as const

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
  const tick = useSpinnerClock()

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

    const fiber = Effect.runForkWith(client.client.services)(
      runWithReconnect(
        () =>
          client.client.streamEvents({ sessionId: props.sessionId, branchId: props.branchId }).pipe(
            Stream.runForEach((envelope) =>
              Effect.sync(() => {
                switch (envelope.event._tag) {
                  case "TaskCreated":
                  case "TaskUpdated":
                  case "TaskCompleted":
                  case "TaskFailed":
                  case "TaskDeleted":
                    loadTasks()
                    break
                }
              }),
            ),
          ),
        {
          onError: () => undefined,
          waitForRetry: () => client.waitForWorkerRunning(),
        },
      ),
    )

    onCleanup(() => {
      Effect.runFork(Fiber.interrupt(fiber))
    })
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

  const statusIcon = (status: Task["status"]) => {
    if (status !== "in_progress") {
      return STATUS_ICONS[status] ?? "?"
    }
    return IN_PROGRESS_SPINNER[tick() % IN_PROGRESS_SPINNER.length] ?? STATUS_ICONS["in_progress"]
  }

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
      <InlineChrome.Root paddingLeft={2} marginTop={1} marginBottom={1}>
        <InlineChrome.Header
          accentColor={theme.info}
          leading={<span style={{ fg: theme.info }}>•</span>}
          title={<span style={{ fg: theme.info, bold: true }}>tasks</span>}
          subtitle={summary()}
          subtitleColor={theme.textMuted}
        />
        <InlineChrome.Body accentColor={theme.info}>
          <For each={displayTasks()}>
            {(task) => (
              <text>
                <span style={{ fg: theme.info }}>{"│ "}</span>
                <span style={{ fg: statusColor(task.status) }}>{statusIcon(task.status)}</span>
                <span style={{ fg: theme.text }}> {task.subject}</span>
              </text>
            )}
          </For>
          <Show when={overflow() > 0}>
            <text>
              <span style={{ fg: theme.info }}>{"│ "}</span>
              <span style={{ fg: theme.textMuted }}>+{overflow()} more</span>
            </text>
          </Show>
        </InlineChrome.Body>
        <InlineChrome.Footer accentColor={theme.info} />
      </InlineChrome.Root>
    </Show>
  )
}
