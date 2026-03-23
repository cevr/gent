import { For } from "solid-js"
import { useTheme } from "../../theme/index"
import { ToolCallTree } from "./tool-call-tree"
import type { ChildSessionEntry } from "../../hooks/use-child-sessions"

export function LiveChildTree(props: { childSessions: ChildSessionEntry[] }) {
  const { theme } = useTheme()

  const statusColor = (status: ChildSessionEntry["status"]) => {
    if (status === "running") return theme.warning
    if (status === "error") return theme.error
    return theme.success
  }

  const statusIcon = (status: ChildSessionEntry["status"]) => {
    if (status === "running") return "⋯"
    if (status === "error") return "✕"
    return "✓"
  }

  return (
    <For each={props.childSessions}>
      {(entry) => {
        const items = () =>
          entry.toolCalls.map((tc) => ({
            toolName: tc.toolName,
            args: (tc.input !== undefined && tc.input !== null ? tc.input : {}) as Record<
              string,
              unknown
            >,
            isError: tc.status === "error",
            status: tc.status,
          }))

        return (
          <box flexDirection="column">
            <text style={{ fg: theme.textMuted }}>
              <span
                style={{
                  fg: statusColor(entry.status),
                }}
              >
                {statusIcon(entry.status)}
              </span>{" "}
              {entry.agentName}
            </text>
            <ToolCallTree toolCalls={items()} />
          </box>
        )
      }}
    </For>
  )
}
