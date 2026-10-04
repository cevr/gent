import {
  type ActivityCall,
  type ActivityOutcome,
  activityRows,
  decodeToolOutputOption,
  formatActivityHeader,
  formatActivityRow,
  formatCellRowLabel,
  formatCost,
  formatClock,
  formatDuration,
  collapsedOperations,
  formatFailureRow,
  formatPreviewFooter,
  formatRowCounts,
  getString,
  type PathPlace,
  toolArgSummary,
  parseBashOutput,
  plural,
  repliesInView,
  type ReplyWriter,
  truncate,
  workingIconFrame,
} from "./utils"
import { textWidth } from "./bun-adapter"
import {
  type Cause,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Match,
  Option,
  Predicate,
  Queue,
  Schema,
  Stream,
} from "effect"
import { resolveThemeColor, useTheme } from "./theme"
import { useClient } from "./client"
import {
  CollapsedRow,
  formatToolCallIdentity,
  ToolCallIdentityProvider,
  FrameClicks,
  ToolFrameBody,
  UserRow,
  useSpinnerClock,
} from "./ui"
import {
  batch,
  createContext,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  For,
  getOwner,
  type JSX,
  on,
  onCleanup,
  onMount,
  runWithOwner,
  Show,
  untrack,
  useContext,
} from "solid-js"
import {
  BoxRenderable,
  type CliRenderer,
  type MarkdownOptions,
  type Renderable,
  type RenderContext,
  type RGBA,
  type ScrollBoxRenderable,
  type ScrollbackSurface,
  StyledText,
  type SyntaxStyle,
  TextAttributes,
  TextRenderable,
} from "@opentui/core"
import { useScopedKeyboard, useTerminalDimensions } from "./terminal"
import {
  bashOutputRows,
  callOperation,
  cellOperations,
  cutShort,
  failureLine,
  failureText,
  FoldOperationsProvider,
  GenericToolRenderer,
  type OutputHead,
  outputHead,
  RegisteredToolCall,
  type ToolCall,
  ToolCallSchema,
} from "./tool-renderers"
import { useExtensionUI } from "./extensions/host"
import {
  type MessageRenderer,
  type DisclosureLevel,
  type MessageRowProps,
  StatusLabelColor,
} from "./extensions/client-facets"
import {
  CONTEXT_WINDOW_MESSAGE_TYPE,
  type ImagePartProjection,
  lineCount,
  MODEL_CHANGE_MESSAGE_TYPE,
} from "@gent/core/protocol"
import { DiagramLibraryContext, diagramsDrawable, useDiagramCodeBlocks } from "./mermaid"
import { insert, RendererContext, useRenderer } from "@opentui/solid"

// ── reasoning text ──────────────────────────────────────────────────────────

/**
 * Reasoning summaries, prepared for the markdown renderer.
 *
 * A model emits reasoning as a run of summaries, each its own bold markdown
 * heading, and `messagePartsReasoning` joins the parts with an empty string:
 *
 *     **Verifying final test output****Refactoring LedgerStore.list…**
 *
 * The run is split back into summaries and joined with a blank line, the
 * paragraph break markdown needs to draw each summary as its own line.
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

/**
 * Reasoning at the collapsed and preview levels, in one line:
 * `∴ Thought · <first summary's heading> · N summaries`. Where the line is
 * wider than `width` columns, the count drops first, then the heading is cut.
 */
const formatThoughtLine = (reasoning: string, width = Number.POSITIVE_INFINITY): string => {
  const summaries = reasoningMarkdown(reasoning)
    .split("\n\n")
    .filter((summary) => summary.length > 0)
  const first = (summaries[0] ?? "").split("\n")[0] ?? ""
  const heading = first
    .replace(/^#+\s*/, "")
    .replace(/^\*\*(.*)\*\*$/, "$1")
    .trim()
  let line = "∴ Thought"
  if (heading.length > 0) line = `${line} · ${heading}`
  const count = ` · ${plural(summaries.length, "summary", "summaries")}`
  if (summaries.length > 1 && textWidth(line + count) <= width) return line + count
  return truncate(line, width)
}

// ── session event labels ────────────────────────────────────────────────────

/** What the model steps of one turn added up to, from each `StreamEnded.outcome`. */
const TurnSteps = Schema.Struct({
  count: Schema.Finite,
  toolCalls: Schema.Finite,
  costUsd: Schema.Finite,
})
type TurnSteps = Schema.Schema.Type<typeof TurnSteps>

export const emptyTurnSteps: TurnSteps = { count: 0, toolCalls: 0, costUsd: 0 }

export const addStep = (
  steps: TurnSteps,
  step: { readonly outcome?: string; readonly costUsd?: number },
): TurnSteps => ({
  count: steps.count + 1,
  toolCalls: steps.toolCalls + Number(step.outcome === "ToolCalls"),
  costUsd: steps.costUsd + (step.costUsd ?? 0),
})

/**
 * How a retry ended, as far as the feed saw. `retried`: the retry ran (it
 * streamed, failed again, or its step ended). `cancelled`: the turn was cut
 * short before the retry answered. `stopped`: the runtime went idle before
 * the feed saw an outcome.
 */
const RetryOutcome = Schema.Literals(["pending", "retried", "cancelled", "stopped"])
export type RetryOutcome = Schema.Schema.Type<typeof RetryOutcome>

const SessionEventPlacement = { createdAt: Schema.Finite, seq: Schema.Finite }

const SessionEvent = Schema.Union([
  Schema.TaggedStruct("turn-ended", {
    durationSeconds: Schema.Finite,
    steps: TurnSteps,
    ...SessionEventPlacement,
  }),
  Schema.TaggedStruct("interruption", SessionEventPlacement),
  Schema.TaggedStruct("error", {
    error: Schema.String,
    /** When a usage limit that failed the turn resets, in epoch milliseconds (`ErrorOccurred.retryAt`). */
    retryAt: Schema.optional(Schema.Finite),
    ...SessionEventPlacement,
  }),
  /**
   * A muted row the turn goes on past: an error such as a compaction
   * fallback, or a row a client extension derives (`noticeRowContribution`).
   */
  Schema.TaggedStruct("notice", {
    /** Unique among the notice rows; the transcript keys the row on it. */
    key: Schema.String,
    /** One glyph, drawn in `color`; the text after it is muted. */
    glyph: Schema.String,
    color: StatusLabelColor,
    text: Schema.String,
    ...SessionEventPlacement,
  }),
  Schema.TaggedStruct("retrying", {
    attempt: Schema.Finite,
    maxAttempts: Schema.Finite,
    delayMs: Schema.Finite,
    /** The feed settles a pending retry in place once it learns the outcome. */
    outcome: Schema.mutableKey(RetryOutcome),
    /** The provider failure that caused the retry, as the core reported it. */
    reason: Schema.String,
    ...SessionEventPlacement,
  }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type SessionEvent = Schema.Schema.Type<typeof SessionEvent>

/** The first line of the retry's reason, after a separator; an empty reason adds nothing. */
const retryReason = (reason: string): string => {
  const line = (reason.split("\n")[0] ?? "").trim()
  if (line === "") return ""
  return ` · ${line}`
}

export const currentMillis = () => DateTime.toEpochMillis(DateTime.nowUnsafe())

/** "3 steps · 2 tool calls · $0.012"; a turn with no recorded steps says nothing extra. */
const stepSummary = (steps: TurnSteps): ReadonlyArray<string> => {
  if (steps.count === 0) return []
  const parts = [plural(steps.count, "step")]
  if (steps.toolCalls > 0) parts.push(plural(steps.toolCalls, "tool call"))
  if (steps.costUsd > 0) parts.push(formatCost(steps.costUsd))
  return parts
}

/** The error's text, its first line ending with the reset time when the failure names one. */
const errorLabel = (
  event: Extract<SessionEvent, { _tag: "error" }>,
  now: number,
  zone: () => DateTime.TimeZone,
): string => {
  if (Predicate.isUndefined(event.retryAt)) return event.error
  const [first = "", ...rest] = event.error.split("\n")
  return [`${first} · resets ${formatClock(event.retryAt, now, zone())}`, ...rest].join("\n")
}

/**
 * The row's text at `now`. Clock times read in the zone `zone` gives, the
 * viewer's own unless a test fixes it; only a row with a reset time asks.
 */
export const getSessionEventLabel = (
  event: SessionEvent,
  now = currentMillis(),
  zone: () => DateTime.TimeZone = DateTime.zoneMakeLocal,
): string => {
  if (event._tag === "turn-ended") {
    return [
      `Worked for ${formatDuration(event.durationSeconds * 1000, "compact")}`,
      ...stepSummary(event.steps),
    ].join(" · ")
  }
  if (event._tag === "interruption") return "Interrupted · what do you want to do instead?"
  if (event._tag === "error") return errorLabel(event, now, zone)
  if (event._tag === "notice") return event.text
  const count = `${event.attempt}/${event.maxAttempts}`
  const reason = retryReason(event.reason)
  if (event.outcome === "retried") return `Retried ${count}${reason}`
  if (event.outcome === "cancelled") return `Retry ${count} cancelled${reason}`
  if (event.outcome === "stopped") return `Retry ${count} stopped${reason}`

  const retryAt = event.createdAt + event.delayMs
  const remainingMs = Math.max(0, retryAt - now)
  const seconds = Math.ceil(remainingMs / 1000)
  if (seconds <= 0) return `Retrying now... ${count}${reason}`
  return `Retrying in ${seconds}s... ${count}${reason}`
}

// ── session event indicator ─────────────────────────────────────────────────

interface SessionEventIndicatorProps {
  event: SessionEvent
  /** Below it an error keeps its first lines; open, it shows whole. */
  open: boolean
}

/** The lines a session error keeps below the full level: a provider body can run long. */
const ERROR_LINES = 4

/** An error's first `ERROR_LINES` lines, then the count of the rest and the key that shows them. */
const cappedError = (text: string): string => {
  const lines = text.replace(/\s+$/, "").split("\n")
  if (lines.length <= ERROR_LINES) return text
  return [...lines.slice(0, ERROR_LINES), formatPreviewFooter(lines.length - ERROR_LINES)].join(
    "\n",
  )
}

function SessionEventIndicator(props: SessionEventIndicatorProps) {
  const { theme } = useTheme()
  const tick = useSpinnerClock()

  // Only a pending retry counts down; every other row's label is fixed, so
  // only that row reads the clock.
  const content = () => {
    const event = props.event
    if (event._tag === "retrying" && event.outcome === "pending") tick()
    const label = getSessionEventLabel(event, currentMillis())
    if (event._tag === "error" && !props.open) return cappedError(label)
    return label
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

  // The glyph keeps its own column, so a row that wraps hangs its next line
  // under the text, not under the glyph.
  const event = props.event
  if (event._tag === "notice") {
    return (
      <box marginTop={1} flexDirection="row">
        <text flexShrink={0} style={{ fg: resolveThemeColor(theme, event.color) }}>
          {`${event.glyph} `}
        </text>
        <text flexShrink={1} style={{ fg: theme.textMuted }}>
          {event.text}
        </text>
      </box>
    )
  }

  return (
    <box marginTop={1} flexDirection="row">
      <text flexShrink={0} style={{ fg: color() }}>
        {"● "}
      </text>
      <text flexShrink={1} style={{ fg: color() }}>
        {content()}
      </text>
    </box>
  )
}

// ── message list ────────────────────────────────────────────────────────────

export type { ToolCall }

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

/** The rows of a call's own output a preview draws under its row: fx's command head. */
const HEAD_LINES = 5

/** A call as its group counts it: a cell by its ops, any other call as the one tool it is. */
const toActivityCall = (call: ToolCall, place: PathPlace): ActivityCall => {
  const base = {
    toolName: call.toolName,
    status: call.status,
    durationMs: call.durationMs,
    reason: failureLine(call),
    failure: Option.getOrUndefined(failureText(call)),
    cancelled: cutShort(call),
    source: call,
  }
  if (call.toolName !== "cell") {
    return { ...base, operations: [callOperation(call, place)], code: "" }
  }
  return { ...base, operations: cellOperations(call, place), code: getString(call.input, "code") }
}

const cellResultText = (call: ToolCall) =>
  Option.match(decodeToolOutputOption(CellFailure, call.output), {
    onNone: () => ({ display: "", error: "" }),
    onSome: (value) => ({
      display: value.display ?? "",
      error: value.message ?? value.error ?? "",
    }),
  })

/** The text a cell or bash row counts beneath itself: the cell display, or the command output. */
const rowOutputText = (call: ToolCall): Option.Option<string> => {
  if (call.toolName === "cell") {
    const result = cellResultText(call)
    if (result.error.length > 0) return Option.some(result.error)
    return Option.some(result.display)
  }
  if (call.toolName !== "bash") return Option.none()
  // Each stream's final newline ends its last line, so the joined text
  // holds as many lines as the two streams do. Output it cannot read shows nothing.
  return Option.some(
    Option.match(parseBashOutput(call.output), {
      onNone: () => "",
      onSome: (value) =>
        [value.stdout, value.stderr]
          .values()
          .filter((text) => text.length > 0)
          .map((text) => text.replace(/\n$/, ""))
          .toArray()
          .join("\n"),
    }),
  )
}

/**
 * Lines a row counts beneath itself. A bash row counts as its body does, so a
 * cut stream counts the whole output its record names, not the kept excerpt.
 */
const rowOutputLines = (call: ToolCall): number => {
  if (call.toolName === "bash" && Option.isSome(parseBashOutput(call.output))) {
    return bashOutputRows(call).total
  }
  return lineCount(Option.getOrElse(rowOutputText(call), () => ""))
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

const ImagePartProjectionSchema: Schema.Codec<ImagePartProjection> = Schema.Struct({
  mediaType: Schema.String,
})

const AssistantSegment = Schema.Union([
  /** The feed appends streamed text to the last text segment in place. */
  Schema.TaggedStruct("text", { content: Schema.mutableKey(Schema.String) }),
  Schema.TaggedStruct("reasoning", { content: Schema.String }),
  Schema.TaggedStruct("tool-call", { toolCall: ToolCallSchema }),
  Schema.TaggedStruct("image", { image: ImagePartProjectionSchema }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type AssistantSegment = Schema.Schema.Type<typeof AssistantSegment>

interface MessageBase {
  id: string
  role: "user" | "assistant" | "system" | "tool"
  pendingMode?: "queued" | "steer"
  /** Concatenated text content (derived — used by picker, search) */
  content: string
  /** Concatenated reasoning (derived) */
  reasoning: string
  images: ReadonlyArray<ImagePartProjection>
  createdAt: number
  /** Ordered parts for interleaved rendering; the one owner of the message's tool calls. */
  segments?: AssistantSegment[]
  metadata?: MessageMetadataInfo
  /** An answer built from streamed chunks: the step's stored answer replaces it. */
  draft?: true
}

interface RegularMessage extends MessageBase {
  _tag: "regular-message"
}

interface InterjectionMessage extends MessageBase {
  _tag: "interjection-message"
  role: "user"
}

export type Message = RegularMessage | InterjectionMessage

/** The tool calls a message shows inline, in segment order. */
export const messageToolCalls = (message: Pick<MessageBase, "segments">): ReadonlyArray<ToolCall> =>
  Option.getOrElse(Option.fromNullishOr(message.segments), (): AssistantSegment[] => []).flatMap(
    (segment) => {
      if (segment._tag === "tool-call") return [segment.toolCall]
      return []
    },
  )
export type SessionItem = Message | SessionEvent

/** A transcript item that is a message, not a session event row. */
export const isMessageItem = Predicate.or(
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

/** The columns an answer is indented by; its text is fitted to the rest. */
const ANSWER_INDENT = 2

// ── tool runs ───────────────────────────────────────────────────────────────

/**
 * A run of tool calls: what one group header draws. As in fx, a run spans the
 * steps of a turn. Reasoning and blank text between its calls do not end it;
 * answer text, an image, a user message, a session row, or an ask does. As in
 * opencode's activity line, the run also takes the reasoning just before its
 * first call (from that call's own message) and the reasoning just before the
 * text that ends it, and its header counts them all as thoughts.
 */
interface ToolRun {
  readonly calls: ReadonlyArray<ToolCall>
  /** The reasoning the run took before its calls, by the id of the call it came before. */
  readonly reasoning: ReadonlyMap<string, ReadonlyArray<string>>
  /** The reasoning the run took from before the text that ended it. */
  readonly closing: ReadonlyArray<string>
  /** Nothing after the run has ended it yet: another step may join it. */
  readonly open: boolean
  /** A step the run took is still a streamed answer (a `draft`) that its stored answer replaces. */
  readonly streamed: boolean
}

/** The runs of a transcript, keyed by segment (`<message id>#<segment index>`). */
interface ToolRuns {
  /** The run each run's first tool-call segment draws. */
  readonly heads: ReadonlyMap<string, ToolRun>
  /** Segments a run draws at its head, so their own message skips them. */
  readonly absorbed: ReadonlySet<string>
  /** The runs each message heads, in order. */
  readonly headedBy: ReadonlyMap<string, ReadonlyArray<ToolRun>>
}

const segmentKey = (messageId: string, index: number) => `${messageId}#${index}`

/** The tools that ask the reader: the run ends after the call that holds one. */
const ASK_TOOLS: ReadonlySet<string> = new Set(["ask_user", "prompt", "handoff"])

const asksReader = (call: ToolCall): boolean =>
  ASK_TOOLS.has(call.toolName) || (call.operations ?? []).some(asksReader)

/** A run while the projection walks the transcript. */
interface RunDraft {
  readonly head: string
  readonly headMessage: string
  readonly calls: ToolCall[]
  readonly reasoning: Map<string, ReadonlyArray<string>>
  closing: ReadonlyArray<string>
  /**
   * Reasoning and blank text since the last call: the run takes them only if
   * another call joins, or answer text ends the run. `streamed` marks one held
   * from a streamed answer.
   */
  readonly held: Passing
}

/** Reasoning and blank text segments in a row, with the keys of the segments. */
interface Passing {
  keys: string[]
  reasoning: string[]
  streamed: boolean
}

const noPassing = (): Passing => ({ keys: [], reasoning: [], streamed: false })

/** A run while the walk may still change it. */
interface RunState {
  readonly draft: RunDraft
  open: boolean
  streamed: boolean
}

/**
 * The tool runs of `items`. `acrossSteps` lets a run span messages and pass
 * over reasoning; without it a run is one message's consecutive calls, as the
 * transcript view (full detail) draws them. A queued follow-up and a pending
 * retry sit at the transcript's end only until they take their place, so
 * they end nothing. Only a running turn adds steps, so with none the last
 * run has ended too.
 */
const projectToolRuns = (
  items: ReadonlyArray<SessionItem>,
  acrossSteps: boolean,
  turnRunning: boolean,
): ToolRuns => {
  const drafts: RunState[] = []
  const absorbed = new Set<string>()
  let current = Option.none<RunState>()
  // Reasoning and blank text in this message with no run open: a call in the
  // same message starts a run that takes them. Only the same message: an
  // earlier one may already be in history, and taking from it would change it.
  let prelude = noPassing()
  // Whatever ends a run ends it for good: no later call joins it.
  const close = () => {
    Option.map(current, (entry) => {
      entry.open = false
    })
    current = Option.none()
  }
  const takeCall = (message: StepMessage, call: ToolCall, key: string) => {
    Option.match(current, {
      onSome: (entry) => joinRun(entry, call, key, absorbed, message.draft === true),
      onNone: () => {
        const entry = startRun(call, key, message.id)
        takeHeld(entry, prelude, call.id, absorbed)
        drafts.push(entry)
        current = Option.some(entry)
      },
    })
    prelude = noPassing()
    if (asksReader(call)) close()
  }
  const takeSegment = (message: StepMessage, segment: AssistantSegment, index: number) => {
    const key = segmentKey(message.id, index)
    const streamed = message.draft === true
    if (segment._tag === "tool-call") return takeCall(message, segment.toolCall, key)
    if (acrossSteps && passesRun(segment)) {
      return Option.match(current, {
        onSome: (entry) => holdSegment(entry.draft.held, segment, key, streamed),
        onNone: () => holdSegment(prelude, segment, key, streamed),
      })
    }
    // Answer text ends the run, which takes the reasoning given just before it.
    if (acrossSteps && segment._tag === "text") {
      Option.map(current, (entry) => takeClosing(entry, streamed, absorbed))
    }
    prelude = noPassing()
    close()
  }
  for (const item of items) {
    prelude = noPassing()
    if (waitsInPlace(item)) continue
    if (!isMessageItem(item) || item.role !== "assistant") {
      close()
      continue
    }
    for (const [index, segment] of (item.segments ?? []).entries()) {
      takeSegment(item, segment, index)
    }
    if (!acrossSteps) close()
  }
  if (!turnRunning) close()
  return toolRunsOf(drafts, absorbed)
}

/** The message a step comes from: its id keys the segments, and a draft marks the run streamed. */
interface StepMessage {
  readonly id: string
  readonly draft?: true
}

/** A queued follow-up and a pending retry wait at the end until they take their place. */
const waitsInPlace = (item: SessionItem): boolean => {
  if (!isMessageItem(item)) return item._tag === "retrying" && item.outcome === "pending"
  return item.role !== "assistant" && Predicate.isNotUndefined(item.pendingMode)
}

/** Reasoning and blank text between calls leave a run open. */
const passesRun = (segment: AssistantSegment): boolean =>
  segment._tag === "reasoning" || (segment._tag === "text" && segment.content.trim().length === 0)

const startRun = (call: ToolCall, key: string, messageId: string): RunState => ({
  draft: {
    head: key,
    headMessage: messageId,
    calls: [call],
    reasoning: new Map<string, ReadonlyArray<string>>(),
    closing: [],
    held: noPassing(),
  },
  open: true,
  streamed: false,
})

/** The run takes the passing segments: their keys draw at its head, their reasoning before `callId`. */
const takeHeld = (entry: RunState, passing: Passing, callId: string, absorbed: Set<string>) => {
  for (const key of passing.keys) absorbed.add(key)
  if (passing.reasoning.length > 0) entry.draft.reasoning.set(callId, passing.reasoning)
  if (passing.streamed) entry.streamed = true
}

/** A call joins the run, and the segments held since the last call go with it. */
const joinRun = (
  entry: RunState,
  call: ToolCall,
  key: string,
  absorbed: Set<string>,
  streamed: boolean,
) => {
  const { draft } = entry
  draft.calls.push(call)
  absorbed.add(key)
  takeHeld(entry, draft.held, call.id, absorbed)
  Object.assign(draft.held, noPassing())
  if (streamed) entry.streamed = true
}

/**
 * Answer text ends the run, and the run takes the reasoning held before it.
 * The head waits for the run's end, so it takes them before history does;
 * the run is streamed while the text or the reasoning is, so the head waits
 * for the stored answer too.
 */
const takeClosing = (entry: RunState, streamed: boolean, absorbed: Set<string>) => {
  const { held } = entry.draft
  if (held.reasoning.length === 0) return
  for (const key of held.keys) absorbed.add(key)
  entry.draft.closing = held.reasoning
  if (held.streamed || streamed) entry.streamed = true
  Object.assign(held, noPassing())
}

/** A segment that passes the run waits: the run takes it only if a call or answer text comes next. */
const holdSegment = (
  passing: Passing,
  segment: AssistantSegment,
  key: string,
  streamed: boolean,
) => {
  passing.keys.push(key)
  if (segment._tag === "reasoning") passing.reasoning.push(segment.content)
  if (streamed) passing.streamed = true
}

const toolRunsOf = (drafts: ReadonlyArray<RunState>, absorbed: ReadonlySet<string>): ToolRuns => {
  const heads = new Map<string, ToolRun>()
  const headedBy = new Map<string, ToolRun[]>()
  for (const { draft, open, streamed } of drafts) {
    const run: ToolRun = {
      calls: draft.calls,
      reasoning: draft.reasoning,
      closing: draft.closing,
      open,
      streamed,
    }
    heads.set(draft.head, run)
    headedBy.set(draft.headMessage, [...(headedBy.get(draft.headMessage) ?? []), run])
  }
  return { heads, absorbed, headedBy }
}

/**
 * The transcript's runs, from the transcript that holds every item. The
 * native transcript draws each item on its own (in the live view and on each
 * history surface), so a run's head reads its later steps from here.
 */
const ToolRunsContext = createContext(Option.none<() => ToolRuns>())

// ── plain answers ───────────────────────────────────────────────────────────

/**
 * True while the rows drawn are an item's last try at native history: its
 * highlight could not settle, or the reader is leaving. Answers then draw
 * their markdown as plain text the transcript makes itself, with nothing
 * to highlight. A highlight that never lands leaves a code block or a quote
 * with no text, and one that fails puts back the raw markdown, marks and
 * all; scrollback would keep either for good.
 */
const PlainHistoryContext = createContext(false)

type MarkdownHook = NonNullable<MarkdownOptions["renderNode"]>
type MarkdownToken = Parameters<MarkdownHook>[0]

const childTokens = (token: MarkdownToken): ReadonlyArray<MarkdownToken> => {
  if ("tokens" in token && Array.isArray(token.tokens)) return token.tokens
  return []
}

const tokenText = (token: MarkdownToken): string => {
  if ("text" in token && Predicate.isString(token.text)) return token.text
  return token.raw
}

/** Inline markdown as the words it reads: emphasis, code spans and links lose their marks. */
const plainInline = (tokens: ReadonlyArray<MarkdownToken>): string =>
  tokens
    .map((token) => {
      if (token.type === "br") return "\n"
      if (token.type === "codespan" || token.type === "escape") return tokenText(token)
      const children = childTokens(token)
      if (children.length > 0) return plainInline(children)
      return tokenText(token)
    })
    .join("")

/** The items of a list token, each with the blocks it holds. */
const listItems = (token: MarkdownToken): ReadonlyArray<MarkdownToken> => {
  if ("items" in token && Array.isArray(token.items)) return token.items
  return []
}

/** The marker of a list's item at `index`: `-`, or its number. */
const listMarker = (token: MarkdownToken, index: number): string => {
  if (!("ordered" in token) || token.ordered !== true) return "-"
  if ("start" in token && Predicate.isNumber(token.start)) return `${token.start + index}.`
  return `${1 + index}.`
}

/** Block markdown as the lines it reads, with no mark a highlight would hide. */
const plainLines = (tokens: ReadonlyArray<MarkdownToken>): ReadonlyArray<string> =>
  tokens.flatMap((token): ReadonlyArray<string> => {
    if (token.type === "space") return []
    if (token.type === "code") return tokenText(token).split("\n")
    if (token.type === "blockquote")
      return plainLines(childTokens(token)).map((line) => `│ ${line}`)
    if (token.type === "hr") return ["───"]
    if (token.type === "list")
      return listItems(token).flatMap((item, index) => {
        const marker = listMarker(token, index)
        const pad = " ".repeat(marker.length + 1)
        return plainLines(childTokens(item)).map((line, at) => {
          if (at === 0) return `${marker} ${line}`
          return `${pad}${line}`
        })
      })
    const children = childTokens(token)
    if (children.length > 0) return plainInline(children).split("\n")
    return tokenText(token).replace(/\n+$/, "").split("\n")
  })

/**
 * The answer's markdown hook for its last try at history. A diagram still
 * draws through `diagrams`; a table and a rule draw as markdown draws them,
 * with nothing to highlight; every other block is plain text.
 */
const plainBlocks =
  (
    ctx: RenderContext,
    colors: { readonly text: RGBA; readonly quote: RGBA },
    diagrams: Option.Option<MarkdownHook>,
  ): MarkdownHook =>
  (token, context) =>
    Option.getOrUndefined(
      Option.orElse(
        Option.flatMap(
          Option.filter(diagrams, () => token.type === "code"),
          (hook) => Option.fromNullishOr(hook(token, context)),
        ),
        () => plainBlock(ctx, colors, token, context),
      ),
    )

/** One block drawn plain, or none where markdown's own drawing has nothing to highlight. */
const plainBlock = (
  ctx: RenderContext,
  colors: { readonly text: RGBA; readonly quote: RGBA },
  token: MarkdownToken,
  context: Parameters<MarkdownHook>[1],
): Option.Option<Renderable> => {
  if (token.type === "table" || token.type === "hr" || token.type === "space") return Option.none()
  return Option.some(plainRenderable(ctx, colors, token, context))
}

const plainRenderable = (
  ctx: RenderContext,
  colors: { readonly text: RGBA; readonly quote: RGBA },
  token: MarkdownToken,
  context: Parameters<MarkdownHook>[1],
): Renderable => {
  if (token.type === "blockquote") {
    const quote = new BoxRenderable(ctx, {
      width: "100%",
      border: ["left"],
      borderColor: colors.quote,
      paddingLeft: 1,
      flexShrink: 0,
    })
    quote.add(
      new TextRenderable(ctx, {
        content: plainLines(childTokens(token)).join("\n"),
        fg: colors.text,
        width: "100%",
      }),
    )
    return quote
  }
  const text = plainLines([token]).join("\n")
  if (token.type !== "heading")
    return new TextRenderable(ctx, { content: text, fg: colors.text, width: "100%" })
  const heading = Option.fromUndefinedOr(context.syntaxStyle.getStyle("markup.heading")?.fg)
  return new TextRenderable(ctx, {
    content: new StyledText([
      {
        __isChunk: true,
        text,
        fg: Option.getOrElse(heading, () => colors.text),
        attributes: TextAttributes.BOLD,
      },
    ]),
    width: "100%",
  })
}

/**
 * How answers and reasoning draw their markdown. Each top-level block (a
 * heading, a paragraph, a list) is its own block, so the text a block draws
 * before its highlight lands comes from its inline tokens: a heading never
 * shows its `#` marks, in the live view or in a row that reaches history
 * without its highlight. Tables keep their grid, which the top-level mode
 * would otherwise trade for borderless columns, with one column of padding
 * and a width fitted to their content within the answer.
 */
const ANSWER_TABLE = { style: "grid", cellPaddingX: 1, widthMode: "content" } as const

function AssistantMessage(props: {
  id: string
  runs: ToolRuns
  content: string
  reasoning: string
  images: ReadonlyArray<ImagePartProjection>
  segments?: AssistantSegment[]
  disclosure: DisclosureLevel
  fullDetail: boolean
  syntaxStyle: () => SyntaxStyle
}) {
  const { theme } = useTheme()
  const ctx = useRenderer()
  const plain = useContext(PlainHistoryContext)
  // The hook changes once, when the diagram library loads: a new hook rebuilds every block.
  const diagrams = useDiagramCodeBlocks(() => ({
    text: theme.text,
    border: theme.textMuted,
    line: theme.textMuted,
    arrow: theme.text,
  }))
  const answerBlocks = (): MarkdownOptions["renderNode"] => {
    if (!plain) return diagrams()
    return plainBlocks(
      ctx,
      { text: theme.text, quote: theme.textMuted },
      Option.fromUndefinedOr(diagrams()),
    )
  }
  // Reasoning draws as markdown draws it, but on the last try: then plain too.
  const reasoningBlocks = (): MarkdownOptions["renderNode"] =>
    Option.getOrUndefined(
      Option.map(Option.liftPredicate(plain, Boolean), () =>
        plainBlocks(ctx, { text: theme.textMuted, quote: theme.textMuted }, Option.none()),
      ),
    )

  // A message whose every segment a run took draws nothing, not even its gap.
  const hasContent = () => {
    if (segments().length > 0 && drawnSegments().length === 0) return false
    if (props.content.length > 0) return true
    if (props.reasoning.length > 0) return true
    if (props.images.length > 0) return true
    return messageToolCalls(props).length > 0
  }

  const contentMargin = () => {
    if (hasContent()) return 1
    return 0
  }

  const segments = () => Option.getOrElse(Option.fromNullishOr(props.segments), () => [])
  // The segments this message draws: a run's first call draws the whole run,
  // and the segments a run took (its later calls, the reasoning between them)
  // draw there, not here.
  const drawnSegments = createMemo(() =>
    segments().flatMap((segment, index) => {
      const key = segmentKey(props.id, index)
      if (props.runs.absorbed.has(key)) return []
      return [{ segment, run: Option.fromUndefinedOr(props.runs.heads.get(key)) }]
    }),
  )
  // Reasoning opens at the full level and in the transcript view; below
  // that it is one line, as fx and Codex keep it out of the inline view.
  const dimensions = useTerminalDimensions()
  const thoughtWidth = () => dimensions().width - ANSWER_INDENT - FREE_LAST_COLUMN
  const reasoningOpen = () => props.fullDetail || props.disclosure === "full"
  // Reasoning parts itself from the block after it; the message's last block
  // leaves the gap to the next message's own margin.
  const reasoningBlock = (content: string, last: boolean) => (
    <Show
      when={reasoningOpen()}
      fallback={
        <box marginBottom={gapAfter(last)}>
          <text wrapMode="none" truncate style={{ fg: theme.textMuted }}>
            {formatThoughtLine(content, thoughtWidth())}
          </text>
        </box>
      }
    >
      {reasoningMarkdownBlock(content, last)}
    </Show>
  )
  const gapAfter = (last: boolean) => {
    if (last) return 0
    return 1
  }
  const reasoningMarkdownBlock = (content: string, last = false) => (
    <box flexDirection="column" marginBottom={gapAfter(last)}>
      <markdown
        syntaxStyle={props.syntaxStyle()}
        streaming
        internalBlockMode="top-level"
        tableOptions={ANSWER_TABLE}
        renderNode={reasoningBlocks()}
        content={reasoningMarkdown(content)}
        fg={theme.textMuted}
        conceal
      />
    </box>
  )

  return (
    <box marginTop={contentMargin()} paddingLeft={ANSWER_INDENT} flexDirection="column">
      {/* The feed writes a segment for every assistant part, so an answer with
          no segments has no text, no reasoning, no image and no tool call to
          draw either. */}
      <Show when={segments().length > 0}>
        <For each={drawnSegments()}>
          {({ segment, run }, index) =>
            Match.value(segment).pipe(
              Match.tagsExhaustive({
                reasoning: (segment) =>
                  reasoningBlock(segment.content, index() === drawnSegments().length - 1),
                image: (segment) => (
                  <text style={{ fg: theme.info }}>
                    [Image: {segment.image.mediaType.replace("image/", "")}]
                  </text>
                ),
                "tool-call": (segment) => (
                  <ToolCallGroup
                    calls={Option.match(run, {
                      onNone: () => [segment.toolCall],
                      onSome: (value) => [...value.calls],
                    })}
                    reasoning={Option.match(run, {
                      onNone: () => new Map<string, ReadonlyArray<string>>(),
                      onSome: (value) => value.reasoning,
                    })}
                    closing={Option.match(run, {
                      onNone: () => [],
                      onSome: (value) => value.closing,
                    })}
                    renderReasoning={reasoningMarkdownBlock}
                    runOpen={Option.exists(run, (value) => value.open)}
                    disclosure={props.disclosure}
                    fullDetail={props.fullDetail}
                  />
                ),
                text: (segment) => (
                  <markdown
                    syntaxStyle={props.syntaxStyle()}
                    streaming
                    internalBlockMode="top-level"
                    tableOptions={ANSWER_TABLE}
                    renderNode={answerBlocks()}
                    content={segment.content}
                    conceal
                  />
                ),
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
  /** Reasoning the run took, by the id of the call it came before: the full level draws it. */
  reasoning: ReadonlyMap<string, ReadonlyArray<string>>
  /** Reasoning the run took from before the text that ended it: the full level draws it last. */
  closing: ReadonlyArray<string>
  /** Draws reasoning; `last` drops the gap after it, where the group's own block ends. */
  renderReasoning: (content: string, last?: boolean) => JSX.Element
  /** A later step may still join the group's run, so its last call is not yet its last. */
  runOpen: boolean
  disclosure: DisclosureLevel
  fullDetail: boolean
}) {
  const { theme } = useTheme()
  const { pathPlace } = useClient()
  const dimensions = useTerminalDimensions()
  const activity = createMemo(() => props.calls.map((call) => toActivityCall(call, pathPlace())))
  // A cut call (the turn's interrupt, the cell's cancel) is no failure.
  const failed = () => props.calls.some((call) => call.status === "error" && !cutShort(call))
  const opsFailed = () =>
    activity().some((call) =>
      call.operations.some(
        (operation) => operation.outcome === "failed" || operation.outcome === "cancelled",
      ),
    )
  const running = () => props.calls.some((call) => call.status === "running")
  const tick = useSpinnerClock()
  // A call that failed is the group's failure; ops that failed inside a cell
  // that recovered, or a command that exited nonzero, are a warning; the
  // pulse runs while a call does.
  const symbol = () => {
    if (failed()) return "✗"
    if (running()) return workingIconFrame(tick())
    return "●"
  }
  const groupColor = () => {
    if (failed()) return theme.error
    if (opsFailed()) return theme.warning
    return theme.textMuted
  }
  // The columns right of the group's glyph or connector and its space: every
  // surface that draws the header or the rows (the live tail, a history
  // commit) keeps the terminal's last column free.
  const lineWidth = () => dimensions().width - ANSWER_INDENT - FREE_LAST_COLUMN - 2
  // Every reasoning segment the run took counts as a thought; one with no text is none.
  const thoughts = () =>
    [...props.closing, ...Array.from(props.reasoning.values()).flat()].filter(
      (content) => content.trim().length > 0,
    ).length
  const header = createMemo(() => formatActivityHeader(activity(), lineWidth(), thoughts()))
  // The transcript view and the full level both open every row.
  const rowsOpen = () => props.fullDetail || props.disclosure === "full"
  // Collapsed draws one line under the header for each failure, so a failure
  // shows at every level.
  const failureRows = createMemo(() => {
    if (props.fullDetail || props.disclosure !== "collapsed") return []
    return collapsedOperations(activity())
  })
  // Preview draws a row per run of one tool, in past-tense words.
  const toolRows = createMemo(() => {
    if (props.fullDetail || props.disclosure !== "preview") return []
    return activityRows(activity())
  })
  // The run's last command row draws the head of its output, but only once
  // the run has ended: while a step may still join, the last command changes,
  // and a head drawn for one step and dropped at the next would shrink the
  // live tail (its freed rows reach scrollback blank). A failed row's op has
  // settled, so its head is final at once.
  const lastCommandRow = createMemo(() => {
    if (props.runOpen) return -1
    return toolRows().findLastIndex((row) => row.tool === "bash")
  })
  const rowHead = (row: ReturnType<typeof activityRows>[number], index: number) => {
    if (row.outcome !== "failed" && index !== lastCommandRow()) return Option.none<OutputHead>()
    const operation = Option.fromUndefinedOr(row.operations.at(-1))
    return Option.flatMap(operation, (value) =>
      Option.fromUndefinedOr(value.source).pipe(
        Option.flatMap((source) => outputHead(source, HEAD_LINES)),
        // A saved receipt has no output to read: its reason is the head.
        Option.orElse(() =>
          Option.map(
            Option.liftPredicate(value.reason ?? "", (reason) => reason.length > 0),
            (reason): OutputHead => ({ lines: [reason], hidden: 0 }),
          ),
        ),
      ),
    )
  }
  // A cancel is the reader's own act, a warning; a failure is an error.
  const endingColor = (outcome: ActivityOutcome) => {
    if (outcome === "cancelled") return theme.warning
    return theme.error
  }
  const connector = (index: number, count: number) => {
    if (index === count - 1) return "└"
    return "├"
  }
  return (
    <Show when={props.calls.length > 0}>
      <box flexDirection="column">
        <Show when={!props.fullDetail}>
          <text wrapMode="none" truncate style={{ fg: groupColor() }}>
            {symbol()} {header()}
          </text>
        </Show>
        <For each={failureRows()}>
          {(operation, index) => (
            <text wrapMode="none" truncate style={{ fg: endingColor(operation.outcome) }}>
              {connector(index(), failureRows().length)} {formatFailureRow(operation, lineWidth())}
            </text>
          )}
        </For>
        <For each={toolRows()}>
          {(row, index) => {
            const text = () => formatActivityRow(row, lineWidth())
            const color = () => {
              if (row.outcome === "succeeded" || row.outcome === "running") return theme.textMuted
              return endingColor(row.outcome)
            }
            return (
              <box flexDirection="column">
                <text wrapMode="none" truncate style={{ fg: color() }}>
                  {connector(index(), toolRows().length)} {text().head}
                  <Show when={Option.getOrUndefined(text().diff)}>
                    {(diff) => (
                      <>
                        <span style={{ fg: theme.success }}> +{diff().added}</span>
                        <span style={{ fg: color() }}> / </span>
                        <span style={{ fg: theme.error }}>-{diff().removed}</span>
                      </>
                    )}
                  </Show>
                  {text().tail}
                </text>
                <Show when={Option.getOrUndefined(rowHead(row, index()))}>
                  {(head) => <OutputHeadRows head={head()} width={lineWidth() - 2} />}
                </Show>
              </box>
            )
          }}
        </For>
        <Show when={rowsOpen()}>
          <For each={props.calls}>
            {(call, index) => {
              const color = () => {
                if (call.status === "error") return theme.error
                return theme.textMuted
              }
              const status = () => {
                if (call.status === "running") return " · running"
                if (Predicate.isNotUndefined(call.durationMs))
                  return ` · ${formatDuration(call.durationMs, "precise")}`
                return ""
              }
              // A cell row names what the cell did; other tools show their leading argument.
              const label = () => {
                if (call.toolName === "cell") {
                  const result = cellResultText(call)
                  return formatCellRowLabel(toActivityCall(call, pathPlace()), {
                    code: getString(call.input, "code"),
                    display: result.display,
                    error: result.error,
                  })
                }
                const args = toolArgSummary(call.toolName, call.input, pathPlace())
                if (args.length > 0) return args
                const summary = (call.summary ?? "").trim()
                if (summary.startsWith("{") || summary.startsWith("[")) return ""
                return summary.split("\n")[0]
              }
              const counts = () => {
                const text = rowCounts(call)
                if (text.length === 0) return ""
                return ` · ${text}`
              }
              // A blank line parts each open row from the last, as it parts
              // transcript blocks.
              const gap = () => {
                if (index() > 0) return 1
                return 0
              }
              return (
                <box flexDirection="column" marginTop={gap()}>
                  {/* The open rows draw the reasoning a step gave before this call. */}
                  <For each={props.reasoning.get(call.id) ?? []}>
                    {(content) => props.renderReasoning(content)}
                  </For>
                  {/* A failed call draws its renderer's frame, which names its id and reason. */}
                  <Show
                    when={call.status === "error"}
                    fallback={
                      <box flexDirection="column">
                        <box flexDirection="row">
                          <text
                            flexGrow={1}
                            flexShrink={1}
                            wrapMode="none"
                            truncate
                            style={{ fg: color() }}
                          >
                            {connector(index(), props.calls.length)} {call.toolName} {label()}
                            {counts()}
                            {status()}
                          </text>
                          <text flexShrink={0} wrapMode="none" style={{ fg: theme.textMuted }}>
                            {" "}
                            #{formatToolCallIdentity(call.id)}
                          </text>
                        </box>
                        <ToolFrameBody>
                          <OpenToolCall toolCall={call} />
                        </ToolFrameBody>
                      </box>
                    }
                  >
                    <OpenToolCall toolCall={call} />
                  </Show>
                </box>
              )
            }}
          </For>
          <Show when={props.closing.length > 0}>
            <box flexDirection="column" marginTop={1}>
              <For each={[...props.closing]}>
                {(content, index) =>
                  props.renderReasoning(content, index() === props.closing.length - 1)
                }
              </For>
            </box>
          </Show>
        </Show>
      </box>
    </Show>
  )
}

/**
 * A call's own output under its preview row, one line a row behind a `│ `
 * gutter, then the count of the lines left out and the key that shows them.
 * `width` is the columns a line has after the gutter.
 */
function OutputHeadRows(props: { head: OutputHead; width: number }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" paddingLeft={2}>
      <For each={[...props.head.lines]}>
        {(line) => (
          <text wrapMode="none" truncate style={{ fg: theme.textMuted }}>
            │ {truncate(line, props.width)}
          </text>
        )}
      </For>
      <Show when={props.head.hidden > 0}>
        <text wrapMode="none" truncate style={{ fg: theme.textMuted }}>
          │{" "}
          <span style={{ fg: theme.textMuted, dim: true }}>
            {formatPreviewFooter(props.head.hidden)}
          </span>
        </text>
      </Show>
    </box>
  )
}

/** A call opened at the full level: its registered renderer, else the generic frame. */
function OpenToolCall(props: { toolCall: ToolCall }) {
  return (
    <RegisteredToolCall
      toolCall={props.toolCall}
      expanded={true}
      fallback={
        <ToolCallIdentityProvider id={props.toolCall.id}>
          <GenericToolRenderer toolCall={props.toolCall} expanded />
        </ToolCallIdentityProvider>
      }
    />
  )
}

interface MessageListProps {
  items: SessionItem[]
  disclosure: DisclosureLevel
  fullDetail?: boolean
  syntaxStyle: () => SyntaxStyle
}

export function MessageList(props: MessageListProps) {
  // The transcript view (full detail) draws each message's own calls. Every
  // other view draws runs across steps: the native transcript's own, which
  // see every item, else the runs of the items given here.
  const shared = useContext(ToolRunsContext)
  const runs = createMemo((): ToolRuns => {
    // On its own the list knows no running turn: it draws a settled transcript.
    if (props.fullDetail === true) return projectToolRuns(props.items, false, false)
    return Option.match(shared, {
      onNone: () => projectToolRuns(props.items, true, false),
      onSome: (read) => read(),
    })
  })
  return (
    <FoldOperationsProvider value={props.fullDetail !== true}>
      <box flexDirection="column">
        <For each={props.items}>
          {(item) =>
            (() => {
              if (!isMessageItem(item)) {
                return (
                  <SessionEventIndicator
                    event={item}
                    open={props.fullDetail === true || props.disclosure === "full"}
                  />
                )
              }
              return (
                <Show
                  when={item.role === "user"}
                  fallback={
                    <AssistantMessage
                      id={item.id}
                      runs={runs()}
                      content={item.content}
                      reasoning={item.reasoning}
                      images={item.images}
                      segments={item.segments}
                      disclosure={props.disclosure}
                      fullDetail={props.fullDetail === true}
                      syntaxStyle={props.syntaxStyle}
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
                    disclosure={props.disclosure}
                    fullDetail={props.fullDetail === true}
                  />
                </Show>
              )
            })()
          }
        </For>
      </box>
    </FoldOperationsProvider>
  )
}

// ── transcript fingerprint ──────────────────────────────────────────────────

/**
 * What a transcript item looks like on screen, as a value that does not depend
 * on how the item was built.
 *
 * Native history compares items with what already reached scrollback.
 * The fingerprint names the drawn fields in a
 * fixed order, so an item rebuilt with the same fields gives the same value;
 * new text, a completed tool call, and a changed event change it.
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
      item.outcome,
      item.reason,
    ])
  return encodeFingerprint([item._tag, item.createdAt, item.seq])
}

/**
 * Each item's fingerprint as history compares it. A message that heads a
 * tool run draws the run's later steps too, so its value holds them: a run
 * that grows after history took its head replays.
 */
const historyFingerprints = (
  items: ReadonlyArray<SessionItem>,
  runs: ToolRuns,
): ReadonlyArray<string> =>
  items.map((item) => {
    const own = transcriptFingerprint(item)
    if (!isMessageItem(item)) return own
    const headed = runs.headedBy.get(item.id) ?? []
    if (headed.length === 0) return own
    return encodeFingerprint([
      own,
      headed.map((run) => [
        run.calls.map(toolFingerprint),
        Array.from(run.reasoning.values()),
        run.closing,
      ]),
    ])
  })

/** A call still running, a cell's inner operation included. */
const isRunningCall = (call: ToolCall): boolean =>
  call.status === "running" || (call.operations ?? []).some(isRunningCall)

/**
 * Whether an item draws its last look, which is all history may take. While
 * a turn runs, a streamed answer waits for the stored answer that replaces
 * it, a queued follow-up has not run, a pending retry counts down, and a
 * running call has rows still to change. A message that heads a tool run
 * waits for the run to end: a later step's calls draw at its head, so it
 * moves only once no step can join, none of the run's calls runs, and no
 * step of it is still streamed. Once no turn runs, every item is final:
 * nothing is left to change them, and a row that does change later is
 * replayed.
 */
const isFinalItem = (item: SessionItem, turnRunning: boolean, runs: ToolRuns): boolean => {
  if (!turnRunning) return true
  if (isMessageItem(item))
    return (
      item.draft !== true &&
      Predicate.isUndefined(item.pendingMode) &&
      !messageToolCalls(item).some(isRunningCall) &&
      (runs.headedBy.get(item.id) ?? []).every(
        (run) => !run.open && !run.streamed && !run.calls.some(isRunningCall),
      )
    )
  if (item._tag === "retrying") return item.outcome !== "pending"
  return true
}

// ── transcript display ──────────────────────────────────────────────────────

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
  if (isMessageItem(item)) return item.id
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
    if (!isMessageItem(item)) continue
    messages.set(item.id, {
      content: item.content,
      reasoning: item.reasoning,
      imageCount: item.images.length,
      segments: (item.segments ?? []).map(segmentContent),
      tools: new Map(messageToolCalls(item).map((tool) => [tool.id, toolIdentity(tool)])),
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
  return {
    ...message,
    content: afterPrefix(message.content, boundary.content),
    reasoning: afterPrefix(message.reasoning, boundary.reasoning),
    images: message.images.slice(boundary.imageCount),
    segments: Option.getOrUndefined(
      Option.map(Option.fromNullishOr(message.segments), () => segments),
    ),
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
    if (!isMessageItem(item)) continue
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
const SPLIT_FOOTER_RESERVED_OUTPUT_ROWS = 2

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

/** How long one commit waits for its highlights before it is tried again. */
const SETTLE_BUDGET_MS = 2000

/**
 * How many times an item waits for its highlights. The last try draws the
 * item as plain text (`PlainHistoryContext`), so a dead highlight worker
 * neither holds history back for good nor leaves its marks or blanks there.
 */
const SETTLE_TRIES = 3

/**
 * How long a plain draw waits for what still highlights in it (a tool's
 * code), before its rows commit as drawn: such text shows unstyled.
 */
const PLAIN_SETTLE_MS = 100

/**
 * How one commit ended: its rows reached history (`landed`); the screen
 * changed hands or the display was cleared (`refused`); its highlights missed
 * the budget (`unsettled`); or an item before it came back, so it waits for
 * the next pass (`stale`).
 */
type CommitOutcome = "landed" | "refused" | "unsettled" | "stale"

/** How long exit waits for the live view's last commits. */
const EXIT_FLUSH_MS = 1500

/** An item's rows from `from` up to `to`, or to its last row when `to` is `None`. */
interface RowRange {
  readonly from: number
  readonly to: Option.Option<number>
}

/** Where the split region sits: the terminal rows above it (`top`) and its height (`rows`). */
interface RegionPlace {
  readonly top: number
  readonly rows: number
}

/**
 * The region's place on the terminal. opentui keeps the rows above the
 * region in a field it does not publish; a renderer without it reads as a
 * region at the bottom of the terminal.
 */
const RegionOffset = Schema.Struct({ renderOffset: Schema.Finite })
const regionPlace = (renderer: CliRenderer): RegionPlace => {
  const rows = renderer.footerHeight
  return Schema.decodeUnknownOption(RegionOffset)(renderer).pipe(
    Option.match({
      onSome: ({ renderOffset }) => ({ top: renderOffset, rows }),
      onNone: () => ({ top: Math.max(0, renderer.terminalHeight - rows), rows }),
    }),
  )
}

/** The last commits of each live transcript, by the renderer it draws on. */
const exitFlushes = new WeakMap<CliRenderer, Effect.Effect<void>>()

/**
 * Moves what the live view still holds into native history, so exit loses
 * no turn: destroying the renderer clears the split region. A turn still in
 * flight commits as drawn. Waits at most `EXIT_FLUSH_MS`, then lets go.
 */
export const flushTranscriptForExit = (renderer: CliRenderer): Effect.Effect<void> =>
  Option.getOrElse(Option.fromUndefinedOr(exitFlushes.get(renderer)), () => Effect.void)

/** The escape that moves the terminal's cursor up `rows` rows. */
const cursorUp = (rows: number): string => `${String.fromCharCode(27)}[${rows}A`

/**
 * Every way gent leaves the terminal: the reader's exit, a signal, a fatal
 * error. The live view's last items reach native history first
 * (`flushTranscriptForExit`, bounded), then the renderer goes. Its destroy
 * clears the split region and leaves the cursor under it, so the cursor
 * goes back up by the region's rows: what the shell writes next follows the
 * transcript with no empty rows between.
 */
export const leaveTerminal = (
  renderer: CliRenderer,
  writeTerminal: (text: string) => void,
): Effect.Effect<void> =>
  flushTranscriptForExit(renderer).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (renderer.isDestroyed) return
        const regionRows = Option.liftPredicate(
          renderer.height,
          () => renderer.screenMode === "split-footer",
        )
        renderer.destroy()
        Option.map(regionRows, (rows) => writeTerminal(cursorUp(rows)))
      }),
    ),
  )

/**
 * Holds the process until the renderer is destroyed: OpenTUI mounts
 * synchronously, and a bare suspended fiber does not keep Bun alive.
 * Interrupted (a signal, the session's shutdown), it leaves the terminal as
 * the reader's exit does.
 */
export const holdUntilRendererDestroyed = (
  renderer: CliRenderer,
  writeTerminal: (text: string) => void,
): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    let settled = false
    const keepAlive = setInterval(() => {}, 60_000) // eslint-disable-line effect/noGlobals -- OpenTUI needs a process-lifetime handle until renderer destruction.
    const onDestroy = () => {
      if (settled) return
      settled = true
      clearInterval(keepAlive)
      resume(Effect.void)
    }
    renderer.once("destroy", onDestroy)
    return Effect.suspend(() => {
      if (settled) return Effect.void
      settled = true
      clearInterval(keepAlive)
      renderer.off("destroy", onDestroy)
      return leaveTerminal(renderer, writeTerminal)
    })
  })

/**
 * Transcript rows keep the terminal's last column free. OpenTUI writes a
 * committed row and then erases to the line's end; after a row that fills
 * the last column the cursor still sits on it (the wrap is pending), so an
 * xterm-like terminal erases that column: a table's right border would be
 * lost in history. The live view keeps the same column free, so an item
 * commits at the width it showed.
 */
const FREE_LAST_COLUMN = 1

interface NativeTranscriptProps {
  items: SessionItem[]
  /** The items are final: no source still derives rows that would land among them. */
  settled: boolean
  streaming: boolean
  footerHeight: number
  /**
   * Growing UI is docked in the footer: a pane or the suggestions. Its rows
   * cover the live tail's last rows; they never move the transcript.
   */
  paneOpen: boolean
  expanded: boolean
  disclosure: DisclosureLevel
  displayRevision: number
  overlayOpen: boolean
  renderItems: (items: SessionItem[]) => JSX.Element
  children: JSX.Element
}

/**
 * Owns native history snapshots. The session feed remains the source of truth.
 *
 * The split region draws the footer and, above it, the live tail: the
 * transcript's last rows. OpenTUI draws only the region's own rows, and rows
 * the region pushes up when it grows at the terminal's bottom go to the
 * terminal's scrollback for good; a shrink there leaves the freed rows
 * empty. So the tail keeps the transcript's last `canvas` rows: the rows the
 * region can show when the footer is at its smallest. Rows above them move
 * into history, a final item's rows in order, the top rows of an item first
 * when the session is idle. In a long session the region then takes every
 * row it may at once and keeps them: the footer's base (composer, status, the
 * activity row while a turn runs) and the tail share them, and growing UI
 * docked in the footer covers the tail's last rows rather than growing the
 * region. Closing it shows those rows again, and a smaller footer shows the
 * tail rows it kept above.
 */
export function NativeTranscript(props: NativeTranscriptProps) {
  const renderer = useRenderer()
  const ext = useExtensionUI()
  const owner = getOwner()
  const diagramLibrary = useContext(DiagramLibraryContext)
  const dimensions = useTerminalDimensions()
  const [ready, setReady] = createSignal(false)
  const [nativeOutputReady, setNativeOutputReady] = createSignal(false)
  const [committed, setCommitted] = createSignal<ReadonlyArray<string>>([])
  const committedCount = () => committed().length
  const [liveHeight, setLiveHeight] = createSignal(0)
  const [measurementVersion, setMeasurementVersion] = createSignal(0)
  const itemHeights = new Map<SessionItem, number>()
  /**
   * Records the rows `box` draws for `item`. OpenTUI reports a box of no rows
   * as one row and sends no size change between them, so the rows come from
   * the Yoga layout: a step whose call its run's head took draws none.
   */
  const measureItem = (item: SessionItem, box: BoxRenderable) => {
    const rows = Math.max(0, Math.round(box.getLayoutNode().getComputedHeight()))
    if (itemHeights.get(item) === rows) return
    itemHeights.set(item, rows)
    setMeasurementVersion((version) => version + 1)
  }
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
   * A commit writes history only while it is the newest: rows coming back to
   * the live view, a replay or a clear take a newer one, so commits drawn
   * before that point never land. The key is constant: only those overtake a
   * commit.
   */
  const commits = repliesInView(() => "commit")
  /** Rows commits moved into history since the region was last sized. */
  let releasedRows = 0
  /** Rows commits queued that no frame has written yet: the region does not grow over them. */
  let unflushedRows = 0
  /**
   * The top rows of the first live item that history already holds. The live
   * view cuts them off, so no row shows twice.
   */
  const [partialRows, setPartialRows] = createSignal(0)
  /** The fingerprint of the item whose top rows history holds. */
  let partialFingerprint = ""
  /** The rows of `items[queued]` offered to history, landed or still in flight. */
  let queuedRows = 0
  /** Rows offered to history whose commit has not landed. The live view still shows them. */
  let pendingRows = 0
  /**
   * The smallest footer base since the transcript was last laid out from the
   * start. The live tail keeps the rows the region shows at that base, so a
   * base that shrinks back (a turn that ends) shows kept rows, never blank ones.
   */
  let footerFloor = Option.none<number>()
  /**
   * The fingerprints history was last checked against as a prefix. A commit
   * lands only while the item it drew still has the fingerprint these hold at
   * its place (`stillOffered`), so a landed commit keeps the proof true.
   */
  let prefixCheckedFor: ReadonlyArray<string> = []
  /** The tries each item's highlights missed, by fingerprint, until it lands. */
  const unsettledTries = new Map<string, number>()
  const [displayBoundary, setDisplayBoundary] = createSignal(captureTranscriptDisplay([]))
  const displayedItems = createMemo(() => projectTranscriptDisplay(props.items, displayBoundary()))
  /** The tool runs across the displayed items: each item draws alone, so its run comes from here. */
  const toolRuns = createMemo(() => projectToolRuns(displayedItems(), true, props.streaming))
  let viewport = Option.none<ScrollBoxRenderable>()
  let settlingNative = false
  /** The split region's height as the alternate screen took over. */
  let leftRows = Option.none<number>()
  /** A return from the alternate screen waits for its first frame (`afterReturnFrame`). */
  let returnFramePending = false
  const [replayPending, setReplayPending] = createSignal(false)
  /**
   * The footer without the growing UI docked in it. While a pane or the
   * suggestions are open it keeps the height the footer had before, so the
   * pane's rows cover the tail instead of moving it. The first height the
   * footer reports after the pane closes was still laid out with the pane,
   * so it is not a base either; the next one is.
   */
  const [baseFooter, setBaseFooter] = createSignal(props.footerHeight)
  createEffect(
    on(
      () => [props.paneOpen, props.footerHeight] as const,
      ([open, footer], previous) => {
        if (open) return
        if (Predicate.isNotUndefined(previous) && previous[0] && previous[1] === footer) return
        setBaseFooter(footer)
      },
    ),
  )
  /** The rows the split region may take: the terminal less the rows kept for scrollback. */
  const regionMax = () => splitFooterHeight(dimensions().height, dimensions().height)
  /**
   * Rows the live tail may take below native history: what the split region
   * leaves after the footer's base. The region is at most `regionMax` rows,
   * not the full terminal, so a tail sized against the terminal pushes the
   * last footer rows (the status line, a docked tray) below the last
   * terminal row.
   */
  const liveRows = () => Math.max(0, regionMax() - baseFooter())
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
    // A commit still settling was drawn for the screen the replay clears:
    // it comes back, and the replay offers its item again.
    commits.take()
    footerFloor = Option.none()
    batch(() => {
      setNativeOutputReady(false)
      setReplayPending(true)
      setCommitted([])
      queued = 0
      queuedRows = 0
      pendingRows = 0
      setPartialRows(0)
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
  // One worker takes the commits off a queue in the order they were asked; a
  // semaphore would not keep that order, as a new taker can pass a waiting one.
  // Cleanup ends the queue: a task still queued then finds the transcript
  // disposed and does nothing, and the worker stops.
  let disposed = false
  const nativeTasks = Effect.runSync(Queue.unbounded<Effect.Effect<void>, Cause.Done>())
  Effect.runFork(
    Stream.fromQueue(nativeTasks).pipe(
      Stream.runForEach((task) =>
        Effect.suspend(() => {
          if (disposed || renderer.isDestroyed) return Effect.void
          return task
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("transcript.native-commit-failed").pipe(
              Effect.annotateLogs({ cause: String(cause) }),
            ),
          ),
        ),
      ),
    ),
  )
  const enqueueNative = (task: Effect.Effect<void>) => {
    Queue.offerUnsafe(nativeTasks, task)
  }

  /** Scrollback accepts a commit only while the split footer owns the screen. */
  const canCommitNatively = () =>
    renderer.screenMode === "split-footer" && renderer.externalOutputMode === "capture-stdout"

  /**
   * Set once the reader leaves. A commit still settling stops waiting for
   * its highlight, and every commit from then on draws plain: exit cannot
   * wait out a highlight's budget.
   */
  const leaving = Deferred.makeUnsafe<void>()
  const isLeaving = () => Deferred.isDoneUnsafe(leaving)

  /**
   * Draws `items` on a new scrollback surface, plain or highlighted. The
   * surface and the rows drawn on it go together once the commit ends.
   */
  const drawSurface = (items: SessionItem[], plain: boolean) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const surface: ScrollbackSurface = renderer.createScrollbackSurface()
        const surfaceRenderer = Object.create(surface.renderContext)
        Object.defineProperties(surfaceRenderer, {
          root: { get: () => surface.root, enumerable: true },
          width: { get: () => surface.width, enumerable: true },
          height: { get: () => surface.height, enumerable: true },
        })
        const dispose = Option.fromNullishOr(
          runWithOwner(owner, () =>
            createRoot((dispose) => {
              insert(surface.root, () => (
                <RendererContext.Provider value={surfaceRenderer}>
                  <PlainHistoryContext.Provider value={plain}>
                    <ToolRunsContext.Provider value={Option.some(toolRuns)}>
                      <box flexDirection="column" paddingRight={FREE_LAST_COLUMN}>
                        {props.renderItems(items)}
                      </box>
                    </ToolRunsContext.Provider>
                  </PlainHistoryContext.Provider>
                </RendererContext.Provider>
              ))
              return dispose
            }),
          ),
        )
        return { surface, dispose }
      }),
      ({ surface, dispose }) =>
        Effect.sync(() => {
          if (Option.isSome(dispose)) dispose.value()
          if (!surface.isDestroyed) surface.destroy()
        }),
    ).pipe(Effect.map(({ surface }) => surface))

  /**
   * Renders one item onto a scrollback surface, settles it, and commits its
   * rows. Reports whether the rows reached scrollback: an overlay that opens
   * while the surface settles takes the screen back, and scrollback rejects a
   * commit from the alternate screen. An item that did not commit stays in the
   * live view, so closing the overlay still shows it.
   *
   * A highlight that misses its budget is tried again: scrollback keeps
   * forever what it is given. The last try, and every commit once the
   * reader leaves, draws the item plain, unless history holds its top rows:
   * those were drawn, so the rest is drawn too.
   *
   * The rows move in place. `handOver` takes the item out of the live view
   * and shrinks the split region by its rows before the rows are queued, so
   * the region's top stays where it was and the commit writes the rows into
   * the space the item left, moving the region back down to the last row.
   * In the other order the commit would scroll the screen first and the
   * shrink would then leave the item's rows empty under the status row.
   * A write that scrollback refuses gives it all back (`handOver`'s undo).
   *
   * `rows` picks the item's rows to commit: its top rows while the rest still
   * shows, or the rest. Rows the live view had already scrolled out of sight
   * leave the region as it was: they are written above it.
   */
  const commitItems = (
    items: SessionItem[],
    rows: RowRange,
    commit: ReplyWriter,
    lastTry: boolean,
    handOver: (rows: number) => () => void,
    stillOffered: () => boolean,
  ): Effect.Effect<CommitOutcome> =>
    Effect.suspend(() => {
      // An item queued behind one that came back waits for the next pass.
      if (!commit.live()) return Effect.succeed("stale")
      // The item may also have changed while it settled (its text replaced, a
      // call's result in): rows drawn from the old item never land.
      const stillCurrent = () => commit.live() && canCommitNatively() && stillOffered()
      if (!stillCurrent()) return Effect.succeed("refused")
      // The rows are the whole item, not its top rows or the rest of them.
      const whole = rows.from === 0 && Option.isNone(rows.to) // A whole item the live view drew with no row (a step whose call its
      // run's head took) lands with none. OpenTUI draws a surface at least
      // one row high, so its commit would put a blank row in history.
      if (whole && items.every((item) => itemHeights.get(item) === 0)) {
        handOver(0)
        return Effect.succeed("landed")
      }
      // Settling is asynchronous. The screen may have changed hands and the
      // reader may have cleared the display while it ran, so both are
      // checked again before the rows are handed over.
      const commitDrawn = (surface: ScrollbackSurface): Effect.Effect<CommitOutcome> =>
        Effect.suspend(() => {
          if (surface.isDestroyed || !stillCurrent()) return Effect.succeed("refused")
          // Drawn at the screen's size now: the rows commit at the width they show.
          surface.render()
          const end = Option.match(rows.to, {
            onNone: () => surface.height,
            onSome: (to) => Math.min(to, surface.height),
          })
          const start = Math.min(rows.from, end)
          const undo = handOver(end - start)
          // The rows end on their last row. A trailing newline would leave the
          // terminal on an empty row that OpenTUI counts as history, so on a
          // short screen the region would start a row under the rows: a blank
          // row between them. The next commit starts on a new row itself.
          return Effect.try(() => surface.commitRows(start, end, { trailingNewline: false })).pipe(
            Effect.as<CommitOutcome>("landed"),
            Effect.catch(() =>
              Effect.sync((): CommitOutcome => {
                undo()
                return "refused"
              }),
            ),
          )
        })
      // The plain layout has other rows than the live view, so only a whole
      // item draws plain. Rows of an item the live view shows in part (its
      // top rows, or the rest once history holds them) come from the drawn
      // layout, so they start and end at the rows the live view cuts. They
      // wait no longer than a plain draw.
      const commitLast = Effect.scoped(
        Effect.gen(function* () {
          const surface = yield* drawSurface(items, whole)
          yield* Effect.tryPromise(() => surface.settle(PLAIN_SETTLE_MS)).pipe(Effect.ignore)
          return yield* commitDrawn(surface)
        }),
      )
      if (lastTry || isLeaving()) return commitLast
      return Effect.scoped(
        Effect.gen(function* () {
          const surface = yield* drawSurface(items, false)
          const settled = yield* Effect.tryPromise(() => surface.settle(SETTLE_BUDGET_MS)).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
            Effect.raceFirst(Deferred.await(leaving).pipe(Effect.as(false))),
          )
          if (settled) return yield* commitDrawn(surface)
          if (isLeaving()) return yield* commitLast
          return "unsettled"
        }),
      )
    })

  /**
   * Give the item back to the live view, and every item queued behind it:
   * history is written in transcript order, so none of them may land before
   * it. A later pass offers them again.
   */
  const rewind = () => {
    commits.take()
    queued = untrack(committedCount)
    queuedRows = untrack(partialRows)
    // Every offer still in flight is behind the one that came back: none lands.
    pendingRows = 0
    setRetryVersion((version) => version + 1)
  }

  /**
   * Hands rows of one item to native history and, only as they land, drops
   * them from the live view: the whole item, or its top rows (`partialRows`).
   * A commit that could not happen leaves the counters untouched, so the rows
   * stay visible and a later pass retries them.
   */
  const write = (item: SessionItem, fingerprintValue: string, range: RowRange) => {
    const tries = unsettledTries.get(fingerprintValue) ?? 0
    const commit = commits.newest()
    const completes = Option.isNone(range.to)
    // The live tail gives up the rows in the same update that drops them, so
    // the region shrinks before the rows are queued, not a layout later.
    const handOver = (rows: number) => {
      const liveRowsGiven = Option.match(range.to, {
        onNone: () => (itemHeights.get(item) ?? range.from + rows) - range.from,
        onSome: (to) => to - range.from,
      })
      releasedRows += rows
      unflushedRows += rows
      pendingRows = Math.max(0, pendingRows - liveRowsGiven)
      batch(() => {
        if (completes) {
          setCommitted((values) => [...values, fingerprintValue])
          setPartialRows(0)
        } else {
          partialFingerprint = fingerprintValue
          setPartialRows(range.from + liveRowsGiven)
        }
        setLiveHeight((height) => Math.max(0, height - liveRowsGiven))
      })
      // Sized here as well as by the effect: the commit is queued next, and
      // a commit queued before the shrink would scroll the screen first.
      untrack(() => sizeRegion(false))
      // The write did not happen: the rows and the region come back.
      return () => {
        releasedRows = Math.max(0, releasedRows - rows)
        unflushedRows = Math.max(0, unflushedRows - rows)
        batch(() => {
          if (completes) {
            setCommitted((values) => values.filter((value) => value !== fingerprintValue))
          }
          setPartialRows(range.from)
          setLiveHeight((height) => height + liveRowsGiven)
        })
        untrack(() => sizeRegion(false))
      }
    }
    enqueueNative(
      commitItems(
        [item],
        range,
        commit,
        tries + 1 >= SETTLE_TRIES,
        handOver,
        // Commits land in transcript order, so this item is the next after history.
        () => untrack(fingerprints)[untrack(committedCount)] === fingerprintValue,
      ).pipe(
        Effect.andThen((outcome) =>
          Effect.sync(() => {
            if (outcome === "stale") return
            if (outcome === "unsettled") unsettledTries.set(fingerprintValue, tries + 1)
            if (outcome !== "landed") return rewind()
            unsettledTries.delete(fingerprintValue)
          }),
        ),
        Effect.onError(() => Effect.sync(rewind)),
      ),
    )
  }

  /**
   * Offers the rows of `items[queued]` from the last offered row up to `to`,
   * or to its end (`None`), and moves the offer mark past them.
   */
  const offer = (item: SessionItem, fingerprintValue: string, to: Option.Option<number>) => {
    const from = queuedRows
    write(item, fingerprintValue, { from, to })
    pendingRows += Option.match(to, {
      onNone: () => Math.max(0, (itemHeights.get(item) ?? from) - from),
      onSome: (end) => end - from,
    })
    if (Option.isSome(to)) {
      queuedRows = to.value
      return
    }
    queued++
    queuedRows = 0
  }

  /**
   * Starts history again from the screen's top. Every caller writes the
   * transcript's rows again, so the reset also clears the terminal's saved
   * lines: the copy they hold would show each row twice. Scrollback cannot
   * lose some of its rows and keep others, so the shell's lines above gent go
   * too. Only the first transcript keeps them: nothing of gent is above it.
   */
  const resetHistory = () => {
    // The reset drops the queued rows with the rest of history.
    unflushedRows = 0
    renderer.resetSplitFooterForReplay({ clearSavedLines: true })
  }

  /**
   * Draws the split region on the terminal's own screen again. The terminal
   * kept that screen behind the alternate one, and OpenTUI (patched, see
   * `patches/README.md`) keeps the split's history state for it: a return at
   * the same size takes the region back at the row it left, and the next
   * commit starts under the last history row, which ends mid-row.
   */
  const enterRegion = () => {
    renderer.screenMode = "split-footer"
    renderer.externalOutputMode = "capture-stdout"
    renderer.useMouse = false
  }

  // At exit every item the live view still holds commits, final or not,
  // plain; a commit still settling stops waiting. The queue's order makes
  // the drain wait for all of them. Exit over the alternate screen (the
  // palette, a pane that holds the composer, the expanded transcript) takes
  // the terminal's screen back first: scrollback takes no rows from there.
  const flushForExit = Effect.suspend(() => {
    Deferred.doneUnsafe(leaving, Exit.void)
    if (disposed) return Effect.void
    const away = Option.filter(leftRows, () => renderer.screenMode === "alternate-screen")
    if (Option.isSome(away)) {
      leftRows = Option.none()
      renderer.footerHeight = away.value
      enterRegion()
      // A resize while away left history for the old width: it starts again.
      if (replayPending()) enqueueNative(Effect.sync(resetHistory))
    }
    if (!canCommitNatively()) return Effect.void
    const items = displayedItems()
    const next = historyFingerprints(items, toolRuns())
    if (!untrack(committed).every((value, index) => next[index] === value)) return Effect.void
    while (queued < items.length) {
      const item = items[queued]
      const value = next[queued]
      if (!item || !Predicate.isString(value)) break
      offer(item, value, Option.none())
    }
    return Effect.gen(function* () {
      const drained = yield* Deferred.make<void>()
      enqueueNative(Deferred.done(drained, Exit.void))
      yield* Deferred.await(drained).pipe(Effect.timeout(EXIT_FLUSH_MS), Effect.ignore)
    })
  })
  exitFlushes.set(renderer, flushForExit)

  onMount(() => {
    renderer.footerHeight = props.footerHeight
    // The first transcript finds the renderer made in this mode; a later one
    // (another session or branch) finds the alternate screen the last one left.
    const later = renderer.screenMode !== "split-footer"
    if (later) renderer.screenMode = "split-footer"
    renderer.externalOutputMode = "capture-stdout"
    // Native history scrolls in the terminal. Mouse tracking would swallow the wheel.
    renderer.useMouse = false
    // A new transcript must not inherit the previous screen's cursor origin.
    // A later one writes its own history, which may share rows with the last.
    if (later) resetHistory()
    else renderer.resetSplitFooterForReplay()
    renderer.on("frame", afterCommitFrame)
    setReady(true)
  })

  onCleanup(() => {
    disposed = true
    if (exitFlushes.get(renderer) === flushForExit) exitFlushes.delete(renderer)
    Queue.endUnsafe(nativeTasks)
    renderer.off("frame", finishNativeReturn)
    renderer.off("frame", afterCommitFrame)
    renderer.off("frame", afterReturnFrame)
    if (renderer.isDestroyed) return
    renderer.externalOutputMode = "passthrough"
    renderer.screenMode = "alternate-screen"
    renderer.useMouse = true
  })

  createEffect(
    on(
      () => [dimensions().width, dimensions().height, props.disclosure] as const,
      (next, previous) => {
        if (
          Predicate.isUndefined(previous) ||
          next.every((value, index) => value === previous[index])
        )
          return
        requestReplay()
      },
    ),
  )

  createEffect(() => {
    if (!ready()) return
    if (props.expanded || props.overlayOpen) {
      setNativeOutputReady(false)
      renderer.off("frame", afterReturnFrame)
      returnFramePending = false
      if (renderer.screenMode === "split-footer") leftRows = Option.some(renderer.footerHeight)
      renderer.externalOutputMode = "passthrough"
      renderer.screenMode = "alternate-screen"
      // The expanded transcript owns scrolling, so the wheel must reach the scrollbox.
      renderer.useMouse = true
      return
    }
    // A return from the alternate screen (the palette, a picker, the
    // expanded transcript) finds the terminal's own screen as it was:
    // history above, and the region's rows, cleared, under it. Nothing
    // replays: the region takes the rows it left, and the items the live
    // view kept commit as they would have. The footer's size is still the
    // overlay's here, so the region takes the rows it had until the return's
    // first frame (`afterReturnFrame`).
    const returning = Option.filter(leftRows, () => renderer.screenMode === "alternate-screen")
    leftRows = Option.none()
    const replaying = replayPending()
    if (Option.isSome(returning) && !replaying) {
      renderer.footerHeight = returning.value
      returnFramePending = true
      renderer.once("frame", afterReturnFrame)
    } else untrack(() => sizeRegion(replaying))
    enterRegion()
    if (replayPending() && !settlingNative) {
      settlingNative = true
      renderer.once("frame", finishNativeReturn)
      // A resize, a disclosure change or an item that changed in history
      // replays all of history (`resetHistory`). Clear before the layout
      // frame; replay only after its measurements arrive.
      enqueueNative(
        Effect.sync(() => {
          resetHistory()
          renderer.requestRender()
        }),
      )
    }
    if (!settlingNative) setNativeOutputReady(true)
  })

  // The region follows the footer and the live tail while it draws on the
  // terminal's own screen. The effect above reads none of them: a region
  // that kept the rows it returned with would cut off the tail's last rows (a
  // turn's answer and its summary, which grew behind a picker) until a
  // commit sized it again.
  createEffect(
    on(
      () => [props.footerHeight, stickyRows(), liveHeight()] as const,
      () => {
        if (!ready() || props.expanded || props.overlayOpen || returnFramePending) return
        sizeRegion(replayPending())
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => [nativeOutputReady(), props.displayRevision] as const,
      ([ready, revision], _previous, consumed = 0) => {
        if (!ready || consumed === revision) return consumed
        const cleared = props.items
        // Bumped before the queue sees the reset: a commit already settling now
        // finds a stale stamp and drops its rows rather than writing history the
        // reader just dismissed.
        commits.take()
        // The boundary moves at once, so no later pass can offer a pre-clear
        // item again while the queue is still draining.
        batch(() => {
          setDisplayBoundary(captureTranscriptDisplay(cleared))
          setCommitted([])
          queued = 0
          queuedRows = 0
          pendingRows = 0
          setPartialRows(0)
        })
        // The reset takes the dismissed rows out of scrollback as well. It joins
        // the commit queue rather than jumping it, so the queue stays the
        // single writer of scrollback.
        enqueueNative(Effect.sync(resetHistory))
        return revision
      },
    ),
  )

  // Scrollback is immutable, so nothing commits until every client renderer
  // has loaded and every notice-row source has answered; the live view draws
  // the rows it has meanwhile. The live tail keeps the transcript's last
  // `canvas` rows: the rows the region shows when the footer is at its
  // smallest. Rows above them move into history in transcript order. While a
  // turn runs only a whole final item moves; once the session is idle the
  // top rows of an item move too, so every row is in history or on screen.
  // A measurement runs it again: what it reads per item it reads from the
  // memos below, so a growing tail costs the same in a session of any length.
  const fingerprints = createMemo(() => historyFingerprints(displayedItems(), toolRuns()))
  // An answer with a diagram commits once the diagram library has loaded,
  // so history never keeps its fence as code. Read in the memo, so the load
  // runs the pass again.
  const undrawn = createMemo(() => {
    const live = committedCount()
    return new Set(
      displayedItems().filter(
        (item, index) =>
          index >= live &&
          isMessageItem(item) &&
          item.role === "assistant" &&
          !diagramsDrawable(diagramLibrary, item.content),
      ),
    )
  })
  createEffect(() => {
    if (!ext.loaded() || !props.settled) return
    if (!nativeOutputReady() || props.expanded || props.overlayOpen) return
    const items = displayedItems()
    const next = fingerprints()
    const unfinished = undrawn()
    const runs = toolRuns()
    const turnRunning = props.streaming
    retryVersion()
    measurementVersion()
    const tailRows = liveHeight()
    const base = baseFooter()
    const pinnedRows = stickyRows()
    const maximum = regionMax()
    untrack(() => {
      if (!historyMatches(items, next)) {
        requestReplay()
        return
      }
      const floor = Option.match(footerFloor, {
        onNone: () => base,
        onSome: (rows) => Math.min(rows, base),
      })
      // A lower floor makes the canvas taller. Rows offered for the old one
      // and not landed would leave the tail short of it: they come back, and
      // this pass offers again for the new canvas.
      if (Option.exists(footerFloor, (rows) => floor < rows) && pendingRows > 0) rewind()
      footerFloor = Option.some(floor)
      // The rows the tail holds above the canvas, less those already offered.
      offerRows(items, next, {
        excess: tailRows - (maximum - floor - pinnedRows) - pendingRows,
        unfinished,
        turnRunning,
        runs,
      })
    })
  })

  /**
   * Whether history is still a prefix of the transcript. History grows only
   * from the fingerprints it was checked against: when the items change, the
   * prefix is checked again, and the heights of items gone are dropped.
   */
  const historyMatches = (
    items: ReadonlyArray<SessionItem>,
    next: ReadonlyArray<string>,
  ): boolean => {
    if (next === prefixCheckedFor) return true
    const prefixMatches =
      untrack(committed).every((value, index) => next[index] === value) &&
      (partialRows() === 0 || next[untrack(committedCount)] === partialFingerprint)
    if (!prefixMatches) return false
    prefixCheckedFor = next
    const currentItems = new Set(items)
    for (const item of itemHeights.keys()) {
      if (!currentItems.has(item)) itemHeights.delete(item)
    }
    return true
  }

  /**
   * Offers the transcript's rows above the canvas to history, in order. A
   * whole final item moves at any time; the top rows of an item move only
   * while no turn runs.
   */
  const offerRows = (
    items: ReadonlyArray<SessionItem>,
    next: ReadonlyArray<string>,
    plan: {
      readonly excess: number
      readonly unfinished: ReadonlySet<SessionItem>
      readonly turnRunning: boolean
      readonly runs: ToolRuns
    },
  ) => {
    let excess = plan.excess
    while (excess > 0 && queued < items.length) {
      const item = items[queued]
      if (!item || !isFinalItem(item, plan.turnRunning, plan.runs) || plan.unfinished.has(item))
        return
      const value = next[queued]
      const height = itemHeights.get(item)
      if (!Predicate.isString(value) || Predicate.isUndefined(height)) return
      // A row has one owner: native history or the live view. The live view
      // keeps it until the queued commit reports that it landed.
      const rest = height - queuedRows
      if (rest <= excess) {
        offer(item, value, Option.none())
        excess -= rest
        continue
      }
      if (plan.turnRunning) return
      offer(item, value, Option.some(queuedRows + excess))
      return
    }
  }

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
   * shows only while the live tail keeps a row of its own beside it. It draws
   * only while a turn runs, and not while history holds the top rows of the
   * first live item: at idle history takes them, and they stay there into the
   * next turn until the item moves whole, so the row would sit between that
   * item's rows in history and its rows on screen. The expanded transcript and
   * an overlay draw on the alternate screen, where nothing is pinned.
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
    // At idle history takes the top rows of the first live item, and they stay
    // there into the next turn until the item moves whole: the row would sit
    // between that item's rows in history and its rows on screen.
    if (!props.streaming || partialRows() > 0) return Option.none()
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

  /**
   * Sizes the split region: the footer and the live tail, at most
   * `regionMax` rows. In a long session the tail holds more rows than the
   * region shows, so the region takes all its rows and keeps them; a docked
   * pane covers the tail's last rows. At the terminal's bottom the region
   * shrinks only by the rows a commit moved into history (`releasedRows`),
   * which the commit then writes into the space the region left. Any other
   * shrink there would leave its rows empty under the status row, so the
   * region keeps them: they sit above the live tail, under history, and the
   * next rows the tail grows take them. A region above the bottom (a short
   * session) has the terminal's own empty rows under it, so it shrinks to
   * what it wants, and a pane grows it into those rows. A replay clears the
   * screen and starts from the rows the region wants.
   */
  function sizeRegion(replaying: boolean) {
    const height = dimensions().height
    const wanted = splitFooterHeight(
      height,
      props.footerHeight + stickyRows() + Math.max(1, liveHeight()),
    )
    let held = Math.min(splitFooterHeight(height, height), renderer.footerHeight - releasedRows)
    const place = regionPlace(renderer)
    if (replaying || place.top + place.rows < renderer.terminalHeight) held = wanted
    releasedRows = 0
    const rows = Math.max(wanted, held)
    // Rows a commit queued are written by the next frame, into the rows the
    // region gave up for them. Until that frame the region only shrinks: rows
    // it took back would put the commit over the history rows above it.
    // `afterCommitFrame` grows it then.
    if (!replaying && unflushedRows > 0) {
      renderer.footerHeight = Math.min(rows, renderer.footerHeight)
      return
    }
    renderer.footerHeight = rows
  }

  /**
   * The return from the alternate screen drew its first frame: the region is
   * on the terminal's own screen again, at the rows it left. It now takes the
   * rows the footer and the live tail want, which may have changed behind the
   * overlay (a turn that ended there). Before this frame a new size would move
   * the region from the rows it took back.
   */
  const afterReturnFrame = () => {
    returnFramePending = false
    if (renderer.screenMode !== "split-footer" || props.expanded || props.overlayOpen) return
    untrack(() => sizeRegion(replayPending()))
  }

  /** The frame wrote the queued rows: the region may take the rows it wants again. */
  const afterCommitFrame = () => {
    if (unflushedRows <= 0) return
    unflushedRows = 0
    if (renderer.screenMode !== "split-footer" || props.expanded || props.overlayOpen) return
    untrack(() => sizeRegion(false))
  }

  // A footer that takes the whole split region (a docked pane, its blank rows
  // given way) leaves the live tail no row. The scrollbox keeps its set height
  // and would draw its last row over the footer's first, so the tail reads its
  // laid-out rows before each draw and, at none, draws nothing.
  const [rowsShown, setRowsShown] = createSignal(Option.none<number>())
  const hasRows = () => !Option.contains(rowsShown(), 0)

  /**
   * The top rows of the first live item that history holds: the live view
   * cuts them off. The expanded transcript shows every item whole.
   */
  const cutRows = (index: number) => {
    if (props.expanded || index !== 0) return 0
    return partialRows()
  }
  /** A cut item hides the rows above its box; an uncut one draws whole. */
  const cutOverflow = (index: number): "hidden" | "visible" => {
    if (cutRows(index) > 0) return "hidden"
    return "visible"
  }
  /** A cut item's box holds the rows history has not taken. */
  const cutHeight = (item: SessionItem, index: number): number | "auto" => {
    const cut = cutRows(index)
    if (cut === 0) return "auto"
    measurementVersion()
    return Math.max(1, (itemHeights.get(item) ?? cut + 1) - cut)
  }

  return (
    <box
      flexDirection="column"
      flexShrink={1}
      flexGrow={1}
      minHeight={0}
      // A footer taller than its base covers the tail's last rows: the tail
      // keeps its rows and place, and this box cuts it off at the footer.
      overflow="hidden"
      // A basis, not the content's height: hidden rows must not end the measure.
      flexBasis={stickyRows() + viewportHeight()}
      renderBefore={function () {
        const rows = Math.max(0, Math.round(this.getLayoutNode().getComputedHeight()))
        if (!Option.contains(rowsShown(), rows)) setRowsShown(Option.some(rows))
      }}
    >
      {/* Rows the region holds beyond the tail's own sit above it, under
        history: never between the tail and the composer. */}
      <box flexGrow={1} flexShrink={1} minHeight={0} />
      <Show when={hasRows() && Option.getOrUndefined(stickyPrompt())}>
        {(prompt) => <StickyPrompt text={prompt()} width={dimensions().width} />}
      </Show>
      <scrollbox
        ref={(value) => {
          viewport = Option.some(value)
        }}
        visible={hasRows()}
        height={viewportHeight()}
        minHeight={0}
        overflow="hidden"
        // Measure content without the current viewport height as a limit.
        viewportOptions={{ overflow: "scroll" }}
        // Let the live tail shrink after leading messages enter native history.
        contentOptions={{ minHeight: 0 }}
        flexShrink={0}
        stickyScroll
        stickyStart="bottom"
        focusable={false}
        verticalScrollbarOptions={{ visible: false }}
      >
        <box
          flexDirection="column"
          flexShrink={0}
          paddingRight={FREE_LAST_COLUMN}
          onSizeChange={function () {
            if (props.expanded || !hasRows()) return
            setLiveHeight(this.height)
          }}
        >
          {/* The transcript view turns the mouse on: there its frames take clicks. */}
          <FrameClicks on={props.expanded}>
            <ToolRunsContext.Provider value={Option.some(toolRuns)}>
              <For each={liveItems()}>
                {(item, index) => (
                  <box
                    flexDirection="column"
                    flexShrink={0}
                    overflow={cutOverflow(index())}
                    height={cutHeight(item, index())}
                  >
                    <box
                      flexDirection="column"
                      flexShrink={0}
                      marginTop={-cutRows(index())}
                      onSizeChange={function () {
                        measureItem(item, this)
                      }}
                      // A change between no row and one sends no size change.
                      renderBefore={function () {
                        measureItem(item, this)
                      }}
                    >
                      {props.renderItems([item])}
                    </box>
                  </box>
                )}
              </For>
            </ToolRunsContext.Provider>
          </FrameClicks>
          {props.children}
        </box>
      </scrollbox>
    </box>
  )
}
