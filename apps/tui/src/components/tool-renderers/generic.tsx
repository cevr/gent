import { Show } from "solid-js"
import { useTheme } from "../../theme/index.js"
import type { ToolRendererProps } from "./types.js"

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

  return (
    <Show when={hasOutput()}>
      <box paddingLeft={4} flexDirection="column">
        <Show
          when={props.expanded}
          fallback={
            <>
              <text style={{ fg: theme.textMuted }}>{props.toolCall.summary}</text>
              <Show when={isTruncated()}>
                <text style={{ fg: theme.textMuted }}>
                  ... ({remainingLines()} more lines, <span style={{ fg: theme.info }}>ctrl+o</span>{" "}
                  to expand)
                </text>
              </Show>
            </>
          }
        >
          <text style={{ fg: theme.textMuted }}>{props.toolCall.output}</text>
        </Show>
      </box>
    </Show>
  )
}
