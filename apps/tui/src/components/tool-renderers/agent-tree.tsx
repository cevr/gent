/**
 * AgentTree — shared renderer for subagent tools (delegate, counsel, research, review).
 *
 * Collapsed: tool call tree (last 10) + usage stats line
 * Expanded:
 *   - Running: live tool calls + streaming text
 *   - Completed: full tool call tree + usage + thinking + message text
 */

import { Show, For, createMemo, createResource } from "solid-js"
import type { JSX } from "solid-js"
import { useTheme } from "../../theme/index"
import { useClient } from "../../client/index"
import { formatUsageStats } from "../../utils/format-tool.js"
import { ToolFrame } from "../tool-frame"
import { ToolCallTree } from "./tool-call-tree"
import { LiveChildTree } from "./live-child-tree"
import type { ChildSessionEntry } from "../../services/child-session-tracker"
import type { BranchId } from "@gent/core/domain/ids.js"

interface AgentTreeProps {
  /** Tool display name */
  title: string
  /** Subtitle for header */
  subtitle?: string
  /** Tool call status */
  status: "running" | "completed" | "error"
  /** Whether expanded */
  expanded: boolean
  /** Child sessions from tracker */
  childSessions?: ChildSessionEntry[]
  /** Optional extra content to show after tool calls (e.g. review comments) */
  completedContent?: JSX.Element
}

/** Extract reasoning + text parts from child session messages */
function extractChildContent(
  messages: ReadonlyArray<{
    role: string
    parts: ReadonlyArray<{ type: string; text?: string }>
  }>,
): { reasoning: string[]; text: string[] } {
  const reasoning: string[] = []
  const text: string[] = []
  for (const msg of messages) {
    if (msg.role !== "assistant") continue
    for (const part of msg.parts) {
      if (part.type === "reasoning" && part.text !== undefined) reasoning.push(part.text)
      else if (part.type === "text" && part.text !== undefined) text.push(part.text)
    }
  }
  return { reasoning, text }
}

export function AgentTree(props: AgentTreeProps) {
  const { theme } = useTheme()
  const clientCtx = useClient()

  const children = () => props.childSessions ?? []
  const hasChildren = () => children().length > 0
  const completedChild = () => {
    const c = children()
    return c.length === 1 ? c[0] : undefined
  }

  // Aggregate tool calls from all child sessions for the tree view
  const allToolCalls = createMemo(() =>
    children().flatMap((child) =>
      child.toolCalls.map((tc) => ({
        toolName: tc.toolName,
        args: (tc.input ?? {}) as Record<string, unknown>,
        isError: tc.status === "error",
        status: tc.status,
      })),
    ),
  )

  // Aggregate usage across all children
  const totalUsage = createMemo(() => {
    const c = children()
    if (c.length === 0) return undefined
    let input = 0
    let output = 0
    let cost = 0
    let hasUsage = false
    for (const child of c) {
      if (child.usage !== undefined) {
        hasUsage = true
        input += child.usage.input
        output += child.usage.output
        cost += child.usage.cost ?? 0
      }
    }
    if (!hasUsage) return undefined
    return { input, output, cost: cost > 0 ? cost : undefined }
  })

  // Live stream text from all children (accumulated during running)
  const liveText = createMemo(() => {
    const c = children()
    const parts: string[] = []
    for (const child of c) {
      if (child.streamText.length > 0) parts.push(child.streamText)
    }
    return parts.join("\n")
  })

  // Fetch structured messages (reasoning + text) on completion
  const childBranchId = () => completedChild()?.childBranchId as BranchId | undefined
  const fetchKey = () => {
    if (props.status === "running") return undefined
    return childBranchId()
  }

  const [childMessages] = createResource(fetchKey, async (branchId) => {
    try {
      const messages = await clientCtx.runtime.run(clientCtx.client.message.list({ branchId }))
      return extractChildContent(messages)
    } catch {
      return undefined
    }
  })

  const usageLine = () => {
    const u = totalUsage()
    if (u === undefined) return undefined
    return formatUsageStats(u)
  }

  return (
    <ToolFrame
      title={props.title}
      subtitle={props.subtitle}
      status={props.status}
      expanded={props.expanded}
      collapsedContent={
        <box flexDirection="column">
          <Show when={hasChildren()}>
            <ToolCallTree toolCalls={allToolCalls()} collapsed />
          </Show>
          <Show when={usageLine()}>
            {(line) => <text style={{ fg: theme.textMuted }}>{line()}</text>}
          </Show>
        </box>
      }
    >
      {/* Running: live tool calls + streaming text */}
      <Show when={props.status === "running" && hasChildren()}>
        <box flexDirection="column">
          <LiveChildTree childSessions={children()} />
          <Show when={liveText().length > 0}>
            <text style={{ fg: theme.textMuted }}>
              <i>{liveText()}</i>
            </text>
          </Show>
        </box>
      </Show>

      <Show when={props.status === "running" && !hasChildren()}>
        <text style={{ fg: theme.textMuted }}>
          <span style={{ fg: theme.warning }}>⋯</span> Running…
        </text>
      </Show>

      {/* Completed: tool tree + usage + messages */}
      <Show when={props.status !== "running" && hasChildren()}>
        <box flexDirection="column">
          <ToolCallTree toolCalls={allToolCalls()} />
          <Show when={usageLine()}>
            {(line) => <text style={{ fg: theme.textMuted }}>{line()}</text>}
          </Show>
        </box>
      </Show>

      {/* Structured messages from child session (fetched on completion) */}
      <Show when={childMessages()}>
        {(content) => (
          <box flexDirection="column" marginTop={1}>
            <Show when={content().reasoning.length > 0}>
              <For each={content().reasoning}>
                {(r) => (
                  <text>
                    <span style={{ fg: theme.textMuted }}>
                      <i>{r}</i>
                    </span>
                  </text>
                )}
              </For>
            </Show>
            <For each={content().text}>{(t) => <text style={{ fg: theme.text }}>{t}</text>}</For>
          </box>
        )}
      </Show>

      {/* Tool-specific completed content (e.g. review comments) */}
      {props.completedContent}
    </ToolFrame>
  )
}
