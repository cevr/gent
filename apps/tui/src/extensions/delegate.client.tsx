/** @jsxImportSource @opentui/solid */
import { Effect, Option, Schema } from "effect"
import { createMemo, For, Show } from "solid-js"
import { splitLines } from "@gent/core/protocol"
import {
  CHILD_COMPLETION_TYPE,
  CHILD_TASK_TYPE,
  ChildCompletionDetails,
  childFailureNames,
  childTaskBody,
  DELEGATE_EXTENSION_ID,
  readChildCompletionHeadline,
} from "@gent/extensions/client"
import {
  type ActivityCall,
  type ActivityOperation,
  activityRows,
  AgentMessageRow,
  ClientContext,
  clientContributions,
  defineClientExtension,
  failureReason,
  formatActivityHeader,
  formatActivityRow,
  formatDuration,
  formatPreviewFooter,
  formatUsageStats,
  messageRendererContribution,
  type MessageRowProps,
  type PathPlace,
  placedSummary,
  plural,
  rendererContribution,
  shortId,
  textWidth,
  ToolFrame,
  truncate,
  type ToolInput,
  type ToolRendererProps,
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
    name: Schema.optional(Schema.String),
  }),
)

/**
 * The delegated task, after the start's own name when it gave one
 * (`greeting audit · check the greeting files`), cut to 61 columns with the
 * ellipsis, as the header subtitle.
 */
export const delegateSubtitle = (input: ToolInput): Option.Option<string> => {
  const decoded = decodeDelegateInput(input)
  const todo = decoded.pipe(Option.flatMap((inp) => Option.fromNullishOr(inp.todo)))
  if (Option.isNone(todo)) return Option.none()
  const text = decoded.pipe(
    Option.flatMap((inp) => Option.fromNullishOr(inp.name)),
    Option.map((name) => name.replace(/\s+/g, " ").trim()),
    Option.filter((name) => name.length > 0),
    Option.match({
      onNone: () => todo.value,
      onSome: (name) => `${name} · ${todo.value}`,
    }),
  )
  // Cut by grapheme and column, so an emoji at the edge is never split in half.
  return Option.some(truncate(text, 61))
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
/** The glyph and its space. */
const GLYPH_COLUMNS = 2
/** The fewest columns an error keeps on the head line before the line drops it. */
const MIN_ERROR_COLUMNS = 4
/** A child's name keeps at most these columns, as the `»` row's sender does. */
const NAME_COLUMNS = 32

/** How the child ended: an end the row cannot read never draws the done mark. */
interface CompletionState {
  /** The child's session name, else its agent's name. */
  readonly name: string
  /** Whether `name` is the session's own: an agent's name needs the id beside it. */
  readonly named: boolean
  /** How the turn ended badly, in the words the parent model read; empty otherwise. */
  readonly failure: string
  readonly ended: "done" | "badly" | "unknown"
}

/**
 * The outcome in the details, else the headline `describeChildCompletion`
 * wrote in the message: rows saved before outcomes were written read it
 * there. A row with neither draws a neutral mark.
 */
const completionState = (details: CompletionDetails, content: string): CompletionState => {
  const headline = readChildCompletionHeadline(content)
  const agent = Option.fromUndefinedOr(details.agentName).pipe(
    Option.orElse(() => Option.map(headline, (value) => value.agentName)),
    Option.getOrElse(() => "child"),
  )
  const sessionName = Option.fromUndefinedOr(details.name).pipe(
    Option.map((value) => value.replace(/\s+/g, " ").trim()),
    Option.filter((value) => value.length > 0),
  )
  const who = {
    name: Option.getOrElse(sessionName, () => agent),
    named: Option.isSome(sessionName),
  }
  const ended = (failure: string): CompletionState => {
    if (failure.length > 0) return { ...who, failure, ended: "badly" }
    return { ...who, failure, ended: "done" }
  }
  const outcome = Option.fromUndefinedOr(details.outcome)
  if (Option.isSome(outcome)) return ended(childFailureNames(outcome.value).join(", "))
  return Option.match(headline, {
    onNone: () => ({ ...who, failure: "", ended: "unknown" }),
    // An older row's headline says `completed`, or `ended (<how>)`.
    onSome: ({ status }) =>
      ended(
        Option.getOrElse(
          Option.liftPredicate(status, (value) => value !== "completed"),
          () => "",
        ),
      ),
  })
}

/**
 * A kept or counted call as the run vocabulary reads it: one op of its tool.
 * The op carries the outcome; the call itself settled, so a failure counts once.
 */
const childCall = (
  name: string,
  status: ChildToolLine["status"],
  summary: string,
): ActivityCall => {
  let outcome: ActivityOperation["outcome"] = "succeeded"
  if (status === "error") outcome = "failed"
  if (status === "incomplete") outcome = "incomplete"
  return {
    toolName: name,
    status: "completed",
    operations: [{ tool: name, outcome, detail: summary }],
    code: "",
  }
}

/**
 * The child's work in the run header's words, fitted to `width` columns:
 * `Read 10 files · ran 4 commands · 1 failed`. The counts hold every call;
 * a row saved before them reads its kept calls when they are all of them,
 * else counts its calls (`14 tools`), since the kept kinds would undercount.
 */
const workSummary = (details: CompletionDetails, width: number): string => {
  const tools = details.tools ?? []
  const counted = Option.fromUndefinedOr(details.toolCounts).pipe(
    Option.map((counts) =>
      counts.flatMap((count) =>
        Array.from({ length: count.count }, () => childCall(count.name, count.status, "")),
      ),
    ),
    Option.orElse(() =>
      Option.liftPredicate(
        tools.map((tool) => childCall(tool.name, tool.status, tool.summary)),
        () => (details.toolCount ?? tools.length) === tools.length,
      ),
    ),
  )
  return Option.match(counted, {
    onNone: () => plural(details.toolCount ?? 0, "tool"),
    onSome: (calls) => formatActivityHeader(calls, width),
  })
}

/** A text the line holds, or none for an empty one. */
const nonEmpty = (text: string): Option.Option<string> =>
  Option.liftPredicate(text, (value) => value.length > 0)

/** The first line of a failed child's error; none for a child that completed. */
const errorLine = (details: CompletionDetails): Option.Option<string> =>
  Option.fromUndefinedOr(details.error).pipe(
    Option.map((text) => (splitLines(text).find((line) => line.trim().length > 0) ?? "").trim()),
    Option.filter((line) => line.length > 0),
  )

/**
 * The row's head line after its glyph, fitted to `width` columns:
 * `delegate: loader audit · Read 10 files · ran 4 commands · 1 failed · 1m 12s · ↑1.2k ↓300 $0.01`.
 * A child that ended badly says how after its name, and its error ends the
 * line. Where the line is too wide, the error is cut first; then the work's
 * later kinds drop, then the bill, then the time, then the work. How it
 * ended never drops: the name is cut for it. The child's id shows at the
 * full level, or beside an agent's name when the row has no session name.
 */
const completionHead = (
  state: CompletionState,
  details: CompletionDetails,
  options: { readonly width: number; readonly open: boolean },
): string => {
  /** ` · <part>` for a part the line holds; nothing for an empty one. */
  const part = (text: string) =>
    Option.match(nonEmpty(text), { onNone: () => "", onSome: (value) => ` · ${value}` })
  const id = part(
    Option.match(
      Option.liftPredicate(details.sessionId, () => !state.named || options.open),
      {
        onNone: () => "",
        onSome: shortId,
      },
    ),
  )
  const failure = part(state.failure)
  const name = truncate(state.name, NAME_COLUMNS)
  const base = `${name}${id}${failure}`
  if (textWidth(base) > options.width) {
    const room = Math.max(1, options.width - textWidth(`${id}${failure}`))
    return truncate(`${truncate(name, room)}${id}${failure}`, options.width)
  }
  const time = Option.map(Option.fromUndefinedOr(details.durationMs), (ms) =>
    formatDuration(ms, "compact"),
  )
  const usage = Option.fromUndefinedOr(details.usage).pipe(
    Option.map((value) =>
      formatUsageStats({ input: value.input, output: value.output, cost: value.costUsd }),
    ),
    Option.filter((text) => text.length > 0),
  )
  // The error is the last part, below the full level; open, it is its own line.
  const error = Option.filter(errorLine(details), () => !options.open)
  const errorReserve = Option.match(error, {
    onNone: () => 0,
    onSome: (text) => 3 + Math.min(MIN_ERROR_COLUMNS, textWidth(text)),
  })
  const join = (work: string, tail: ReadonlyArray<string>) =>
    [base, ...Option.toArray(nonEmpty(work)), ...tail].join(" · ")
  const tails = [[...Option.toArray(time), ...Option.toArray(usage)], Option.toArray(time), []]
  let line = base
  for (const tail of tails) {
    const fixed = textWidth(join("", tail)) + errorReserve
    if (fixed > options.width) continue
    const work = workSummary(details, options.width - fixed - 3)
    if (work.length === 0 || textWidth(join(work, tail)) + errorReserve <= options.width) {
      line = join(work, tail)
      break
    }
  }
  return Option.match(error, {
    onNone: () => line,
    onSome: (text) => {
      const room = options.width - textWidth(line) - 3
      if (room < Math.min(MIN_ERROR_COLUMNS, textWidth(text))) return line
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

/**
 * The child's calls as run rows, in the run's past-tense words: the calls
 * before the last `max` counted on one row. Below the full level the rows
 * fold a run of one tool and one outcome into one (`Read a.ts, b.ts`), as a
 * tool group's preview does; open, each call is its own row.
 */
function ChildCallRows(props: {
  details: CompletionDetails
  max: number
  open: boolean
  width: number
  place: PathPlace
}) {
  const { theme } = useTheme()
  const tools = () => (props.details.tools ?? []).slice(-props.max)
  const earlier = () => Math.max(0, (props.details.toolCount ?? 0) - tools().length)
  const rows = createMemo(() => {
    const calls = tools().map((tool) =>
      childCall(tool.name, tool.status, placedSummary(tool.summary, props.place)),
    )
    if (props.open) return calls.flatMap((call) => activityRows([call]))
    return activityRows(calls)
  })
  const color = (row: ReturnType<typeof activityRows>[number]) => {
    if (row.outcome === "failed") return theme.error
    if (row.outcome === "incomplete" || row.outcome === "cancelled") return theme.warning
    return theme.textMuted
  }
  const connector = (index: number) => {
    if (index === rows().length - 1) return "└"
    return "├"
  }
  // The connector and its space take two columns.
  const text = (row: ReturnType<typeof activityRows>[number]) => {
    const parts = formatActivityRow(row, props.width - 2)
    return truncate(`${parts.head}${parts.tail}`, props.width - 2)
  }
  return (
    <box flexDirection="column">
      <Show when={earlier() > 0}>
        <text style={{ fg: theme.textMuted }} wrapMode="none">
          ├ … {plural(earlier(), "earlier call")}
        </text>
      </Show>
      <For each={[...rows()]}>
        {(row, index) => (
          <text style={{ fg: color(row) }} wrapMode="none">
            {connector(index())} {text(row)}
          </text>
        )}
      </For>
    </box>
  )
}

function ChildCompletionRow(
  props: MessageRowProps & { details: CompletionDetails; place: PathPlace },
) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const state = () => completionState(props.details, props.content)
  const glyph = () => {
    const ended = state().ended
    if (ended === "badly") return { mark: "✕", color: theme.error }
    if (ended === "unknown") return { mark: "·", color: theme.textMuted }
    return { mark: "◆", color: theme.textMuted }
  }
  const open = () => props.disclosure === "full"
  // The columns right of the row's indent, less the free last column.
  const width = () => dimensions().width - ROW_INDENT - FREE_LAST_COLUMN
  const head = () =>
    completionHead(state(), props.details, { width: width() - GLYPH_COLUMNS, open: open() })
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
        <ChildCallRows
          details={props.details}
          max={calls()}
          open={open()}
          width={width()}
          place={props.place}
        />
        <Show when={shownAnswer().length > 0}>
          <Show
            when={!open()}
            fallback={
              <box paddingLeft={2}>
                <text style={{ fg: theme.textMuted }}>{shownAnswer().join("\n")}</text>
              </box>
            }
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
  setup: Effect.gen(function* () {
    const { workspace } = yield* ClientContext
    const place: PathPlace = { cwd: workspace.cwd, home: workspace.home }
    return clientContributions(
      rendererContribution(["delegate.start"], (props) => <DelegateStartRow {...props} />),
      // Details that do not decode draw the raw text, off the reader's rail.
      messageRendererContribution(CHILD_COMPLETION_TYPE, (props) => (
        <Show
          when={Option.getOrUndefined(decodeCompletionDetails(props.details))}
          fallback={
            <AgentMessageRow
              head="child completion"
              body={props.content}
              images={props.images}
              disclosure={props.disclosure}
            />
          }
        >
          {(details) => <ChildCompletionRow {...props} details={details()} place={place} />}
        </Show>
      )),
      // A child's first message is its task under a frame the child's model
      // reads. Its parent wrote it, so it is the `»` row, not the reader's rail;
      // the transcript shows the task, and the raw view the frame.
      messageRendererContribution(
        CHILD_TASK_TYPE,
        (props) => (
          <AgentMessageRow
            head="task from parent"
            body={childTaskBody(props.content)}
            images={props.images}
            disclosure={props.disclosure}
          />
        ),
        { prompt: childTaskBody },
      ),
    )
  }),
})
