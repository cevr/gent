import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../theme/index"
import { formatThinkTime } from "./message-list-utils"
import { truncate } from "../utils/truncate"

export type SessionEvent =
  | {
      _tag: "event"
      kind: "turn-ended"
      durationSeconds: number
      createdAt: number
      seq: number
    }
  | {
      _tag: "event"
      kind: "interruption"
      createdAt: number
      seq: number
    }
  | {
      _tag: "event"
      kind: "error"
      error: string
      createdAt: number
      seq: number
    }

export interface SessionEventIndicatorProps {
  event: SessionEvent
}

const LINE_CHAR = "\u2500"

const getLabel = (event: SessionEvent): string => {
  switch (event.kind) {
    case "turn-ended":
      return `Worked for ${formatThinkTime(event.durationSeconds)}`
    case "interruption":
      return "Interrupted - what do you want to do instead?"
    case "error":
      return event.error
  }
}

export function SessionEventIndicator(props: SessionEventIndicatorProps) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  const line = () => {
    const width = Math.max(0, dimensions().width)
    const label = getLabel(props.event)
    const prefix = `- ${label} `
    if (width <= 0) return ""
    if (prefix.length >= width) {
      return truncate(prefix.trimEnd(), width)
    }
    return `${prefix}${LINE_CHAR.repeat(width - prefix.length)}`
  }

  const plain = () => {
    const width = Math.max(0, dimensions().width)
    return truncate(getLabel(props.event), width)
  }

  const isLineEvent = () => props.event.kind === "turn-ended" || props.event.kind === "error"

  const color = () => {
    switch (props.event.kind) {
      case "error":
        return theme.error
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
