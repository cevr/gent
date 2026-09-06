import { Option, Schema } from "effect"
import { Show, For } from "solid-js"
import { useTheme } from "../../theme/index"
import { AgentTree } from "./agent-tree"
import { decodeToolOutputOption, getString } from "../../utils/parse-tool-output"
import type { ToolInput } from "../../utils/parse-tool-output"
import type { ToolRendererProps } from "./types"

const ReviewCommentSchema = Schema.Struct({
  file: Schema.String,
  line: Schema.optional(Schema.Finite),
  severity: Schema.Literals(["critical", "high", "medium", "low"]),
  type: Schema.Literals(["bug", "suggestion", "style"]),
  text: Schema.String,
  fix: Schema.optional(Schema.String),
})

const ReviewOutputSchema = Schema.Struct({
  comments: Schema.optional(Schema.Array(ReviewCommentSchema)),
  summary: Schema.optional(
    Schema.Struct({
      critical: Schema.Finite,
      high: Schema.Finite,
      medium: Schema.Finite,
      low: Schema.Finite,
    }),
  ),
  raw: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
})

function getDescription(input: ToolInput): Option.Option<string> {
  const desc = getString(input, "description")
  if (desc.length === 0) return Option.none()
  return Option.some(desc)
}

const SEVERITY_COLORS = {
  critical: "#ff5555",
  high: "#ffb86c",
  medium: "#f1fa8c",
  low: "#6272a4",
} satisfies Record<string, string>

function formatSummary(s: { critical: number; high: number; medium: number; low: number }): string {
  const total = s.critical + s.high + s.medium + s.low
  const parts: string[] = []
  if (s.critical > 0) parts.push(`${s.critical} critical`)
  if (s.high > 0) parts.push(`${s.high} high`)
  if (s.medium > 0) parts.push(`${s.medium} medium`)
  if (s.low > 0) parts.push(`${s.low} low`)
  return `${total} comments: ${parts.join(", ")}`
}

export function ReviewToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const description = () => getDescription(props.toolCall.input)
  const output = () => decodeToolOutputOption(ReviewOutputSchema, props.toolCall.output)

  const subtitle = (): Option.Option<string> => {
    const d = description()
    if (Option.isNone(d)) return Option.none()
    if (d.value.length > 60) return Option.some(d.value.slice(0, 60) + "…")
    return d
  }

  const summaryText = (): Option.Option<string> => {
    const s = Option.flatMap(output(), (value) => Option.fromNullishOr(value.summary))
    if (Option.isNone(s)) return Option.none()
    return Option.some(formatSummary(s.value))
  }

  const reviewContent = () => {
    const comments = Option.flatMap(output(), (value) => Option.fromNullishOr(value.comments))
    if (Option.isNone(comments) || comments.value.length === 0) return Option.none()
    return comments
  }

  return (
    <AgentTree
      title="review"
      subtitle={Option.getOrUndefined(subtitle())}
      toolCall={props.toolCall}
      expanded={props.expanded}
      childSessions={props.childSessions}
      collapsedSummary={
        <Show when={Option.getOrUndefined(summaryText())}>
          {(text) => (
            <text style={{ fg: theme.textMuted }}>
              <span style={{ fg: theme.success }}>✓</span> {text()}
            </text>
          )}
        </Show>
      }
      completedContent={
        <>
          <Show when={props.expanded && Option.getOrUndefined(reviewContent())}>
            {(comments) => (
              <For each={comments()}>
                {(comment, index) => {
                  const isLast = () => index() === comments().length - 1
                  const connector = () => {
                    if (isLast()) return "╰──"
                    return "├──"
                  }
                  const severityColor = () =>
                    Option.getOrElse(
                      Option.fromNullishOr(SEVERITY_COLORS[comment.severity]),
                      () => theme.textMuted,
                    )
                  const lineSuffix = () => {
                    const line = Option.fromNullishOr(comment.line)
                    if (Option.isNone(line)) return ""
                    return `:${line.value}`
                  }

                  return (
                    <box flexDirection="column">
                      <text style={{ fg: theme.textMuted }}>
                        {connector()}{" "}
                        <span style={{ fg: severityColor() }}>[{comment.severity}]</span>{" "}
                        <span style={{ fg: theme.text }}>
                          {comment.file}
                          {lineSuffix()}
                        </span>{" "}
                        <span style={{ fg: theme.textMuted }}>({comment.type})</span>
                      </text>
                      <box paddingLeft={4}>
                        <text style={{ fg: theme.textMuted }}>{comment.text}</text>
                      </box>
                      <Show when={Option.getOrUndefined(Option.fromNullishOr(comment.fix))}>
                        <box paddingLeft={4}>
                          <text style={{ fg: theme.success }}>
                            fix: {Option.getOrElse(Option.fromNullishOr(comment.fix), () => "")}
                          </text>
                        </box>
                      </Show>
                    </box>
                  )
                }}
              </For>
            )}
          </Show>

          <Show
            when={Option.getOrUndefined(
              Option.flatMap(output(), (value) => Option.fromNullishOr(value.error)),
            )}
          >
            <text style={{ fg: theme.error }}>
              <span>✕</span>{" "}
              {Option.getOrElse(
                Option.flatMap(output(), (value) => Option.fromNullishOr(value.error)),
                () => "",
              )}
            </text>
          </Show>
        </>
      }
    />
  )
}
