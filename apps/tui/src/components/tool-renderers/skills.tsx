import { Show, createMemo } from "solid-js"
import { useTheme } from "../../theme/index"
import { ToolFrame } from "../tool-frame"
import type { ToolRendererProps } from "./types"
import { Option, Schema } from "effect"
import type { ToolInput } from "../../utils/parse-tool-output"

const decodeSkillInput = Schema.decodeUnknownOption(
  Schema.Struct({ names: Schema.Union([Schema.Literal("all"), Schema.Array(Schema.String)]) }),
)

function getSkillNames(input: ToolInput): string[] {
  const decoded = decodeSkillInput(input)
  if (Option.isNone(decoded)) return []
  const names = decoded.value.names
  if (names === "all") return ["all"]
  return [...names]
}

export function SkillsToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const names = createMemo(() => getSkillNames(props.toolCall.input))
  const subtitle = createMemo(() => names().join(", "))

  return (
    <ToolFrame
      title="skills"
      subtitle={subtitle()}
      status={props.toolCall.status}
      expanded={props.expanded}
      collapsedContent={
        <Show when={props.toolCall.summary ?? props.toolCall.output}>
          {(text) => {
            const skillCount = createMemo(() => {
              const matches = text().match(/^## /gm)
              return matches?.length ?? 0
            })
            const countLabel = () => {
              if (skillCount() === 1) return " skill loaded"
              return " skills loaded"
            }
            return (
              <text style={{ fg: theme.textMuted }}>
                <span style={{ fg: theme.success, bold: true }}>{skillCount()}</span>
                {countLabel()}
              </text>
            )
          }}
        </Show>
      }
    >
      <Show when={props.toolCall.output ?? props.toolCall.summary}>
        {(text) => <text style={{ fg: theme.textMuted }}>{text()}</text>}
      </Show>
    </ToolFrame>
  )
}
