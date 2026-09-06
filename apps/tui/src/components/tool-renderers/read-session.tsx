import { Option, Schema } from "effect"
import { Show } from "solid-js"
import { useTheme } from "../../theme/index"
import { ToolFrame } from "../tool-frame"
import { decodeToolOutputOption, getString } from "../../utils/parse-tool-output"
import type { ToolInput } from "../../utils/parse-tool-output"
import type { ToolRendererProps } from "./types"

const ReadSessionOutputSchema = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  extracted: Schema.optional(Schema.Boolean),
  goal: Schema.optional(Schema.String),
  messageCount: Schema.optional(Schema.Finite),
  branchCount: Schema.optional(Schema.Finite),
  error: Schema.optional(Schema.String),
})

function getInputField(input: ToolInput, key: string): Option.Option<string> {
  const val = getString(input, key)
  if (val.length === 0) return Option.none()
  return Option.some(val)
}

export function ReadSessionToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const output = () => decodeToolOutputOption(ReadSessionOutputSchema, props.toolCall.output)

  const subtitle = () => {
    const sid = getInputField(props.toolCall.input, "sessionId")
    if (Option.isNone(sid)) return Option.getOrUndefined(Option.none<string>())
    const goal = getInputField(props.toolCall.input, "goal")
    if (Option.isSome(goal)) return `${sid.value.slice(0, 8)}… — ${goal.value.slice(0, 40)}`
    return sid.value.slice(0, 8) + "…"
  }

  const summary = (): Option.Option<string> => {
    const o = output()
    if (Option.isNone(o)) return Option.none()
    if (o.value.extracted) {
      const goal = Option.getOrElse(
        Option.map(Option.fromNullishOr(o.value.goal), (value) => value.slice(0, 50)),
        () => "?",
      )
      return Option.some(`Extracted for: ${goal}`)
    }
    const messageCount = Option.fromNullishOr(o.value.messageCount)
    if (Option.isSome(messageCount)) {
      return Option.some(`${messageCount.value} messages, ${o.value.branchCount} branches`)
    }
    return Option.none()
  }

  const content = () => Option.flatMap(output(), (value) => Option.fromNullishOr(value.content))
  const error = () => Option.flatMap(output(), (value) => Option.fromNullishOr(value.error))
  const renderContent = (value: string): string => {
    if (value.length > 500) return value.slice(0, 500) + "…"
    return value
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

      <Show when={props.toolCall.status !== "running" && Option.getOrUndefined(summary())}>
        <text style={{ fg: theme.textMuted }}>
          <span style={{ fg: theme.success }}>✓</span> {Option.getOrElse(summary(), () => "")}
        </text>
      </Show>

      <Show when={props.expanded && Option.getOrUndefined(content())}>
        <box paddingLeft={2}>
          <text style={{ fg: theme.textMuted }}>
            {Option.match(content(), { onNone: () => "", onSome: renderContent })}
          </text>
        </box>
      </Show>

      <Show when={Option.getOrUndefined(error())}>
        <text style={{ fg: theme.error }}>
          <span>✕</span> {Option.getOrElse(error(), () => "")}
        </text>
      </Show>
    </ToolFrame>
  )
}
