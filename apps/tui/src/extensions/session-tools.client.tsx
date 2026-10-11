/** @jsxImportSource @opentui/solid */
import { Effect, Option, Schema } from "effect"
import { createMemo, For, Show } from "solid-js"
import { splitLines } from "@gent/core/protocol"
import {
  roundFailureNames,
  SESSION_MESSAGE_TYPE,
  SESSION_TOOLS_EXTENSION_ID,
  SessionMessageDetails,
  sessionMessageBody,
  THREAD_ROUND_END_TYPE,
  THREAD_ROUND_TYPE,
  ThreadRoundEndDetails,
  threadRoundBody,
  threadRoundEndAnswer,
} from "@gent/extensions/client"
import {
  type ActivityCall,
  type ActivityOperation,
  type ActivityTone,
  activityHeaderRuns,
  activityRows,
  activityToneColor,
  AgentMessageRow,
  ClientContext,
  clientContributions,
  defineClientExtension,
  failureReason,
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
  type TextRun,
  textWidth,
  ToneRuns,
  ToolFrame,
  truncate,
  truncateRuns,
  type ToolInput,
  type ToolRendererProps,
  useTerminalDimensions,
  useTheme,
} from "@gent/tui/extensions"

/**
 * The `@gent/session-tools` client: the rows of the messages sessions send
 * each other and of the threads a session starts.
 *
 * - A `session.send` message and a thread's round are `»` rows: another
 *   session wrote them, so neither draws on the reader's rail.
 * - The `thread.start` row: a start settles at admission with the thread's
 *   handle, never its answer.
 * - The round-end row: a `notify: "starter"` round's end, the message that
 *   wakes the starter with the thread's answer.
 *
 * Native scrollback commits a row once, so each row draws only from its own
 * props: the start row a static handle line, the round-end row the details
 * the threads wrote when the round ended. The docked agents pane keeps the
 * live progress of a running thread.
 *
 * The round-end row is a node on the transcript's `ctrl+o` ladder, like a
 * tool group: collapsed is its one head line, preview adds the round's last
 * calls as a tree and a head of its answer, and full draws every call the
 * details kept and the whole answer.
 */

// ── session message row ─────────────────────────────────────────────────────

/** A message from another session names its sender at the head of its row. */
const decodeSessionMessageDetails = Schema.decodeUnknownOption(SessionMessageDetails)

/** The sender fits beside the id: an auto-named thread carries its whole task in the name. */
const SENDER_NAME_MAX_COLUMNS = 32

/** Collapses runs of whitespace, then cuts by terminal columns via `truncate`. */
const shortName = (name: string): string =>
  truncate(name.replace(/\s+/g, " ").trim(), SENDER_NAME_MAX_COLUMNS)

/** Who wrote a sent message, cut to fit beside the relation word and the short session id; empty for no name. */
const senderName = ({ from }: SessionMessageDetails): string =>
  Option.match(Option.fromUndefinedOr(from.name), { onNone: () => "", onSome: shortName })

// ── thread.start row ────────────────────────────────────────────────────────

const decodeStartInput = Schema.decodeUnknownOption(
  Schema.Struct({
    task: Schema.optional(Schema.String),
    name: Schema.optional(Schema.String),
    notify: Schema.optional(Schema.String),
  }),
)

/** A field of the start's input with its whitespace collapsed; none when it is empty. */
const startField = (input: ToolInput, field: "task" | "name"): Option.Option<string> =>
  decodeStartInput(input).pipe(
    Option.flatMap((decoded) => Option.fromNullishOr(decoded[field])),
    Option.map((text) => text.replace(/\s+/g, " ").trim()),
    Option.filter((text) => text.length > 0),
  )

/**
 * The thread's task, after the start's own name when it gave one
 * (`greeting audit · check the greeting files`), cut to 61 columns with the
 * ellipsis, as the header subtitle. A start with no task shows its name.
 */
export const threadStartSubtitle = (input: ToolInput): Option.Option<string> => {
  const name = startField(input, "name")
  const text = Option.match(startField(input, "task"), {
    onNone: () => name,
    onSome: (task) =>
      Option.some(
        Option.match(name, {
          onNone: () => task,
          onSome: (named) => `${named} · ${task}`,
        }),
      ),
  })
  // Cut by grapheme and column, so an emoji at the edge is never split in half.
  return Option.map(text, (value) => truncate(value, 61))
}

/** The handle `thread.start` returns, read leniently from the saved output. */
const decodeHandle = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ sessionId: Schema.String })),
)

/** Where the thread's answers go: back to this session as a message, or nowhere but the thread. */
const answerWords = (input: ToolInput): string => {
  const notify = Option.flatMap(decodeStartInput(input), (decoded) =>
    Option.fromNullishOr(decoded.notify),
  )
  if (Option.contains(notify, "starter")) return "result arrives as a message"
  return "replies stay in the thread"
}

/** One line: the thread the call started, or why it did not start. */
const startLine = (props: ToolRendererProps): string => {
  if (props.toolCall.status === "running") return "starting a thread…"
  if (props.toolCall.status === "error") {
    return Option.getOrElse(failureReason(props.toolCall), () => "the thread did not start")
  }
  const words = answerWords(props.toolCall.input)
  return Option.flatMap(Option.fromNullishOr(props.toolCall.output), decodeHandle).pipe(
    Option.match({
      onNone: () => words,
      onSome: (handle) => `thread ${shortId(handle.sessionId)} · ${words}`,
    }),
  )
}

function ThreadStartRow(props: ToolRendererProps) {
  const { theme } = useTheme()
  const line = () => <text style={{ fg: theme.textMuted }}>{startLine(props)}</text>
  return (
    <ToolFrame
      title="thread"
      subtitle={Option.getOrUndefined(threadStartSubtitle(props.toolCall.input))}
      status={props.toolCall.status}
      expanded={props.expanded}
      collapsedContent={line()}
    >
      {line()}
    </ToolFrame>
  )
}

// ── round-end row ───────────────────────────────────────────────────────────

type RoundEndDetails = typeof ThreadRoundEndDetails.Type
type RoundToolLine = RoundEndDetails["tools"][number]

const decodeRoundEndDetails = Schema.decodeUnknownOption(ThreadRoundEndDetails)

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
/** A thread's name keeps at most these columns, as the `»` row's sender does. */
const NAME_COLUMNS = 32

/** Who the thread is, and how its round ended. */
interface RoundEndState {
  /** The thread session's name, else its agent's name, else `thread`. */
  readonly name: string
  /** Whether `name` is the session's own: an agent's name needs the id beside it. */
  readonly named: boolean
  /** `completed`, or the ways the turn ended badly, in the words the starter's model read. */
  readonly outcome: string
  readonly badly: boolean
}

const roundEndState = (details: RoundEndDetails): RoundEndState => {
  const sessionName = Option.fromUndefinedOr(details.name).pipe(
    Option.map((value) => value.replace(/\s+/g, " ").trim()),
    Option.filter((value) => value.length > 0),
  )
  const failures = roundFailureNames(details)
  const outcome = Option.match(
    Option.liftPredicate(failures, (names) => names.length > 0),
    {
      onNone: () => "completed",
      onSome: (names) => names.join(", "),
    },
  )
  return {
    name: Option.getOrElse(sessionName, () =>
      Option.getOrElse(Option.fromUndefinedOr(details.agentName), () => "thread"),
    ),
    named: Option.isSome(sessionName),
    outcome,
    badly: failures.length > 0,
  }
}

/**
 * A kept or counted call as the run vocabulary reads it: one op of its tool.
 * The op carries the outcome; the call itself settled, so a failure counts once.
 */
const roundCall = (
  name: string,
  status: RoundToolLine["status"],
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
 * The round's work in the run header's words, fitted to `width` columns:
 * `Read 10 files · ran 4 commands · 1 failed`. The counts hold every call,
 * not only the calls the details kept.
 */
const workSummary = (
  details: RoundEndDetails,
  width: number,
): ReadonlyArray<TextRun<ActivityTone>> =>
  activityHeaderRuns(
    details.toolCounts.flatMap((count) =>
      Array.from({ length: count.count }, () => roundCall(count.name, count.status, "")),
    ),
    width,
  )

/** The runs' text as one line. */
const runsText = <Tone,>(runs: ReadonlyArray<TextRun<Tone>>): string =>
  runs.map((run) => run.text).join("")

/** A text the line holds, or none for an empty one. */
const nonEmpty = (text: string): Option.Option<string> =>
  Option.liftPredicate(text, (value) => value.length > 0)

/** The first line of the error the round's turn ended on; none for a round that completed. */
const errorLine = (details: RoundEndDetails): Option.Option<string> =>
  Option.fromUndefinedOr(details.error).pipe(
    Option.map((text) => (splitLines(text).find((line) => line.trim().length > 0) ?? "").trim()),
    Option.filter((line) => line.length > 0),
  )

/** The head's hue: the thread's name in the names' colour (Codex draws a nickname in its accent), its work in the run tones, the rest muted. */
type HeadTone = "name" | ActivityTone

/**
 * The row's head line after its glyph, fitted to `width` columns:
 * `loader audit · completed · Read 10 files · ran 4 commands · 1 failed · 1m 12s · ↑1.2k ↓300 $0.01`.
 * How the round ended follows the name: `completed`, or the ways its turn
 * ended badly, and then the error it ended on ends the line. Where the line
 * is too wide, the error is cut first; then the work's later kinds drop,
 * then the bill, then the time, then the work. How it ended never drops: the
 * name is cut for it. The thread's id shows at the full level, or beside an
 * agent's name when the thread has no session name.
 */
const roundEndHead = (
  state: RoundEndState,
  details: RoundEndDetails,
  options: { readonly width: number; readonly open: boolean },
): ReadonlyArray<TextRun<HeadTone>> => {
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
  const outcome = part(state.outcome)
  const name = truncate(state.name, NAME_COLUMNS)
  const base = `${name}${id}${outcome}`
  if (textWidth(base) > options.width) {
    const room = Math.max(1, options.width - textWidth(`${id}${outcome}`))
    return truncateRuns<HeadTone>(
      [
        { text: truncate(name, room), tone: "name" },
        { text: `${id}${outcome}`, tone: "muted" },
      ],
      options.width,
    )
  }
  const muted = (text: string): TextRun<HeadTone> => ({ text, tone: "muted" })
  const time = formatDuration(details.durationMs, "compact")
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
  // The line opens with the name whole; the round's work draws as a run
  // header does (`1 failed` in its tone), the rest muted.
  const join = (
    work: ReadonlyArray<TextRun<ActivityTone>>,
    tail: ReadonlyArray<string>,
  ): ReadonlyArray<TextRun<HeadTone>> => {
    const runs: Array<TextRun<HeadTone>> = [{ text: name, tone: "name" }, muted(`${id}${outcome}`)]
    if (work.length > 0) runs.push(muted(" · "), ...work)
    for (const text of tail) runs.push(muted(` · ${text}`))
    return runs.filter((run) => run.text.length > 0)
  }
  const tails = [[time, ...Option.toArray(usage)], [time], []]
  let line = join([], [])
  for (const tail of tails) {
    const fixed = textWidth(runsText(join([], tail))) + errorReserve
    if (fixed > options.width) continue
    const work = workSummary(details, options.width - fixed - 3)
    if (
      work.length === 0 ||
      textWidth(runsText(join(work, tail))) + errorReserve <= options.width
    ) {
      line = join(work, tail)
      break
    }
  }
  return Option.match(error, {
    onNone: () => line,
    onSome: (text) => {
      const room = options.width - textWidth(runsText(line)) - 3
      if (room < Math.min(MIN_ERROR_COLUMNS, textWidth(text))) return line
      return [...line, muted(` · ${truncate(text, room)}`)]
    },
  })
}

/** The answer's lines, with the blank lines at its end dropped. */
const answerLines = (content: string): ReadonlyArray<string> => {
  const lines = splitLines(threadRoundEndAnswer(content))
  let end = lines.length
  while (end > 0 && (lines[end - 1] ?? "").trim().length === 0) end -= 1
  return lines.slice(0, end)
}

/**
 * The round's calls as run rows, in the run's past-tense words: the calls
 * before the last `max` counted on one row. Below the full level the rows
 * fold a run of one tool and one outcome into one (`Read a.ts, b.ts`), as a
 * tool group's preview does; open, each call is its own row.
 */
function RoundCallRows(props: {
  details: RoundEndDetails
  max: number
  open: boolean
  width: number
  place: PathPlace
}) {
  const { theme } = useTheme()
  const tools = () => props.details.tools.slice(-props.max)
  const earlier = () => Math.max(0, props.details.toolCount - tools().length)
  const rows = createMemo(() => {
    const calls = tools().map((tool) =>
      roundCall(tool.name, tool.status, placedSummary(tool.summary, props.place)),
    )
    if (props.open) return calls.flatMap((call) => activityRows([call]))
    return activityRows(calls)
  })
  // As a run's rows: only the outcome word takes a hue.
  const color = (tone: ActivityTone) => activityToneColor(theme)(tone)
  const connector = (index: number) => {
    if (index === rows().length - 1) return "└"
    return "├"
  }
  // The connector and its space take two columns.
  const text = (row: ReturnType<typeof activityRows>[number]) => {
    const parts = formatActivityRow(row, props.width - 2)
    const runs: Array<TextRun<ActivityTone>> = [{ text: parts.head, tone: "muted" }]
    for (const ending of Option.toArray(parts.ending))
      runs.push({ text: " · ", tone: "muted" }, ending)
    return truncateRuns(runs, props.width - 2)
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
          <text style={{ fg: theme.textMuted }} wrapMode="none">
            {connector(index())} <ToneRuns runs={text(row)} color={color} />
          </text>
        )}
      </For>
    </box>
  )
}

function RoundEndRow(props: MessageRowProps & { details: RoundEndDetails; place: PathPlace }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const state = () => roundEndState(props.details)
  const glyph = () => {
    if (state().badly) return { mark: "✕", color: theme.error }
    return { mark: "◆", color: theme.textMuted }
  }
  const open = () => props.disclosure === "full"
  // The columns right of the row's indent, less the free last column.
  const width = () => dimensions().width - ROW_INDENT - FREE_LAST_COLUMN
  const head = () =>
    roundEndHead(state(), props.details, { width: width() - GLYPH_COLUMNS, open: open() })
  const headColor = (tone: HeadTone) => {
    if (tone === "name") return theme.info
    return activityToneColor(theme)(tone)
  }
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
        <span style={{ fg: glyph().color }}>{glyph().mark}</span>{" "}
        <ToneRuns runs={head()} color={headColor} />
      </text>
      <Show when={props.disclosure !== "collapsed"}>
        {/* The error tells a failure that will repeat (a sign-in) from a flake. */}
        <Show when={open() && props.details.error}>
          {(error) => <text style={{ fg: theme.error }}>{error()}</text>}
        </Show>
        <RoundCallRows
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
                  │ {formatPreviewFooter(answer().length - shownAnswer().length)}
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

export default defineClientExtension(SESSION_TOOLS_EXTENSION_ID, {
  setup: Effect.gen(function* () {
    const { workspace } = yield* ClientContext
    const place: PathPlace = { cwd: workspace.cwd, home: workspace.home }
    return clientContributions(
      // The model reads the header `sessionMessageText` writes, then the
      // text; the row names the sender at its head and `sessionMessageBody`
      // removes the header, old rows included, so blank lines in a name or
      // body stay whole. Details that do not decode draw the raw text under
      // the bare relation word.
      messageRendererContribution(SESSION_MESSAGE_TYPE, (props) => (
        <Show
          when={Option.getOrUndefined(decodeSessionMessageDetails(props.details))}
          fallback={
            <AgentMessageRow
              head="session"
              body={props.content}
              images={props.images}
              disclosure={props.disclosure}
            />
          }
        >
          {(details) => (
            <AgentMessageRow
              head={details().from.relation}
              name={senderName(details())}
              id={shortId(details().from.sessionId)}
              body={sessionMessageBody(details().from, props.content)}
              images={props.images}
              disclosure={props.disclosure}
            />
          )}
        </Show>
      )),
      // A round is its task under a frame the thread's model reads; the row
      // shows the task, and the raw view the frame.
      messageRendererContribution(
        THREAD_ROUND_TYPE,
        (props) => (
          <AgentMessageRow
            head="task from session"
            body={threadRoundBody(props.content)}
            images={props.images}
            disclosure={props.disclosure}
          />
        ),
        { prompt: threadRoundBody },
      ),
      rendererContribution(["thread.start"], (props) => <ThreadStartRow {...props} />),
      // Details that do not decode draw the raw text, off the reader's rail.
      messageRendererContribution(THREAD_ROUND_END_TYPE, (props) => (
        <Show
          when={Option.getOrUndefined(decodeRoundEndDetails(props.details))}
          fallback={
            <AgentMessageRow
              head="round end"
              body={props.content}
              images={props.images}
              disclosure={props.disclosure}
            />
          }
        >
          {(details) => <RoundEndRow {...props} details={details()} place={place} />}
        </Show>
      )),
    )
  }),
})
