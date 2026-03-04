import { Show } from "solid-js"
import { useTheme } from "../../theme/index"
import { ToolBox } from "../tool-box"
import type { ToolRendererProps } from "./types"

function parseInput(input: unknown): { query?: string } | undefined {
  if (input === null || input === undefined || typeof input !== "object") return undefined
  return input as { query?: string }
}

function parseOutput(
  output: string | undefined,
): { found?: boolean; response?: string; error?: string } | undefined {
  if (output === undefined) return undefined
  try {
    return JSON.parse(output) as { found?: boolean; response?: string; error?: string }
  } catch {
    return undefined
  }
}

export function FinderToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const input = () => parseInput(props.toolCall.input)
  const output = () => parseOutput(props.toolCall.output)

  const subtitle = () => {
    const q = input()?.query
    if (q === undefined) return undefined
    return q.length > 60 ? q.slice(0, 60) + "…" : q
  }

  return (
    <ToolBox
      title="finder"
      subtitle={subtitle()}
      status={props.toolCall.status}
      expanded={props.expanded}
    >
      <Show when={props.toolCall.status === "running"}>
        <text style={{ fg: theme.textMuted }}>
          <span style={{ fg: theme.warning }}>⋯</span> Searching…
        </text>
      </Show>

      <Show when={props.toolCall.status !== "running" && output()?.found === true}>
        <text style={{ fg: theme.textMuted }}>
          <span style={{ fg: theme.success }}>✓</span> Found
        </text>
        <Show when={props.expanded && output()?.response !== undefined}>
          {(() => {
            const response = output()?.response ?? ""
            return (
              <box paddingLeft={2}>
                <text style={{ fg: theme.textMuted }}>
                  {response.length > 300 ? response.slice(0, 300) + "…" : response}
                </text>
              </box>
            )
          })()}
        </Show>
      </Show>

      <Show when={props.toolCall.status !== "running" && output()?.found === false}>
        <text style={{ fg: theme.error }}>
          <span>✕</span> {output()?.error ?? "Not found"}
        </text>
      </Show>
    </ToolBox>
  )
}
