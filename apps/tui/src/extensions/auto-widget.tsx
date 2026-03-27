/**
 * Auto loop widget — renders server-projected auto extension state.
 *
 * Shows iteration progress, goal snippet, and counsel indicator.
 * Placed in `above-input` slot.
 */

import { Schema } from "effect"
import { Show, createMemo } from "solid-js"
import type { RGBA } from "@opentui/core"
import { useExtensionUI } from "./context"
import { useTheme } from "../theme/context"

const EXTENSION_ID = "auto"

const AutoUiModel = Schema.Struct({
  active: Schema.Boolean,
  phase: Schema.optional(Schema.Literals(["working", "awaiting-counsel"])),
  iteration: Schema.optional(Schema.Number),
  maxIterations: Schema.optional(Schema.Number),
  goal: Schema.optional(Schema.String),
  learningsCount: Schema.Number,
})
type AutoUiModel = typeof AutoUiModel.Type

const decodeAuto = Schema.decodeUnknownOption(AutoUiModel)

export function AutoWidget() {
  const ext = useExtensionUI()
  const { theme } = useTheme()

  const model = createMemo((): AutoUiModel | undefined => {
    const snapshot = ext.snapshots().get(EXTENSION_ID)
    if (snapshot === undefined) return undefined
    return decodeAuto(snapshot.model).pipe((opt) => (opt._tag === "Some" ? opt.value : undefined))
  })

  const phaseLabel = createMemo(() => {
    const m = model()
    if (m === undefined || !m.active) return ""
    return m.phase === "awaiting-counsel" ? "COUNSEL" : "AUTO"
  })

  const phaseColor = createMemo((): RGBA => {
    const m = model()
    if (m?.phase === "awaiting-counsel") return theme.warning
    return theme.info
  })

  const iterationText = createMemo(() => {
    const m = model()
    if (m === undefined || m.iteration === undefined) return ""
    return `${m.iteration}/${m.maxIterations ?? "?"}`
  })

  const goalSnippet = createMemo(() => {
    const m = model()
    if (m?.goal === undefined) return ""
    return m.goal.length > 40 ? m.goal.slice(0, 40) + "..." : m.goal
  })

  return (
    <Show when={model()?.active === true}>
      <box paddingLeft={1} paddingRight={1}>
        <text>
          <span style={{ fg: phaseColor(), bold: true }}>[{phaseLabel()}]</span>
          <span style={{ fg: theme.textMuted }}> {iterationText()}</span>
          <Show when={goalSnippet() !== ""}>
            <span style={{ fg: theme.text }}> — {goalSnippet()}</span>
          </Show>
          <Show when={(model()?.learningsCount ?? 0) > 0}>
            <span style={{ fg: theme.textMuted }}> ({model()?.learningsCount} learnings)</span>
          </Show>
        </text>
      </box>
    </Show>
  )
}
