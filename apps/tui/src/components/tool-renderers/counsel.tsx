import { Show } from "solid-js"
import { useTheme } from "../../theme/index"
import { ToolFrame } from "../tool-frame"
import { LiveChildTree } from "./live-child-tree"
import type { ToolRendererProps } from "./types"

interface CounselOutput {
  mode?: string
  response?: string
  error?: string
}

function parseOutput(output: string | undefined): CounselOutput | undefined {
  if (output === undefined) return undefined
  try {
    return JSON.parse(output) as CounselOutput
  } catch {
    return undefined
  }
}

function parseInput(input: unknown): { mode?: string } | undefined {
  if (input === null || input === undefined || typeof input !== "object") return undefined
  return input as { mode?: string }
}

export function CounselToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const input = () => parseInput(props.toolCall.input)
  const output = () => parseOutput(props.toolCall.output)

  const subtitle = () => {
    const mode = input()?.mode ?? "standard"
    return mode === "deep" ? "deep analysis" : "quick opinion"
  }

  return (
    <ToolFrame
      title="counsel"
      subtitle={subtitle()}
      status={props.toolCall.status}
      expanded={props.expanded}
    >
      <Show when={props.toolCall.status === "running"}>
        <Show
          when={props.childSessions !== undefined && props.childSessions.length > 0}
          fallback={
            <text style={{ fg: theme.textMuted }}>
              <span style={{ fg: theme.warning }}>⋯</span> Consulting…
            </text>
          }
        >
          <LiveChildTree childSessions={props.childSessions ?? []} />
        </Show>
      </Show>

      <Show when={props.toolCall.status !== "running" && output()?.response !== undefined}>
        <text style={{ fg: theme.text }}>
          {(() => {
            const resp = output()?.response ?? ""
            return resp.length > 500 ? resp.slice(0, 500) + "…" : resp
          })()}
        </text>
      </Show>

      <Show when={output()?.error !== undefined}>
        <text style={{ fg: theme.error }}>
          <span>✕</span> {output()?.error}
        </text>
      </Show>
    </ToolFrame>
  )
}
