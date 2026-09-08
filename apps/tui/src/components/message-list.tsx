import { createMemo, createSignal, For, Show, type Accessor } from "solid-js"
import { Match, Option, Predicate, Schema } from "effect"
import type { SyntaxStyle } from "@opentui/core"
import { useTerminalDimensions } from "../terminal-dimensions"
import { useTheme } from "../theme/index"
import type { ToolCall } from "./tool-renderers/index"
import { formatToolCallIdentity, ToolCallIdentityProvider, ToolFrameBody } from "./tool-frame"
import { GenericToolRenderer } from "./tool-renderers/generic"
import { useExtensionUI } from "../extensions/context"
import { SessionEventIndicator } from "./session-event-indicator"
import type { SessionEvent } from "./session-event-label"
import type { ImageInfo } from "../client"
import type { ChildSessionEntry } from "../hooks/use-child-sessions"
import { replaceMermaidBlocks } from "../utils/mermaid"
import { decodeToolOutputOption, getString } from "../utils/parse-tool-output"
import { toolArgSummary } from "../utils/format-tool"
import {
  type ActivityCall,
  type ActivityOperation,
  formatActivityHeader,
  formatCellRowLabel,
  formatCompactionLabel,
  formatPreviewFooter,
  formatRowCounts,
  previewOutput,
} from "./message-list-utils"
import { formatGenericToolText } from "./tool-renderers/generic-format"
import type { DisclosureLevel } from "../routes/session-ui-state"
export type { ToolCall }
export type { DisclosureLevel }

const CellOperationReceipts = Schema.Struct({
  operations: Schema.optional(
    Schema.Array(
      Schema.Struct({
        tool: Schema.String,
        outcome: Schema.Literals(["succeeded", "failed", "incomplete"]),
      }),
    ),
  ),
})

const CellFailure = Schema.Struct({
  display: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
})

const BashOutput = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.optional(Schema.String),
})

const CompactionDetails = Schema.Struct({
  sourceMessageIds: Schema.Array(Schema.String),
})

const COMPACTION_MESSAGE_TYPE = "model-compaction"
const PREVIEW_LINES = 20

const liveOutcome = (status: ToolCall["status"]): ActivityOperation["outcome"] => {
  if (status === "completed") return "succeeded"
  if (status === "error") return "failed"
  return "running"
}

/** Calls a cell admitted: live nested calls carry arguments; saved receipts carry tool and outcome. */
const cellOperations = (call: ToolCall): ReadonlyArray<ActivityOperation> => {
  const live = Option.fromNullishOr(call.operations)
  if (Option.isSome(live) && live.value.length > 0) {
    return live.value.map((operation) => ({
      tool: operation.toolName,
      outcome: liveOutcome(operation.status),
      detail: toolArgSummary(operation.toolName, operation.input),
    }))
  }
  return Option.match(decodeToolOutputOption(CellOperationReceipts, call.output), {
    onNone: () => [],
    onSome: (value) =>
      (value.operations ?? []).map((operation) => ({
        tool: operation.tool,
        outcome: operation.outcome,
        detail: "",
      })),
  })
}

const toActivityCall = (call: ToolCall): ActivityCall => ({
  toolName: call.toolName,
  status: call.status,
  operations: cellOperations(call),
})

const cellResultText = (call: ToolCall) =>
  Option.match(decodeToolOutputOption(CellFailure, call.output), {
    onNone: () => ({ display: "", error: "" }),
    onSome: (value) => ({
      display: value.display ?? "",
      error: value.message ?? value.error ?? "",
    }),
  })

/** What a row would show beneath itself: the cell display, the command output, or the raw result. */
const rowOutputText = (call: ToolCall): string => {
  if (call.toolName === "cell") {
    const result = cellResultText(call)
    if (result.error.length > 0) return result.error
    return result.display
  }
  if (call.toolName === "bash") {
    return Option.match(decodeToolOutputOption(BashOutput, call.output), {
      onNone: () => formatGenericToolText(call.output) ?? "",
      onSome: (value) => [value.stdout, value.stderr ?? ""].filter((t) => t.length > 0).join("\n"),
    })
  }
  return formatGenericToolText(call.output) ?? ""
}

const rowCounts = (call: ToolCall): string => {
  if (call.status === "running") return ""
  return formatRowCounts(call.toolName, {
    input: getString(call.input, "code"),
    output: rowOutputText(call),
  })
}

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

/** Harness-authored user messages collapse to one line unless full detail is on. */
const collapsedUserLabel = (customType: string): Option.Option<string> => {
  if (customType === "goal-context") return Option.some("↻ goal continuation")
  if (customType === "context-window") return Option.some("⇣ new context window")
  return Option.none()
}

function UserMessage(props: {
  content: string
  images: ImageInfo[]
  interjection: boolean
  pendingMode?: "queued" | "steer"
  customType?: string
  fullDetail: boolean
}) {
  const { theme } = useTheme()
  const collapsedLabel = () =>
    Option.fromUndefinedOr(props.customType).pipe(
      Option.flatMap(collapsedUserLabel),
      Option.filter(() => !props.fullDetail),
    )
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
      <Show
        when={Option.getOrUndefined(collapsedLabel())}
        fallback={
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
        }
      >
        {(label) => (
          <box marginTop={1} flexDirection="row">
            <text width={1} flexShrink={0} style={{ fg: theme.textMuted }}>
              ┃
            </text>
            <text paddingLeft={1} style={{ fg: theme.textMuted }}>
              {label()}
            </text>
          </box>
        )}
      </Show>
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
  disclosure: DisclosureLevel
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
            disclosure={props.disclosure}
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
                    disclosure={props.disclosure}
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
  disclosure: DisclosureLevel
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
            disclosure={props.disclosure}
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
  disclosure: DisclosureLevel
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
  const header = createMemo(() => formatActivityHeader(props.calls.map(toActivityCall)))
  // The transcript view and the full level both open every row; collapsed keeps only failures.
  const rowsOpen = () => props.fullDetail || props.disclosure === "full"
  const visibleCalls = () => {
    if (rowsOpen() || props.disclosure === "preview") return props.calls
    return props.calls.filter((call) => call.status === "error")
  }
  // Preview shows the head of the last finished call's output beneath the rows.
  const preview = createMemo(() => {
    if (props.fullDetail || props.disclosure !== "preview") return previewOutput("")
    return Option.fromNullishOr(props.calls.at(-1)).pipe(
      Option.filter((last) => last.status === "completed"),
      Option.map((last) => previewOutput(rowOutputText(last), PREVIEW_LINES)),
      Option.getOrElse(() => previewOutput("")),
    )
  })
  return (
    <Show when={props.calls.length > 0}>
      <box flexDirection="column">
        <Show when={!props.fullDetail}>
          <text style={{ fg: groupColor() }}>
            {symbol()} {header()}
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
              // A cell row names what the cell did; other tools show their leading argument.
              const label = () => {
                if (call.toolName === "cell") {
                  const result = cellResultText(call)
                  return formatCellRowLabel(toActivityCall(call), {
                    code: getString(call.input, "code"),
                    display: result.display,
                    error: result.error,
                  })
                }
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
              const counts = () => {
                const text = rowCounts(call)
                if (text.length === 0) return ""
                return ` · ${text}`
              }
              return (
                <Show
                  when={call.status === "error"}
                  fallback={
                    <box flexDirection="column">
                      <box flexDirection="row">
                        <text flexGrow={1} flexShrink={1} style={{ fg: color() }}>
                          {connector()} {call.toolName} {label()}
                          {counts()}
                          {status()}
                        </text>
                        <text flexShrink={0} wrapMode="none" style={{ fg: theme.textMuted }}>
                          {" "}
                          #{formatToolCallIdentity(call.id)}
                        </text>
                      </box>
                      <Show when={rowsOpen()}>
                        <ToolFrameBody>
                          <SingleToolCall
                            toolCall={call}
                            expanded={true}
                            getChildSessions={props.getChildSessions}
                          />
                        </ToolFrameBody>
                      </Show>
                    </box>
                  }
                >
                  <SingleToolCall
                    toolCall={call}
                    expanded={rowsOpen()}
                    getChildSessions={props.getChildSessions}
                  />
                </Show>
              )
            }}
          </For>
        </Show>
        <Show when={preview().lines.length > 0}>
          <box flexDirection="column" paddingLeft={2}>
            <For each={preview().lines}>
              {(line) => <text style={{ fg: theme.textMuted }}>{line}</text>}
            </For>
            <Show when={preview().hidden > 0}>
              <text>
                <span style={{ fg: theme.textMuted, dim: true }}>
                  {formatPreviewFooter(preview().hidden)}
                </span>
              </text>
            </Show>
          </box>
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

/** A compaction record folds to one line until the full level or the transcript view opens. */
function CompactionCard(props: { content: string; details: unknown; open: boolean }) {
  const { theme } = useTheme()
  const sourceCount = () =>
    Schema.decodeUnknownOption(CompactionDetails)(props.details).pipe(
      Option.map((value) => value.sourceMessageIds.length),
      Option.getOrElse(() => 0),
    )
  return (
    <box marginTop={1} paddingLeft={2} flexDirection="column">
      <text style={{ fg: theme.textMuted }}>
        {formatCompactionLabel(sourceCount(), props.content.length)}
      </text>
      <Show when={props.open}>
        <text>
          <span style={{ fg: theme.textMuted, dim: true }}>{props.content}</span>
        </text>
      </Show>
    </box>
  )
}

interface MessageListProps {
  items: SessionItem[]
  disclosure: DisclosureLevel
  fullDetail?: boolean
  syntaxStyle: () => SyntaxStyle
  streaming: boolean
  getChildSessions?: (toolCallId: string) => ChildSessionEntry[]
}

export function MessageList(props: MessageListProps) {
  const dimensions = useTerminalDimensions()

  return (
    <box flexDirection="column">
      <For each={props.items}>
        {(item, index) =>
          (() => {
            if (!isMessageItem(item)) {
              return <SessionEventIndicator event={item} />
            }
            if (item.metadata?.customType === COMPACTION_MESSAGE_TYPE) {
              return (
                <CompactionCard
                  content={item.content}
                  details={item.metadata.details}
                  open={props.fullDetail === true || props.disclosure === "full"}
                />
              )
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
                    disclosure={props.disclosure}
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
                  customType={item.metadata?.customType}
                  fullDetail={props.fullDetail === true}
                />
              </Show>
            )
          })()
        }
      </For>
    </box>
  )
}
