/**
 * Read tool renderer.
 *
 * Collapsed: path + line count + truncation indicator
 * Expanded: line-numbered content with GutterText
 */

import { Match, Option, Schema } from "effect"
import { Show, For, createMemo } from "solid-js"
import { windowItems, headTailExcerpts } from "@gent/core-internal/domain/windowing.js"
import { useTheme } from "../../theme/index"
import { ToolFrame } from "../tool-frame"
import { GutterText } from "../gutter-text"
import { truncatePath } from "../message-list-utils"
import { fileUrl, isAbsPath } from "../../utils/file-refs"
import { decodeToolOutputOption, getString } from "../../utils/parse-tool-output"
import type { ToolInput } from "../../utils/parse-tool-output"
import type { ToolRendererProps } from "./types"

type WindowedLine =
  | { _tag: "line"; text: string; lineNum: number }
  | { _tag: "elision"; count: number }

interface ReadOutput {
  readonly content: string
  readonly path: string
  readonly lineCount: number
  readonly truncated: boolean
}

const ReadOutputSchema = Schema.Struct({
  content: Schema.String,
  path: Schema.optional(Schema.String),
  lineCount: Schema.optional(Schema.Finite),
  truncated: Schema.optional(Schema.Boolean),
})

function parseReadOutput(
  output: ToolRendererProps["toolCall"]["output"],
): Option.Option<ReadOutput> {
  return Option.map(decodeToolOutputOption(ReadOutputSchema, output), (d) => ({
    content: d["content"],
    path: d["path"] ?? "",
    lineCount: d["lineCount"] ?? 0,
    truncated: d["truncated"] ?? false,
  }))
}

function getPath(input: ToolInput): string {
  return getString(input, "path")
}

/** Parse line-numbered content (tab-separated: "  1\tcontent") into lines */
function parseContentLines(content: string): string[] {
  return content.split("\n").map((line) => {
    // strip "  N\t" prefix if present
    const tabIdx = line.indexOf("\t")
    if (tabIdx >= 0) return line.slice(tabIdx + 1)
    return line
  })
}

/** Extract start line number from tab-prefixed content */
function getStartLine(content: string): number {
  const firstLine = content.split("\n")[0] ?? ""
  const tabIdx = firstLine.indexOf("\t")
  if (tabIdx < 0) return 1
  const num = parseInt(firstLine.slice(0, tabIdx).trim(), 10)
  if (isNaN(num)) return 1
  return num
}

export function ReadToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const data = createMemo(() => parseReadOutput(props.toolCall.output))
  const path = createMemo(() => getPath(props.toolCall.input))

  const contentLines = createMemo(() => {
    const d = data()
    if (Option.isNone(d)) return []
    return parseContentLines(d.value.content)
  })

  const startLine = createMemo(() => {
    const d = data()
    if (Option.isNone(d)) return 1
    return getStartLine(d.value.content)
  })

  const collapsedLines = createMemo((): WindowedLine[] => {
    const lines = contentLines()
    if (lines.length === 0) return []
    const start = startLine()
    const indexed: WindowedLine[] = lines.map((text, i) => ({
      _tag: "line",
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
    <ToolFrame
      title="read"
      subtitle={truncatePath(path())}
      subtitleHref={Option.getOrUndefined(
        Option.some(path()).pipe(Option.filter(isAbsPath), Option.map(fileUrl)),
      )}
      status={props.toolCall.status}
      expanded={props.expanded}
      collapsedContent={
        <Show when={Option.getOrUndefined(data())}>
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
                    Match.value(item).pipe(
                      Match.tagsExhaustive({
                        elision: (item) => (
                          <text>
                            <span style={{ fg: theme.border }}>{"· ··· "}</span>
                            <span style={{ fg: theme.textMuted }}>{item.count} more lines</span>
                          </text>
                        ),
                        line: (item) => (
                          <text>
                            <span style={{ fg: theme.border }}>
                              {String(item.lineNum).padStart(4)} │{" "}
                            </span>
                            <span style={{ fg: theme.textMuted }}>{item.text}</span>
                          </text>
                        ),
                      }),
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
    </ToolFrame>
  )
}
