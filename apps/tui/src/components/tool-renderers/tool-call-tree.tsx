import { For } from "solid-js"
import { useTheme } from "../../theme/index"
import { toolArgSummary } from "../../utils/format-tool.js"

interface ToolCallInfo {
  toolName: string
  args: Record<string, unknown>
  isError: boolean
}

export function ToolCallTree(props: {
  toolCalls: ReadonlyArray<ToolCallInfo>
  collapsed?: boolean
}) {
  const { theme } = useTheme()

  const visible = () => {
    const calls = props.toolCalls
    if (props.collapsed && calls.length > 10) return calls.slice(calls.length - 10)
    return calls
  }

  const hiddenCount = () => {
    if (!props.collapsed) return 0
    return Math.max(0, props.toolCalls.length - 10)
  }

  return (
    <box flexDirection="column" paddingLeft={2}>
      <For each={[...visible()]}>
        {(call, index) => {
          const isLast = () => index() === visible().length - 1 && hiddenCount() === 0
          const connector = () => (isLast() ? "╰──" : "├──")
          const icon = () => (call.isError ? "✕" : "✓")
          const iconColor = () => (call.isError ? theme.error : theme.textMuted)
          const summary = () => toolArgSummary(call.toolName, call.args)

          return (
            <text style={{ fg: theme.textMuted }}>
              {connector()} <span style={{ fg: iconColor() }}>{icon()}</span> {call.toolName}
              {summary().length > 0 ? ` ${summary()}` : ""}
            </text>
          )
        }}
      </For>
    </box>
  )
}
