import { Show, createMemo } from "solid-js"
import { useTheme } from "../../theme/index"
import type { ToolRendererProps } from "./types"

export function ReadToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const parsedOutput = createMemo(() => {
    const output = props.toolCall.output
    if (output === undefined) return null
    try {
      const parsed = JSON.parse(output) as { content?: unknown; truncated?: unknown } | null
      if (parsed !== null && typeof parsed === "object" && typeof parsed.content === "string") {
        return {
          content: parsed.content,
          truncated: parsed.truncated === true,
        }
      }
    } catch {
      // ignore parse errors
    }
    return null
  })

  const content = () => parsedOutput()?.content ?? props.toolCall.output ?? ""

  const lineCount = () => {
    return content()
      .split("\n")
      .filter((l) => l.trim()).length
  }

  const isTruncated = () => {
    const parsed = parsedOutput()
    if (parsed?.truncated === true) return true
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
      <Show when={props.expanded && content()}>
        <box marginTop={1}>
          <text style={{ fg: theme.textMuted }}>{content()}</text>
        </box>
      </Show>
    </box>
  )
}
