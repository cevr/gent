/**
 * Workflow progress widget — renders audit and review workflow phase/progress.
 *
 * Reads from server-projected extension snapshots. Shows phase indicator
 * and iteration progress when a workflow is active.
 */

import { Show, createMemo } from "solid-js"
import type { RGBA } from "@opentui/core"
import { useExtensionUI } from "./context"
import { useTheme } from "../theme/context"

const AUDIT_EXTENSION_ID = "audit-workflow"
const REVIEW_EXTENSION_ID = "review-workflow"

interface WorkflowUiModel {
  readonly phase: string
  readonly iteration: number
  readonly maxIterations: number
  readonly active: boolean
}

const PHASE_LABELS: Record<string, string> = {
  detect: "Detecting concerns",
  audit: "Auditing concerns",
  review: "Reviewing code",
  adversarial: "Adversarial review",
  synthesize: "Synthesizing findings",
  present: "Presenting results",
  execute: "Executing fixes",
  evaluate: "Evaluating results",
}

function WorkflowPhaseIndicator(props: {
  label: string
  model: WorkflowUiModel
  color: RGBA
  mutedColor: RGBA
}) {
  const phaseLabel = createMemo(() => PHASE_LABELS[props.model.phase] ?? props.model.phase)

  const iterationText = createMemo(() => {
    if (props.model.maxIterations <= 0) return ""
    return ` (${props.model.iteration}/${props.model.maxIterations})`
  })

  return (
    <text>
      <span style={{ fg: props.color, bold: true }}>[{props.label}]</span>
      <span style={{ fg: props.mutedColor }}>
        {" "}
        {phaseLabel()}
        {iterationText()}
      </span>
    </text>
  )
}

export function WorkflowProgressWidget() {
  const ext = useExtensionUI()
  const { theme } = useTheme()

  const auditModel = createMemo((): WorkflowUiModel | undefined => {
    const snapshot = ext.snapshots().get(AUDIT_EXTENSION_ID)
    if (snapshot === undefined) return undefined
    const m = snapshot.model as WorkflowUiModel
    return m.active ? m : undefined
  })

  const reviewModel = createMemo((): WorkflowUiModel | undefined => {
    const snapshot = ext.snapshots().get(REVIEW_EXTENSION_ID)
    if (snapshot === undefined) return undefined
    const m = snapshot.model as WorkflowUiModel
    return m.active ? m : undefined
  })

  const hasActive = createMemo(() => auditModel() !== undefined || reviewModel() !== undefined)

  return (
    <Show when={hasActive()}>
      <box flexDirection="column" paddingLeft={1} paddingRight={1}>
        <Show when={auditModel()}>
          {(m) => (
            <WorkflowPhaseIndicator
              label="AUDIT"
              model={m()}
              color={theme.info}
              mutedColor={theme.textMuted}
            />
          )}
        </Show>
        <Show when={reviewModel()}>
          {(m) => (
            <WorkflowPhaseIndicator
              label="REVIEW"
              model={m()}
              color={theme.accent}
              mutedColor={theme.textMuted}
            />
          )}
        </Show>
      </box>
    </Show>
  )
}
