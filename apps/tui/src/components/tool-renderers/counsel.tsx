import { AgentTree } from "./agent-tree"
import type { ToolRendererProps } from "./types"
import { Option, Schema } from "effect"
import type { ToolInput } from "../../utils/parse-tool-output"

const decodeInput = Schema.decodeUnknownOption(
  Schema.Struct({ mode: Schema.optional(Schema.String) }),
)

const parseInput = (input: ToolInput) => Option.getOrUndefined(decodeInput(input))

export function CounselToolRenderer(props: ToolRendererProps) {
  const input = () => parseInput(props.toolCall.input)

  const subtitle = () => {
    const mode = input()?.mode ?? "standard"
    if (mode === "deep") return "deep analysis"
    return "quick opinion"
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
