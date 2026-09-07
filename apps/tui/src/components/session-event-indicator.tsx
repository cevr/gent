import { useTheme } from "../theme/index"
import { useSpinnerClock } from "../hooks/use-spinner-clock"
import { getSessionEventLabel, type SessionEvent } from "./session-event-label"
import { DateTime } from "effect"

export interface SessionEventIndicatorProps {
  event: SessionEvent
}

const currentMillis = () => DateTime.toEpochMillis(DateTime.nowUnsafe())

export function SessionEventIndicator(props: SessionEventIndicatorProps) {
  const { theme } = useTheme()
  const tick = useSpinnerClock()

  const content = () => {
    tick()
    return getSessionEventLabel(props.event, currentMillis())
  }

  const color = () => {
    switch (props.event._tag) {
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
      <text style={{ fg: color() }}>● {content()}</text>
    </box>
  )
}
