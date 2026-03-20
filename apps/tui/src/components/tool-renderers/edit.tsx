/**
 * Edit tool renderer.
 *
 * Collapsed: +N -N stats
 * Expanded: unified diff view with syntax highlighting
 */

import { Show, For, createMemo } from "solid-js"
import { windowItems, headTailExcerpts } from "@gent/core"
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

type DiffLine =
  | { _tag: "line"; text: string; kind: "add" | "remove" | "context" }
  | { _tag: "elision"; count: number }

export function EditToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const editData = () => getEditUnifiedDiff(props.toolCall.input)
  const path = () => getPath(props.toolCall.input)

  const collapsedDiffLines = createMemo((): DiffLine[] => {
    const data = editData()
    if (data === null) return []
    const lines: DiffLine[] = data.diff.split("\n").map((text) => {
      const kind = text.startsWith("+")
        ? ("add" as const)
        : text.startsWith("-")
          ? ("remove" as const)
          : ("context" as const)
      return { _tag: "line", text, kind }
    })
    if (lines.length <= 6) return lines
    const { items } = windowItems<DiffLine>(lines, headTailExcerpts(3, 3), (count) => ({
      _tag: "elision",
      count,
    }))
    return items
  })

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
            <box flexDirection="column">
              <text>
                <span style={{ fg: theme.success, bold: true }}>+{data().added}</span>
                <span style={{ fg: theme.textMuted }}> </span>
                <span style={{ fg: theme.error, bold: true }}>-{data().removed}</span>
              </text>
              <Show when={collapsedDiffLines().length > 0}>
                <For each={collapsedDiffLines()}>
                  {(item) =>
                    item._tag === "elision" ? (
                      <text>
                        <span style={{ fg: theme.border }}>{"· ··· "}</span>
                        <span style={{ fg: theme.textMuted }}>{item.count} more lines</span>
                      </text>
                    ) : (
                      <text>
                        <span
                          style={{
                            fg:
                              item.kind === "add"
                                ? theme.success
                                : item.kind === "remove"
                                  ? theme.error
                                  : theme.textMuted,
                          }}
                        >
                          {item.text}
                        </span>
                      </text>
                    )
                  }
                </For>
              </Show>
            </box>
          }
        >
          <diff
            diff={data().diff}
            view="unified"
            filetype={data().filetype}
            showLineNumbers={true}
            addedBg="#1a4d1a"
            removedBg="#4d1a1a"
            addedContentBg="#2d6b2d"
            removedContentBg="#6b2d2d"
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
