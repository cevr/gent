/**
 * Plan-mode widget — renders server-projected plan state.
 *
 * Shows mode indicator + progress when plan extension is active.
 * Step-level display is delegated to the task widget.
 * Placed in `above-input` slot so it's always visible during session interaction.
 */

import { Schema } from "effect"
import { Show, createMemo } from "solid-js"
import type { RGBA } from "@opentui/core"
import { useExtensionUI } from "./context"
import { useTheme } from "../theme/context"

const EXTENSION_ID = "plan"

const PlanUiModel = Schema.Struct({
  mode: Schema.Literals(["normal", "plan", "executing"]),
  steps: Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      text: Schema.String,
      status: Schema.Literals(["pending", "in_progress", "completed", "failed", "stopped"]),
    }),
  ),
  progress: Schema.Struct({
    total: Schema.Number,
    completed: Schema.Number,
    inProgress: Schema.Number,
  }),
})
type PlanUiModel = typeof PlanUiModel.Type

const decodePlan = Schema.decodeUnknownOption(PlanUiModel)

export function PlanWidget() {
  const ext = useExtensionUI()
  const { theme } = useTheme()

  const model = createMemo((): PlanUiModel | undefined => {
    const snapshot = ext.snapshots().get(EXTENSION_ID)
    if (snapshot === undefined) return undefined
    return decodePlan(snapshot.model).pipe((opt) => (opt._tag === "Some" ? opt.value : undefined))
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
    return `${m.progress.completed}/${m.progress.total}`
  })

  return (
    <Show when={isActive()}>
      <box flexDirection="column" paddingLeft={1} paddingRight={1}>
        <text>
          <span style={{ fg: modeColor(), bold: true }}>[{modeLabel()}]</span>
          <Show when={progressText() !== ""}>
            <span style={{ fg: theme.textMuted }}> {progressText()}</span>
          </Show>
        </text>
      </box>
    </Show>
  )
}
