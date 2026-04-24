/**
 * AgentTree — shared renderer for subagent tools (delegate, counsel, research, review).
 *
 * Collapsed: tool call tree (last 10) + usage stats + optional summary
 * Expanded:
 *   - Running: live tool calls + streaming text
 *   - Completed: full tool call tree + usage + thinking + message text
 *   - Fallback: toolCall.output/preview when message fetch unavailable
 */

import { Show, For, createMemo, createResource } from "solid-js"
import type { JSX } from "solid-js"
import { useTheme } from "../../theme/index"
import { useClient } from "../../client/index"
import { formatUsageStats } from "../../utils/format-tool.js"
import { ToolFrame } from "../tool-frame"
import { ToolCallTree } from "./tool-call-tree"
import { LiveChildTree } from "./live-child-tree"
import type { ToolCall } from "./types"
import type { ChildSessionEntry } from "../../services/child-session-tracker"
import { BranchId } from "@gent/core/domain/ids.js"

interface AgentTreeProps {
  /** Tool display name */
  title: string
  /** Subtitle for header */
  subtitle?: string
  /** The tool call data (for output/summary fallback) */
  toolCall: ToolCall
  /** Whether expanded */
  expanded: boolean
  /** Child sessions from tracker */
  childSessions?: ChildSessionEntry[]
  /** Summary shown in collapsed state (e.g. review severity counts) */
  collapsedSummary?: JSX.Element
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
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- TUI adapter narrows heterogeneous framework value shape
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

  // Live stream text — bounded tail from all children
  const liveText = createMemo(() => {
    const c = children()
    const parts: string[] = []
    for (const child of c) {
      if (child.streamText.length > 0) parts.push(child.streamText)
    }
    return parts.join("\n")
  })

  // Fetch structured messages (reasoning + text) on completion
  const childBranchId = () => {
    const id = completedChild()?.childBranchId
    return id !== undefined ? BranchId.make(id) : undefined
  }
  const fetchKey = () => {
    if (props.toolCall.status === "running") return undefined
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

  // Fallback text from toolCall.output or child preview
  const fallbackText = () => {
    const cm = childMessages()
    if (cm !== undefined && (cm.reasoning.length > 0 || cm.text.length > 0)) return undefined
    // Try preview from completed child
    const preview = completedChild()?.preview
    if (preview !== undefined) return preview
    // Try toolCall.output or summary
    return props.toolCall.output ?? props.toolCall.summary ?? undefined
  }

  const usageLine = () => {
    const u = totalUsage()
    if (u === undefined) return undefined
    return formatUsageStats(u)
  }

  return (
    <ToolFrame
      title={props.title}
      subtitle={props.subtitle}
      status={props.toolCall.status}
      expanded={props.expanded}
      collapsedContent={
        <box flexDirection="column">
          <Show when={hasChildren()}>
            <ToolCallTree toolCalls={allToolCalls()} collapsed />
          </Show>
          <Show when={usageLine()}>
            {(line) => <text style={{ fg: theme.textMuted }}>{line()}</text>}
          </Show>
          {props.collapsedSummary}
        </box>
      }
    >
      {/* Running: live tool calls + streaming text */}
      <Show when={props.toolCall.status === "running" && hasChildren()}>
        <box flexDirection="column">
          <LiveChildTree childSessions={children()} />
          <Show when={liveText().length > 0}>
            <text style={{ fg: theme.textMuted }}>
              <i>{liveText()}</i>
            </text>
          </Show>
        </box>
      </Show>

      <Show when={props.toolCall.status === "running" && !hasChildren()}>
        <text style={{ fg: theme.textMuted }}>
          <span style={{ fg: theme.warning }}>⋯</span> Running…
        </text>
      </Show>

      {/* Completed: tool tree + usage + messages */}
      <Show when={props.toolCall.status !== "running" && hasChildren()}>
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
          <Show when={content().reasoning.length > 0 || content().text.length > 0}>
            <box flexDirection="column" marginTop={1}>
              <For each={content().reasoning}>
                {(r) => (
                  <text>
                    <span style={{ fg: theme.textMuted }}>
                      <i>{r}</i>
                    </span>
                  </text>
                )}
              </For>
              <For each={content().text}>{(t) => <text style={{ fg: theme.text }}>{t}</text>}</For>
            </box>
          </Show>
        )}
      </Show>

      {/* Fallback: preview/output when message fetch unavailable */}
      <Show when={props.toolCall.status !== "running" && fallbackText()}>
        {(text) => (
          <text style={{ fg: theme.textMuted }} marginTop={1}>
            {text()}
          </text>
        )}
      </Show>

      {/* Tool-specific completed content (e.g. review comments) */}
      {props.completedContent}
    </ToolFrame>
  )
}
