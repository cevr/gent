/**
 * Read tool renderer.
 *
 * Collapsed: path + line count + truncation indicator
 * Expanded: line-numbered content with GutterText
 */

import { Show, For, createMemo } from "solid-js"
import { windowItems, headTailExcerpts } from "@gent/core"
import { useTheme } from "../../theme/index"
import { ToolBox } from "../tool-box"
import { GutterText } from "../gutter-text"
import { truncatePath } from "../message-list-utils"
import type { ToolRendererProps } from "./types"

type WindowedLine =
  | { _tag: "line"; text: string; lineNum: number }
  | { _tag: "elision"; count: number }

interface ReadOutput {
  content: string
  path: string
  lineCount: number
  truncated: boolean
}

function parseReadOutput(output: string | undefined): ReadOutput | null {
  if (output === undefined) return null
  try {
    const parsed = JSON.parse(output) as {
      content?: unknown
      path?: unknown
      lineCount?: unknown
      truncated?: unknown
    } | null
    if (parsed !== null && typeof parsed === "object" && typeof parsed.content === "string") {
      return {
        content: parsed.content,
        path: typeof parsed.path === "string" ? parsed.path : "",
        lineCount: typeof parsed.lineCount === "number" ? parsed.lineCount : 0,
        truncated: parsed.truncated === true,
      }
    }
  } catch {
    // ignore
  }
  return null
}

function getPath(input: unknown): string {
  if (input !== null && typeof input === "object" && "path" in input) {
    return typeof (input as { path: unknown }).path === "string"
      ? (input as { path: string }).path
      : ""
  }
  return ""
}

/** Parse line-numbered content (tab-separated: "  1\tcontent") into lines */
function parseContentLines(content: string): string[] {
  return content.split("\n").map((line) => {
    // strip "  N\t" prefix if present
    const tabIdx = line.indexOf("\t")
    return tabIdx >= 0 ? line.slice(tabIdx + 1) : line
  })
}

/** Extract start line number from tab-prefixed content */
function getStartLine(content: string): number {
  const firstLine = content.split("\n")[0] ?? ""
  const tabIdx = firstLine.indexOf("\t")
  if (tabIdx < 0) return 1
  const num = parseInt(firstLine.slice(0, tabIdx).trim(), 10)
  return isNaN(num) ? 1 : num
}

export function ReadToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const data = createMemo(() => parseReadOutput(props.toolCall.output))
  const path = createMemo(() => getPath(props.toolCall.input))

  const contentLines = createMemo(() => {
    const d = data()
    if (d === null) return []
    return parseContentLines(d.content)
  })

  const startLine = createMemo(() => {
    const d = data()
    if (d === null) return 1
    return getStartLine(d.content)
  })

  const collapsedLines = createMemo((): WindowedLine[] => {
    const lines = contentLines()
    if (lines.length === 0) return []
    const start = startLine()
    const indexed: WindowedLine[] = lines.map((text, i) => ({
      _tag: "line" as const,
      text,
      lineNum: start + i,
    }))
    if (lines.length <= 6) return indexed
    const { items } = windowItems<WindowedLine>(indexed, headTailExcerpts(3, 3), (count) => ({
      _tag: "elision",
      count,
    }))
    return items
  })

  return (
    <ToolBox
      title="read"
      subtitle={truncatePath(path())}
      status={props.toolCall.status}
      expanded={props.expanded}
      collapsedContent={
        <Show when={data()}>
          {(d) => (
            <box flexDirection="column">
              <text>
                <span style={{ fg: theme.success, bold: true }}>{d().lineCount}</span>
                <span style={{ fg: theme.textMuted }}> lines</span>
                <Show when={d().truncated}>
                  <span style={{ fg: theme.warning }}> (truncated)</span>
                </Show>
              </text>
              <Show when={collapsedLines().length > 0}>
                <For each={collapsedLines()}>
                  {(item) =>
                    item._tag === "elision" ? (
                      <text>
                        <span style={{ fg: theme.border }}>{"· ··· "}</span>
                        <span style={{ fg: theme.textMuted }}>{item.count} more lines</span>
                      </text>
                    ) : (
                      <text>
                        <span style={{ fg: theme.border }}>
                          {String(item.lineNum).padStart(4)} │{" "}
                        </span>
                        <span style={{ fg: theme.textMuted }}>{item.text}</span>
                      </text>
                    )
                  }
                </For>
              </Show>
            </box>
          )}
        </Show>
      }
    >
      <Show when={contentLines().length > 0}>
        <GutterText lines={contentLines()} startLine={startLine()} />
      </Show>
    </ToolBox>
  )
}
