/**
 * TodoDialog — overlay panel for viewing and managing todos.
 *
 * Features:
 * - List todos with status indicators
 * - Navigate with j/k, select with enter for detail view
 * - Stop todos with x (via todo_update → stopped)
 * - Close with escape
 */

import { createSignal, createEffect, Show, For } from "solid-js"
import { Effect } from "effect"
import { useTerminalDimensions } from "@opentui/solid"
import { ref } from "@gent/core/extensions/api"
import { type TodoEntry, type TodoIdType, TodoUpdateRequest } from "@gent/extensions/client.js"
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

export function TodoDialog(props: {
  open: boolean
  onClose: () => void
  todos: readonly TodoEntry[]
}) {
  const clientCtx = useClient()
  const { cast } = useRuntime()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const tick = useSpinnerClock()

  const [selectedIdx, setSelectedIdx] = createSignal(0)
  const [detailTodoId, setDetailTodoId] = createSignal<TodoIdType | undefined>(undefined)

  // Reset selection when todos change
  createEffect(() => {
    const len = props.todos.length
    if (selectedIdx() >= len && len > 0) {
      setSelectedIdx(len - 1)
    }
  })

  const stopTodo = (todoId: TodoIdType) => {
    const session = clientCtx.session()
    if (session === undefined || session === null) return
    const updateRef = ref(TodoUpdateRequest)
    cast(
      clientCtx.client.extension
        .request({
          sessionId: session.sessionId,
          branchId: session.branchId,
          extensionId: updateRef.extensionId,
          capabilityId: updateRef.capabilityId,
          input: { todoId, status: "stopped" },
        })
        .pipe(Effect.catchEager(() => Effect.void)),
    )
  }

  useScopedKeyboard(
    (event) => {
      if (!props.open) return false

      if (event.name === "escape") {
        if (detailTodoId() !== undefined) {
          setDetailTodoId(undefined)
        } else {
          props.onClose()
        }
        return true
      }

      if (detailTodoId() !== undefined) return false

      const todos = props.todos
      if (todos.length === 0) return false

      if (event.name === "j" || event.name === "down") {
        setSelectedIdx((i) => Math.min(i + 1, todos.length - 1))
        return true
      }
      if (event.name === "k" || event.name === "up") {
        setSelectedIdx((i) => Math.max(i - 1, 0))
        return true
      }
      if (event.name === "return") {
        const todo = todos[selectedIdx()]
        if (todo !== undefined) {
          setDetailTodoId(todo.id)
        }
        return true
      }
      if (event.name === "x") {
        const todo = todos[selectedIdx()]
        if (todo !== undefined && (todo.status === "in_progress" || todo.status === "pending")) {
          stopTodo(todo.id)
        }
        return true
      }

      return false
    },
    { when: () => props.open },
  )

  const statusIcon = (status: TodoEntry["status"]) => {
    if (status !== "in_progress") return STATUS_ICONS[status] ?? "?"
    return IN_PROGRESS_SPINNER[tick() % IN_PROGRESS_SPINNER.length] ?? "◰"
  }

  const statusColor = (status: TodoEntry["status"]) => {
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

  const detailTodo = () => {
    const id = detailTodoId()
    return id !== undefined ? props.todos.find((t) => t.id === id) : undefined
  }

  const left = () => Math.max(0, Math.floor((dimensions().width - PANEL_WIDTH) / 2))
  const top = () => Math.max(0, Math.floor((dimensions().height - PANEL_HEIGHT) / 2))

  return (
    <Show when={props.open}>
      <ChromePanel.Root
        title={detailTodo() !== undefined ? `Todo: ${detailTodo()?.subject}` : "Todos"}
        width={PANEL_WIDTH}
        height={PANEL_HEIGHT}
        left={left()}
        top={top()}
      >
        <ChromePanel.Body>
          <Show
            when={detailTodo() === undefined}
            fallback={
              <box flexDirection="column" paddingLeft={1}>
                <text>
                  <span style={{ fg: theme.textMuted }}>Subject: </span>
                  <span style={{ fg: theme.text }}>{detailTodo()?.subject}</span>
                </text>
                <text>
                  <span style={{ fg: theme.textMuted }}>Status: </span>
                  <span style={{ fg: statusColor(detailTodo()?.status ?? "pending") }}>
                    {detailTodo()?.status}
                  </span>
                </text>
              </box>
            }
          >
            <Show
              when={props.todos.length > 0}
              fallback={
                <box paddingLeft={1}>
                  <text>
                    <span style={{ fg: theme.textMuted }}>No todos</span>
                  </text>
                </box>
              }
            >
              <For each={[...props.todos]}>
                {(todo, idx) => {
                  const selected = () => idx() === selectedIdx()
                  return (
                    <text>
                      <span style={{ fg: selected() ? theme.primary : theme.textMuted }}>
                        {selected() ? " ❯ " : "   "}
                      </span>
                      <span style={{ fg: statusColor(todo.status) }}>
                        {statusIcon(todo.status)}
                      </span>
                      <span style={{ fg: selected() ? theme.text : theme.textMuted }}>
                        {" "}
                        {todo.subject}
                      </span>
                    </text>
                  )
                }}
              </For>
            </Show>
          </Show>
        </ChromePanel.Body>
        <ChromePanel.Footer>
          <Show when={detailTodo() === undefined} fallback="esc back">
            {"↑↓ navigate · enter detail · x stop · esc close"}
          </Show>
        </ChromePanel.Footer>
      </ChromePanel.Root>
    </Show>
  )
}
