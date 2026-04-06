import { Show, For } from "solid-js"
import { useTheme } from "../../theme/index"
import { formatUsageStats } from "../../utils/format-tool.js"
import { ToolFrame } from "../tool-frame"
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

interface DelegateOutput {
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

function parseDelegateOutput(output: string | undefined): DelegateOutput | undefined {
  if (output === undefined) return undefined
  try {
    return JSON.parse(output) as DelegateOutput
  } catch {
    return undefined
  }
}

function parseDelegateInput(input: unknown):
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

export function DelegateToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const delegateInput = () => parseDelegateInput(props.toolCall.input)
  const delegateOutput = () => parseDelegateOutput(props.toolCall.output)

  const isLibrarian = () => props.toolCall.toolName === "librarian"

  const title = () => {
    if (isLibrarian()) {
      const inp = props.toolCall.input as { spec?: string } | undefined
      return inp?.spec !== undefined ? `librarian → ${inp.spec}` : "librarian"
    }
    const inp = delegateInput()
    if (inp?.agent !== undefined) return `delegate → ${inp.agent}`
    if (inp?.tasks !== undefined) return `delegate → ${inp.tasks.length} parallel`
    if (inp?.chain !== undefined) return `delegate → ${inp.chain.length} chain`
    return "delegate"
  }

  const subtitle = () => {
    if (isLibrarian()) {
      const inp = props.toolCall.input as { question?: string } | undefined
      if (inp?.question !== undefined)
        return inp.question.length > 60 ? inp.question.slice(0, 60) + "…" : inp.question
      return undefined
    }
    const inp = delegateInput()
    if (inp?.task !== undefined)
      return inp.task.length > 60 ? inp.task.slice(0, 60) + "…" : inp.task
    return undefined
  }

  const results = (): SubagentResultJson[] => {
    const out = delegateOutput()
    if (out?.metadata?.results !== undefined) return out.metadata.results
    return []
  }

  return (
    <ToolFrame
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
          {delegateOutput()?.output ?? delegateOutput()?.error ?? props.toolCall.summary ?? ""}
        </text>
        <Show when={delegateOutput()?.metadata?.toolCalls}>
          {(calls) => <ToolCallTree toolCalls={calls()} collapsed={!props.expanded} />}
        </Show>
      </Show>

      <Show when={delegateOutput()?.metadata?.usage}>
        {(usage) => <text style={{ fg: theme.textMuted }}>{formatUsageStats(usage())}</text>}
      </Show>
    </ToolFrame>
  )
}
