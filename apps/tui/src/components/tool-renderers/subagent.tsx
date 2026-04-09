import { AgentTree } from "./agent-tree"
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

export function SubagentToolRenderer(props: ToolRendererProps) {
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

  return (
    <AgentTree
      title={title()}
      subtitle={subtitle()}
      toolCall={props.toolCall}
      expanded={props.expanded}
      childSessions={props.childSessions}
    />
  )
}
