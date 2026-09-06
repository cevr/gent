import { AgentTree } from "./agent-tree"
import type { ToolRendererProps } from "./types"
import { Option, Schema } from "effect"
import type { ToolInput } from "../../utils/parse-tool-output"

const DelegateItem = Schema.Struct({ agent: Schema.String, todo: Schema.String })
const decodeDelegateInput = Schema.decodeUnknownOption(
  Schema.Struct({
    agent: Schema.optional(Schema.String),
    todo: Schema.optional(Schema.String),
    todos: Schema.optional(Schema.Array(DelegateItem)),
    chain: Schema.optional(Schema.Array(DelegateItem)),
  }),
)

const parseDelegateInput = (input: ToolInput) => decodeDelegateInput(input)

export function SubagentToolRenderer(props: ToolRendererProps) {
  const delegateInput = () => parseDelegateInput(props.toolCall.input)

  const title = () => {
    const inp = delegateInput()
    if (Option.isSome(inp)) {
      const agent = Option.fromNullishOr(inp.value.agent)
      if (Option.isSome(agent)) return `delegate → ${agent.value}`
      const todos = Option.fromNullishOr(inp.value.todos)
      if (Option.isSome(todos)) return `delegate → ${todos.value.length} parallel`
      const chain = Option.fromNullishOr(inp.value.chain)
      if (Option.isSome(chain)) return `delegate → ${chain.value.length} chain`
    }
    return "delegate"
  }

  const subtitle = (): Option.Option<string> => {
    const inp = delegateInput()
    if (Option.isNone(inp)) return Option.none()
    const todo = Option.fromNullishOr(inp.value.todo)
    if (Option.isNone(todo)) return Option.none()
    if (todo.value.length > 60) return Option.some(todo.value.slice(0, 60) + "…")
    return todo
  }

  return (
    <AgentTree
      title={title()}
      subtitle={Option.getOrUndefined(subtitle())}
      toolCall={props.toolCall}
      expanded={props.expanded}
      childSessions={props.childSessions}
    />
  )
}
