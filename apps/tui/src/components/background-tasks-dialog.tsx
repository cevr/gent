/**
 * BackgroundTasksDialog — overlay panel for viewing and managing background tasks.
 *
 * Features:
 * - List tasks with status indicators
 * - Navigate with j/k, select with enter for detail view
 * - Stop tasks with x (via task_update → stopped)
 * - Close with escape
 */

import { createSignal, createEffect, Show, For } from "solid-js"
import { Effect } from "effect"
import { useTerminalDimensions } from "@opentui/solid"
import type { TaskId } from "@gent/core/domain/ids.js"
import { TaskUpdateRef } from "@gent/extensions/task-tools/mutations.js"
import { type TaskEntry } from "@gent/extensions/task-tools/identity.js"
import { ChromePanel } from "./chrome-panel"
import { useScopedKeyboard } from "../keyboard/context"
import { useClient } from "../client/context"
import { useRuntime } from "../hooks/use-runtime"
import { useTheme } from "../theme/index"
import { useSpinnerClock } from "../hooks/use-spinner-clock"

const STATUS_ICONS: Record<string, string> = {
  pending: "◻",
  in_progress: "◰",
  completed: "✔",
  failed: "✗",
  stopped: "◼",
}

const IN_PROGRESS_SPINNER = ["◰", "◳", "◲", "◱"] as const

const PANEL_WIDTH = 70
const PANEL_HEIGHT = 20

export function BackgroundTasksDialog(props: {
  open: boolean
  onClose: () => void
  tasks: readonly TaskEntry[]
}) {
  const clientCtx = useClient()
  const { cast } = useRuntime()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const tick = useSpinnerClock()

  const [selectedIdx, setSelectedIdx] = createSignal(0)
  const [detailTaskId, setDetailTaskId] = createSignal<TaskId | undefined>(undefined)

  // Reset selection when tasks change
  createEffect(() => {
    const len = props.tasks.length
    if (selectedIdx() >= len && len > 0) {
      setSelectedIdx(len - 1)
    }
  })

  const stopTask = (taskId: TaskId) => {
    const session = clientCtx.session()
    if (session === undefined || session === null) return
    cast(
      clientCtx.client.extension
        .mutate({
          sessionId: session.sessionId,
          branchId: session.branchId,
          extensionId: TaskUpdateRef.extensionId,
          mutationId: TaskUpdateRef.mutationId,
          input: { taskId, status: "stopped" },
        })
        .pipe(Effect.catchEager(() => Effect.void)),
    )
  }

  useScopedKeyboard(
    (event) => {
      if (!props.open) return false

      if (event.name === "escape") {
        if (detailTaskId() !== undefined) {
          setDetailTaskId(undefined)
        } else {
          props.onClose()
        }
        return true
      }

      if (detailTaskId() !== undefined) return false

      const tasks = props.tasks
      if (tasks.length === 0) return false

      if (event.name === "j" || event.name === "down") {
        setSelectedIdx((i) => Math.min(i + 1, tasks.length - 1))
        return true
      }
      if (event.name === "k" || event.name === "up") {
        setSelectedIdx((i) => Math.max(i - 1, 0))
        return true
      }
      if (event.name === "return") {
        const task = tasks[selectedIdx()]
        if (task !== undefined) {
          setDetailTaskId(task.id)
        }
        return true
      }
      if (event.name === "x") {
        const task = tasks[selectedIdx()]
        if (task !== undefined && (task.status === "in_progress" || task.status === "pending")) {
          stopTask(task.id)
        }
        return true
      }

      return false
    },
    { when: () => props.open },
  )

  const statusIcon = (status: TaskEntry["status"]) => {
    if (status !== "in_progress") return STATUS_ICONS[status] ?? "?"
    return IN_PROGRESS_SPINNER[tick() % IN_PROGRESS_SPINNER.length] ?? "◰"
  }

  const statusColor = (status: TaskEntry["status"]) => {
    switch (status) {
      case "in_progress":
        return theme.warning
      case "completed":
        return theme.success
      case "failed":
      case "stopped":
        return theme.error
      case "pending":
        return theme.textMuted
      default:
        return theme.text
    }
  }

  const detailTask = () => {
    const id = detailTaskId()
    return id !== undefined ? props.tasks.find((t) => t.id === id) : undefined
  }

  const left = () => Math.max(0, Math.floor((dimensions().width - PANEL_WIDTH) / 2))
  const top = () => Math.max(0, Math.floor((dimensions().height - PANEL_HEIGHT) / 2))

  return (
    <Show when={props.open}>
      <ChromePanel.Root
        title={detailTask() !== undefined ? `Task: ${detailTask()?.subject}` : "Background Tasks"}
        width={PANEL_WIDTH}
        height={PANEL_HEIGHT}
        left={left()}
        top={top()}
      >
        <ChromePanel.Body>
          <Show
            when={detailTask() === undefined}
            fallback={
              <box flexDirection="column" paddingLeft={1}>
                <text>
                  <span style={{ fg: theme.textMuted }}>Subject: </span>
                  <span style={{ fg: theme.text }}>{detailTask()?.subject}</span>
                </text>
                <text>
                  <span style={{ fg: theme.textMuted }}>Status: </span>
                  <span style={{ fg: statusColor(detailTask()?.status ?? "pending") }}>
                    {detailTask()?.status}
                  </span>
                </text>
              </box>
            }
          >
            <Show
              when={props.tasks.length > 0}
              fallback={
                <box paddingLeft={1}>
                  <text>
                    <span style={{ fg: theme.textMuted }}>No background tasks</span>
                  </text>
                </box>
              }
            >
              <For each={[...props.tasks]}>
                {(task, idx) => {
                  const selected = () => idx() === selectedIdx()
                  return (
                    <text>
                      <span style={{ fg: selected() ? theme.primary : theme.textMuted }}>
                        {selected() ? " ❯ " : "   "}
                      </span>
                      <span style={{ fg: statusColor(task.status) }}>
                        {statusIcon(task.status)}
                      </span>
                      <span style={{ fg: selected() ? theme.text : theme.textMuted }}>
                        {" "}
                        {task.subject}
                      </span>
                    </text>
                  )
                }}
              </For>
            </Show>
          </Show>
        </ChromePanel.Body>
        <ChromePanel.Footer>
          <Show when={detailTask() === undefined} fallback="esc back">
            {"↑↓ navigate · enter detail · x stop · esc close"}
          </Show>
        </ChromePanel.Footer>
      </ChromePanel.Root>
    </Show>
  )
}
