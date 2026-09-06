import { AgentTree } from "./agent-tree"
import type { ToolRendererProps } from "./types"
import { Option, Schema } from "effect"
import type { ToolInput } from "../../utils/parse-tool-output"

const decodeInput = Schema.decodeUnknownOption(
  Schema.Struct({ repos: Schema.optional(Schema.Array(Schema.String)) }),
)

const parseInput = (input: ToolInput) => Option.getOrUndefined(decodeInput(input))

export function ResearchToolRenderer(props: ToolRendererProps) {
  const input = () => parseInput(props.toolCall.input)

  const subtitle = () => {
    const repos = Option.fromNullishOr(input()).pipe(
      Option.flatMap((value) => Option.fromNullishOr(value.repos)),
    )
    if (Option.isNone(repos) || repos.value.length === 0) return Option.none<string>()
    if (repos.value.length === 1) return Option.fromNullishOr(repos.value[0])
    return Option.some(`${repos.value.length} repos`)
  }

  return (
    <AgentTree
      title="research"
      subtitle={Option.getOrUndefined(subtitle())}
      toolCall={props.toolCall}
      expanded={props.expanded}
      childSessions={props.childSessions}
    />
  )
}
