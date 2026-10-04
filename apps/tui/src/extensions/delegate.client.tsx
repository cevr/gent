/** @jsxImportSource @opentui/solid */
import { Effect, Option, Schema } from "effect"
import { createMemo, For, Show } from "solid-js"
import { splitLines } from "@gent/core/protocol"
import {
  CHILD_COMPLETION_TYPE,
  CHILD_TASK_TYPE,
  ChildCompletionDetails,
  childOutcomeWords,
  childTaskBody,
  DELEGATE_EXTENSION_ID,
  readChildCompletionHeadline,
} from "@gent/extensions/client"
import {
  clientContributions,
  defineClientExtension,
  failureReason,
  formatPreviewFooter,
  formatUsageStats,
  messageRendererContribution,
  type MessageRowProps,
  plural,
  rendererContribution,
  shortId,
  textWidth,
  ToolFrame,
  truncate,
  type ToolInput,
  type ToolRendererProps,
  UserRow,
  useTerminalDimensions,
  useTheme,
} from "@gent/tui/extensions"

// ── delegate rows ───────────────────────────────────────────────────────────

/**
 * The `delegate.start` row and the child-completion row.
 *
 * A child never blocks its parent: `delegate.start` settles at admission with
 * the child's handle, and the child's result arrives later as a
 * `child-completion` message. Native scrollback commits a row once, so both
 * rows draw only from their own props: the start row a static handle line,
 * the completion row the details the delegate wrote when the child ended.
 * The docked agents pane keeps the live progress of a running child.
 *
 * The completion row is a node on the transcript's `ctrl+o` ladder, like a
 * tool group: collapsed is its one head line, preview adds the child's last
 * calls as a tree and a head of its answer, and full draws every call the
 * details kept and the whole answer.
 */

// ── start row ───────────────────────────────────────────────────────────────

const decodeDelegateInput = Schema.decodeUnknownOption(
  Schema.Struct({
    todo: Schema.optional(Schema.String),
  }),
)

/** The delegated task, cut to 61 columns with the ellipsis, as the header subtitle. */
export const delegateSubtitle = (input: ToolInput): Option.Option<string> => {
  const todo = decodeDelegateInput(input).pipe(
    Option.flatMap((inp) => Option.fromNullishOr(inp.todo)),
  )
  if (Option.isNone(todo)) return Option.none()
  // Cut by grapheme and column, so an emoji at the edge is never split in half.
  return Option.some(truncate(todo.value, 61))
}

/** The handle `delegate.start` returns, read leniently from the saved output. */
const decodeHandle = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ sessionId: Schema.String })),
)

/** One line: the child the call started, or why it did not start. */
const startLine = (props: ToolRendererProps): string => {
  if (props.toolCall.status === "running") return "starting a child…"
  if (props.toolCall.status === "error") {
    return Option.getOrElse(failureReason(props.toolCall), () => "the child did not start")
  }
  return Option.flatMap(Option.fromNullishOr(props.toolCall.output), decodeHandle).pipe(
    Option.match({
      onNone: () => "result arrives as a message",
      onSome: (handle) => `child ${shortId(handle.sessionId)} · result arrives as a message`,
    }),
  )
}

function DelegateStartRow(props: ToolRendererProps) {
  const { theme } = useTheme()
  const line = () => <text style={{ fg: theme.textMuted }}>{startLine(props)}</text>
  return (
    <ToolFrame
      title="delegate"
      subtitle={Option.getOrUndefined(delegateSubtitle(props.toolCall.input))}
      status={props.toolCall.status}
      expanded={props.expanded}
      collapsedContent={line()}
    >
      {line()}
    </ToolFrame>
  )
}

// ── completion row ──────────────────────────────────────────────────────────

type CompletionDetails = typeof ChildCompletionDetails.Type
type ChildToolLine = NonNullable<CompletionDetails["tools"]>[number]

const decodeCompletionDetails = Schema.decodeUnknownOption(ChildCompletionDetails)

/** The model reads a status header, then the answer after the first blank line. */
const completionAnswer = (content: string): string => {
  const start = content.indexOf("\n\n")
  if (start === -1) return content
  return content.slice(start + 2)
}

/** The calls and the answer lines the preview shows; the full level shows them all. */
const PREVIEW_CALLS = 5
const PREVIEW_ANSWER_LINES = 5

/** The columns a row keeps: the transcript indent, and the last column every row leaves free. */
const ROW_INDENT = 2
const FREE_LAST_COLUMN = 1
/** The fewest columns an error keeps on the head line before the line drops it. */
const MIN_ERROR_COLUMNS = 4

/** How a headline's status words ended. */
const endedBy = (status: string): "completed" | "badly" => {
  if (status === "completed") return "completed"
  return "badly"
}

/** What the row says about how the child ended; "unknown" never draws a success mark. */
interface CompletionState {
  readonly who: string
  readonly status: string
  readonly ended: "completed" | "badly" | "unknown"
}

/**
 * The outcome in the details, else the headline `describeChildCompletion`
 * wrote in the message: rows saved before outcomes were written read it
 * there. A row with neither reads "finished" with a neutral mark.
 */
const completionState = (details: CompletionDetails, content: string): CompletionState => {
  const agentName = Option.fromUndefinedOr(details.agentName)
  const outcome = Option.fromUndefinedOr(details.outcome)
  if (Option.isSome(outcome)) {
    const status = childOutcomeWords(outcome.value)
    return {
      who: Option.getOrElse(agentName, () => "child"),
      status,
      ended: endedBy(status),
    }
  }
  return Option.match(readChildCompletionHeadline(content), {
    onNone: () => ({
      who: Option.getOrElse(agentName, () => "child"),
      status: "finished",
      ended: "unknown",
    }),
    onSome: (headline) => ({
      who: Option.getOrElse(agentName, () => headline.agentName),
      status: headline.status,
      ended: endedBy(headline.status),
    }),
  })
}

/**
 * The row's head line, fitted to `width` columns after its mark:
 * `explore completed · 9f3a2c1d · 14 tools · ↑1.2k ↓300 $0.0123`, and for a
 * child that failed, ` · <the first line of its error>` last. Where the line
 * is too wide, the error is cut first, then the usage drops, then the call
 * count; the agent, the outcome and the child's id stay.
 */
const completionLine = (
  state: CompletionState,
  details: CompletionDetails,
  options: { readonly width: number; readonly error: boolean },
): string => {
  const head = `${state.who} ${state.status} · ${shortId(details.sessionId)}`
  const optional: string[] = []
  Option.map(Option.fromUndefinedOr(details.toolCount), (count) =>
    optional.push(plural(count, "tool")),
  )
  const usage = Option.fromUndefinedOr(details.usage).pipe(
    Option.map((value) =>
      formatUsageStats({ input: value.input, output: value.output, cost: value.costUsd }),
    ),
    Option.filter((text) => text.length > 0),
  )
  Option.map(usage, (text) => optional.push(text))
  const error = Option.fromUndefinedOr(details.error).pipe(
    Option.filter(() => options.error),
    Option.map((text) => (splitLines(text).find((line) => line.trim().length > 0) ?? "").trim()),
    Option.filter((line) => line.length > 0),
  )
  const errorRoom = Option.match(error, {
    onNone: () => 0,
    onSome: (line) => 3 + Math.min(MIN_ERROR_COLUMNS, textWidth(line)),
  })
  const join = (parts: ReadonlyArray<string>) => [head, ...parts].join(" · ")
  let kept = optional.length
  while (kept > 0 && textWidth(join(optional.slice(0, kept))) + errorRoom > options.width) kept -= 1
  const line = join(optional.slice(0, kept))
  return Option.match(error, {
    onNone: () => truncate(line, options.width),
    onSome: (text) => {
      const room = options.width - textWidth(line) - 3
      if (room < Math.min(MIN_ERROR_COLUMNS, textWidth(text))) return truncate(line, options.width)
      return `${line} · ${truncate(text, room)}`
    },
  })
}

/** The answer's lines, with the blank lines at its end dropped. */
const answerLines = (content: string): ReadonlyArray<string> => {
  const lines = splitLines(completionAnswer(content))
  let end = lines.length
  while (end > 0 && (lines[end - 1] ?? "").trim().length === 0) end -= 1
  return lines.slice(0, end)
}

/** The child's calls as tree rows: the calls before the last `max` counted on one row. */
function ChildToolTree(props: { details: CompletionDetails; max: number; width: number }) {
  const { theme } = useTheme()
  const tools = () => (props.details.tools ?? []).slice(-props.max)
  const earlier = () => Math.max(0, (props.details.toolCount ?? 0) - tools().length)
  const icon = (tool: ChildToolLine) => {
    if (tool.status === "error") return { glyph: "✕", color: theme.error }
    if (tool.status === "incomplete") return { glyph: "?", color: theme.warning }
    return { glyph: "✓", color: theme.textMuted }
  }
  const connector = (index: number) => {
    if (index === tools().length - 1) return "└"
    return "├"
  }
  const label = (tool: ChildToolLine) => {
    let text = tool.name
    if (tool.summary.length > 0) text = `${tool.name} ${tool.summary}`
    // The connector, the mark and their spaces take four columns.
    return truncate(text, props.width - 4)
  }
  return (
    <box flexDirection="column">
      <Show when={earlier() > 0}>
        <text style={{ fg: theme.textMuted }} wrapMode="none">
          ├ … {plural(earlier(), "earlier call")}
        </text>
      </Show>
      <For each={[...tools()]}>
        {(tool, index) => (
          // One row per call: a cell receipt's summary can be a long output head.
          <text style={{ fg: theme.textMuted }} wrapMode="none">
            {connector(index())} <span style={{ fg: icon(tool).color }}>{icon(tool).glyph}</span>{" "}
            {label(tool)}
          </text>
        )}
      </For>
    </box>
  )
}

function ChildCompletionRow(props: MessageRowProps & { details: CompletionDetails }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const state = () => completionState(props.details, props.content)
  const glyph = () => {
    const ended = state().ended
    if (ended === "badly") return { mark: "✕", color: theme.error }
    if (ended === "unknown") return { mark: "·", color: theme.textMuted }
    return { mark: "✓", color: theme.success }
  }
  const open = () => props.disclosure === "full"
  // The columns right of the row's indent, less the free last column.
  const width = () => dimensions().width - ROW_INDENT - FREE_LAST_COLUMN
  // Below the full level the error is the head line's last part; open, it is its own text.
  const head = () => completionLine(state(), props.details, { width: width() - 2, error: !open() })
  const answer = createMemo(() => answerLines(props.content))
  const shownAnswer = () => {
    if (open()) return answer()
    return answer().slice(0, PREVIEW_ANSWER_LINES)
  }
  const calls = () => {
    if (open()) return Number.POSITIVE_INFINITY
    return PREVIEW_CALLS
  }
  return (
    <box marginTop={1} paddingLeft={ROW_INDENT} flexDirection="column">
      <text style={{ fg: theme.textMuted }} wrapMode="none">
        <span style={{ fg: glyph().color }}>{glyph().mark}</span> {head()}
      </text>
      <Show when={props.disclosure !== "collapsed"}>
        {/* The error tells a failure that will repeat (a sign-in) from a flake. */}
        <Show when={open() && props.details.error}>
          {(error) => <text style={{ fg: theme.error }}>{error()}</text>}
        </Show>
        <ChildToolTree details={props.details} max={calls()} width={width()} />
        <Show when={shownAnswer().length > 0}>
          <Show
            when={!open()}
            fallback={<text style={{ fg: theme.text }}>{shownAnswer().join("\n")}</text>}
          >
            <box flexDirection="column" paddingLeft={2}>
              <For each={[...shownAnswer()]}>
                {(line) => (
                  <text style={{ fg: theme.textMuted }} wrapMode="none">
                    │ {truncate(line, width() - 4)}
                  </text>
                )}
              </For>
              <Show when={answer().length > shownAnswer().length}>
                <text style={{ fg: theme.textMuted }} wrapMode="none">
                  │{" "}
                  <span style={{ fg: theme.textMuted, dim: true }}>
                    {formatPreviewFooter(answer().length - shownAnswer().length)}
                  </span>
                </text>
              </Show>
            </box>
          </Show>
        </Show>
      </Show>
    </box>
  )
}

// ── extension ───────────────────────────────────────────────────────────────

export default defineClientExtension(DELEGATE_EXTENSION_ID, {
  setup: Effect.succeed(
    clientContributions(
      rendererContribution(["delegate.start"], (props) => <DelegateStartRow {...props} />),
      // Details that do not decode draw the plain row.
      messageRendererContribution(CHILD_COMPLETION_TYPE, (props) => (
        <Show
          when={Option.getOrUndefined(decodeCompletionDetails(props.details))}
          fallback={<UserRow {...props} />}
        >
          {(details) => <ChildCompletionRow {...props} details={details()} />}
        </Show>
      )),
      // A child's first message is its task under a frame the child's model
      // reads; the transcript shows the task, and the frame when expanded.
      messageRendererContribution(
        CHILD_TASK_TYPE,
        (props) => (
          <UserRow {...props} header="delegate · task" content={childTaskBody(props.content)} />
        ),
        { prompt: childTaskBody },
      ),
    ),
  ),
})
