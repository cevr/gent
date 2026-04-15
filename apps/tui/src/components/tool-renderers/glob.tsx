/**
 * Glob tool renderer.
 *
 * Collapsed: pattern + file count
 * Expanded: full file list with head/tail truncation
 */

import { For, Show, createMemo } from "solid-js"
import { headTail } from "@gent/core/domain/output-buffer.js"
import { useTheme } from "../../theme/index"
import { ToolFrame } from "../tool-frame"
import { truncatePath } from "../message-list-utils"
import { parseToolOutput, getString } from "../../utils/parse-tool-output"
import type { ToolRendererProps } from "./types"

interface GlobOutput {
  files: string[]
  truncated: boolean
}

function parseGlobOutput(output: string | undefined): GlobOutput | null {
  const parsed = parseToolOutput(output)
  if (parsed === undefined || !Array.isArray(parsed["files"])) return null
  const rawFiles = parsed["files"]
  return {
    files: rawFiles.filter((f: unknown): f is string => typeof f === "string"),
    truncated: parsed["truncated"] === true,
  }
}

function getPattern(input: unknown): string {
  return getString(input, "pattern")
}

export function GlobToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const data = createMemo(() => parseGlobOutput(props.toolCall.output))
  const pattern = createMemo(() => getPattern(props.toolCall.input))

  const collapsedFiles = createMemo(() => {
    const d = data()
    if (d === null) return { head: [] as string[], tail: [] as string[], truncatedCount: 0 }
    return headTail(d.files, 6)
  })

  const expandedFiles = createMemo(() => {
    const d = data()
    if (d === null) return { head: [] as string[], tail: [] as string[], truncatedCount: 0 }
    return headTail(d.files, 50)
  })

  return (
    <ToolFrame
      title="glob"
      subtitle={pattern()}
      status={props.toolCall.status}
      expanded={props.expanded}
      collapsedContent={
        <Show when={data()}>
          {(d) => (
            <box flexDirection="column">
              <text>
                <span style={{ fg: theme.success, bold: true }}>{d().files.length}</span>
                <span style={{ fg: theme.textMuted }}> files</span>
                <Show when={d().truncated}>
                  <span style={{ fg: theme.warning }}> (truncated)</span>
                </Show>
              </text>
              <For each={collapsedFiles().head}>
                {(file) => <text style={{ fg: theme.textMuted }}> {truncatePath(file)}</text>}
              </For>
              <Show when={collapsedFiles().truncatedCount > 0}>
                <text style={{ fg: theme.textMuted }}>
                  {" "}
                  ... +{collapsedFiles().truncatedCount} more
                </text>
              </Show>
              <For each={collapsedFiles().tail}>
                {(file) => <text style={{ fg: theme.textMuted }}> {truncatePath(file)}</text>}
              </For>
            </box>
          )}
        </Show>
      }
    >
      <Show when={data()}>
        {(d) => (
          <box flexDirection="column">
            <text>
              <span style={{ fg: theme.success, bold: true }}>{d().files.length}</span>
              <span style={{ fg: theme.textMuted }}> files</span>
              <Show when={d().truncated}>
                <span style={{ fg: theme.warning }}> (truncated)</span>
              </Show>
            </text>
            <For each={expandedFiles().head}>
              {(file) => <text style={{ fg: theme.text }}> {truncatePath(file, 60)}</text>}
            </For>
            <Show when={expandedFiles().truncatedCount > 0}>
              <text style={{ fg: theme.textMuted }}>
                {" "}
                ... {expandedFiles().truncatedCount} more files ...
              </text>
            </Show>
            <For each={expandedFiles().tail}>
              {(file) => <text style={{ fg: theme.text }}> {truncatePath(file, 60)}</text>}
            </For>
          </box>
        )}
      </Show>
    </ToolFrame>
  )
}
