/**
 * ActivityRow — shows current agent activity between input and status bar.
 *
 * Displays: · turn 2 · bash(npm test) · 12s
 * Animated spinner using ·•*⁑⁂ pattern at 150ms (reuses spinner clock).
 * Phases: idle (hidden) | thinking | tool | streaming
 */

import { Show, createMemo, createSignal, createEffect, onCleanup } from "solid-js"
import { useTheme } from "../theme/index"
import { useSpinnerClock } from "../hooks/use-spinner-clock"

const SPINNER_FRAMES = ["·", "•", "*", "⁑", "⁂"]

export interface ActivityInfo {
  /** Current phase */
  phase: "idle" | "thinking" | "tool" | "streaming"
  /** Current turn number */
  turn: number
  /** Active tool name + input summary (if phase === "tool") */
  toolInfo?: string
}

export interface ActivityRowProps {
  activity: ActivityInfo
}

function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const remainingSecs = secs % 60
  return `${mins}m ${remainingSecs}s`
}

export function ActivityRow(props: ActivityRowProps) {
  const { theme } = useTheme()
  const tick = useSpinnerClock()
  const [elapsed, setElapsed] = createSignal(0)
  let startTime = Date.now()

  // Reset timer when phase changes
  createEffect(() => {
    const _phase = props.activity.phase
    startTime = Date.now()
    setElapsed(0)

    if (_phase === "idle") return

    const interval = setInterval(() => {
      setElapsed(Date.now() - startTime)
    }, 1000)
    onCleanup(() => clearInterval(interval))
  })

  const spinner = createMemo(() => {
    const idx = tick() % SPINNER_FRAMES.length
    return SPINNER_FRAMES[idx] ?? SPINNER_FRAMES[0]
  })

  const phaseLabel = createMemo(() => {
    switch (props.activity.phase) {
      case "thinking":
        return "thinking"
      case "streaming":
        return "writing"
      case "tool":
        return props.activity.toolInfo ?? "working"
      case "idle":
        return ""
    }
  })

  return (
    <Show when={props.activity.phase !== "idle"}>
      <box flexShrink={0} paddingLeft={1}>
        <text>
          <span style={{ fg: theme.textMuted }}>{spinner()} </span>
          <span style={{ fg: theme.textMuted }}>turn {props.activity.turn}</span>
          <span style={{ fg: theme.border }}> · </span>
          <span style={{ fg: theme.info }}>{phaseLabel()}</span>
          <Show when={elapsed() >= 1000}>
            <span style={{ fg: theme.border }}> · </span>
            <span style={{ fg: theme.textMuted }}>{formatElapsed(elapsed())}</span>
          </Show>
        </text>
      </box>
    </Show>
  )
}
