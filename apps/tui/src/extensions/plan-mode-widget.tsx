/**
 * Plan-mode widget — renders server-projected plan-mode state.
 *
 * Shows mode indicator + todo checklist when plan-mode extension is active.
 * Placed in `above-input` slot so it's always visible during session interaction.
 */

import { Schema } from "effect"
import { Show, For, createMemo } from "solid-js"
import type { RGBA } from "@opentui/core"
import { useExtensionUI } from "./context"
import { useTheme } from "../theme/context"

const EXTENSION_ID = "plan-mode"

const PlanModeUiModel = Schema.Struct({
  mode: Schema.Literals(["normal", "plan", "executing"]),
  todos: Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      text: Schema.String,
      status: Schema.Literals(["pending", "in-progress", "done"]),
    }),
  ),
  progress: Schema.Struct({
    total: Schema.Number,
    done: Schema.Number,
    inProgress: Schema.Number,
  }),
})
type PlanModeUiModel = typeof PlanModeUiModel.Type

const decodePlanMode = Schema.decodeUnknownOption(PlanModeUiModel)

export function PlanModeWidget() {
  const ext = useExtensionUI()
  const { theme } = useTheme()

  const model = createMemo((): PlanModeUiModel | undefined => {
    const snapshot = ext.snapshots().get(EXTENSION_ID)
    if (snapshot === undefined) return undefined
    return decodePlanMode(snapshot.model).pipe((opt) =>
      opt._tag === "Some" ? opt.value : undefined,
    )
  })

  const isActive = createMemo(() => {
    const m = model()
    return m !== undefined && m.mode !== "normal"
  })

  const modeLabel = createMemo(() => {
    const m = model()
    if (m === undefined) return ""
    switch (m.mode) {
      case "plan":
        return "PLAN"
      case "executing":
        return "EXEC"
      default:
        return ""
    }
  })

  const modeColor = createMemo((): RGBA => {
    const m = model()
    if (m === undefined) return theme.textMuted
    switch (m.mode) {
      case "plan":
        return theme.warning
      case "executing":
        return theme.success
      default:
        return theme.textMuted
    }
  })

  const progressText = createMemo(() => {
    const m = model()
    if (m === undefined || m.progress.total === 0) return ""
    return `${m.progress.done}/${m.progress.total}`
  })

  return (
    <Show when={isActive()}>
      <box flexDirection="column" paddingLeft={1} paddingRight={1}>
        {/* Mode indicator + progress */}
        <text>
          <span style={{ fg: modeColor(), bold: true }}>[{modeLabel()}]</span>
          <Show when={progressText() !== ""}>
            <span style={{ fg: theme.textMuted }}> {progressText()}</span>
          </Show>
        </text>

        {/* Todo list (compact — only show when there are items) */}
        <Show when={model()?.todos !== undefined && (model()?.todos.length ?? 0) > 0}>
          <For each={model()?.todos ?? []}>
            {(todo) => {
              const marker = () => {
                switch (todo.status) {
                  case "done":
                    return "x"
                  case "in-progress":
                    return "~"
                  default:
                    return " "
                }
              }
              const color = (): RGBA => {
                switch (todo.status) {
                  case "done":
                    return theme.textMuted
                  case "in-progress":
                    return theme.warning
                  default:
                    return theme.text
                }
              }
              return (
                <text>
                  <span style={{ fg: color() }}>
                    [{marker()}] {todo.text}
                  </span>
                </text>
              )
            }}
          </For>
        </Show>
      </box>
    </Show>
  )
}
