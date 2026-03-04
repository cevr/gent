import { Show } from "solid-js"
import { useTheme } from "../../theme/index"
import { ToolBox } from "../tool-box"
import type { ToolRendererProps } from "./types"

function parseInput(input: unknown): { task?: string } | undefined {
  if (input === null || input === undefined || typeof input !== "object") return undefined
  return input as { task?: string }
}

function parseOutput(output: string | undefined): { output?: string; error?: string } | undefined {
  if (output === undefined) return undefined
  try {
    return JSON.parse(output) as { output?: string; error?: string }
  } catch {
    return undefined
  }
}

export function OracleToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const input = () => parseInput(props.toolCall.input)
  const output = () => parseOutput(props.toolCall.output)

  const subtitle = () => {
    const t = input()?.task
    if (t === undefined) return undefined
    return t.length > 60 ? t.slice(0, 60) + "…" : t
  }

  return (
    <ToolBox
      title="oracle"
      subtitle={subtitle()}
      status={props.toolCall.status}
      expanded={props.expanded}
    >
      <Show when={props.toolCall.status === "running"}>
        <text style={{ fg: theme.textMuted }}>
          <span style={{ fg: theme.warning }}>⋯</span> Reasoning…
        </text>
      </Show>

      <Show when={props.toolCall.status !== "running" && output()?.output !== undefined}>
        <text style={{ fg: theme.textMuted }}>
          <span style={{ fg: theme.success }}>✓</span> Analysis complete
        </text>
        <Show when={props.expanded}>
          {(() => {
            const text = output()?.output ?? ""
            return (
              <box paddingLeft={2}>
                <text style={{ fg: theme.textMuted }}>
                  {text.length > 300 ? text.slice(0, 300) + "…" : text}
                </text>
              </box>
            )
          })()}
        </Show>
      </Show>

      <Show when={props.toolCall.status !== "running" && output()?.error !== undefined}>
        <text style={{ fg: theme.error }}>
          <span>✕</span> {output()?.error}
        </text>
      </Show>
    </ToolBox>
  )
}
