import { Show } from "solid-js"
import { useTheme } from "../../theme/index"
import { ToolFrame } from "../tool-frame"
import { LiveChildTree } from "./live-child-tree"
import type { ToolRendererProps } from "./types"

interface ResearchOutput {
  response?: string
  repos?: string[]
  repoCount?: number
  error?: string
}

function parseOutput(output: string | undefined): ResearchOutput | undefined {
  if (output === undefined) return undefined
  try {
    return JSON.parse(output) as ResearchOutput
  } catch {
    return undefined
  }
}

function parseInput(input: unknown): { repos?: string[] } | undefined {
  if (input === null || input === undefined || typeof input !== "object") return undefined
  return input as { repos?: string[] }
}

export function ResearchToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const input = () => parseInput(props.toolCall.input)
  const output = () => parseOutput(props.toolCall.output)

  const subtitle = () => {
    const repos = input()?.repos
    if (repos === undefined || repos.length === 0) return undefined
    if (repos.length === 1) return repos[0]
    return `${repos.length} repos`
  }

  return (
    <ToolFrame
      title="research"
      subtitle={subtitle()}
      status={props.toolCall.status}
      expanded={props.expanded}
    >
      <Show when={props.toolCall.status === "running"}>
        <Show
          when={props.childSessions !== undefined && props.childSessions.length > 0}
          fallback={
            <text style={{ fg: theme.textMuted }}>
              <span style={{ fg: theme.warning }}>⋯</span> Researching…
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
