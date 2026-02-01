import { For, Show } from "solid-js"
import type { SyntaxStyle } from "@opentui/core"
import { useTheme } from "../theme/index"
import { TOOL_RENDERERS, GenericToolRenderer, type ToolCall } from "./tool-renderers/index"
import { getSpinnerFrames, formatToolInput } from "./message-list-utils"
import { SessionEventIndicator, type SessionEvent } from "./session-event-indicator"
import type { ImageInfo } from "../client"
import { useSpinnerClock } from "../hooks/use-spinner-clock"

export type { ToolCall }

export interface Message {
  _tag: "message"
  id: string
  role: "user" | "assistant" | "system" | "tool"
  kind: "regular" | "interjection"
  content: string
  images: ImageInfo[]
  createdAt: number
  toolCalls: ToolCall[] | undefined
}

export type SessionItem = Message | SessionEvent

function UserMessage(props: {
  content: string
  images: ImageInfo[]
  kind: "regular" | "interjection"
}) {
  const { theme } = useTheme()
  const isInterjection = () => props.kind === "interjection"
  const background = () => (isInterjection() ? theme.backgroundPanel : theme.backgroundElement)
  const textColor = () => (isInterjection() ? theme.warning : theme.text)
  const hasContent = () => props.content.length > 0 || props.images.length > 0

  return (
    <Show when={hasContent()}>
      <box
        marginTop={1}
        backgroundColor={background()}
        paddingLeft={2}
        paddingRight={2}
        flexDirection="column"
      >
        <Show when={props.images.length > 0}>
          <For each={props.images}>
            {(img) => (
              <text style={{ fg: theme.info }}>[Image: {img.mediaType.replace("image/", "")}]</text>
            )}
          </For>
        </Show>
        <Show when={props.content.length > 0}>
          <text style={{ fg: textColor() }}>
            {isInterjection() ? "[!] " : ""}
            {props.content}
          </text>
        </Show>
      </box>
    </Show>
  )
}

function AssistantMessage(props: {
  content: string
  images: ImageInfo[]
  toolCalls: ToolCall[] | undefined
  expanded: boolean
  syntaxStyle: () => SyntaxStyle
  streaming: boolean
}) {
  const { theme } = useTheme()
  const hasContent = () =>
    props.content.length > 0 ||
    props.images.length > 0 ||
    (props.toolCalls !== undefined && props.toolCalls.length > 0)

  return (
    <box marginTop={hasContent() ? 1 : 0} paddingLeft={2} flexDirection="column">
      <Show when={props.images.length > 0}>
        <box
          flexDirection="column"
          marginBottom={
            props.content.length > 0 ||
            (props.toolCalls !== undefined && props.toolCalls.length > 0)
              ? 1
              : 0
          }
        >
          <For each={props.images}>
            {(img) => (
              <text style={{ fg: theme.info }}>[Image: {img.mediaType.replace("image/", "")}]</text>
            )}
          </For>
        </box>
      </Show>
      <Show when={props.toolCalls !== undefined && props.toolCalls.length > 0}>
        <box flexDirection="column" marginBottom={props.content.length > 0 ? 1 : 0}>
          <For each={props.toolCalls}>
            {(tc) => <SingleToolCall toolCall={tc} expanded={props.expanded} />}
          </For>
        </box>
      </Show>
      <Show when={props.content.length > 0}>
        <markdown
          syntaxStyle={props.syntaxStyle()}
          streaming={props.streaming}
          content={props.content}
          conceal
        />
      </Show>
    </box>
  )
}

function useSpinner(toolName: string) {
  const frames = getSpinnerFrames(toolName)
  const tick = useSpinnerClock()
  return () => frames[tick() % frames.length] ?? frames[0]
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
        <Show when={inputSummary().length > 0}>
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
  syntaxStyle: () => SyntaxStyle
  streaming: boolean
}

export function MessageList(props: MessageListProps) {
  return (
    <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
      <For each={props.items}>
        {(item, index) =>
          item._tag === "event" ? (
            <SessionEventIndicator event={item} />
          ) : (
            <Show
              when={item.role === "user"}
              fallback={
                <AssistantMessage
                  content={item.content}
                  images={item.images}
                  toolCalls={item.toolCalls}
                  expanded={props.toolsExpanded}
                  syntaxStyle={props.syntaxStyle}
                  streaming={props.streaming && index() === props.items.length - 1}
                />
              }
            >
              <UserMessage content={item.content} images={item.images} kind={item.kind} />
            </Show>
          )
        }
      </For>
    </scrollbox>
  )
}
