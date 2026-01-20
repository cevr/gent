import { Show } from "solid-js"
import { useTheme } from "../../theme/index"
import type { ToolRendererProps } from "./types"
import { getEditUnifiedDiff } from "./edit-utils"

export function EditToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const editData = () => getEditUnifiedDiff(props.toolCall.input)

  return (
    <Show when={editData()}>
      {(data) => (
        <box paddingLeft={4} flexDirection="column">
          <text>
            <span style={{ fg: theme.textMuted }}>└ Added </span>
            <span style={{ fg: theme.success, bold: true }}>{data().added}</span>
            <span style={{ fg: theme.textMuted }}> lines, removed </span>
            <span style={{ fg: theme.error, bold: true }}>{data().removed}</span>
            <span style={{ fg: theme.textMuted }}> lines</span>
            <Show when={!props.expanded}>
              <span style={{ fg: theme.textMuted }}> (</span>
              <span style={{ fg: theme.info }}>ctrl+o</span>
              <span style={{ fg: theme.textMuted }}> to expand)</span>
            </Show>
          </text>
          <Show when={props.expanded}>
            <box marginTop={1}>
              <diff
                diff={data().diff}
                view="unified"
                filetype={data().filetype}
                showLineNumbers={true}
                addedBg="#1a4d1a"
                removedBg="#4d1a1a"
                addedSignColor="#22c55e"
                removedSignColor="#ef4444"
                lineNumberFg={theme.textMuted}
                width="100%"
              />
            </box>
          </Show>
        </box>
      )}
    </Show>
  )
}
