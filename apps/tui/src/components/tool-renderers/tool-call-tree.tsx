import { Option } from "effect"
import type { Schema } from "effect"
import { Show, For } from "solid-js"
import { useTheme } from "../../theme/index"
import { toolArgSummary } from "../../utils/format-tool.js"
import { useSpinnerClock } from "../../hooks/use-spinner-clock"

interface ToolCallInfo {
  toolName: string
  args: Schema.JsonObject
  isError: boolean
  status?: "running" | "completed" | "error"
}

const SPINNER_FRAMES = ["·", "•", "*"]

export function ToolCallTree(props: {
  toolCalls: ReadonlyArray<ToolCallInfo>
  collapsed?: boolean
}) {
  const { theme } = useTheme()
  const tick = useSpinnerClock()

  const hiddenCount = () => {
    if (!props.collapsed) return 0
    return Math.max(0, props.toolCalls.length - 10)
  }

  const visible = () => {
    const calls = props.toolCalls
    if (hiddenCount() > 0) return calls.slice(calls.length - 10)
    return calls
  }

  return (
    <box flexDirection="column" paddingLeft={2}>
      <Show when={hiddenCount() > 0}>
        <text style={{ fg: theme.textMuted }}>├── … {hiddenCount()} earlier calls</text>
      </Show>
      <For each={[...visible()]}>
        {(call, index) => {
          const isLast = () => index() === visible().length - 1
          const connector = () => {
            if (isLast()) return "╰──"
            return "├──"
          }
          const icon = () => {
            if (call.status === "running") {
              return Option.getOrElse(
                Option.fromNullishOr(SPINNER_FRAMES[tick() % SPINNER_FRAMES.length]),
                () => "·",
              )
            }
            if (call.isError || call.status === "error") return "✕"
            return "✓"
          }
          const iconColor = () => {
            if (call.status === "running") return theme.warning
            if (call.isError || call.status === "error") return theme.error
            return theme.textMuted
          }
          const summary = () => toolArgSummary(call.toolName, call.args)
          const summaryText = () => {
            if (summary().length > 0) return ` ${summary()}`
            return ""
          }

          return (
            <text style={{ fg: theme.textMuted }}>
              {connector()} <span style={{ fg: iconColor() }}>{icon()}</span> {call.toolName}
              {summaryText()}
            </text>
          )
        }}
      </For>
    </box>
  )
}
