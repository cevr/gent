import { AgentTree } from "./agent-tree"
import type { ToolRendererProps } from "./types"

function parseDelegateInput(input: unknown):
  | {
      agent?: string
      todo?: string
      todos?: Array<{ agent: string; todo: string }>
      chain?: Array<{ agent: string; todo: string }>
    }
  | undefined {
  if (input === null || input === undefined || typeof input !== "object") return undefined
  return input as {
    agent?: string
    todo?: string
    todos?: Array<{ agent: string; todo: string }>
    chain?: Array<{ agent: string; todo: string }>
  }
}

export function SubagentToolRenderer(props: ToolRendererProps) {
  const delegateInput = () => parseDelegateInput(props.toolCall.input)

  const title = () => {
    const inp = delegateInput()
    if (inp?.agent !== undefined) return `delegate → ${inp.agent}`
    if (inp?.todos !== undefined) return `delegate → ${inp.todos.length} parallel`
    if (inp?.chain !== undefined) return `delegate → ${inp.chain.length} chain`
    return "delegate"
  }

  const subtitle = () => {
    const inp = delegateInput()
    if (inp?.todo !== undefined)
      return inp.todo.length > 60 ? inp.todo.slice(0, 60) + "…" : inp.todo
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
