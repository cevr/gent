import { AgentTree } from "./agent-tree"
import type { ToolRendererProps } from "./types"

function parseInput(input: unknown): { mode?: string } | undefined {
  if (input === null || input === undefined || typeof input !== "object") return undefined
  return input as { mode?: string }
}

export function CounselToolRenderer(props: ToolRendererProps) {
  const input = () => parseInput(props.toolCall.input)

  const subtitle = () => {
    const mode = input()?.mode ?? "standard"
    return mode === "deep" ? "deep analysis" : "quick opinion"
  }

  return (
    <AgentTree
      title="counsel"
      subtitle={subtitle()}
      toolCall={props.toolCall}
      expanded={props.expanded}
      childSessions={props.childSessions}
    />
  )
}
