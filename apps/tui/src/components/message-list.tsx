import { createMemo, For, Show } from "solid-js"
import type { SyntaxStyle } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../theme/index"
import { GenericToolRenderer, type ToolCall } from "./tool-renderers/index"
import { useExtensionUI } from "../extensions/context"
import { SessionEventIndicator } from "./session-event-indicator"
import type { SessionEvent } from "./session-event-label"
import type { ImageInfo } from "../client"
import type { ChildSessionEntry } from "../hooks/use-child-sessions"
import { replaceMermaidBlocks } from "../utils/mermaid"
export type { ToolCall }

export interface MessageMetadataInfo {
  customType?: string
  extensionId?: string
  hidden?: boolean
  details?: unknown
}

export type AssistantSegment =
  | { _tag: "text"; content: string }
  | { _tag: "reasoning"; content: string }
  | { _tag: "tool-call"; toolCall: ToolCall }
  | { _tag: "image"; image: ImageInfo }

export interface Message {
  _tag: "message"
  id: string
  role: "user" | "assistant" | "system" | "tool"
  kind: "regular" | "interjection"
  pendingMode?: "queued" | "steer"
  /** Concatenated text content (derived — used by picker, mermaid, search) */
  content: string
  /** Concatenated reasoning (derived) */
  reasoning: string
  images: ImageInfo[]
  createdAt: number
  toolCalls: ToolCall[] | undefined
  /** Ordered parts for interleaved rendering */
  segments?: AssistantSegment[]
  metadata?: MessageMetadataInfo
}

export type SessionItem = Message | SessionEvent

function UserMessage(props: {
  content: string
  images: ImageInfo[]
  kind: "regular" | "interjection"
  pendingMode?: "queued" | "steer"
}) {
  const { theme } = useTheme()
  const isInterjection = () => props.kind === "interjection"
  const background = () => (isInterjection() ? theme.backgroundPanel : theme.backgroundElement)
  const textColor = () => (isInterjection() ? theme.warning : theme.text)
  const label = () => props.pendingMode
  const labelColor = () => (isInterjection() ? theme.warning : theme.textMuted)
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
          <box flexDirection="column">
            <Show when={label()}>
              {(value) => <text style={{ fg: labelColor() }}>[{value()}]</text>}
            </Show>
            <text style={{ fg: textColor() }}>{props.content}</text>
          </box>
        </Show>
      </box>
    </Show>
  )
}

function AssistantMessage(props: {
  content: string
  reasoning: string
  images: ImageInfo[]
  toolCalls: ToolCall[] | undefined
  segments?: AssistantSegment[]
  expanded: boolean
  syntaxStyle: () => SyntaxStyle
  streaming: boolean
  getChildSessions?: (toolCallId: string) => ChildSessionEntry[]
}) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  const hasContent = () =>
    props.content.length > 0 ||
    props.reasoning.length > 0 ||
    props.images.length > 0 ||
    (props.toolCalls ?? []).length > 0

  // Replace mermaid code blocks with rendered ASCII art (skip while streaming)
  const processedContent = createMemo(() =>
    props.streaming ? props.content : replaceMermaidBlocks(props.content, dimensions().width),
  )

  return (
    <box marginTop={hasContent() ? 1 : 0} paddingLeft={2} flexDirection="column">
      <Show
        when={props.segments !== undefined && props.segments.length > 0}
        fallback={
          <AssistantMessageLegacy
            content={props.content}
            reasoning={props.reasoning}
            images={props.images}
            toolCalls={props.toolCalls}
            expanded={props.expanded}
            syntaxStyle={props.syntaxStyle}
            streaming={props.streaming}
            processedContent={processedContent()}
            getChildSessions={props.getChildSessions}
          />
        }
      >
        <For each={props.segments}>
          {(segment) => {
            switch (segment._tag) {
              case "reasoning":
                return (
                  <box flexDirection="column" marginBottom={1}>
                    <text>
                      <span style={{ fg: theme.textMuted, dim: true }}>
                        <i>{segment.content}</i>
                      </span>
                    </text>
                  </box>
                )
              case "image":
                return (
                  <text style={{ fg: theme.info }}>
                    [Image: {segment.image.mediaType.replace("image/", "")}]
                  </text>
                )
              case "tool-call":
                return (
                  <SingleToolCall
                    toolCall={segment.toolCall}
                    expanded={props.expanded}
                    getChildSessions={props.getChildSessions}
                  />
                )
              case "text":
                return (
                  <markdown
                    syntaxStyle={props.syntaxStyle()}
                    streaming={props.streaming}
                    content={
                      props.streaming
                        ? segment.content
                        : replaceMermaidBlocks(segment.content, dimensions().width)
                    }
                    conceal
                  />
                )
            }
          }}
        </For>
      </Show>
    </box>
  )
}

/** Fallback for snapshot-hydrated messages without segments */
function AssistantMessageLegacy(props: {
  content: string
  reasoning: string
  images: ImageInfo[]
  toolCalls: ToolCall[] | undefined
  expanded: boolean
  syntaxStyle: () => SyntaxStyle
  streaming: boolean
  processedContent: string
  getChildSessions?: (toolCallId: string) => ChildSessionEntry[]
}) {
  const { theme } = useTheme()

  return (
    <>
      <Show when={props.reasoning.length > 0}>
        <box flexDirection="column" marginBottom={1}>
          <text>
            <span style={{ fg: theme.textMuted, dim: true }}>
              <i>{props.reasoning}</i>
            </span>
          </text>
        </box>
      </Show>
      <Show when={props.images.length > 0}>
        <box flexDirection="column" marginBottom={props.content.length > 0 ? 1 : 0}>
          <For each={props.images}>
            {(img) => (
              <text style={{ fg: theme.info }}>[Image: {img.mediaType.replace("image/", "")}]</text>
            )}
          </For>
        </box>
      </Show>
      <Show when={(props.toolCalls ?? []).length > 0}>
        <box flexDirection="column" marginBottom={props.content.length > 0 ? 1 : 0}>
          <For each={props.toolCalls ?? []}>
            {(tc) => (
              <SingleToolCall
                toolCall={tc}
                expanded={props.expanded}
                getChildSessions={props.getChildSessions}
              />
            )}
          </For>
        </box>
      </Show>
      <Show when={props.content.length > 0}>
        <markdown
          syntaxStyle={props.syntaxStyle()}
          streaming={props.streaming}
          content={props.processedContent}
          conceal
        />
      </Show>
    </>
  )
}

function SingleToolCall(props: {
  toolCall: ToolCall
  expanded: boolean
  getChildSessions?: (toolCallId: string) => ChildSessionEntry[]
}) {
  const ext = useExtensionUI()
  const toolName = () => props.toolCall.toolName.toLowerCase()

  // Resolved map includes builtins + extensions with scope precedence
  const Renderer = () => ext.renderers().get(toolName()) ?? GenericToolRenderer

  const childSessions = () => props.getChildSessions?.(props.toolCall.id)

  return (() => {
    const R = Renderer()
    return <R toolCall={props.toolCall} expanded={props.expanded} childSessions={childSessions()} />
  })()
}

interface MessageListProps {
  items: SessionItem[]
  toolsExpanded: boolean
  syntaxStyle: () => SyntaxStyle
  streaming: boolean
  getChildSessions?: (toolCallId: string) => ChildSessionEntry[]
}

export function MessageList(props: MessageListProps) {
  const visibleItems = createMemo(() =>
    props.items.filter((item) => item._tag !== "message" || item.metadata?.hidden !== true),
  )

  return (
    <box flexDirection="column">
      <For each={visibleItems()}>
        {(item, index) =>
          item._tag === "event" ? (
            <SessionEventIndicator event={item} />
          ) : (
            <Show
              when={item.role === "user"}
              fallback={
                <AssistantMessage
                  content={item.content}
                  reasoning={item.reasoning}
                  images={item.images}
                  toolCalls={item.toolCalls}
                  segments={item.segments}
                  expanded={props.toolsExpanded}
                  syntaxStyle={props.syntaxStyle}
                  streaming={props.streaming && index() === props.items.length - 1}
                  getChildSessions={props.getChildSessions}
                />
              }
            >
              <UserMessage
                content={item.content}
                images={item.images}
                kind={item.kind}
                pendingMode={item.pendingMode}
              />
            </Show>
          )
        }
      </For>
    </box>
  )
}
