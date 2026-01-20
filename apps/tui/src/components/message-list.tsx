import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { useTheme } from "../theme/index.js"
import { TOOL_RENDERERS, GenericToolRenderer, type ToolCall } from "./tool-renderers/index.js"
import { formatThinkTime, getSpinnerFrames, formatToolInput } from "./message-list-utils.js"

export type { ToolCall }

export interface Message {
  id: string
  role: "user" | "assistant" | "system" | "tool"
  content: string
  createdAt: number
  toolCalls: ToolCall[] | undefined
  thinkTime: number | undefined
  interrupted: boolean | undefined
}

function UserMessage(props: { content: string }) {
  const { theme } = useTheme()
  return (
    <box marginTop={1} backgroundColor={theme.backgroundElement} paddingLeft={2} paddingRight={2}>
      <text style={{ fg: theme.text }}>{props.content}</text>
    </box>
  )
}

function AssistantMessage(props: {
  content: string
  toolCalls: ToolCall[] | undefined
  thinkTime: number | undefined
  interrupted: boolean | undefined
  expanded: boolean
}) {
  const { theme } = useTheme()
  const hasContent = () => props.content || (props.toolCalls && props.toolCalls.length > 0)

  return (
    <box marginTop={hasContent() ? 1 : 0} paddingLeft={2} flexDirection="column">
      <Show when={props.toolCalls && props.toolCalls.length > 0}>
        <box flexDirection="column" marginBottom={props.content ? 1 : 0}>
          <For each={props.toolCalls}>
            {(tc) => <SingleToolCall toolCall={tc} expanded={props.expanded} />}
          </For>
        </box>
      </Show>
      <Show when={props.content}>
        <text style={{ fg: theme.text }}>{props.content}</text>
      </Show>
      <Show
        when={props.interrupted}
        fallback={
          <Show when={props.thinkTime !== undefined && props.thinkTime > 0}>
            <box marginTop={1}>
              <text style={{ fg: theme.textMuted }}>
                Thought for {formatThinkTime(props.thinkTime ?? 0)}
              </text>
            </box>
          </Show>
        }
      >
        <box marginTop={1}>
          <text style={{ fg: theme.warning }}>Interrupted</text>
        </box>
      </Show>
    </box>
  )
}

function useSpinner(toolName: string) {
  const [frame, setFrame] = createSignal(0)
  const frames = getSpinnerFrames(toolName)

  onMount(() => {
    const interval = setInterval(() => {
      setFrame((f) => (f + 1) % frames.length)
    }, 150)
    onCleanup(() => clearInterval(interval))
  })

  return () => frames[frame()] ?? frames[0]
}

function SingleToolCall(props: { toolCall: ToolCall; expanded: boolean }) {
  const { theme } = useTheme()
  const spinner = useSpinner(props.toolCall.toolName)
  const toolName = () => props.toolCall.toolName.toLowerCase()

  const statusColor = () =>
    props.toolCall.status === "running"
      ? theme.warning
      : props.toolCall.status === "error"
        ? theme.error
        : theme.success

  const statusIcon = () =>
    props.toolCall.status === "running"
      ? spinner()
      : props.toolCall.status === "error"
        ? " x "
        : " + "

  const inputSummary = () => formatToolInput(props.toolCall.toolName, props.toolCall.input)

  const Renderer = () => TOOL_RENDERERS[toolName()] ?? GenericToolRenderer

  return (
    <box flexDirection="column">
      <text>
        <span style={{ fg: statusColor() }}>[{statusIcon()}]</span>
        <span style={{ fg: theme.info }}> {props.toolCall.toolName}</span>
        <Show when={inputSummary()}>
          <span style={{ fg: theme.textMuted }}>({inputSummary()})</span>
        </Show>
      </text>
      <Show when={props.toolCall.status !== "running"}>
        {(() => {
          const R = Renderer()
          return <R toolCall={props.toolCall} expanded={props.expanded} />
        })()}
      </Show>
    </box>
  )
}

const DOTS_FRAMES = ["", ".", "..", "..."]

export interface ThinkingIndicatorProps {
  elapsed: number
  visible: boolean
}

export function ThinkingIndicator(props: ThinkingIndicatorProps) {
  const { theme } = useTheme()
  const [frame, setFrame] = createSignal(0)

  onMount(() => {
    const interval = setInterval(() => {
      if (props.visible) {
        setFrame((f) => (f + 1) % DOTS_FRAMES.length)
      }
    }, 500)
    onCleanup(() => clearInterval(interval))
  })

  const dots = () => DOTS_FRAMES[frame()]

  return (
    <Show when={props.visible}>
      <box flexShrink={0} paddingLeft={1}>
        <text>
          <span style={{ fg: theme.textMuted, italic: true }}>thinking{dots()}</span>
        </text>
      </box>
    </Show>
  )
}

interface MessageListProps {
  messages: Message[]
  toolsExpanded: boolean
}

export function MessageList(props: MessageListProps) {
  return (
    <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" paddingLeft={1} paddingRight={1}>
      <For each={props.messages}>
        {(msg) => (
          <Show
            when={msg.role === "user"}
            fallback={
              <AssistantMessage
                content={msg.content}
                toolCalls={msg.toolCalls}
                thinkTime={msg.thinkTime}
                interrupted={msg.interrupted}
                expanded={props.toolsExpanded}
              />
            }
          >
            <UserMessage content={msg.content} />
          </Show>
        )}
      </For>
    </scrollbox>
  )
}
