/**
 * Glob tool renderer.
 *
 * Collapsed: pattern + file count
 * Expanded: full file list with head/tail truncation
 */

import { For, Show, createMemo } from "solid-js"
import { headTail } from "@gent/core"
import { useTheme } from "../../theme/index"
import { ToolBox } from "../tool-box"
import { truncatePath } from "../message-list-utils"
import type { ToolRendererProps } from "./types"

interface GlobOutput {
  files: string[]
  truncated: boolean
}

function parseGlobOutput(output: string | undefined): GlobOutput | null {
  if (output === undefined) return null
  try {
    const parsed = JSON.parse(output) as { files?: unknown; truncated?: unknown } | null
    if (parsed !== null && typeof parsed === "object" && Array.isArray(parsed.files)) {
      return {
        files: parsed.files as string[],
        truncated: parsed.truncated === true,
      }
    }
  } catch {
    // ignore
  }
  return null
}

function getPattern(input: unknown): string {
  if (input !== null && typeof input === "object" && "pattern" in input) {
    return typeof (input as { pattern: unknown }).pattern === "string"
      ? (input as { pattern: string }).pattern
      : ""
  }
  return ""
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
    <ToolBox
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
    </ToolBox>
  )
}
