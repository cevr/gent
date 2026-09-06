import type { Accessor } from "solid-js"
import { useTheme } from "../theme/index"
import { truncate } from "../utils/format-tool"
import { useSpinnerClock } from "../hooks/use-spinner-clock"
import { getSessionEventLabel, type SessionEvent } from "./session-event-label"
import { DateTime, Predicate } from "effect"

export interface SessionEventIndicatorProps {
  event: SessionEvent
  dimensions: Accessor<{ readonly width: number; readonly height: number }>
}

const LINE_CHAR = "\u2500"

const currentMillis = () => DateTime.toEpochMillis(DateTime.nowUnsafe())

export function SessionEventIndicator(props: SessionEventIndicatorProps) {
  const { theme } = useTheme()
  const tick = useSpinnerClock()

  const line = () => {
    tick()
    const width = Math.max(0, props.dimensions().width)
    const label = getSessionEventLabel(props.event, currentMillis())
    const prefix = `- ${label} `
    if (width <= 0) return ""
    if (prefix.length >= width) {
      return truncate(prefix.trimEnd(), width)
    }
    return `${prefix}${LINE_CHAR.repeat(width - prefix.length)}`
  }

  const plain = () => {
    tick()
    const width = Math.max(0, props.dimensions().width)
    return truncate(getSessionEventLabel(props.event, currentMillis()), width)
  }

  const isLineEvent = Predicate.or(
    Predicate.isTagged("turn-ended"),
    Predicate.or(Predicate.isTagged("error"), Predicate.isTagged("retrying")),
  )

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

  const content = () => {
    if (isLineEvent(props.event)) return line()
    return plain()
  }

  return (
    <box marginTop={1}>
      <text style={{ fg: color() }}>{content()}</text>
    </box>
  )
}
