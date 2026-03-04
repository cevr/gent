import { Show } from "solid-js"
import { useTheme } from "../../theme/index"
import { ToolBox } from "../tool-box"
import type { ToolRendererProps } from "./types"

interface ReadSessionOutput {
  sessionId?: string
  content?: string
  extracted?: boolean
  goal?: string
  messageCount?: number
  branchCount?: number
  error?: string
}

function parseOutput(output: string | undefined): ReadSessionOutput | undefined {
  if (output === undefined) return undefined
  try {
    return JSON.parse(output) as ReadSessionOutput
  } catch {
    return undefined
  }
}

function parseInput(input: unknown): { sessionId?: string; goal?: string } | undefined {
  if (input === null || input === undefined || typeof input !== "object") return undefined
  return input as { sessionId?: string; goal?: string }
}

export function ReadSessionToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const input = () => parseInput(props.toolCall.input)
  const output = () => parseOutput(props.toolCall.output)

  const subtitle = () => {
    const sid = input()?.sessionId
    if (sid === undefined) return undefined
    const goal = input()?.goal
    if (goal !== undefined) return `${sid.slice(0, 8)}… — ${goal.slice(0, 40)}`
    return sid.slice(0, 8) + "…"
  }

  const summary = () => {
    const o = output()
    if (o === undefined) return undefined
    if (o.extracted) return `Extracted for: ${o.goal?.slice(0, 50) ?? "?"}`
    if (o.messageCount !== undefined) return `${o.messageCount} messages, ${o.branchCount} branches`
    return undefined
  }

  return (
    <ToolBox
      title="read_session"
      subtitle={subtitle()}
      status={props.toolCall.status}
      expanded={props.expanded}
    >
      <Show when={props.toolCall.status === "running"}>
        <text style={{ fg: theme.textMuted }}>
          <span style={{ fg: theme.warning }}>⋯</span> Loading session…
        </text>
      </Show>

      <Show when={props.toolCall.status !== "running" && summary() !== undefined}>
        <text style={{ fg: theme.textMuted }}>
          <span style={{ fg: theme.success }}>✓</span> {summary()}
        </text>
      </Show>

      <Show when={props.expanded && output()?.content !== undefined}>
        {(() => {
          const content = output()?.content ?? ""
          return (
            <box paddingLeft={2}>
              <text style={{ fg: theme.textMuted }}>
                {content.length > 500 ? content.slice(0, 500) + "…" : content}
              </text>
            </box>
          )
        })()}
      </Show>

      <Show when={output()?.error !== undefined}>
        <text style={{ fg: theme.error }}>
          <span>✕</span> {output()?.error}
        </text>
      </Show>
    </ToolBox>
  )
}
