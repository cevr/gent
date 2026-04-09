import { AgentTree } from "./agent-tree"
import type { ToolRendererProps } from "./types"

function parseInput(input: unknown): { repos?: string[] } | undefined {
  if (input === null || input === undefined || typeof input !== "object") return undefined
  return input as { repos?: string[] }
}

export function ResearchToolRenderer(props: ToolRendererProps) {
  const input = () => parseInput(props.toolCall.input)

  const subtitle = () => {
    const repos = input()?.repos
    if (repos === undefined || repos.length === 0) return undefined
    if (repos.length === 1) return repos[0]
    return `${repos.length} repos`
  }

  return (
    <AgentTree
      title="research"
      subtitle={subtitle()}
      status={props.toolCall.status}
      expanded={props.expanded}
      childSessions={props.childSessions}
    />
  )
}
