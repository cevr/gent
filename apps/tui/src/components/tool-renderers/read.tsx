import { Show } from "solid-js"
import { useTheme } from "../../theme/index"
import type { ToolRendererProps } from "./types"

export function ReadToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const lineCount = () => {
    const output = props.toolCall.output ?? ""
    return output.split("\n").filter((l) => l.trim()).length
  }

  const isTruncated = () => {
    const { output, summary } = props.toolCall
    return output && summary && output.length > summary.length
  }

  return (
    <box paddingLeft={4} flexDirection="column">
      <text>
        <span style={{ fg: theme.textMuted }}>└ Read </span>
        <span style={{ fg: theme.success, bold: true }}>{lineCount()}</span>
        <span style={{ fg: theme.textMuted }}> lines</span>
        <Show when={!props.expanded && isTruncated()}>
          <span style={{ fg: theme.textMuted }}> (</span>
          <span style={{ fg: theme.info }}>ctrl+o</span>
          <span style={{ fg: theme.textMuted }}> to expand)</span>
        </Show>
      </text>
      <Show when={props.expanded && props.toolCall.output}>
        <box marginTop={1}>
          <text style={{ fg: theme.textMuted }}>{props.toolCall.output}</text>
        </box>
      </Show>
    </box>
  )
}
