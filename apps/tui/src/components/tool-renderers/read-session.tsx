import { Schema } from "effect"
import { Show } from "solid-js"
import { useTheme } from "../../theme/index"
import { ToolFrame } from "../tool-frame"
import { decodeToolOutput, getString } from "../../utils/parse-tool-output"
import type { ToolRendererProps } from "./types"

interface ReadSessionOutput {
  readonly sessionId?: string
  readonly content?: string
  readonly extracted?: boolean
  readonly goal?: string
  readonly messageCount?: number
  readonly branchCount?: number
  readonly error?: string
}

const ReadSessionOutputSchema = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  extracted: Schema.optional(Schema.Boolean),
  goal: Schema.optional(Schema.String),
  messageCount: Schema.optional(Schema.Number),
  branchCount: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
})

function getInputField(input: unknown, key: string): string | undefined {
  const val = getString(input, key)
  return val !== "" ? val : undefined
}

export function ReadSessionToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const output = () =>
    decodeToolOutput(ReadSessionOutputSchema, props.toolCall.output) as
      | ReadSessionOutput
      | undefined

  const subtitle = () => {
    const sid = getInputField(props.toolCall.input, "sessionId")
    if (sid === undefined) return undefined
    const goal = getInputField(props.toolCall.input, "goal")
    if (goal !== undefined) return `${sid.slice(0, 8)}… — ${goal.slice(0, 40)}`
    return sid.slice(0, 8) + "…"
  }

  const summary = () => {
    const o = output()
    if (o === undefined) return undefined
    if (o.extracted) return `Extracted for: ${o.goal?.slice(0, 50) ?? "?"}`
    if (o.messageCount !== undefined) return `${o.messageCount} messages, ${o.branchCount} branches`
    return undefined
  }

  return (
    <ToolFrame
      title="read_session"
      subtitle={subtitle()}
      status={props.toolCall.status}
      expanded={props.expanded}
    >
      <Show when={props.toolCall.status === "running"}>
        <text style={{ fg: theme.textMuted }}>
          <span style={{ fg: theme.warning }}>⋯</span> Loading session…
        </text>
      </Show>

      <Show when={props.toolCall.status !== "running" && summary() !== undefined}>
        <text style={{ fg: theme.textMuted }}>
          <span style={{ fg: theme.success }}>✓</span> {summary()}
        </text>
      </Show>

      <Show when={props.expanded && output()?.content !== undefined}>
        {(() => {
          const content = output()?.content ?? ""
          return (
            <box paddingLeft={2}>
              <text style={{ fg: theme.textMuted }}>
                {content.length > 500 ? content.slice(0, 500) + "…" : content}
              </text>
            </box>
          )
        })()}
      </Show>

      <Show when={output()?.error !== undefined}>
        <text style={{ fg: theme.error }}>
          <span>✕</span> {output()?.error}
        </text>
      </Show>
    </ToolFrame>
  )
}
