import { createMemo, createSignal, For, Show, type Accessor } from "solid-js"
import { Match, Option, Predicate } from "effect"
import type { SyntaxStyle } from "@opentui/core"
import { useTerminalDimensions } from "../terminal-dimensions"
import { useTheme } from "../theme/index"
import type { ToolCall } from "./tool-renderers/index"
import { formatToolCallIdentity, ToolCallIdentityProvider } from "./tool-frame"
import { GenericToolRenderer } from "./tool-renderers/generic"
import { useExtensionUI } from "../extensions/context"
import { SessionEventIndicator } from "./session-event-indicator"
import type { SessionEvent } from "./session-event-label"
import type { ImageInfo } from "../client"
import type { ChildSessionEntry } from "../hooks/use-child-sessions"
import { replaceMermaidBlocks } from "../utils/mermaid"
import { getString } from "../utils/parse-tool-output"
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

export interface MessageBase {
  id: string
  role: "user" | "assistant" | "system" | "tool"
  pendingMode?: "queued" | "steer"
  /** Concatenated text content (derived — used by picker, mermaid, search) */
  content: string
  /** Concatenated reasoning (derived) */
  reasoning: string
  images: ImageInfo[]
  createdAt: number
  // eslint-disable-next-line effect/noNullish -- snapshot messages preserve absent tool-call data.
  toolCalls: ToolCall[] | undefined
  /** Ordered parts for interleaved rendering */
  segments?: AssistantSegment[]
  metadata?: MessageMetadataInfo
}

export interface RegularMessage extends MessageBase {
  _tag: "regular-message"
}

export interface InterjectionMessage extends MessageBase {
  _tag: "interjection-message"
  role: "user"
}

export type Message = RegularMessage | InterjectionMessage
export type SessionItem = Message | SessionEvent

type TerminalDimensions = { readonly width: number; readonly height: number }

const isMessageItem = Predicate.or(
  Predicate.isTagged("regular-message"),
  Predicate.isTagged("interjection-message"),
)

function UserMessage(props: {
  content: string
  images: ImageInfo[]
  interjection: boolean
  pendingMode?: "queued" | "steer"
}) {
  const { theme } = useTheme()
  const textColor = () => {
    if (props.interjection) return theme.warning
    return theme.text
  }
  const label = () => props.pendingMode
  const labelColor = () => {
    if (props.interjection) return theme.warning
    return theme.textMuted
  }
  const railColor = () => {
    if (props.interjection) return theme.warning
    return theme.primary
  }
  const hasContent = () => props.content.length > 0 || props.images.length > 0
  const [contentHeight, setContentHeight] = createSignal(1)

  return (
    <Show when={hasContent()}>
      <box marginTop={1} flexDirection="row" alignItems="flex-start">
        <text width={1} flexShrink={0} style={{ fg: railColor() }}>
          {Array.from({ length: contentHeight() }, () => "┃").join("\n")}
        </text>
        <box
          flexGrow={1}
          paddingLeft={1}
          paddingRight={1}
          flexDirection="column"
          onSizeChange={function () {
            setContentHeight(this.height)
          }}
        >
          <Show when={props.images.length > 0}>
            <For each={props.images}>
              {(img) => (
                <text style={{ fg: theme.info }}>
                  [Image: {img.mediaType.replace("image/", "")}]
                </text>
              )}
            </For>
          </Show>
          <Show when={props.content.length > 0}>
            <box flexDirection="column">
              <Show when={label()}>
                {(value) => (
                  <text>
                    <span style={{ fg: labelColor(), bold: true }}>[{value()}]</span>
                  </text>
                )}
              </Show>
              <text style={{ fg: textColor() }}>
                <span style={{ bold: true }}>{props.content}</span>
              </text>
            </box>
          </Show>
        </box>
      </box>
    </Show>
  )
}

function AssistantMessage(props: {
  content: string
  reasoning: string
  images: ImageInfo[]
  // eslint-disable-next-line effect/noNullish -- snapshot messages preserve absent tool-call data.
  toolCalls: ToolCall[] | undefined
  segments?: AssistantSegment[]
  expanded: boolean
  fullDetail: boolean
  syntaxStyle: () => SyntaxStyle
  streaming: boolean
  dimensions: Accessor<TerminalDimensions>
  getChildSessions?: (toolCallId: string) => ChildSessionEntry[]
}) {
  const { theme } = useTheme()

  const hasContent = () => {
    if (props.content.length > 0) return true
    if (props.reasoning.length > 0) return true
    if (props.images.length > 0) return true
    return (props.toolCalls ?? []).length > 0
  }

  const processedContent = createMemo(() => {
    if (props.streaming) return props.content
    return replaceMermaidBlocks(props.content, props.dimensions().width)
  })

  const contentMargin = () => {
    if (hasContent()) return 1
    return 0
  }

  const segments = () => Option.getOrElse(Option.fromNullishOr(props.segments), () => [])
  const groupedSegments = createMemo(() => {
    const groups: { segment: AssistantSegment; calls: ToolCall[] }[] = []
    for (const segment of segments()) {
      const previous = groups.at(-1)
      if (segment._tag === "tool-call" && previous?.segment._tag === "tool-call") {
        previous.calls.push(segment.toolCall)
      } else {
        const calls: ToolCall[] = []
        if (segment._tag === "tool-call") calls.push(segment.toolCall)
        groups.push({ segment, calls })
      }
    }
    return groups
  })

  // Replace mermaid code blocks with rendered ASCII art (skip while streaming)
  return (
    <box marginTop={contentMargin()} paddingLeft={2} flexDirection="column">
      <Show
        when={segments().length > 0}
        fallback={
          <AssistantMessageLegacy
            content={props.content}
            reasoning={props.reasoning}
            images={props.images}
            toolCalls={props.toolCalls}
            expanded={props.expanded}
            fullDetail={props.fullDetail}
            syntaxStyle={props.syntaxStyle}
            streaming={props.streaming}
            processedContent={processedContent()}
            getChildSessions={props.getChildSessions}
          />
        }
      >
        <For each={groupedSegments()}>
          {({ segment, calls }) =>
            Match.value(segment).pipe(
              Match.tagsExhaustive({
                reasoning: (segment) => (
                  <box flexDirection="column" marginBottom={1}>
                    <text>
                      <span style={{ fg: theme.textMuted, dim: true }}>
                        <i>{segment.content}</i>
                      </span>
                    </text>
                  </box>
                ),
                image: (segment) => (
                  <text style={{ fg: theme.info }}>
                    [Image: {segment.image.mediaType.replace("image/", "")}]
                  </text>
                ),
                "tool-call": () => (
                  <ToolCallGroup
                    calls={calls}
                    expanded={props.expanded}
                    fullDetail={props.fullDetail}
                    getChildSessions={props.getChildSessions}
                  />
                ),
                text: (segment) => {
                  const renderContent = () => {
                    if (props.streaming) return segment.content
                    return replaceMermaidBlocks(segment.content, props.dimensions().width)
                  }
                  return (
                    <markdown
                      syntaxStyle={props.syntaxStyle()}
                      streaming
                      content={renderContent()}
                      conceal
                    />
                  )
                },
              }),
            )
          }
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
  // eslint-disable-next-line effect/noNullish -- snapshot messages preserve absent tool-call data.
  toolCalls: ToolCall[] | undefined
  expanded: boolean
  fullDetail: boolean
  syntaxStyle: () => SyntaxStyle
  streaming: boolean
  processedContent: string
  getChildSessions?: (toolCallId: string) => ChildSessionEntry[]
}) {
  const { theme } = useTheme()
  const contentMargin = () => {
    if (props.content.length > 0) return 1
    return 0
  }

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
        <box flexDirection="column" marginBottom={contentMargin()}>
          <For each={props.images}>
            {(img) => (
              <text style={{ fg: theme.info }}>[Image: {img.mediaType.replace("image/", "")}]</text>
            )}
          </For>
        </box>
      </Show>
      <Show when={(props.toolCalls ?? []).length > 0}>
        <box flexDirection="column" marginBottom={contentMargin()}>
          <ToolCallGroup
            calls={props.toolCalls ?? []}
            expanded={props.expanded}
            fullDetail={props.fullDetail}
            getChildSessions={props.getChildSessions}
          />
        </box>
      </Show>
      <Show when={props.content.length > 0}>
        <markdown
          syntaxStyle={props.syntaxStyle()}
          streaming
          content={props.processedContent}
          conceal
        />
      </Show>
    </>
  )
}

function ToolCallGroup(props: {
  calls: ToolCall[]
  expanded: boolean
  fullDetail: boolean
  getChildSessions?: (toolCallId: string) => ChildSessionEntry[]
}) {
  const { theme } = useTheme()
  const failed = () => props.calls.some((call) => call.status === "error")
  const running = () => props.calls.some((call) => call.status === "running")
  const symbol = () => {
    if (failed()) return "✕"
    if (running()) return "⋯"
    return "●"
  }
  const groupColor = () => {
    if (failed()) return theme.error
    return theme.textMuted
  }
  const callLabel = () => {
    if (props.calls.length === 1) return "call"
    return "calls"
  }
  const counts = createMemo(() => {
    const names = new Map<string, number>()
    for (const call of props.calls) names.set(call.toolName, (names.get(call.toolName) ?? 0) + 1)
    return Array.from(names, ([name, count]) => `${count} ${name}`).join(" · ")
  })
  const visibleCalls = () => {
    if (props.expanded || props.fullDetail) return props.calls
    return props.calls.filter((call) => call.status === "error")
  }
  return (
    <Show when={props.calls.length > 0}>
      <box flexDirection="column">
        <Show when={!props.fullDetail}>
          <text style={{ fg: groupColor() }}>
            {symbol()} {props.calls.length} tool {callLabel()} · {counts()}
          </text>
        </Show>
        <Show when={visibleCalls().length > 0}>
          <For each={visibleCalls()}>
            {(call, index) => {
              const color = () => {
                if (call.status === "error") return theme.error
                return theme.textMuted
              }
              const connector = () => {
                if (index() === props.calls.length - 1) return "└"
                return "├"
              }
              const status = () => {
                if (call.status === "error") return " · failed"
                if (call.status === "running") return " · running"
                return ""
              }
              const label = () => {
                for (const key of [
                  "path",
                  "url",
                  "command",
                  "pattern",
                  "query",
                  "goal",
                  "description",
                  "task",
                  "todo",
                  "agent",
                ]) {
                  const value = getString(call.input, key)
                  if (value.length > 0) return value.split("\n")[0]
                }
                const summary = (call.summary ?? "").trim()
                if (summary.startsWith("{") || summary.startsWith("[")) return ""
                return summary.split("\n")[0]
              }
              return (
                <Show
                  when={props.fullDetail || call.status === "error"}
                  fallback={
                    <text style={{ fg: color() }}>
                      {connector()} {call.toolName} {label()}
                      {status()}
                    </text>
                  }
                >
                  <SingleToolCall
                    toolCall={call}
                    expanded={props.fullDetail}
                    getChildSessions={props.getChildSessions}
                  />
                </Show>
              )
            }}
          </For>
        </Show>
      </box>
    </Show>
  )
}

function SingleToolCall(props: {
  toolCall: ToolCall
  expanded: boolean
  getChildSessions?: (toolCallId: string) => ChildSessionEntry[]
}) {
  const { theme } = useTheme()
  const ext = useExtensionUI()
  const toolName = () => props.toolCall.toolName.toLowerCase()
  const hasRenderer = () => ext.renderers().has(toolName())
  const Renderer = () => ext.renderers().get(toolName())

  const childSessions = () => props.getChildSessions?.(props.toolCall.id)

  return (
    <Show
      when={hasRenderer()}
      fallback={
        <Show
          when={props.expanded}
          fallback={
            <Show when={props.toolCall.status === "error"}>
              <text>
                <span style={{ fg: theme.error }}>
                  [x {props.toolCall.toolName}] #{formatToolCallIdentity(props.toolCall.id)}{" "}
                  {props.toolCall.summary ?? "failed"}
                </span>
              </text>
            </Show>
          }
        >
          <ToolCallIdentityProvider id={props.toolCall.id}>
            <GenericToolRenderer toolCall={props.toolCall} expanded />
          </ToolCallIdentityProvider>
        </Show>
      }
    >
      {(() => {
        const R = Option.fromNullishOr(Renderer())
        if (Option.isNone(R)) return <></>
        const RendererComponent = R.value
        return (
          <ToolCallIdentityProvider id={props.toolCall.id}>
            <RendererComponent
              toolCall={props.toolCall}
              expanded={props.expanded}
              childSessions={childSessions()}
            />
          </ToolCallIdentityProvider>
        )
      })()}
    </Show>
  )
}

interface MessageListProps {
  items: SessionItem[]
  toolsExpanded: boolean
  fullDetail?: boolean
  syntaxStyle: () => SyntaxStyle
  streaming: boolean
  getChildSessions?: (toolCallId: string) => ChildSessionEntry[]
}

export function MessageList(props: MessageListProps) {
  const dimensions = useTerminalDimensions()
  const visibleItems = createMemo(() =>
    props.items.filter((item) => !isMessageItem(item) || item.metadata?.hidden !== true),
  )

  return (
    <box flexDirection="column">
      <For each={visibleItems()}>
        {(item, index) =>
          (() => {
            if (!isMessageItem(item)) {
              return <SessionEventIndicator event={item} />
            }
            return (
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
                    fullDetail={props.fullDetail === true}
                    syntaxStyle={props.syntaxStyle}
                    streaming={props.streaming && index() === props.items.length - 1}
                    dimensions={dimensions}
                    getChildSessions={props.getChildSessions}
                  />
                }
              >
                <UserMessage
                  content={item.content}
                  images={item.images}
                  interjection={item._tag === "interjection-message"}
                  pendingMode={item.pendingMode}
                />
              </Show>
            )
          })()
        }
      </For>
    </box>
  )
}
