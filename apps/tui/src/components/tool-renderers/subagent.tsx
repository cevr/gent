import { AgentTree } from "./agent-tree"
import type { ToolRendererProps } from "./types"
import { Option, Schema } from "effect"
import type { ToolInput } from "../../utils/parse-tool-output"

const decodeDelegateInput = Schema.decodeUnknownOption(
  Schema.Struct({
    agent: Schema.optional(Schema.String),
    todo: Schema.optional(Schema.String),
  }),
)

const parseDelegateInput = (input: ToolInput) => decodeDelegateInput(input)

export function SubagentToolRenderer(props: ToolRendererProps) {
  const delegateInput = () => parseDelegateInput(props.toolCall.input)

  const title = () => {
    const agent = delegateInput().pipe(Option.flatMap((inp) => Option.fromNullishOr(inp.agent)))
    if (Option.isSome(agent)) return `delegate → ${agent.value}`
    return "delegate"
  }

  const subtitle = (): Option.Option<string> => {
    const todo = delegateInput().pipe(Option.flatMap((inp) => Option.fromNullishOr(inp.todo)))
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
