/**
 * AgentTree — shared renderer for subagent tools (delegate, counsel, research, review).
 *
 * Collapsed: tool call tree (last 10) + usage stats + optional summary
 * Expanded:
 *   - Running: live tool calls + streaming text
 *   - Completed: full tool call tree + usage + thinking + message text
 *   - Fallback: toolCall.output/preview when message fetch unavailable
 */

import { Option, Schema } from "effect"
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
import { BranchId } from "@gent/core-internal/domain/ids.js"

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

interface ChildContent {
  readonly reasoning: string[]
  readonly text: string[]
}

/** Extract reasoning + text parts from child session messages */
function extractChildContent(
  messages: ReadonlyArray<{
    role: string
    parts: ReadonlyArray<{ type: string; text?: string }>
  }>,
): ChildContent {
  const reasoning: string[] = []
  const text: string[] = []
  for (const msg of messages) {
    if (msg.role !== "assistant") continue
    for (const part of msg.parts) {
      const partText = Option.fromNullishOr(part.text)
      if (part.type === "reasoning" && Option.isSome(partText)) reasoning.push(partText.value)
      else if (part.type === "text" && Option.isSome(partText)) text.push(partText.value)
    }
  }
  return { reasoning, text }
}

export function AgentTree(props: AgentTreeProps) {
  const { theme } = useTheme()
  const clientCtx = useClient()

  const children = () => props.childSessions ?? []
  const hasChildren = () => children().length > 0
  const completedChild = (): Option.Option<ChildSessionEntry> => {
    const c = children()
    if (c.length !== 1) return Option.none()
    return Option.fromNullishOr(c[0])
  }

  // Aggregate tool calls from all child sessions for the tree view
  const allToolCalls = createMemo(() =>
    children().flatMap((child) =>
      child.toolCalls.map((tc) => ({
        toolName: tc.toolName,
        args: Option.getOrElse(Schema.decodeUnknownOption(Schema.JsonObject)(tc.input), () => ({})),
        isError: tc.status === "error",
        status: tc.status,
      })),
    ),
  )

  // Aggregate usage across all children
  const totalUsage = createMemo(() => {
    const c = children()
    if (c.length === 0)
      return Option.none<{
        input: number
        output: number
        // eslint-disable-next-line effect/noNullish -- usage formatting accepts an absent cost.
        cost: number | undefined
      }>()
    let input = 0
    let output = 0
    let cost = 0
    let hasUsage = false
    for (const child of c) {
      const usage = Option.fromNullishOr(child.usage)
      if (Option.isSome(usage)) {
        hasUsage = true
        input += usage.value.input
        output += usage.value.output
        const childCost = Option.getOrElse(Option.fromNullishOr(usage.value.cost), () => 0)
        cost += childCost
      }
    }
    if (!hasUsage) return Option.none()
    let costValue = Option.none<number>()
    if (cost > 0) costValue = Option.some(cost)
    return Option.some({ input, output, cost: Option.getOrUndefined(costValue) })
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
  const childBranchId = () =>
    Option.flatMap(completedChild(), (child) =>
      Option.map(Option.fromNullishOr(child.childBranchId), (id) => BranchId.make(id)),
    )
  const fetchKey = () => {
    if (props.toolCall.status === "running") return Option.getOrUndefined(Option.none<BranchId>())
    return Option.getOrUndefined(childBranchId())
  }

  const [childMessages] = createResource(fetchKey, (branchId) =>
    clientCtx.runtime
      .run(clientCtx.client.message.list({ branchId }))
      .then((messages) => extractChildContent(messages))
      .catch(() => Option.getOrUndefined(Option.none<ChildContent>())),
  )

  // Fallback text from toolCall.output or child preview
  const fallbackText = () => {
    const cm = Option.fromNullishOr(childMessages())
    if (Option.isSome(cm) && (cm.value.reasoning.length > 0 || cm.value.text.length > 0)) {
      return Option.none<string>()
    }
    // Try preview from completed child
    const preview = Option.flatMap(completedChild(), (child) => Option.fromNullishOr(child.preview))
    if (Option.isSome(preview)) return preview
    // Try toolCall.output or summary
    return Option.orElse(Option.fromNullishOr(props.toolCall.output), () =>
      Option.fromNullishOr(props.toolCall.summary),
    )
  }

  const usageLine = () => {
    const u = totalUsage()
    if (Option.isNone(u)) return Option.none<string>()
    return Option.some(formatUsageStats(u.value))
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
          <Show when={Option.getOrUndefined(usageLine())}>
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
          <Show when={Option.getOrUndefined(usageLine())}>
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
      <Show when={props.toolCall.status !== "running" && Option.getOrUndefined(fallbackText())}>
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
