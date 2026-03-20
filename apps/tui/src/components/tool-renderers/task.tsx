import { Show, For } from "solid-js"
import { useTheme } from "../../theme/index"
import { formatUsageStats } from "../../utils/format-tool.js"
import { ToolBox } from "../tool-box"
import { ToolCallTree } from "./tool-call-tree"
import { LiveChildTree } from "./live-child-tree"
import type { ToolRendererProps } from "./types"

// Parsed JSON shape — not the discriminated union from @gent/core
// because JSON.parse produces plain objects without TS narrowing
interface SubagentResultJson {
  _tag: "success" | "error"
  text?: string
  error?: string
  agentName?: string
  sessionId?: string
  usage?: { input?: number; output?: number; cost?: number }
  toolCalls?: ReadonlyArray<{ toolName: string; args: Record<string, unknown>; isError: boolean }>
}

interface TaskOutput {
  output?: string
  error?: string
  metadata?: {
    mode: "single" | "parallel" | "chain"
    results?: SubagentResultJson[]
    sessionId?: string
    agentName?: string
    usage?: { input?: number; output?: number; cost?: number }
    toolCalls?: ReadonlyArray<{
      toolName: string
      args: Record<string, unknown>
      isError: boolean
    }>
  }
}

function parseTaskOutput(output: string | undefined): TaskOutput | undefined {
  if (output === undefined) return undefined
  try {
    return JSON.parse(output) as TaskOutput
  } catch {
    return undefined
  }
}

function parseTaskInput(input: unknown):
  | {
      agent?: string
      task?: string
      tasks?: Array<{ agent: string; task: string }>
      chain?: Array<{ agent: string; task: string }>
    }
  | undefined {
  if (input === null || input === undefined || typeof input !== "object") return undefined
  return input as {
    agent?: string
    task?: string
    tasks?: Array<{ agent: string; task: string }>
    chain?: Array<{ agent: string; task: string }>
  }
}

const STATUS_ICONS = {
  running: "⋯",
  success: "✓",
  error: "✕",
} as const

export function TaskToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const taskInput = () => parseTaskInput(props.toolCall.input)
  const taskOutput = () => parseTaskOutput(props.toolCall.output)

  const title = () => {
    const inp = taskInput()
    if (inp?.agent !== undefined) return `task → ${inp.agent}`
    if (inp?.tasks !== undefined) return `task → ${inp.tasks.length} parallel`
    if (inp?.chain !== undefined) return `task → ${inp.chain.length} chain`
    return "task"
  }

  const subtitle = () => {
    const inp = taskInput()
    if (inp?.task !== undefined)
      return inp.task.length > 60 ? inp.task.slice(0, 60) + "…" : inp.task
    return undefined
  }

  const results = (): SubagentResultJson[] => {
    const out = taskOutput()
    if (out?.metadata?.results !== undefined) return out.metadata.results
    return []
  }

  return (
    <ToolBox
      title={title()}
      subtitle={subtitle()}
      status={props.toolCall.status}
      expanded={props.expanded}
    >
      <Show when={props.toolCall.status === "running"}>
        <Show
          when={props.childSessions !== undefined && props.childSessions.length > 0}
          fallback={
            <text style={{ fg: theme.textMuted }}>
              <span style={{ fg: theme.warning }}>{STATUS_ICONS.running}</span> Running sub-agent...
            </text>
          }
        >
          <LiveChildTree childSessions={props.childSessions ?? []} />
        </Show>
      </Show>

      <Show when={results().length > 0}>
        <For each={results()}>
          {(result, index) => {
            const isLast = () => index() === results().length - 1
            const connector = () => (isLast() ? "╰──" : "├──")
            const icon = () =>
              result._tag === "success" ? STATUS_ICONS.success : STATUS_ICONS.error
            const iconColor = () => (result._tag === "success" ? theme.success : theme.error)

            return (
              <box flexDirection="column">
                <text style={{ fg: theme.textMuted }}>
                  {connector()} <span style={{ fg: iconColor() }}>{icon()}</span>{" "}
                  <span style={{ fg: theme.text }}>{result.agentName ?? "agent"}</span>
                  <Show when={result.usage !== undefined}>
                    {" "}
                    <span style={{ fg: theme.textMuted }}>
                      {formatUsageStats(result.usage ?? {})}
                    </span>
                  </Show>
                </text>
                <Show
                  when={props.expanded && result._tag === "success" && result.text !== undefined}
                >
                  <box paddingLeft={4}>
                    <text style={{ fg: theme.textMuted }}>
                      {result.text && result.text.length > 200
                        ? result.text.slice(0, 200) + "…"
                        : result.text}
                    </text>
                  </box>
                </Show>
                <Show when={result._tag === "error" && result.error !== undefined}>
                  <box paddingLeft={4}>
                    <text style={{ fg: theme.error }}>{result.error}</text>
                  </box>
                </Show>
                <Show
                  when={
                    result.toolCalls !== undefined && result.toolCalls.length > 0
                      ? result.toolCalls
                      : undefined
                  }
                >
                  {(calls) => (
                    <box paddingLeft={4}>
                      <ToolCallTree toolCalls={calls()} collapsed={!props.expanded} />
                    </box>
                  )}
                </Show>
              </box>
            )
          }}
        </For>
      </Show>

      <Show when={props.toolCall.status !== "running" && results().length === 0}>
        <text style={{ fg: theme.textMuted }}>
          {taskOutput()?.output ?? taskOutput()?.error ?? props.toolCall.summary ?? ""}
        </text>
        <Show when={taskOutput()?.metadata?.toolCalls}>
          {(calls) => <ToolCallTree toolCalls={calls()} collapsed={!props.expanded} />}
        </Show>
      </Show>

      <Show when={taskOutput()?.metadata?.usage}>
        {(usage) => <text style={{ fg: theme.textMuted }}>{formatUsageStats(usage())}</text>}
      </Show>
    </ToolBox>
  )
}
