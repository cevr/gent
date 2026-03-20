import { Show, For } from "solid-js"
import { useTheme } from "../../theme/index"
import { ToolBox } from "../tool-box"
import { LiveChildTree } from "./live-child-tree"
import type { ToolRendererProps } from "./types"

interface ReviewComment {
  file: string
  line?: number
  severity: "critical" | "high" | "medium" | "low"
  type: "bug" | "suggestion" | "style"
  text: string
  fix?: string
}

interface ReviewOutput {
  comments?: ReviewComment[]
  summary?: { critical: number; high: number; medium: number; low: number }
  raw?: string
  error?: string
}

function parseOutput(output: string | undefined): ReviewOutput | undefined {
  if (output === undefined) return undefined
  try {
    return JSON.parse(output) as ReviewOutput
  } catch {
    return undefined
  }
}

function parseInput(input: unknown): { description?: string } | undefined {
  if (input === null || input === undefined || typeof input !== "object") return undefined
  return input as { description?: string }
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: "#ff5555",
  high: "#ffb86c",
  medium: "#f1fa8c",
  low: "#6272a4",
}

export function CodeReviewToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const input = () => parseInput(props.toolCall.input)
  const output = () => parseOutput(props.toolCall.output)

  const subtitle = () => {
    const d = input()?.description
    if (d === undefined) return undefined
    return d.length > 60 ? d.slice(0, 60) + "…" : d
  }

  const summaryText = () => {
    const s = output()?.summary
    if (s === undefined) return undefined
    const total = s.critical + s.high + s.medium + s.low
    const parts: string[] = []
    if (s.critical > 0) parts.push(`${s.critical} critical`)
    if (s.high > 0) parts.push(`${s.high} high`)
    if (s.medium > 0) parts.push(`${s.medium} medium`)
    if (s.low > 0) parts.push(`${s.low} low`)
    return `${total} comments: ${parts.join(", ")}`
  }

  return (
    <ToolBox
      title="code_review"
      subtitle={subtitle()}
      status={props.toolCall.status}
      expanded={props.expanded}
    >
      <Show when={props.toolCall.status === "running"}>
        <Show
          when={props.childSessions !== undefined && props.childSessions.length > 0}
          fallback={
            <text style={{ fg: theme.textMuted }}>
              <span style={{ fg: theme.warning }}>⋯</span> Reviewing…
            </text>
          }
        >
          <LiveChildTree childSessions={props.childSessions ?? []} />
        </Show>
      </Show>

      <Show when={props.toolCall.status !== "running" && summaryText() !== undefined}>
        <text style={{ fg: theme.textMuted }}>
          <span style={{ fg: theme.success }}>✓</span> {summaryText()}
        </text>
      </Show>

      <Show when={props.expanded && (output()?.comments?.length ?? 0) > 0}>
        <For each={output()?.comments ?? []}>
          {(comment, index) => {
            const isLast = () => index() === (output()?.comments?.length ?? 1) - 1
            const connector = () => (isLast() ? "╰──" : "├──")
            const severityColor = () => SEVERITY_COLORS[comment.severity] ?? theme.textMuted

            return (
              <box flexDirection="column">
                <text style={{ fg: theme.textMuted }}>
                  {connector()} <span style={{ fg: severityColor() }}>[{comment.severity}]</span>{" "}
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
      </Show>

      <Show when={props.toolCall.status !== "running" && output()?.raw !== undefined}>
        {(() => {
          const raw = output()?.raw ?? ""
          return (
            <text style={{ fg: theme.textMuted }}>
              {raw.length > 300 ? raw.slice(0, 300) + "…" : raw}
            </text>
          )
        })()}
      </Show>

      <Show when={output()?.error !== undefined}>
        <text style={{ fg: theme.error }}>
          <span>✕</span> {output()?.error}
        </text>
      </Show>
    </ToolBox>
  )
}
