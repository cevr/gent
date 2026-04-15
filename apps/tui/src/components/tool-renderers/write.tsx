/**
 * Write tool renderer.
 *
 * Collapsed: path + bytes written
 * Expanded: same (write has no content preview in output)
 */

import { Show, createMemo } from "solid-js"
import { useTheme } from "../../theme/index"
import { ToolFrame } from "../tool-frame"
import { truncatePath } from "../message-list-utils"
import { fileUrl, isAbsPath } from "../../utils/file-url"
import { parseToolOutput } from "../../utils/parse-tool-output"
import type { ToolRendererProps } from "./types"

interface WriteOutput {
  path: string
  bytesWritten: number
}

function parseWriteOutput(output: string | undefined): WriteOutput | null {
  const parsed = parseToolOutput(output)
  if (
    parsed !== undefined &&
    typeof parsed["path"] === "string" &&
    typeof parsed["bytesWritten"] === "number"
  ) {
    return { path: parsed["path"], bytesWritten: parsed["bytesWritten"] }
  }
  return null
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

export function WriteToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const data = createMemo(() => parseWriteOutput(props.toolCall.output))
  const path = createMemo(() => data()?.path ?? "")

  return (
    <ToolFrame
      title="write"
      subtitle={truncatePath(path())}
      subtitleHref={isAbsPath(path()) ? fileUrl(path()) : undefined}
      status={props.toolCall.status}
      expanded={props.expanded}
      collapsedContent={
        <Show when={data()}>
          {(d) => (
            <text>
              <span style={{ fg: theme.success }}>{formatBytes(d().bytesWritten)}</span>
              <span style={{ fg: theme.textMuted }}> written</span>
            </text>
          )}
        </Show>
      }
    >
      <Show when={data()}>
        {(d) => (
          <text>
            <span style={{ fg: theme.text }}>{d().path}</span>
            <span style={{ fg: theme.textMuted }}> · </span>
            <span style={{ fg: theme.success }}>{formatBytes(d().bytesWritten)}</span>
            <span style={{ fg: theme.textMuted }}> written</span>
          </text>
        )}
      </Show>
    </ToolFrame>
  )
}
