import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../theme/index"
import { truncate } from "../utils/truncate"
import { useSpinnerClock } from "../hooks/use-spinner-clock"
import { getSessionEventLabel, type SessionEvent } from "./session-event-label"

export interface SessionEventIndicatorProps {
  event: SessionEvent
}

const LINE_CHAR = "\u2500"

export function SessionEventIndicator(props: SessionEventIndicatorProps) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const tick = useSpinnerClock()

  const line = () => {
    tick()
    const width = Math.max(0, dimensions().width)
    const label = getSessionEventLabel(props.event)
    const prefix = `- ${label} `
    if (width <= 0) return ""
    if (prefix.length >= width) {
      return truncate(prefix.trimEnd(), width)
    }
    return `${prefix}${LINE_CHAR.repeat(width - prefix.length)}`
  }

  const plain = () => {
    tick()
    const width = Math.max(0, dimensions().width)
    return truncate(getSessionEventLabel(props.event), width)
  }

  const isLineEvent = () =>
    props.event.kind === "turn-ended" ||
    props.event.kind === "error" ||
    props.event.kind === "retrying"

  const color = () => {
    switch (props.event.kind) {
      case "error":
        return theme.error
      case "retrying":
        return theme.warning
      case "interruption":
        return theme.warning
      default:
        return theme.textMuted
    }
  }

  return (
    <box marginTop={1}>
      <text style={{ fg: color() }}>{isLineEvent() ? line() : plain()}</text>
    </box>
  )
}
