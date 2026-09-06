import { Option, Schema } from "effect"
import { Show, For } from "solid-js"
import { useTheme } from "../../theme/index"
import { ToolFrame } from "../tool-frame"
import { decodeToolOutputOption, getString } from "../../utils/parse-tool-output"
import type { ToolInput } from "../../utils/parse-tool-output"
import type { ToolRendererProps } from "./types"

const SessionResultSchema = Schema.Struct({
  sessionId: Schema.String,
  name: Schema.String,
  lastActivity: Schema.String,
  excerpts: Schema.Array(Schema.String),
})

const SearchOutputSchema = Schema.Struct({
  query: Schema.optional(Schema.String),
  totalMatches: Schema.optional(Schema.Finite),
  sessions: Schema.optional(Schema.Array(SessionResultSchema)),
  error: Schema.optional(Schema.String),
})

function getQuery(input: ToolInput): Option.Option<string> {
  const q = getString(input, "query")
  if (q.length === 0) return Option.none()
  return Option.some(q)
}

export function SearchSessionsToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const query = () => getQuery(props.toolCall.input)
  const output = () => decodeToolOutputOption(SearchOutputSchema, props.toolCall.output)

  const subtitle = (): Option.Option<string> => {
    const q = query()
    if (Option.isNone(q)) return Option.none()
    if (q.value.length > 60) return Option.some(q.value.slice(0, 60) + "…")
    return q
  }

  const sessions = () => Option.flatMap(output(), (value) => Option.fromNullishOr(value.sessions))
  const totalMatches = () =>
    Option.getOrElse(
      Option.flatMap(output(), (value) => Option.fromNullishOr(value.totalMatches)),
      () => 0,
    )
  const error = () => Option.flatMap(output(), (value) => Option.fromNullishOr(value.error))
  const excerptText = (excerpt: string): string => {
    if (excerpt.length > 120) return excerpt.slice(0, 120) + "…"
    return excerpt
  }

  return (
    <ToolFrame
      title="search_sessions"
      subtitle={Option.getOrUndefined(subtitle())}
      status={props.toolCall.status}
      expanded={props.expanded}
    >
      <Show when={props.toolCall.status === "running"}>
        <text style={{ fg: theme.textMuted }}>
          <span style={{ fg: theme.warning }}>⋯</span> Searching sessions…
        </text>
      </Show>

      <Show when={props.toolCall.status !== "running" && Option.getOrUndefined(sessions())}>
        <text style={{ fg: theme.textMuted }}>
          <span style={{ fg: theme.success }}>✓</span> {totalMatches()} matches in{" "}
          {Option.getOrElse(sessions(), () => []).length} sessions
        </text>

        <Show when={props.expanded}>
          <For each={Option.getOrElse(sessions(), () => [])}>
            {(session, index) => {
              const sessionList = Option.getOrElse(sessions(), () => [])
              const isLast = () => index() === sessionList.length - 1
              const connector = () => {
                if (isLast()) return "╰──"
                return "├──"
              }

              return (
                <box flexDirection="column">
                  <text style={{ fg: theme.textMuted }}>
                    {connector()} <span style={{ fg: theme.text }}>{session.name}</span>{" "}
                    <span style={{ fg: theme.textMuted }}>({session.sessionId.slice(0, 8)})</span>
                  </text>
                  <For each={session.excerpts}>
                    {(excerpt) => (
                      <box paddingLeft={4}>
                        <text style={{ fg: theme.textMuted }}>{excerptText(excerpt)}</text>
                      </box>
                    )}
                  </For>
                </box>
              )
            }}
          </For>
        </Show>
      </Show>

      <Show when={Option.getOrUndefined(error())}>
        <text style={{ fg: theme.error }}>
          <span>✕</span> {Option.getOrElse(error(), () => "")}
        </text>
      </Show>
    </ToolFrame>
  )
}
