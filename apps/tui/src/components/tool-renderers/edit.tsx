/**
 * Edit tool renderer.
 *
 * Collapsed: +N -N stats
 * Expanded: unified diff view with syntax highlighting
 */

import { Show, For, createMemo } from "solid-js"
import type { JSX } from "solid-js"
import { Option } from "effect"
import { windowItems, headTailExcerpts } from "@gent/core-internal/domain/windowing.js"
import { buildSyntaxStyle, useTheme } from "../../theme/index"
import { ToolFrame } from "../tool-frame"
import { truncatePath } from "../message-list-utils"
import { fileUrl, isAbsPath } from "../../utils/file-refs"
import { getString } from "../../utils/parse-tool-output"
import type { ToolInput } from "../../utils/parse-tool-output"
import type { ToolRendererProps } from "./types"
import { getEditUnifiedDiff } from "./edit-utils"

function getPath(input: ToolInput): string {
  return getString(input, "path")
}

type DiffLine =
  | { _tag: "line"; text: string; kind: "add" | "remove" | "context" }
  | { _tag: "elision"; count: number }

type DiffLineKind = Extract<DiffLine, { _tag: "line" }>["kind"]

function diffLineKind(text: string): DiffLineKind {
  if (text.startsWith("+")) return "add"
  if (text.startsWith("-")) return "remove"
  return "context"
}

function diffLineColor(kind: DiffLineKind, theme: ReturnType<typeof useTheme>["theme"]) {
  if (kind === "add") return theme.diffAdded
  if (kind === "remove") return theme.diffRemoved
  return theme.textMuted
}

const renderDiffLine = (
  item: DiffLine,
  theme: ReturnType<typeof useTheme>["theme"],
): JSX.Element => {
  if (item._tag === "elision") {
    return (
      <text>
        <span style={{ fg: theme.border }}>{"· ··· "}</span>
        <span style={{ fg: theme.textMuted }}>{item.count} more lines</span>
      </text>
    )
  }
  return (
    <text>
      <span style={{ fg: diffLineColor(item.kind, theme) }}>{item.text.slice(0, 1)}</span>
      <span style={{ fg: theme.text }}>{item.text.slice(1)}</span>
    </text>
  )
}

export function EditToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()
  const syntaxStyle = createMemo(() => buildSyntaxStyle(theme))

  const editData = () => getEditUnifiedDiff(props.toolCall.input)
  const path = () => getPath(props.toolCall.input)
  const subtitleHref = () => {
    if (isAbsPath(path())) return fileUrl(path())
    return Option.getOrUndefined(Option.none<string>())
  }

  const collapsedDiffLines = createMemo((): DiffLine[] => {
    const data = editData()
    // `getEditUnifiedDiff` returns null for invalid tool input at this adapter boundary.
    // eslint-disable-next-line effect/noNullish -- invalid edit payloads are rendered as an empty diff.
    if (data === null) return []
    const lines: DiffLine[] = data.diff
      .split("\n")
      .map((text) => ({ _tag: "line", text, kind: diffLineKind(text) }))
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
        <ToolFrame
          title="edit"
          subtitle={truncatePath(path())}
          subtitleHref={subtitleHref()}
          status={props.toolCall.status}
          expanded={props.expanded}
        />
      }
    >
      {(data) => (
        <ToolFrame
          title="edit"
          subtitle={truncatePath(path())}
          subtitleHref={subtitleHref()}
          status={props.toolCall.status}
          expanded={props.expanded}
          collapsedContent={
            <box flexDirection="column">
              <text>
                <span style={{ fg: theme.diffAdded, bold: true }}>+{data().added}</span>
                <span style={{ fg: theme.textMuted }}> </span>
                <span style={{ fg: theme.diffRemoved, bold: true }}>-{data().removed}</span>
              </text>
              <Show when={collapsedDiffLines().length > 0}>
                <For each={collapsedDiffLines()}>{(item) => renderDiffLine(item, theme)}</For>
              </Show>
            </box>
          }
        >
          <diff
            diff={data().diff}
            view="unified"
            filetype={data().filetype}
            syntaxStyle={syntaxStyle()}
            fg={theme.text}
            showLineNumbers={true}
            addedBg={theme.diffAddedBg}
            removedBg={theme.diffRemovedBg}
            contextBg={theme.diffContextBg}
            addedContentBg={theme.diffAddedBg}
            removedContentBg={theme.diffRemovedBg}
            contextContentBg={theme.diffContextBg}
            addedSignColor={theme.diffAdded}
            removedSignColor={theme.diffRemoved}
            addedLineNumberBg={theme.diffAddedLineNumberBg}
            removedLineNumberBg={theme.diffRemovedLineNumberBg}
            lineNumberBg={theme.background}
            lineNumberFg={theme.textMuted}
            width="100%"
          />
        </ToolFrame>
      )}
    </Show>
  )
}
