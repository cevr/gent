/** @jsxImportSource @opentui/solid */
import { Effect, Option, Schema } from "effect"
import { For, Show } from "solid-js"
import { formatHeadTail, splitLines } from "@gent/core/protocol"
import {
  CHILD_COMPLETION_TYPE,
  ChildCompletionDetails,
  childOutcomeWords,
  DELEGATE_EXTENSION_ID,
  readChildCompletionHeadline,
} from "@gent/extensions/client"
import {
  clientContributions,
  defineClientExtension,
  formatUsageStats,
  messageRendererContribution,
  type MessageRowProps,
  rendererContribution,
  shortId,
  ToolFrame,
  truncate,
  type ToolInput,
  type ToolRendererProps,
  UserRow,
  useTheme,
} from "@gent/tui/extensions"

// ── builtins/delegate.client ────────────────────────────────────────────────

/**
 * The `delegate.start` row and the child-completion row.
 *
 * A child never blocks its parent: `delegate.start` settles at admission with
 * the child's handle, and the child's result arrives later as a
 * `child-completion` message. Native scrollback commits a row once, so both
 * rows draw only from their own props: the start row a static handle line,
 * the completion row the details the delegate wrote when the child ended.
 * The docked agents pane keeps the live progress of a running child.
 */

/** The server delegate's id; the client module shares it by convention. */

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
  const output = Option.fromNullishOr(props.toolCall.output)
  if (props.toolCall.status === "error") {
    return Option.getOrElse(output, () => "the child did not start")
  }
  return Option.flatMap(output, decodeHandle).pipe(
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

const COMPLETION_ANSWER_LINES = 12

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

/** `delegate completed · abcd1234 · ↑1.2k ↓300`. */
const completionHeader = (state: CompletionState, details: CompletionDetails): string => {
  const usage = Option.fromUndefinedOr(details.usage).pipe(
    Option.map(formatUsageStats),
    Option.filter((text) => text.length > 0),
    Option.map((text) => ` · ${text}`),
    Option.getOrElse(() => ""),
  )
  return `${state.who} ${state.status} · ${shortId(details.sessionId)}${usage}`
}

function ChildToolTree(props: { details: CompletionDetails }) {
  const { theme } = useTheme()
  const tools = () => props.details.tools ?? []
  const earlier = () => Math.max(0, (props.details.toolCount ?? 0) - tools().length)
  const icon = (tool: ChildToolLine) => {
    if (tool.status === "error") return { glyph: "✕", color: theme.error }
    if (tool.status === "incomplete") return { glyph: "?", color: theme.warning }
    return { glyph: "✓", color: theme.textMuted }
  }
  const connector = (index: number) => {
    if (index === tools().length - 1) return "╰──"
    return "├──"
  }
  const summary = (tool: ChildToolLine) => {
    if (tool.summary.length === 0) return ""
    return ` ${tool.summary}`
  }
  return (
    <box flexDirection="column" paddingLeft={2}>
      <Show when={earlier() > 0}>
        <text style={{ fg: theme.textMuted }}>├── … {earlier()} earlier calls</text>
      </Show>
      <For each={[...tools()]}>
        {(tool, index) => (
          // One row per call: a cell receipt's summary can be a long output head.
          <text style={{ fg: theme.textMuted }} wrapMode="none">
            {connector(index())} <span style={{ fg: icon(tool).color }}>{icon(tool).glyph}</span>{" "}
            {tool.name}
            {summary(tool)}
          </text>
        )}
      </For>
    </box>
  )
}

function ChildCompletionRow(props: MessageRowProps & { details: CompletionDetails }) {
  const { theme } = useTheme()
  const state = () => completionState(props.details, props.content)
  const glyph = () => {
    const ended = state().ended
    if (ended === "badly") return { mark: "✕", color: theme.error }
    if (ended === "unknown") return { mark: "·", color: theme.textMuted }
    return { mark: "✓", color: theme.success }
  }
  const answer = () =>
    formatHeadTail(splitLines(completionAnswer(props.content)), COMPLETION_ANSWER_LINES)
  return (
    <box
      marginTop={1}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
      border={["left"]}
      borderStyle="heavy"
      borderColor={theme.textMuted}
    >
      <text style={{ fg: theme.textMuted }}>
        <span style={{ fg: glyph().color }}>{glyph().mark}</span>{" "}
        {completionHeader(state(), props.details)}
      </text>
      <ChildToolTree details={props.details} />
      <Show when={answer().length > 0}>
        <text style={{ fg: theme.text }}>{answer()}</text>
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
    ),
  ),
})
