/**
 * Bash tool renderer.
 *
 * Collapsed: exit code + head-3/tail-3 of stdout
 * Expanded: full head-50/tail-50 with OutputBuffer
 */

import { Option, Schema } from "effect"
import { Show, createMemo } from "solid-js"
import { formatHeadTail } from "@gent/core-internal/domain/output-buffer.js"
import { useTheme } from "../../theme/index"
import { ToolFrame } from "../tool-frame"
import { decodeToolOutputOption, getString } from "../../utils/parse-tool-output"
import type { ToolInput } from "../../utils/parse-tool-output"
import type { ToolRendererProps } from "./types"

interface BashOutput {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

const BashOutputSchema = Schema.Struct({
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
  exitCode: Schema.Finite,
})

function parseBashOutput(
  output: ToolRendererProps["toolCall"]["output"],
): Option.Option<BashOutput> {
  return Option.map(decodeToolOutputOption(BashOutputSchema, output), (decoded) => ({
    stdout: decoded["stdout"] ?? "",
    stderr: decoded["stderr"] ?? "",
    exitCode: decoded["exitCode"],
  }))
}

function getCommand(input: ToolInput): string {
  return getString(input, "command")
}

export function BashToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const data = createMemo(() => parseBashOutput(props.toolCall.output))
  const command = createMemo(() => getCommand(props.toolCall.input))

  const lines = createMemo(() => {
    const d = data()
    if (Option.isNone(d)) return []
    let combined = d.value.stdout
    if (d.value.stderr.length > 0) combined += `\n${d.value.stderr}`
    return combined.split("\n").filter((l) => l.length > 0)
  })

  const collapsedText = createMemo(() => formatHeadTail(lines(), 6))
  const expandedText = createMemo(() => formatHeadTail(lines(), 100))

  const exitCodeColor = () => {
    const d = data()
    if (Option.isNone(d)) return theme.textMuted
    if (d.value.exitCode === 0) return theme.success
    return theme.error
  }

  return (
    <ToolFrame
      title="bash"
      subtitle={command()}
      status={props.toolCall.status}
      expanded={props.expanded}
      collapsedContent={
        <Show when={Option.getOrUndefined(data())}>
          <box flexDirection="column">
            <text>
              <span style={{ fg: exitCodeColor() }}>
                exit {Option.getOrUndefined(data())?.exitCode}
              </span>
              <span style={{ fg: theme.textMuted }}> · {lines().length} lines</span>
            </text>
            <Show when={collapsedText().length > 0}>
              <text style={{ fg: theme.textMuted }}>{collapsedText()}</text>
            </Show>
          </box>
        </Show>
      }
    >
      <Show when={Option.getOrUndefined(data())}>
        <box flexDirection="column">
          <text>
            <span style={{ fg: exitCodeColor() }}>
              exit {Option.getOrUndefined(data())?.exitCode}
            </span>
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
