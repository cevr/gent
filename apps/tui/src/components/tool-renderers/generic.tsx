import { Show } from "solid-js"
import { useTheme } from "../../theme/index"
import { formatToolInput } from "../message-list-utils"
import { ToolFrame } from "../tool-frame"
import { formatGenericToolText } from "./generic-format"
import type { ToolRendererProps } from "./types"

export function GenericToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()
  const summaryText = () => formatGenericToolText(props.toolCall.summary)
  const outputText = () => formatGenericToolText(props.toolCall.output)

  const isTruncated = () => {
    const output = outputText()
    const summary = summaryText()
    return output && summary && output.length > summary.length
  }

  const remainingLines = () => {
    const output = outputText() ?? ""
    const summary = summaryText() ?? ""
    return Math.max(0, output.split("\n").length - summary.split("\n").length)
  }

  const hasOutput = () => summaryText() || outputText()
  const subtitle = () => formatToolInput(props.toolCall.toolName, props.toolCall.input)

  return (
    <ToolFrame
      title={props.toolCall.toolName}
      subtitle={subtitle()}
      status={props.toolCall.status}
      expanded={props.expanded}
      collapsedContent={
        <Show when={hasOutput()}>
          <box flexDirection="column">
            <Show when={summaryText()}>
              <text style={{ fg: theme.textMuted }}>{summaryText()}</text>
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
        <text style={{ fg: theme.textMuted }}>{outputText() ?? summaryText()}</text>
      </Show>
    </ToolFrame>
  )
}
