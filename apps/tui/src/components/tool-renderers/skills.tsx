import { Show, createMemo } from "solid-js"
import { useTheme } from "../../theme/index"
import { ToolFrame } from "../tool-frame"
import type { ToolRendererProps } from "./types"

function getSkillNames(input: unknown): string[] {
  if (input === null || typeof input !== "object" || !("names" in input)) return []
  const names = (input as { names: unknown }).names
  if (names === "all") return ["all"]
  if (Array.isArray(names)) return names.filter((n): n is string => typeof n === "string")
  return []
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
            return (
              <text style={{ fg: theme.textMuted }}>
                <span style={{ fg: theme.success, bold: true }}>{skillCount()}</span>
                {skillCount() === 1 ? " skill loaded" : " skills loaded"}
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
