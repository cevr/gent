import { Show, For } from "solid-js"
import { useTheme } from "../../theme/index"
import { ToolFrame } from "../tool-frame"
import type { ToolRendererProps } from "./types"

interface SessionResult {
  sessionId: string
  name: string
  lastActivity: string
  excerpts: string[]
}

interface SearchOutput {
  query?: string
  totalMatches?: number
  sessions?: SessionResult[]
  error?: string
}

function parseOutput(output: string | undefined): SearchOutput | undefined {
  if (output === undefined) return undefined
  try {
    return JSON.parse(output) as SearchOutput
  } catch {
    return undefined
  }
}

function parseInput(input: unknown): { query?: string } | undefined {
  if (input === null || input === undefined || typeof input !== "object") return undefined
  return input as { query?: string }
}

export function SearchSessionsToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const input = () => parseInput(props.toolCall.input)
  const output = () => parseOutput(props.toolCall.output)

  const subtitle = () => {
    const q = input()?.query
    if (q === undefined) return undefined
    return q.length > 60 ? q.slice(0, 60) + "…" : q
  }

  return (
    <ToolFrame
      title="search_sessions"
      subtitle={subtitle()}
      status={props.toolCall.status}
      expanded={props.expanded}
    >
      <Show when={props.toolCall.status === "running"}>
        <text style={{ fg: theme.textMuted }}>
          <span style={{ fg: theme.warning }}>⋯</span> Searching sessions…
        </text>
      </Show>

      <Show when={props.toolCall.status !== "running" && output()?.sessions !== undefined}>
        <text style={{ fg: theme.textMuted }}>
          <span style={{ fg: theme.success }}>✓</span> {output()?.totalMatches ?? 0} matches in{" "}
          {output()?.sessions?.length ?? 0} sessions
        </text>

        <Show when={props.expanded}>
          <For each={output()?.sessions ?? []}>
            {(session, index) => {
              const isLast = () => index() === (output()?.sessions?.length ?? 1) - 1
              const connector = () => (isLast() ? "╰──" : "├──")

              return (
                <box flexDirection="column">
                  <text style={{ fg: theme.textMuted }}>
                    {connector()} <span style={{ fg: theme.text }}>{session.name}</span>{" "}
                    <span style={{ fg: theme.textMuted }}>({session.sessionId.slice(0, 8)})</span>
                  </text>
                  <For each={session.excerpts}>
                    {(excerpt) => (
                      <box paddingLeft={4}>
                        <text style={{ fg: theme.textMuted }}>
                          {excerpt.length > 120 ? excerpt.slice(0, 120) + "…" : excerpt}
                        </text>
                      </box>
                    )}
                  </For>
                </box>
              )
            }}
          </For>
        </Show>
      </Show>

      <Show when={output()?.error !== undefined}>
        <text style={{ fg: theme.error }}>
          <span>✕</span> {output()?.error}
        </text>
      </Show>
    </ToolFrame>
  )
}
