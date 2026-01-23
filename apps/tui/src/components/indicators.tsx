import { Show, createSignal, onCleanup, onMount } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../theme/index"

const DOTS_FRAMES = ["", ".", "..", "..."]

export type Indicator =
  | { _tag: "thinking" }
  | { _tag: "compacting" }
  | { _tag: "error"; message: string }
  | { _tag: "toast"; message: string }

export interface IndicatorsProps {
  indicator: Indicator | null
}

const indicatorLabel = (indicator: Indicator): string => {
  switch (indicator._tag) {
    case "thinking":
      return "thinking"
    case "compacting":
      return "compacting"
    case "error":
      return "error"
    case "toast":
      return ""
  }
}

export function Indicators(props: IndicatorsProps) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [frame, setFrame] = createSignal(0)

  onMount(() => {
    const interval = setInterval(() => {
      if (props.indicator && props.indicator._tag !== "error") {
        setFrame((f) => (f + 1) % DOTS_FRAMES.length)
      }
    }, 500)
    onCleanup(() => clearInterval(interval))
  })

  const dots = () => DOTS_FRAMES[frame()] ?? DOTS_FRAMES[0]

  const truncate = (value: string, max: number): string =>
    value.length > max ? `${value.slice(0, Math.max(0, max - 3))}...` : value

  const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim()

  const renderText = (indicator: Indicator) => {
    const maxWidth = Math.max(0, dimensions().width - 2)
    if (indicator._tag === "error") {
      return truncate(oneLine(indicator.message), maxWidth)
    }
    if (indicator._tag === "toast") {
      return truncate(oneLine(indicator.message), maxWidth)
    }
    return truncate(`${indicatorLabel(indicator)}${dots()}`, maxWidth)
  }

  const renderStyle = (indicator: Indicator) => {
    if (indicator._tag === "error") {
      return { fg: theme.error }
    }
    if (indicator._tag === "toast") {
      return { fg: theme.primary }
    }
    return { fg: theme.textMuted, italic: true }
  }

  return (
    <Show when={props.indicator}>
      {(current) => (
        <box flexShrink={0} paddingLeft={1}>
          <text>
            <span style={renderStyle(current())}>{renderText(current())}</span>
          </text>
        </box>
      )}
    </Show>
  )
}
