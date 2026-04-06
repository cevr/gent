import { Show } from "solid-js"
import { useTheme } from "../../theme/index"
import { formatUsageStats } from "../../utils/format-tool.js"
import { ToolFrame } from "../tool-frame"
import { LiveChildTree } from "./live-child-tree"
import type { ToolRendererProps } from "./types"

function parseDelegateInput(input: unknown):
  | {
      agent?: string
      task?: string
      tasks?: Array<{ agent: string; task: string }>
      chain?: Array<{ agent: string; task: string }>
    }
  | undefined {
  if (input === null || input === undefined || typeof input !== "object") return undefined
  return input as {
    agent?: string
    task?: string
    tasks?: Array<{ agent: string; task: string }>
    chain?: Array<{ agent: string; task: string }>
  }
}

/**
 * Generic subagent tool renderer — single source for delegate rendering.
 *
 * Uses child session tracker entries as the source of truth for both
 * live (running) and completed states. No JSON parsing of tool output.
 */
export function SubagentToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const delegateInput = () => parseDelegateInput(props.toolCall.input)

  const title = () => {
    const inp = delegateInput()
    if (inp?.agent !== undefined) return `delegate → ${inp.agent}`
    if (inp?.tasks !== undefined) return `delegate → ${inp.tasks.length} parallel`
    if (inp?.chain !== undefined) return `delegate → ${inp.chain.length} chain`
    return "delegate"
  }

  const subtitle = () => {
    const inp = delegateInput()
    if (inp?.task !== undefined)
      return inp.task.length > 60 ? inp.task.slice(0, 60) + "…" : inp.task
    return undefined
  }

  const children = () => props.childSessions ?? []
  const hasChildren = () => children().length > 0

  const completedChild = () => {
    const c = children()
    return c.length === 1 ? c[0] : undefined
  }

  return (
    <ToolFrame
      title={title()}
      subtitle={subtitle()}
      status={props.toolCall.status}
      expanded={props.expanded}
    >
      <Show when={hasChildren()}>
        <LiveChildTree childSessions={children()} />
      </Show>

      <Show when={!hasChildren() && props.toolCall.status === "running"}>
        <text style={{ fg: theme.textMuted }}>
          <span style={{ fg: theme.warning }}>⋯</span> Running sub-agent...
        </text>
      </Show>

      <Show when={completedChild()?.usage !== undefined}>
        <text style={{ fg: theme.textMuted }}>
          {formatUsageStats(completedChild()?.usage ?? {})}
        </text>
      </Show>

      <Show when={props.expanded && completedChild()?.preview !== undefined}>
        <text style={{ fg: theme.textMuted }}>{completedChild()?.preview}</text>
      </Show>

      <Show when={completedChild()?.savedPath !== undefined}>
        <text style={{ fg: theme.textMuted }}>Full output: {completedChild()?.savedPath}</text>
      </Show>

      <Show when={!hasChildren() && props.toolCall.status !== "running"}>
        <text style={{ fg: theme.textMuted }}>{props.toolCall.summary ?? ""}</text>
      </Show>
    </ToolFrame>
  )
}
