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
import { Effect, Option } from "effect"
import { useTerminalDimensions } from "../terminal-dimensions"
import { ref } from "@gent/core/extensions/api"
import { type TodoEntry, type TodoIdType, TodoUpdateRequest } from "@gent/extensions/client.js"
import { ChromePanel } from "./chrome-panel"
import { useScopedKeyboard } from "../keyboard/context"
import { useClient } from "../client/context"
import { useRuntime } from "../hooks/use-runtime"
import { useTheme } from "../theme/index"
import { useSpinnerClock } from "../hooks/use-spinner-clock"
import type { ScrollBoxRenderable } from "@opentui/core"
import { pickerText } from "./picker-text"
import { useScrollSync } from "../hooks/use-scroll-sync"

const STATUS_ICONS = {
  pending: "◻",
  in_progress: "◰",
  completed: "✔",
  failed: "✗",
  stopped: "◼",
} satisfies Record<string, string>

const IN_PROGRESS_SPINNER = ["◰", "◳", "◲", "◱"] satisfies ReadonlyArray<string>

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
  const [detailTodoId, setDetailTodoId] = createSignal<Option.Option<TodoIdType>>(Option.none())
  let body = Option.none<ScrollBoxRenderable>()

  useScrollSync(() => `todo-${selectedIdx()}`, {
    enabled: () => props.open && Option.isNone(detailTodoId()),
    getRef: () => Option.getOrUndefined(body),
  })

  // Reset selection when todos change
  createEffect(() => {
    const len = props.todos.length
    if (selectedIdx() >= len && len > 0) {
      setSelectedIdx(len - 1)
    }
  })

  const stopTodo = (todoId: TodoIdType) => {
    const session = Option.fromNullishOr(clientCtx.session())
    if (Option.isNone(session)) return
    const updateRef = ref(TodoUpdateRequest)
    cast(
      clientCtx.client.extension
        .request({
          sessionId: session.value.sessionId,
          branchId: session.value.branchId,
          extensionId: updateRef.extensionId,
          capabilityId: updateRef.capabilityId,
          input: { todoId, status: "stopped" },
        })
        .pipe(Effect.catchEager(() => Effect.void)),
    )
  }

  const scrollDetail = (key: string) => {
    if (Option.isNone(body)) return false
    if (key === "pageup") {
      body.value.scrollBy(-body.value.height)
      return true
    }
    if (key === "pagedown") {
      body.value.scrollBy(body.value.height)
      return true
    }
    return false
  }

  useScopedKeyboard(
    (event) => {
      if (!props.open) return false

      if (event.name === "escape") {
        if (Option.isSome(detailTodoId())) {
          setDetailTodoId(Option.none())
        } else {
          props.onClose()
        }
        return true
      }

      if (Option.isSome(detailTodoId())) {
        return scrollDetail(event.name)
      }

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
        const todo = Option.fromNullishOr(todos[selectedIdx()])
        if (Option.isSome(todo)) {
          setDetailTodoId(Option.some(todo.value.id))
        }
        return true
      }
      if (event.name === "x") {
        const todo = Option.fromNullishOr(todos[selectedIdx()])
        if (
          Option.isSome(todo) &&
          (todo.value.status === "in_progress" || todo.value.status === "pending")
        ) {
          stopTodo(todo.value.id)
        }
        return true
      }

      return false
    },
    { when: () => props.open },
  )

  const statusIcon = (status: TodoEntry["status"]) => {
    if (status !== "in_progress") {
      return Option.getOrElse(Option.fromNullishOr(STATUS_ICONS[status]), () => "?")
    }
    return Option.getOrElse(
      Option.fromNullishOr(IN_PROGRESS_SPINNER[tick() % IN_PROGRESS_SPINNER.length]),
      () => "◰",
    )
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

  const detailTodo = (): Option.Option<TodoEntry> => {
    const id = detailTodoId()
    if (Option.isNone(id)) return Option.none()
    return Option.fromNullishOr(props.todos.find((todo) => todo.id === id.value))
  }

  const detailTitle = () =>
    Option.match(detailTodo(), {
      onNone: () => "Todos",
      onSome: (todo) => `Todo: ${todo.subject}`,
    })

  const panelWidth = () => Math.min(PANEL_WIDTH, dimensions().width)
  const panelHeight = () => Math.min(PANEL_HEIGHT, dimensions().height)
  const left = () => Math.max(0, Math.floor((dimensions().width - panelWidth()) / 2))
  const top = () => Math.max(0, Math.floor((dimensions().height - panelHeight()) / 2))
  const footer = () => {
    if (dimensions().width < 60) return "↑↓ Move · Enter Detail · x Stop · Esc"
    return "↑↓ navigate · enter detail · x stop · esc close"
  }

  return (
    <Show when={props.open}>
      <ChromePanel.Root
        title={pickerText(detailTitle(), panelWidth() - 6)}
        width={panelWidth()}
        height={panelHeight()}
        left={left()}
        top={top()}
      >
        <ChromePanel.Body
          ref={(value) => {
            body = Option.some(value)
          }}
        >
          <Show
            when={Option.isNone(detailTodo())}
            fallback={
              <box flexDirection="column" paddingLeft={1}>
                {Option.match(detailTodo(), {
                  onNone: () => <></>,
                  onSome: (todo) => (
                    <>
                      <text>
                        <span style={{ fg: theme.textMuted }}>Subject: </span>
                        <span style={{ fg: theme.text }}>{todo.subject}</span>
                      </text>
                      <text>
                        <span style={{ fg: theme.textMuted }}>Status: </span>
                        <span style={{ fg: statusColor(todo.status) }}>{todo.status}</span>
                      </text>
                    </>
                  ),
                })}
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
                  const selectionColor = () => {
                    if (selected()) return theme.primary
                    return theme.textMuted
                  }
                  const selectionMarker = () => {
                    if (selected()) return " ❯ "
                    return "   "
                  }
                  const subjectColor = () => {
                    if (selected()) return theme.text
                    return theme.textMuted
                  }
                  return (
                    <text id={`todo-${idx()}`} height={1} wrapMode="none" truncate>
                      <span style={{ fg: selectionColor() }}>{selectionMarker()}</span>
                      <span style={{ fg: statusColor(todo.status) }}>
                        {statusIcon(todo.status)}
                      </span>
                      <span style={{ fg: subjectColor() }}>
                        {" "}
                        {pickerText(todo.subject, panelWidth() - 9)}
                      </span>
                    </text>
                  )
                }}
              </For>
            </Show>
          </Show>
        </ChromePanel.Body>
        <ChromePanel.Footer>
          <Show when={Option.isNone(detailTodo())} fallback="PgUp/PgDn scroll · Esc back">
            {footer()}
          </Show>
        </ChromePanel.Footer>
      </ChromePanel.Root>
    </Show>
  )
}
