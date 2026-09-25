import {
  type ActivityCall,
  decodeToolOutputOption,
  formatActivityHeader,
  formatCellRowLabel,
  formatDuration,
  formatGenericToolText,
  formatPreviewFooter,
  formatRowCounts,
  getString,
  parseBashOutput,
  plural,
  previewOutput,
  truncate,
  workingIconFrame,
} from "./utils"
import { DateTime, Effect, Fiber, Match, Option, Predicate, Schema } from "effect"
import { resolveThemeColor, useTheme } from "./theme"
import {
  CollapsedRow,
  formatToolCallIdentity,
  ToolCallIdentityProvider,
  ToolFrameBody,
  UserRow,
  useSpinnerClock,
} from "./ui"
import {
  type Accessor,
  batch,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  For,
  getOwner,
  type JSX,
  onCleanup,
  onMount,
  runWithOwner,
  Show,
  untrack,
} from "solid-js"
import type { ScrollBoxRenderable, ScrollbackSurface, SyntaxStyle } from "@opentui/core"
import { useScopedKeyboard, useTerminalDimensions } from "./terminal"
import {
  bashOutputRows,
  cellOperations,
  GenericToolRenderer,
  RegisteredToolCall,
  type ToolCall,
} from "./tool-renderers"
import { useExtensionUI } from "./extensions/host"
import type { MessageRenderer, MessageRowProps, StatusLabelColor } from "./extensions/client-facets"
import {
  CONTEXT_WINDOW_MESSAGE_TYPE,
  type ImagePartProjection,
  lineCount,
  MODEL_CHANGE_MESSAGE_TYPE,
} from "@gent/core/protocol"
import { replaceMermaidBlocks } from "./mermaid"
import type { DisclosureLevel } from "./session"
import { insert, RendererContext, useRenderer } from "@opentui/solid"

// ── reasoning text ──────────────────────────────────────────────────────────

/**
 * Reasoning summaries, prepared for the markdown renderer.
 *
 * A model emits reasoning as a run of summaries, and each one is its own bold
 * markdown heading. `messagePartsReasoning` joins the parts with an empty
 * string, so the headings collide and the pane showed one unreadable line:
 *
 *     **Verifying final test output****Refactoring LedgerStore.list…**
 *
 * The literal asterisks were there because reasoning rendered as plain text
 * rather than through the markdown element the reply uses.
 *
 * Splitting the run back into summaries and joining them with a blank line
 * gives markdown the paragraph break it needs, so each summary renders as its
 * own line with the emphasis applied rather than printed.
 */

/** A bold span that ends where the next one begins, with no separator between. */
const collidingSummaries = /\*\*(?=\*\*)/g

export const reasoningMarkdown = (reasoning: string): string => {
  if (reasoning.length === 0) return ""
  return reasoning
    .replace(collidingSummaries, "**\n\n")
    .split("\n\n")
    .map((summary) => summary.trim())
    .filter((summary) => summary.length > 0)
    .join("\n\n")
}

// ── session event labels ────────────────────────────────────────────────────

/** What the model steps of one turn added up to, from each `StreamEnded.outcome`. */
type TurnSteps = {
  readonly count: number
  readonly toolCalls: number
  readonly costUsd: number
}

export const emptyTurnSteps: TurnSteps = { count: 0, toolCalls: 0, costUsd: 0 }

export const addStep = (
  steps: TurnSteps,
  step: { readonly outcome?: string; readonly costUsd?: number },
): TurnSteps => ({
  count: steps.count + 1,
  toolCalls: steps.toolCalls + Number(step.outcome === "ToolCalls"),
  costUsd: steps.costUsd + (step.costUsd ?? 0),
})

export type SessionEvent =
  | {
      _tag: "turn-ended"
      durationSeconds: number
      steps: TurnSteps
      createdAt: number
      seq: number
    }
  | {
      _tag: "interruption"
      createdAt: number
      seq: number
    }
  | {
      _tag: "error"
      error: string
      createdAt: number
      seq: number
    }
  | {
      /**
       * A muted row the turn goes on past: an error such as a compaction
       * fallback, or a row a client extension derives (`noticeRowContribution`).
       */
      _tag: "notice"
      /** Unique among the notice rows; the transcript keys the row on it. */
      key: string
      /** One glyph, drawn in `color`; the text after it is muted. */
      glyph: string
      color: StatusLabelColor
      text: string
      createdAt: number
      seq: number
    }
  | {
      _tag: "retrying"
      attempt: number
      maxAttempts: number
      delayMs: number
      resolved: boolean
      createdAt: number
      seq: number
    }

const currentMillis = () => DateTime.toEpochMillis(DateTime.nowUnsafe())

/** "3 steps · 2 tool calls · $0.012"; a turn with no recorded steps says nothing extra. */
const stepSummary = (steps: TurnSteps): ReadonlyArray<string> => {
  if (steps.count === 0) return []
  const parts = [plural(steps.count, "step")]
  if (steps.toolCalls > 0) parts.push(plural(steps.toolCalls, "tool call"))
  if (steps.costUsd > 0) parts.push(`$${steps.costUsd.toFixed(3)}`)
  return parts
}

export const getSessionEventLabel = (event: SessionEvent, now = currentMillis()): string => {
  if (event._tag === "turn-ended") {
    return [
      `Worked for ${formatDuration(event.durationSeconds * 1000, "compact")}`,
      ...stepSummary(event.steps),
    ].join(" · ")
  }
  if (event._tag === "interruption") return "Interrupted - what do you want to do instead?"
  if (event._tag === "error") return event.error
  if (event._tag === "notice") return event.text
  if (event.resolved) return `Retry ${event.attempt}/${event.maxAttempts} finished`

  const retryAt = event.createdAt + event.delayMs
  const remainingMs = Math.max(0, retryAt - now)
  const seconds = Math.ceil(remainingMs / 1000)
  if (seconds <= 0) {
    return `Retrying now... ${event.attempt}/${event.maxAttempts}`
  }
  return `Retrying in ${seconds}s... ${event.attempt}/${event.maxAttempts}`
}

// ── session event indicator ─────────────────────────────────────────────────

interface SessionEventIndicatorProps {
  event: SessionEvent
}

function SessionEventIndicator(props: SessionEventIndicatorProps) {
  const { theme } = useTheme()
  const tick = useSpinnerClock()

  const content = () => {
    tick()
    return getSessionEventLabel(props.event, currentMillis())
  }

  const color = () => {
    switch (props.event._tag) {
      case "error":
        return theme.error
      case "retrying":
        return theme.warning
      case "interruption":
        return theme.warning
      default:
        return theme.textMuted
    }
  }

  const event = props.event
  if (event._tag === "notice") {
    return (
      <box marginTop={1}>
        <text>
          <span style={{ fg: resolveThemeColor(theme, event.color) }}>{`${event.glyph} `}</span>
          <span style={{ fg: theme.textMuted }}>{event.text}</span>
        </text>
      </box>
    )
  }

  return (
    <box marginTop={1}>
      <text style={{ fg: color() }}>● {content()}</text>
    </box>
  )
}

// ── message list ────────────────────────────────────────────────────────────

export type { ToolCall }
export type { DisclosureLevel }

const CellFailure = Schema.Struct({
  display: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
})

/** The part of a window marker's details the transcript shows: how much history a handoff replaced. */
const HandoffDetails = Schema.Struct({
  summarized: Schema.optional(Schema.Struct({ count: Schema.Natural })),
})
type HandoffDetails = typeof HandoffDetails.Type
const decodeHandoffDetails = Schema.decodeUnknownOption(HandoffDetails)

const PREVIEW_LINES = 20

const toActivityCall = (call: ToolCall): ActivityCall => ({
  toolName: call.toolName,
  status: call.status,
  operations: cellOperations(call),
  code: getString(call.input, "code"),
  durationMs: call.durationMs,
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
    return Option.match(parseBashOutput(call.output), {
      onNone: () => formatGenericToolText(call.output) ?? "",
      // Each stream's final newline ends its last line, so the joined text
      // holds as many lines as the two streams do.
      onSome: (value) =>
        [value.stdout, value.stderr]
          .filter((text) => text.length > 0)
          .map((text) => text.replace(/\n$/, ""))
          .join("\n"),
    })
  }
  return formatGenericToolText(call.output) ?? ""
}

/**
 * Lines a row counts beneath itself. A bash row counts as its body does, so a
 * cut stream counts the whole output its record names, not the kept excerpt.
 */
const rowOutputLines = (call: ToolCall): number => {
  if (call.toolName === "bash" && Option.isSome(parseBashOutput(call.output))) {
    return bashOutputRows(call).total
  }
  return lineCount(rowOutputText(call))
}

/** A declined command (stored by an earlier version) never ran and a background one has not ended: neither has lines to count. */
const hasNoOutputYet = (call: ToolCall): boolean =>
  call.toolName === "bash" &&
  Option.exists(parseBashOutput(call.output), (value) => Option.isSome(value.status))

const rowCounts = (call: ToolCall): string => {
  if (call.status === "running" || hasNoOutputYet(call)) return ""
  return formatRowCounts(call.toolName, {
    inputLines: lineCount(getString(call.input, "code")),
    outputLines: rowOutputLines(call),
  })
}

interface MessageMetadataInfo {
  customType?: string
  hidden?: boolean
  details?: unknown
  /** The server stamps it on every message a client sent: the reader typed it. */
  fromClient?: boolean
  /** The extension that sent the message (`Session.send`). */
  extensionId?: string
}

export type AssistantSegment =
  | { _tag: "text"; content: string }
  | { _tag: "reasoning"; content: string }
  | { _tag: "tool-call"; toolCall: ToolCall }
  | { _tag: "image"; image: ImagePartProjection }

interface MessageBase {
  id: string
  role: "user" | "assistant" | "system" | "tool"
  pendingMode?: "queued" | "steer"
  /** Concatenated text content (derived — used by picker, mermaid, search) */
  content: string
  /** Concatenated reasoning (derived) */
  reasoning: string
  images: ReadonlyArray<ImagePartProjection>
  createdAt: number
  // eslint-disable-next-line effect/noNullish -- snapshot messages preserve absent tool-call data.
  toolCalls: ToolCall[] | undefined
  /** Ordered parts for interleaved rendering */
  segments?: AssistantSegment[]
  metadata?: MessageMetadataInfo
}

interface RegularMessage extends MessageBase {
  _tag: "regular-message"
}

interface InterjectionMessage extends MessageBase {
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

/** The runtime's own user-role messages collapse to one line; an extension draws its own kinds. */
const runtimeRows = new Map<string, MessageRenderer>([
  [
    CONTEXT_WINDOW_MESSAGE_TYPE,
    (props) => <CollapsedRow label={windowLabel(decodeHandoffDetails(props.details))} />,
  ],
  [MODEL_CHANGE_MESSAGE_TYPE, () => <CollapsedRow label="⇄ model changed" />],
])

/** A handoff names what it summarized; a bare window says only that history left the view. */
const windowLabel = (handoff: Option.Option<HandoffDetails>): string =>
  handoff.pipe(
    Option.flatMap((value) => Option.fromUndefinedOr(value.summarized)),
    Option.match({
      onNone: () => "⇣ new context window",
      onSome: (summarized) =>
        `⇣ context handoff · ${plural(summarized.count, "message")} summarized`,
    }),
  )

function UserMessage(props: MessageRowProps & { customType?: string; fullDetail: boolean }) {
  const ext = useExtensionUI()
  /** An extension's renderer first, then the runtime's; full detail draws every message plain. */
  const renderer = () =>
    Option.fromUndefinedOr(props.customType).pipe(
      Option.filter(() => !props.fullDetail),
      Option.flatMap((customType) =>
        Option.orElse(
          Option.map(
            Option.fromUndefinedOr(ext.messageRenderers().get(customType)),
            (entry) => entry.component,
          ),
          () => Option.fromUndefinedOr(runtimeRows.get(customType)),
        ),
      ),
    )
  const hasContent = () => props.content.length > 0 || props.images.length > 0

  return (
    <Show when={hasContent()}>
      <Show when={Option.getOrUndefined(renderer())} keyed fallback={<UserRow {...props} />}>
        {(Row) => <Row {...props} />}
      </Show>
    </Show>
  )
}

function AssistantMessage(props: {
  content: string
  reasoning: string
  images: ReadonlyArray<ImagePartProjection>
  // eslint-disable-next-line effect/noNullish -- snapshot messages preserve absent tool-call data.
  toolCalls: ToolCall[] | undefined
  segments?: AssistantSegment[]
  disclosure: DisclosureLevel
  fullDetail: boolean
  syntaxStyle: () => SyntaxStyle
  streaming: boolean
  dimensions: Accessor<TerminalDimensions>
}) {
  const { theme } = useTheme()

  const hasContent = () => {
    if (props.content.length > 0) return true
    if (props.reasoning.length > 0) return true
    if (props.images.length > 0) return true
    return (props.toolCalls ?? []).length > 0
  }

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
      {/* The feed writes a segment for every assistant part, so an answer with
          no segments has no text, no reasoning, no image and no tool call to
          draw either. */}
      <Show when={segments().length > 0}>
        <For each={groupedSegments()}>
          {({ segment, calls }) =>
            Match.value(segment).pipe(
              Match.tagsExhaustive({
                reasoning: (segment) => (
                  <box flexDirection="column" marginBottom={1}>
                    <markdown
                      syntaxStyle={props.syntaxStyle()}
                      streaming
                      content={reasoningMarkdown(segment.content)}
                      fg={theme.textMuted}
                      conceal
                    />
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

function ToolCallGroup(props: {
  calls: ToolCall[]
  disclosure: DisclosureLevel
  fullDetail: boolean
}) {
  const { theme } = useTheme()
  const failed = () => props.calls.some((call) => call.status === "error")
  const running = () => props.calls.some((call) => call.status === "running")
  const tick = useSpinnerClock()
  const symbol = () => {
    if (failed()) return "✗"
    if (running()) return workingIconFrame(tick())
    return "✓"
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
                if (Predicate.isNotUndefined(call.durationMs))
                  return ` · ${formatDuration(call.durationMs, "precise")}`
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
                          <SingleToolCall toolCall={call} expanded={true} />
                        </ToolFrameBody>
                      </Show>
                    </box>
                  }
                >
                  <SingleToolCall toolCall={call} expanded={rowsOpen()} />
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

function SingleToolCall(props: { toolCall: ToolCall; expanded: boolean }) {
  const { theme } = useTheme()
  return (
    <RegisteredToolCall
      toolCall={props.toolCall}
      expanded={props.expanded}
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
    />
  )
}

interface MessageListProps {
  items: SessionItem[]
  disclosure: DisclosureLevel
  fullDetail?: boolean
  syntaxStyle: () => SyntaxStyle
  streaming: boolean
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
                  />
                }
              >
                <UserMessage
                  content={item.content}
                  images={item.images}
                  interjection={item._tag === "interjection-message"}
                  pendingMode={item.pendingMode}
                  customType={item.metadata?.customType}
                  details={item.metadata?.details}
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

// ── transcript fingerprint ──────────────────────────────────────────────────

/**
 * What a transcript item looks like on screen, as a value that does not depend
 * on how the item was built.
 *
 * Two readers compare transcript items for identity: native history decides
 * what already reached scrollback, and the display boundary decides what a
 * `/clear` already dismissed. Both used a JSON encode of the whole item, which
 * carries key order — and the feed built one message two ways, so the same
 * message encoded to two different strings. Native history replayed and
 * cleared the terminal's saved lines; the boundary would report an unchanged
 * tool call as changed.
 *
 * Naming the drawn fields in a fixed order answers both. A rebuild is silent;
 * new text, a completed tool call, and a changed event still change the value.
 *
 * @module
 */

const encodeFingerprint = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** The tool-call fields that change what a reader sees, nested calls included. */
const toolFingerprint = (call: ToolCall): ReadonlyArray<unknown> => [
  call.id,
  call.toolName,
  call.status,
  call.summary,
  call.output,
  call.durationMs,
  (call.operations ?? []).map(toolFingerprint),
]

/** One answer piece, by what it draws rather than by its encoding. */
const segmentFingerprint = (segment: AssistantSegment): ReadonlyArray<unknown> => {
  if (segment._tag === "tool-call") return [segment._tag, toolFingerprint(segment.toolCall)]
  if (segment._tag === "image") return [segment._tag, segment.image.mediaType]
  return [segment._tag, segment.content]
}

/** A tool call as one comparable string. */
const toolIdentity = (call: ToolCall): string => encodeFingerprint(toolFingerprint(call))

/** A segment as one comparable string. */
const segmentIdentity = (segment: AssistantSegment): string =>
  encodeFingerprint(segmentFingerprint(segment))

/** A whole transcript item as one comparable string. */
export const transcriptFingerprint = (item: SessionItem): string => {
  if (isMessageItem(item))
    return encodeFingerprint([
      item._tag,
      item.id,
      item.role,
      item.content,
      item.reasoning,
      item.images.length,
      item.createdAt,
      item.pendingMode,
      (item.toolCalls ?? []).map(toolFingerprint),
      (item.segments ?? []).map(segmentFingerprint),
      item.metadata?.customType,
      item.metadata?.hidden,
    ])
  if (item._tag === "turn-ended")
    return encodeFingerprint([
      item._tag,
      item.createdAt,
      item.seq,
      item.durationSeconds,
      item.steps.count,
      item.steps.toolCalls,
      item.steps.costUsd,
    ])
  if (item._tag === "error")
    return encodeFingerprint([item._tag, item.createdAt, item.seq, item.error])
  if (item._tag === "notice")
    return encodeFingerprint([item._tag, item.key, item.createdAt, item.glyph, item.text])
  if (item._tag === "retrying")
    return encodeFingerprint([
      item._tag,
      item.createdAt,
      item.seq,
      item.attempt,
      item.maxAttempts,
      item.delayMs,
      item.resolved,
    ])
  return encodeFingerprint([item._tag, item.createdAt, item.seq])
}

// ── transcript display ──────────────────────────────────────────────────────

const isMessage = Predicate.or(
  Predicate.isTagged("regular-message"),
  Predicate.isTagged("interjection-message"),
)
const isTextSegment = Predicate.or(Predicate.isTagged("text"), Predicate.isTagged("reasoning"))

interface MessageBoundary {
  readonly content: string
  readonly reasoning: string
  readonly imageCount: number
  readonly segments: readonly string[]
  readonly tools: ReadonlyMap<string, string>
}

interface TranscriptDisplayBoundary {
  readonly items: ReadonlySet<string>
  readonly messages: ReadonlyMap<string, MessageBoundary>
}

const itemKey = (item: SessionItem): string => {
  if (isMessage(item)) return item.id
  if (item._tag === "notice") return `notice:${item.key}`
  return `${item._tag}:${item.createdAt}:${item.seq}`
}

const segmentContent = (segment: AssistantSegment): string => {
  if (isTextSegment(segment)) return segment.content
  return segmentIdentity(segment)
}

function captureTranscriptDisplay(items: SessionItem[]): TranscriptDisplayBoundary {
  const messages = new Map<string, MessageBoundary>()
  for (const item of items) {
    if (!isMessage(item)) continue
    messages.set(item.id, {
      content: item.content,
      reasoning: item.reasoning,
      imageCount: item.images.length,
      segments: (item.segments ?? []).map(segmentContent),
      tools: new Map((item.toolCalls ?? []).map((tool) => [tool.id, toolIdentity(tool)])),
    })
  }
  return { items: new Set(items.map(itemKey)), messages }
}

const afterPrefix = (content: string, prefix: string): string => {
  if (content.startsWith(prefix)) return content.slice(prefix.length)
  return content
}

function projectMessage(message: Message, boundary: MessageBoundary): Message {
  const segments: AssistantSegment[] = []
  for (const [index, segment] of (message.segments ?? []).entries()) {
    const previous = boundary.segments[index] ?? ""
    if (isTextSegment(segment)) {
      const content = afterPrefix(segment.content, previous)
      if (content.length > 0) segments.push({ ...segment, content })
    } else if (segmentContent(segment) !== previous) {
      segments.push(segment)
    }
  }
  const toolCalls = Option.map(Option.fromNullishOr(message.toolCalls), (tools) =>
    tools.filter((tool) => boundary.tools.get(tool.id) !== toolIdentity(tool)),
  )
  return {
    ...message,
    content: afterPrefix(message.content, boundary.content),
    reasoning: afterPrefix(message.reasoning, boundary.reasoning),
    images: message.images.slice(boundary.imageCount),
    segments: Option.getOrUndefined(
      Option.map(Option.fromNullishOr(message.segments), () => segments),
    ),
    toolCalls: Option.getOrUndefined(toolCalls),
  }
}

function projectTranscriptDisplay(
  items: SessionItem[],
  boundary: TranscriptDisplayBoundary,
): SessionItem[] {
  const visible: SessionItem[] = []
  for (const item of items) {
    if (!boundary.items.has(itemKey(item))) {
      visible.push(item)
      continue
    }
    if (!isMessage(item)) continue
    const cleared = Option.fromNullishOr(boundary.messages.get(item.id))
    if (Option.isSome(cleared)) visible.push(projectMessage(item, cleared.value))
  }
  return visible
}

// ── split footer height ─────────────────────────────────────────────────────

/**
 * How tall the split footer may grow.
 *
 * Scrollback is written by letting committed rows scroll off the top of the
 * output region above the footer. OpenTUI derives that region from the footer:
 * `calculateRenderGeometry` gives it `terminalHeight - effectiveFooterHeight`
 * rows and `getSplitPinnedRenderOffset` pins the commit origin to the same
 * value. The native commit then sets a scroll region of `ESC[1;<rows>r`.
 *
 * Two footer heights break that region:
 *
 *  - A footer as tall as the terminal leaves zero output rows. The commit
 *    writes at screen row 1, the footer repaint covers those rows in the same
 *    synchronized frame, and nothing scrolls off at all.
 *  - A footer one row short leaves a single output row, so the region is
 *    `ESC[1;1r`. A one-row region has no line to scroll away from; the
 *    terminal discards the row instead of keeping it.
 *
 * Reserving two rows is the smallest region a terminal will actually scroll,
 * and it is what keeps history growing. Measured on a 40-row terminal
 * resuming a 23-step session: zero reserved rows and one reserved row both
 * give 0 history rows, two give 235.
 */
export const SPLIT_FOOTER_RESERVED_OUTPUT_ROWS = 2

export const splitFooterHeight = (terminalHeight: number, requestedHeight: number): number => {
  const maximum = Math.max(1, terminalHeight - SPLIT_FOOTER_RESERVED_OUTPUT_ROWS)
  return Math.min(maximum, Math.max(1, requestedHeight))
}

// ── sticky last prompt ──────────────────────────────────────────────────────

/**
 * The text of a prompt the reader posted, or `None` when `item` is not one.
 * The one place that decides whose message it is, from its metadata:
 *
 * - The reader's own: a user message the server stamped as a client's
 *   (`fromClient`), typed or a steer that joined the running turn.
 * - A custom type whose message renderer names it a prompt (`promptOf`), in
 *   the text the reader asked: a `/btw` fork's question.
 * - Nothing else: a message another agent or an extension sent (a parent's
 *   `Session.send`, a wake, a delegate start) carries no client origin, and a
 *   row stored before the origin existed carries none either.
 *
 * A queued follow-up has not run yet, and a hidden message is not drawn.
 */
export const readerPrompt = (
  item: SessionItem,
  promptOf: (customType: string) => Option.Option<(content: string) => string>,
): Option.Option<string> => {
  if (!isMessageItem(item) || item.role !== "user") return Option.none()
  if (Predicate.isNotUndefined(item.pendingMode) || item.metadata?.hidden === true)
    return Option.none()
  if (item.metadata?.fromClient === true) return Option.some(item.content)
  return Option.fromUndefinedOr(item.metadata?.customType).pipe(
    Option.flatMap(promptOf),
    Option.map((text) => text(item.content)),
  )
}

/** `UserRow` opens with a one-row top margin; the prompt's text starts under it. */
const PROMPT_TEXT_ROW = 1

/** Where the transcript stands, in rows, as `promptOnScreen` reads it. */
interface PromptGeometry {
  /** A displayed item's measured height, by its display index. */
  readonly heightAt: (index: number) => Option.Option<number>
  /** The prompt's item. */
  readonly index: number
  /** How many leading items native history holds. */
  readonly committed: number
  /** The live content's rows, widgets included. */
  readonly liveHeight: number
  /** The rows the live tail may take before the pinned row takes one. */
  readonly liveRows: number
  /** The rows of native history the terminal shows above the app, the pinned row drawn. */
  readonly scrollbackRows: number
}

/**
 * Whether the prompt's first text row is on screen, reckoned as if the pinned
 * row were drawn. Reckoning one way only keeps the answer stable: drawing the
 * row cannot move the prompt back into view and hide it again.
 *
 * A live prompt is on screen while its row is at or below the viewport's top:
 * the viewport sticks to the bottom, so a live tail taller than it cuts rows
 * off the top. A committed prompt is on screen while it and the history rows
 * after it fit in the rows the terminal shows above the app. An unmeasured
 * height met before the answer is known counts as on screen, so nothing is
 * pinned on a guess.
 *
 * The sums stop once they pass what decides the answer, so the work is
 * bounded by the rows on screen, never by how much history lies beyond them.
 */
export const promptOnScreen = (geometry: PromptGeometry): boolean => {
  /** Rows of items `from` up to `to`, or `past` itself once they exceed it. */
  const rowsUpTo = (from: number, to: number, past: number): Option.Option<number> => {
    let total = 0
    for (let index = from; index < to && total <= past; index++) {
      const height = geometry.heightAt(index)
      if (Option.isNone(height)) return Option.none()
      total += height.value
    }
    return Option.some(total)
  }
  if (geometry.index < geometry.committed) {
    const past = geometry.scrollbackRows + PROMPT_TEXT_ROW
    return Option.match(rowsUpTo(geometry.index, geometry.committed, past), {
      onNone: () => true,
      onSome: (rows) => rows <= past,
    })
  }
  const viewport = Math.min(Math.max(1, geometry.liveHeight), geometry.liveRows - 1)
  const scrollTop = Math.max(0, geometry.liveHeight - viewport)
  const past = scrollTop - PROMPT_TEXT_ROW
  return Option.match(rowsUpTo(geometry.committed, geometry.index, past), {
    onNone: () => true,
    onSome: (above) => above >= past,
  })
}

/** The pinned prompt: `↑ <first line>`, cut to the width with an ellipsis. */
function StickyPrompt(props: { readonly text: string; readonly width: number }) {
  const { theme } = useTheme()
  const line = () =>
    Option.fromUndefinedOr(
      props.text
        .split("\n")
        .map((text) => text.trim())
        .find((text) => text.length > 0),
    ).pipe(Option.getOrElse(() => ""))
  return (
    <box height={1} flexShrink={0} paddingLeft={1}>
      <text wrapMode="none" style={{ fg: theme.textMuted }}>
        {truncate(`↑ ${line()}`, Math.max(1, props.width - 2))}
      </text>
    </box>
  )
}

// ── native scrollback transcript ────────────────────────────────────────────

interface NativeTranscriptProps {
  items: SessionItem[]
  /** The items are final: no source still derives rows that would land among them. */
  settled: boolean
  streaming: boolean
  footerHeight: number
  expanded: boolean
  disclosure: DisclosureLevel
  displayRevision: number
  overlayOpen: boolean
  renderItems: (items: SessionItem[], streaming: boolean) => JSX.Element
  children: JSX.Element
}

/** The surface did not settle before its timeout; the rows still commit as rendered. */
class NativeSettleError extends Schema.TaggedError<NativeSettleError>()("NativeSettleError", {
  message: Schema.String,
}) {}

/** Owns native history snapshots. The session feed remains the source of truth. */
export function NativeTranscript(props: NativeTranscriptProps) {
  const renderer = useRenderer()
  const ext = useExtensionUI()
  const owner = getOwner()
  const dimensions = useTerminalDimensions()
  const [ready, setReady] = createSignal(false)
  const [nativeOutputReady, setNativeOutputReady] = createSignal(false)
  const [committedCount, setCommittedCount] = createSignal(0)
  const [liveHeight, setLiveHeight] = createSignal(0)
  const [measurementVersion, setMeasurementVersion] = createSignal(0)
  const itemHeights = new Map<SessionItem, number>()
  let committed: string[] = []
  /**
   * How far the queue has been offered items. It runs ahead of `committed`
   * while commits are in flight, so a re-render cannot enqueue the same item
   * twice; a commit that does not land rewinds it to `committed.length`.
   */
  let queued = 0
  /**
   * Bumped when a queued commit hands its item back. The rewind of `queued`
   * runs on the queue fiber, so the pass that offers items needs a reactive
   * nudge to run again and retry the item that came back.
   */
  const [retryVersion, setRetryVersion] = createSignal(0)
  /**
   * Which display a commit belongs to. A `/clear` bumps it, so a commit queued
   * before the clear finds a stale stamp when its surface finally settles and
   * drops its rows instead of writing history the reader already dismissed.
   */
  let displayGeneration = 0
  let displayRevision = 0
  const [displayBoundary, setDisplayBoundary] = createSignal(captureTranscriptDisplay([]))
  const displayedItems = createMemo(() => projectTranscriptDisplay(props.items, displayBoundary()))
  let viewport = Option.none<ScrollBoxRenderable>()
  let settlingNative = false
  const [replayPending, setReplayPending] = createSignal(false)
  let measuredDimensions = dimensions()
  let measuredDisclosure = props.disclosure
  /**
   * Rows the live tail may take below native history: what the split footer
   * leaves after the composer's footer. The footer region is at most
   * `splitFooterHeight` rows, not the full terminal, so a tail sized against
   * the terminal pushes the last footer rows (the status line, a docked tray)
   * below the last terminal row.
   */
  const liveRows = () =>
    Math.max(0, splitFooterHeight(dimensions().height, dimensions().height) - props.footerHeight)
  const finishNativeReturn = () => {
    settlingNative = false
    if (props.expanded || props.overlayOpen) return
    batch(() => {
      setReplayPending(false)
      setNativeOutputReady(true)
    })
  }

  const requestReplay = () => {
    renderer.off("frame", finishNativeReturn)
    settlingNative = false
    batch(() => {
      setNativeOutputReady(false)
      setReplayPending(true)
      committed = []
      queued = 0
      setCommittedCount(0)
    })
  }

  useScopedKeyboard(
    (event) => {
      if (Option.isNone(viewport)) return false
      if (event.name === "pageup") {
        viewport.value.scrollBy(-viewport.value.height)
        return true
      }
      if (event.name === "pagedown") {
        viewport.value.scrollBy(viewport.value.height)
        return true
      }
      return false
    },
    { when: () => props.expanded && !props.overlayOpen },
  )

  // Native history commits are serialized: markdown highlights arrive from the
  // tree-sitter worker asynchronously, and scrollback is immutable once written,
  // so each item renders on a surface, settles, and only then commits its rows.
  let disposed = false
  let nativeTail: Fiber.Fiber<void> = Effect.runFork(Effect.void)
  const enqueueNative = (task: Effect.Effect<void>) => {
    const previous = nativeTail
    nativeTail = Effect.runFork(
      Fiber.await(previous).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            if (disposed || renderer.isDestroyed) return Effect.void
            return task
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("transcript.native-commit-failed").pipe(
            Effect.annotateLogs({ cause: String(cause) }),
          ),
        ),
      ),
    )
  }

  /** Scrollback accepts a commit only while the split footer owns the screen. */
  const canCommitNatively = () =>
    renderer.screenMode === "split-footer" && renderer.externalOutputMode === "capture-stdout"

  /**
   * Renders one item onto a scrollback surface, settles it, and commits its
   * rows. Reports whether the rows reached scrollback: an overlay that opens
   * while the surface settles takes the screen back, and scrollback rejects a
   * commit from the alternate screen. An item that did not commit stays in the
   * live view, so closing the overlay still shows it.
   *
   * The footer is left exactly as it is. Changing it here would run OpenTUI's
   * `applyScreenMode` in the middle of the commit, and that path rewrites the
   * screen with `ESC[nS`, which drops the rows instead of scrolling them into
   * scrollback. `splitFooterHeight` keeps the output region large enough
   * instead, so the commit needs no footer of its own.
   */
  const commitItems = (items: SessionItem[]): Effect.Effect<boolean> =>
    Effect.suspend(() => {
      const generation = displayGeneration
      const stillCurrent = () => displayGeneration === generation && canCommitNatively()
      if (!stillCurrent()) return Effect.succeed(false)
      const surface: ScrollbackSurface = renderer.createScrollbackSurface()
      const surfaceRenderer = Object.create(surface.renderContext)
      Object.defineProperties(surfaceRenderer, {
        root: { get: () => surface.root, enumerable: true },
        width: { get: () => surface.width, enumerable: true },
        height: { get: () => surface.height, enumerable: true },
      })
      const disposeSnapshot = Option.fromNullishOr(
        runWithOwner(owner, () =>
          createRoot((dispose) => {
            insert(surface.root, () => (
              <RendererContext.Provider value={surfaceRenderer}>
                {props.renderItems(items, false)}
              </RendererContext.Provider>
            ))
            return dispose
          }),
        ),
      )
      return Effect.tryPromise({
        try: () => surface.settle(2000),
        catch: (error) => new NativeSettleError({ message: String(error) }),
      }).pipe(
        // A highlight that never lands still commits; the row text is complete.
        // A surface the renderer already tore down has nothing left to draw.
        Effect.catch(() =>
          Effect.suspend(() => {
            if (surface.isDestroyed) return Effect.void
            return Effect.sync(() => surface.render())
          }),
        ),
        // Settling is asynchronous. The screen may have changed hands and the
        // reader may have cleared the display while it ran, so both are
        // checked again before the rows are handed over.
        Effect.andThen(
          Effect.suspend(() => {
            if (surface.isDestroyed || !stillCurrent()) return Effect.succeed(false)
            return Effect.sync(() => {
              surface.commitRows(0, surface.height)
              return true
            })
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (Option.isSome(disposeSnapshot)) disposeSnapshot.value()
            if (!surface.isDestroyed) surface.destroy()
          }),
        ),
      )
    })

  /** The screen changed hands: give the item back to the live view. */
  const rewind = () => {
    queued = committed.length
    setRetryVersion((version) => version + 1)
  }

  /**
   * Hands one item to native history and, only once its rows land, drops it
   * from the live view. A commit that could not happen leaves the counters
   * untouched, so the item stays visible and a later pass retries it.
   */
  const write = (item: SessionItem, fingerprintValue: string) => {
    enqueueNative(
      commitItems([item]).pipe(
        Effect.andThen((landed) =>
          Effect.sync(() => {
            if (!landed) return rewind()
            committed = [...committed, fingerprintValue]
            setCommittedCount(committed.length)
          }),
        ),
        Effect.onError(() => Effect.sync(rewind)),
      ),
    )
  }

  onMount(() => {
    renderer.footerHeight = props.footerHeight
    renderer.screenMode = "split-footer"
    renderer.externalOutputMode = "capture-stdout"
    // Native history scrolls in the terminal. Mouse tracking would swallow the wheel.
    renderer.useMouse = false
    // A new transcript must not inherit the previous screen's cursor origin.
    renderer.resetSplitFooterForReplay()
    setReady(true)
  })

  onCleanup(() => {
    disposed = true
    renderer.off("frame", finishNativeReturn)
    if (renderer.isDestroyed) return
    renderer.externalOutputMode = "passthrough"
    renderer.screenMode = "alternate-screen"
    renderer.useMouse = true
  })

  createEffect(() => {
    const next = dimensions()
    const disclosure = props.disclosure
    if (
      next.width === measuredDimensions.width &&
      next.height === measuredDimensions.height &&
      disclosure === measuredDisclosure
    )
      return
    measuredDimensions = next
    measuredDisclosure = disclosure
    untrack(requestReplay)
  })

  createEffect(() => {
    if (!ready()) return
    if (props.expanded || props.overlayOpen) {
      setNativeOutputReady(false)
      renderer.externalOutputMode = "passthrough"
      renderer.screenMode = "alternate-screen"
      // The expanded transcript owns scrolling, so the wheel must reach the scrollbox.
      renderer.useMouse = true
      return
    }
    const returning = renderer.screenMode === "alternate-screen"
    renderer.footerHeight = splitFooterHeight(
      dimensions().height,
      props.footerHeight + stickyRows() + Math.max(1, liveHeight()),
    )
    renderer.screenMode = "split-footer"
    renderer.externalOutputMode = "capture-stdout"
    renderer.useMouse = false
    if ((returning || replayPending()) && !settlingNative) {
      settlingNative = true
      renderer.once("frame", finishNativeReturn)
      // Layout and content changes invalidate saved snapshots.
      // Clear before the layout frame; replay only after its measurements arrive.
      const clearSavedLines = replayPending()
      enqueueNative(
        Effect.sync(() => {
          renderer.resetSplitFooterForReplay({ clearSavedLines })
          renderer.requestRender()
        }),
      )
    }
    if (!settlingNative) setNativeOutputReady(true)
  })

  createEffect(() => {
    if (!nativeOutputReady()) return
    const nextDisplayRevision = props.displayRevision
    if (displayRevision === nextDisplayRevision) return
    untrack(() => {
      displayRevision = nextDisplayRevision
      const cleared = props.items
      // Bumped before the queue sees the reset: a commit already settling now
      // finds a stale stamp and drops its rows rather than writing history the
      // reader just dismissed.
      displayGeneration += 1
      // The boundary moves at once, so no later pass can offer a pre-clear
      // item again while the queue is still draining.
      batch(() => {
        setDisplayBoundary(captureTranscriptDisplay(cleared))
        committed = []
        queued = 0
        setCommittedCount(0)
      })
      // The renderer reset joins the commit queue rather than jumping it, so
      // the queue stays the single writer of scrollback.
      enqueueNative(Effect.sync(() => renderer.resetSplitFooterForReplay()))
    })
  })

  // Scrollback is immutable, so nothing commits until every client renderer
  // has loaded and every notice-row source has answered; the live view draws
  // the rows it has meanwhile.
  createEffect(() => {
    if (!ext.loaded() || !props.settled) return
    if (!nativeOutputReady() || props.streaming || props.expanded || props.overlayOpen) return
    const items = displayedItems()
    const next = items.map((item) => transcriptFingerprint(item))
    measurementVersion()
    retryVersion()
    // The rows the live tail really has: the pinned prompt takes one.
    const available = liveRows() - stickyRows()
    untrack(() => {
      const prefixMatches = committed.every((value, index) => next[index] === value)
      if (!prefixMatches) {
        requestReplay()
        return
      }
      let remainingHeight = 0
      for (const item of items.slice(queued)) {
        remainingHeight += itemHeights.get(item) ?? 0
      }
      while (queued < items.length && remainingHeight > available) {
        const item = items[queued]
        if (!item) break
        const height = Option.fromNullishOr(itemHeights.get(item))
        if (Option.isNone(height)) break
        const value = next[queued]
        if (!Predicate.isString(value)) break
        // A completed item has one owner: native history or the live view. The
        // live view keeps it until the queued commit reports that it landed.
        write(item, value)
        remainingHeight -= height.value
        queued++
      }
      const currentItems = new Set(items)
      for (const item of itemHeights.keys()) {
        if (!currentItems.has(item)) itemHeights.delete(item)
      }
    })
  })

  const liveItems = createMemo(() => {
    if (props.expanded) return props.items
    return displayedItems().slice(committedCount())
  })
  /**
   * The last posted prompt, pinned in one row above the live tail while its
   * own row is off screen above: scrolled out of the live viewport, or deep
   * enough in native history that the terminal no longer shows it. Derived
   * from the displayed items, so a switch of branch or session pins that
   * branch's prompt. The row is the first thing a short terminal gives up: it
   * shows only while the live tail keeps a row of its own beside it. The
   * expanded transcript and an overlay draw on the alternate screen, where
   * nothing is pinned.
   */
  const promptOf = (customType: string) =>
    Option.flatMap(Option.fromUndefinedOr(ext.messageRenderers().get(customType)), (renderer) =>
      Option.fromUndefinedOr(renderer.prompt),
    )
  /**
   * The reader's last prompt and its display index. A memo of the displayed
   * items alone: a measurement never re-runs it, and it scans back from the
   * end only as far as that prompt.
   */
  const lastPrompt = createMemo(
    (): Option.Option<{ readonly index: number; readonly text: string }> => {
      const items = displayedItems()
      for (let index = items.length - 1; index >= 0; index--) {
        const text = Option.flatMap(Option.fromUndefinedOr(items[index]), (item) =>
          readerPrompt(item, promptOf),
        )
        if (Option.isSome(text)) return Option.some({ index, text: text.value })
      }
      return Option.none()
    },
  )
  /** Per measurement: a height lookup by index and sums bounded by the screen. */
  const stickyPrompt = createMemo((): Option.Option<string> => {
    if (props.expanded || props.overlayOpen || liveRows() < 2) return Option.none()
    const prompt = lastPrompt()
    if (Option.isNone(prompt)) return Option.none()
    measurementVersion()
    const items = displayedItems()
    const height = dimensions().height
    const onScreen = promptOnScreen({
      heightAt: (index) =>
        Option.flatMap(Option.fromUndefinedOr(items[index]), (item) =>
          Option.fromUndefinedOr(itemHeights.get(item)),
        ),
      index: prompt.value.index,
      committed: committedCount(),
      liveHeight: liveHeight(),
      liveRows: liveRows(),
      scrollbackRows:
        height - splitFooterHeight(height, props.footerHeight + 1 + Math.max(1, liveHeight())),
    })
    if (onScreen) return Option.none()
    return Option.some(prompt.value.text)
  })
  const stickyRows = () => {
    if (Option.isSome(stickyPrompt())) return 1
    return 0
  }

  const viewportHeight = () => {
    if (props.expanded) return Math.max(0, dimensions().height - props.footerHeight)
    return Math.min(Math.max(1, liveHeight()), liveRows() - stickyRows())
  }

  return (
    <box flexDirection="column" flexShrink={1} minHeight={0}>
      <Show when={Option.getOrUndefined(stickyPrompt())}>
        {(prompt) => <StickyPrompt text={prompt()} width={dimensions().width} />}
      </Show>
      <scrollbox
        ref={(value) => {
          viewport = Option.some(value)
        }}
        height={viewportHeight()}
        minHeight={0}
        overflow="hidden"
        // Measure content without the current viewport height as a limit.
        viewportOptions={{ overflow: "scroll" }}
        // Let the live tail shrink after leading messages enter native history.
        contentOptions={{ minHeight: 0 }}
        flexShrink={1}
        stickyScroll
        stickyStart="bottom"
        focusable={false}
        verticalScrollbarOptions={{ visible: false }}
      >
        <box
          flexDirection="column"
          flexShrink={0}
          onSizeChange={function () {
            if (props.expanded || props.overlayOpen) return
            setLiveHeight(this.height)
          }}
        >
          <For each={liveItems()}>
            {(item, index) => (
              <box
                flexDirection="column"
                flexShrink={0}
                onSizeChange={function () {
                  if (itemHeights.get(item) === this.height) return
                  itemHeights.set(item, this.height)
                  setMeasurementVersion((version) => version + 1)
                }}
              >
                {props.renderItems([item], props.streaming && index() === liveItems().length - 1)}
              </box>
            )}
          </For>
          {props.children}
        </box>
      </scrollbox>
    </box>
  )
}
