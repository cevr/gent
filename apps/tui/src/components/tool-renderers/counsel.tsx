import { Show } from "solid-js"
import { useTheme } from "../../theme/index"
import { formatUsageStats } from "../../utils/format-tool.js"
import { ToolBox } from "../tool-box"
import { ToolCallTree } from "./tool-call-tree"
import { LiveChildTree } from "./live-child-tree"
import type { ToolRendererProps } from "./types"

function parseInput(input: unknown): { prompt?: string } | undefined {
  if (input === null || input === undefined || typeof input !== "object") return undefined
  return input as { prompt?: string }
}

interface CounselOutput {
  review?: string
  reviewer?: string
  error?: string
  metadata?: {
    usage?: { input?: number; output?: number; cost?: number }
    toolCalls?: ReadonlyArray<{
      toolName: string
      args: Record<string, unknown>
      isError: boolean
    }>
  }
}

function parseOutput(output: string | undefined): CounselOutput | undefined {
  if (output === undefined) return undefined
  try {
    return JSON.parse(output) as CounselOutput
  } catch {
    return undefined
  }
}

export function CounselToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const input = () => parseInput(props.toolCall.input)
  const output = () => parseOutput(props.toolCall.output)

  const subtitle = () => {
    const reviewer = output()?.reviewer
    if (reviewer !== undefined) return `→ ${reviewer}`
    const prompt = input()?.prompt
    if (prompt === undefined) return undefined
    return prompt.length > 60 ? prompt.slice(0, 60) + "…" : prompt
  }

  return (
    <ToolBox
      title="counsel"
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

      <Show when={props.toolCall.status !== "running" ? output()?.review : undefined}>
        {(review) => (
          <>
            <text style={{ fg: theme.textMuted }}>
              <span style={{ fg: theme.success }}>✓</span> Review complete
            </text>
            <Show when={props.expanded}>
              <box paddingLeft={2}>
                <text style={{ fg: theme.textMuted }}>
                  {review().length > 300 ? review().slice(0, 300) + "…" : review()}
                </text>
              </box>
            </Show>
          </>
        )}
      </Show>

      <Show when={props.toolCall.status !== "running" ? output()?.error : undefined}>
        {(error) => (
          <text style={{ fg: theme.error }}>
            <span>✕</span> {error()}
          </text>
        )}
      </Show>

      <Show when={output()?.metadata?.toolCalls}>
        {(calls) => <ToolCallTree toolCalls={calls()} collapsed={!props.expanded} />}
      </Show>

      <Show when={output()?.metadata?.usage}>
        {(usage) => <text style={{ fg: theme.textMuted }}>{formatUsageStats(usage())}</text>}
      </Show>
    </ToolBox>
  )
}
