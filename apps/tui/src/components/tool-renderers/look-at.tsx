import { Show } from "solid-js"
import { useTheme } from "../../theme/index"
import { ToolBox } from "../tool-box"
import type { ToolRendererProps } from "./types"

function parseInput(input: unknown): { path?: string; objective?: string } | undefined {
  if (input === null || input === undefined || typeof input !== "object") return undefined
  return input as { path?: string; objective?: string }
}

function parseOutput(output: string | undefined): { output?: string; error?: string } | undefined {
  if (output === undefined) return undefined
  try {
    return JSON.parse(output) as { output?: string; error?: string }
  } catch {
    return undefined
  }
}

export function LookAtToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const input = () => parseInput(props.toolCall.input)
  const output = () => parseOutput(props.toolCall.output)

  const subtitle = () => {
    const p = input()?.path
    if (p === undefined) return undefined
    const filename = p.split("/").pop() ?? p
    const obj = input()?.objective
    if (obj !== undefined) return `${filename} — ${obj.slice(0, 40)}`
    return filename
  }

  return (
    <ToolBox
      title="look_at"
      subtitle={subtitle()}
      status={props.toolCall.status}
      expanded={props.expanded}
    >
      <Show when={props.toolCall.status === "running"}>
        <text style={{ fg: theme.textMuted }}>
          <span style={{ fg: theme.warning }}>⋯</span> Analyzing…
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

      <Show when={output()?.error !== undefined}>
        <text style={{ fg: theme.error }}>
          <span>✕</span> {output()?.error}
        </text>
      </Show>
    </ToolBox>
  )
}
