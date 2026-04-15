import { Schema } from "effect"
import { Show, For } from "solid-js"
import { useTheme } from "../../theme/index"
import { AgentTree } from "./agent-tree"
import { decodeToolOutput, getString } from "../../utils/parse-tool-output"
import type { ToolRendererProps } from "./types"

interface ReviewComment {
  readonly file: string
  readonly line?: number
  readonly severity: "critical" | "high" | "medium" | "low"
  readonly type: "bug" | "suggestion" | "style"
  readonly text: string
  readonly fix?: string
}

interface ReviewOutput {
  readonly comments?: readonly ReviewComment[]
  readonly summary?: {
    readonly critical: number
    readonly high: number
    readonly medium: number
    readonly low: number
  }
  readonly raw?: string
  readonly error?: string
}

const ReviewCommentSchema = Schema.Struct({
  file: Schema.String,
  line: Schema.optional(Schema.Number),
  severity: Schema.Literals(["critical", "high", "medium", "low"]),
  type: Schema.Literals(["bug", "suggestion", "style"]),
  text: Schema.String,
  fix: Schema.optional(Schema.String),
})

const ReviewOutputSchema = Schema.Struct({
  comments: Schema.optional(Schema.Array(ReviewCommentSchema)),
  summary: Schema.optional(
    Schema.Struct({
      critical: Schema.Number,
      high: Schema.Number,
      medium: Schema.Number,
      low: Schema.Number,
    }),
  ),
  raw: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
})

function getDescription(input: unknown): string | undefined {
  const desc = getString(input, "description")
  return desc !== "" ? desc : undefined
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: "#ff5555",
  high: "#ffb86c",
  medium: "#f1fa8c",
  low: "#6272a4",
}

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
  const output = () =>
    decodeToolOutput(ReviewOutputSchema, props.toolCall.output) as ReviewOutput | undefined

  const subtitle = () => {
    const d = description()
    if (d === undefined) return undefined
    return d.length > 60 ? d.slice(0, 60) + "…" : d
  }

  const summaryText = () => {
    const s = output()?.summary
    if (s === undefined) return undefined
    return formatSummary(s)
  }

  const reviewContent = () => {
    const comments = output()?.comments
    if (comments === undefined || comments.length === 0) return undefined
    return comments
  }

  return (
    <AgentTree
      title="review"
      subtitle={subtitle()}
      toolCall={props.toolCall}
      expanded={props.expanded}
      childSessions={props.childSessions}
      collapsedSummary={
        <Show when={summaryText()}>
          {(text) => (
            <text style={{ fg: theme.textMuted }}>
              <span style={{ fg: theme.success }}>✓</span> {text()}
            </text>
          )}
        </Show>
      }
      completedContent={
        <>
          <Show when={props.expanded && reviewContent()}>
            {(comments) => (
              <For each={comments()}>
                {(comment, index) => {
                  const isLast = () => index() === (reviewContent()?.length ?? 1) - 1
                  const connector = () => (isLast() ? "╰──" : "├──")
                  const severityColor = () => SEVERITY_COLORS[comment.severity] ?? theme.textMuted

                  return (
                    <box flexDirection="column">
                      <text style={{ fg: theme.textMuted }}>
                        {connector()}{" "}
                        <span style={{ fg: severityColor() }}>[{comment.severity}]</span>{" "}
                        <span style={{ fg: theme.text }}>
                          {comment.file}
                          {comment.line !== undefined ? `:${comment.line}` : ""}
                        </span>{" "}
                        <span style={{ fg: theme.textMuted }}>({comment.type})</span>
                      </text>
                      <box paddingLeft={4}>
                        <text style={{ fg: theme.textMuted }}>{comment.text}</text>
                      </box>
                      <Show when={comment.fix !== undefined}>
                        <box paddingLeft={4}>
                          <text style={{ fg: theme.success }}>fix: {comment.fix}</text>
                        </box>
                      </Show>
                    </box>
                  )
                }}
              </For>
            )}
          </Show>

          <Show when={output()?.error !== undefined}>
            <text style={{ fg: theme.error }}>
              <span>✕</span> {output()?.error}
            </text>
          </Show>
        </>
      }
    />
  )
}
