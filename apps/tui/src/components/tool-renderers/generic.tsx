import { Show } from "solid-js"
import { useTheme } from "../../theme/index"
import { formatToolInput } from "../message-list-utils"
import { ToolBox } from "../tool-box"
import type { ToolRendererProps } from "./types"

export function GenericToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const isTruncated = () => {
    const { output, summary } = props.toolCall
    return output && summary && output.length > summary.length
  }

  const remainingLines = () => {
    const output = props.toolCall.output ?? ""
    const summary = props.toolCall.summary ?? ""
    return Math.max(0, output.split("\n").length - summary.split("\n").length)
  }

  const hasOutput = () => props.toolCall.summary || props.toolCall.output
  const subtitle = () => formatToolInput(props.toolCall.toolName, props.toolCall.input)

  return (
    <ToolBox
      title={props.toolCall.toolName}
      subtitle={subtitle()}
      status={props.toolCall.status}
      expanded={props.expanded}
      collapsedContent={
        <Show when={hasOutput()}>
          <box flexDirection="column">
            <Show when={props.toolCall.summary}>
              <text style={{ fg: theme.textMuted }}>{props.toolCall.summary}</text>
            </Show>
            <Show when={isTruncated()}>
              <text style={{ fg: theme.textMuted }}>
                ... ({remainingLines()} more lines, <span style={{ fg: theme.info }}>ctrl+o</span>{" "}
                to expand)
              </text>
            </Show>
          </box>
        </Show>
      }
    >
      <Show when={hasOutput()}>
        <text style={{ fg: theme.textMuted }}>
          {props.toolCall.output ?? props.toolCall.summary}
        </text>
      </Show>
    </ToolBox>
  )
}
