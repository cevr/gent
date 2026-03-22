import { Effect } from "effect"
import { createSignal, createEffect, onCleanup, Show, For } from "solid-js"
import type { Task } from "@gent/core/domain/task.js"
import type { SessionId, BranchId } from "@gent/core/domain/ids.js"
import { useClient } from "../client/context"
import { useRuntime } from "../hooks/use-runtime"

const STATUS_ICONS: Record<string, string> = {
  pending: "◻",
  in_progress: "✳",
  completed: "✔",
  failed: "✗",
}

const STATUS_COLORS: Record<string, string> = {
  pending: "gray",
  in_progress: "yellow",
  completed: "green",
  failed: "red",
}

const MAX_DISPLAY = 10

export function TaskWidget(props: { sessionId: SessionId; branchId: BranchId }) {
  const client = useClient()
  const { cast } = useRuntime(client.client.services)

  const [tasks, setTasks] = createSignal<Task[]>([])

  const loadTasks = () => {
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
    loadTasks()
  })

  // Subscribe to task events for live updates
  createEffect(() => {
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
    const t = tasks()
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

  const displayTasks = () => tasks().slice(0, MAX_DISPLAY)

  const overflow = () => Math.max(0, tasks().length - MAX_DISPLAY)

  return (
    <Show when={tasks().length > 0}>
      <box flexDirection="column" paddingLeft={1} paddingRight={1}>
        <text>
          <span style={{ fg: "cyan", bold: true }}>● </span>
          <span style={{ dimmed: true }}>{summary()}</span>
        </text>
        <For each={displayTasks()}>
          {(task) => (
            <text>
              <span style={{ fg: STATUS_COLORS[task.status] ?? "white" }}>
                {"  "}
                {STATUS_ICONS[task.status] ?? "?"}{" "}
              </span>
              <span>{task.subject}</span>
            </text>
          )}
        </For>
        <Show when={overflow() > 0}>
          <text>
            <span style={{ dimmed: true }}>
              {"  "}+{overflow()} more
            </span>
          </text>
        </Show>
      </box>
    </Show>
  )
}
