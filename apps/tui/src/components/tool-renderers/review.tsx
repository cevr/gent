import { Show, For } from "solid-js"
import { useTheme } from "../../theme/index"
import { AgentTree } from "./agent-tree"
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

export function ReviewToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const input = () => parseInput(props.toolCall.input)
  const output = () => parseOutput(props.toolCall.output)

  const subtitle = () => {
    const d = input()?.description
    if (d === undefined) return undefined
    return d.length > 60 ? d.slice(0, 60) + "…" : d
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
      status={props.toolCall.status}
      expanded={props.expanded}
      childSessions={props.childSessions}
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
        </>
      }
    />
  )
}
