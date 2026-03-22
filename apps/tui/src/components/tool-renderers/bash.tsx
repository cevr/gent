/**
 * Bash tool renderer.
 *
 * Collapsed: exit code + head-3/tail-3 of stdout
 * Expanded: full head-50/tail-50 with OutputBuffer
 */

import { Show, createMemo } from "solid-js"
import { formatHeadTail } from "@gent/core/domain/output-buffer.js"
import { useTheme } from "../../theme/index"
import { ToolFrame } from "../tool-frame"
import type { ToolRendererProps } from "./types"

interface BashOutput {
  stdout: string
  stderr: string
  exitCode: number
}

function parseBashOutput(output: string | undefined): BashOutput | null {
  if (output === undefined) return null
  try {
    const parsed = JSON.parse(output) as {
      stdout?: unknown
      stderr?: unknown
      exitCode?: unknown
    } | null
    if (parsed !== null && typeof parsed === "object" && typeof parsed.exitCode === "number") {
      return {
        stdout: typeof parsed.stdout === "string" ? parsed.stdout : "",
        stderr: typeof parsed.stderr === "string" ? parsed.stderr : "",
        exitCode: parsed.exitCode,
      }
    }
  } catch {
    // not JSON — treat as raw text
  }
  return null
}

function getCommand(input: unknown): string {
  if (input !== null && typeof input === "object" && "command" in input) {
    return typeof (input as { command: unknown }).command === "string"
      ? (input as { command: string }).command
      : ""
  }
  return ""
}

export function BashToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const data = createMemo(() => parseBashOutput(props.toolCall.output))
  const command = createMemo(() => getCommand(props.toolCall.input))

  const lines = createMemo(() => {
    const d = data()
    if (d === null) return []
    const combined = d.stderr.length > 0 ? `${d.stdout}\n${d.stderr}` : d.stdout
    return combined.split("\n").filter((l) => l.length > 0)
  })

  const collapsedText = createMemo(() => formatHeadTail(lines(), 6))
  const expandedText = createMemo(() => formatHeadTail(lines(), 100))

  const exitCodeColor = () => {
    const d = data()
    if (d === null) return theme.textMuted
    return d.exitCode === 0 ? theme.success : theme.error
  }

  return (
    <ToolFrame
      title="bash"
      subtitle={command()}
      status={props.toolCall.status}
      expanded={props.expanded}
      collapsedContent={
        <Show when={data()}>
          <box flexDirection="column">
            <text>
              <span style={{ fg: exitCodeColor() }}>exit {data()?.exitCode}</span>
              <span style={{ fg: theme.textMuted }}> · {lines().length} lines</span>
            </text>
            <Show when={collapsedText().length > 0}>
              <text style={{ fg: theme.textMuted }}>{collapsedText()}</text>
            </Show>
          </box>
        </Show>
      }
    >
      <Show when={data()}>
        <box flexDirection="column">
          <text>
            <span style={{ fg: exitCodeColor() }}>exit {data()?.exitCode}</span>
            <span style={{ fg: theme.textMuted }}> · {lines().length} lines</span>
          </text>
          <Show when={expandedText().length > 0}>
            <text style={{ fg: theme.text }}>{expandedText()}</text>
          </Show>
        </box>
      </Show>
    </ToolFrame>
  )
}
