/**
 * Edit tool renderer.
 *
 * Collapsed: +N -N stats
 * Expanded: unified diff view with syntax highlighting
 */

import { Show } from "solid-js"
import { useTheme } from "../../theme/index"
import { ToolBox } from "../tool-box"
import { truncatePath } from "../message-list-utils"
import type { ToolRendererProps } from "./types"
import { getEditUnifiedDiff } from "./edit-utils"

function getPath(input: unknown): string {
  if (input !== null && typeof input === "object" && "path" in input) {
    return typeof (input as { path: unknown }).path === "string"
      ? (input as { path: string }).path
      : ""
  }
  return ""
}

export function EditToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const editData = () => getEditUnifiedDiff(props.toolCall.input)
  const path = () => getPath(props.toolCall.input)

  return (
    <Show
      when={editData()}
      fallback={
        <ToolBox
          title="edit"
          subtitle={truncatePath(path())}
          status={props.toolCall.status}
          expanded={props.expanded}
        />
      }
    >
      {(data) => (
        <ToolBox
          title="edit"
          subtitle={truncatePath(path())}
          status={props.toolCall.status}
          expanded={props.expanded}
          collapsedContent={
            <text>
              <span style={{ fg: theme.success, bold: true }}>+{data().added}</span>
              <span style={{ fg: theme.textMuted }}> </span>
              <span style={{ fg: theme.error, bold: true }}>-{data().removed}</span>
            </text>
          }
        >
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
        </ToolBox>
      )}
    </Show>
  )
}
