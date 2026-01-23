import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { useTheme } from "../theme/index"
import { TOOL_RENDERERS, GenericToolRenderer, type ToolCall } from "./tool-renderers/index"
import { getSpinnerFrames, formatToolInput } from "./message-list-utils"
import { SessionEventIndicator, type SessionEvent } from "./session-event-indicator"

export type { ToolCall }

export interface Message {
  _tag: "message"
  id: string
  role: "user" | "assistant" | "system" | "tool"
  kind: "regular" | "interjection"
  content: string
  createdAt: number
  toolCalls: ToolCall[] | undefined
}

export type SessionItem = Message | SessionEvent

function UserMessage(props: { content: string; kind: "regular" | "interjection" }) {
  const { theme } = useTheme()
  const background = () =>
    props.kind === "interjection" ? theme.backgroundPanel : theme.backgroundElement
  return (
    <box marginTop={1} backgroundColor={background()} paddingLeft={2} paddingRight={2}>
      <text style={{ fg: theme.text }}>{props.content}</text>
    </box>
  )
}

function AssistantMessage(props: {
  content: string
  toolCalls: ToolCall[] | undefined
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

interface MessageListProps {
  items: SessionItem[]
  toolsExpanded: boolean
}

export function MessageList(props: MessageListProps) {
  return (
    <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
      <For each={props.items}>
        {(item) =>
          item._tag === "event" ? (
            <SessionEventIndicator event={item} />
          ) : (
            <Show
              when={item.role === "user"}
              fallback={
                <AssistantMessage
                  content={item.content}
                  toolCalls={item.toolCalls}
                  expanded={props.toolsExpanded}
                />
              }
            >
              <UserMessage content={item.content} kind={item.kind} />
            </Show>
          )
        }
      </For>
    </scrollbox>
  )
}
