/**
 * Child agents, built on the public extension facade alone.
 *
 * A child is a session under the caller's branch, run as the `delegate`
 * agent. The registry is one JSON file per parent branch under
 * `<data directory>/delegates/`, the data directory `resolveDataDir` names
 * (`GENT_DATA_DIR`, else `~/.gent`); every entry names the child, the tool
 * call that owns it, and whether the parent has its completion.
 * `delegate.start` admits a child and returns its handle at admission, never
 * its answer: the child reports through the delegate's own `turnAfter` hook,
 * as a message on the parent branch that wakes it. The same hook stops a
 * parent's running children when the parent's turn is interrupted. The
 * parent's first turn in a process and every `delegate.list` reconcile what a
 * crash left.
 */
import {
  Cause,
  Clock,
  Context,
  Crypto,
  Effect,
  Exit,
  Layer,
  Option,
  type PlatformError,
  Predicate,
  Record,
  Ref,
  Schema,
  Stream,
  Struct,
} from "effect"
import { Hex } from "effect/encoding"
import {
  ActorCommandId,
  AGENT_PROMPT_PRIORITY,
  AgentDefinition,
  type AgentEvent,
  AgentName,
  BranchId,
  defineExtension,
  defineResource,
  ExtensionContext,
  ExtensionHost,
  ExtensionId,
  type ExtensionServiceError,
  RunOverrides,
  type SessionReachError,
  headChars,
  headTailChars,
  isRuntimeUserMessage,
  latestAssistantText,
  type Message,
  MessageId,
  RequestId,
  type RunSpec,
  SessionId,
  ToolCallId,
  tool,
  type TurnAfterInput,
  type TurnUsage,
} from "@gent/core/extensions/api"
import { makeBranchStateStore } from "./branch-state-store.js"
import { childSessionName } from "./session-tools.js"
import { type CollectedWork, type WorkspaceError, Workspaces } from "./workspaces.js"

// Test seam: only tests read these exports. DELEGATE_AGENT_NAME and
// DelegateEntry name the registry's shapes in assertions. StartChild,
// CancelChild, ListChildren and ChildAgentHandle are the capabilities and the
// handle the cell tests drive.

// ── the subagent ────────────────────────────────────────────────────────────

/**
 * A child never delegates. Fan-out is the caller's decision, and a project
 * prompt that addresses "the orchestrator" reaches children too, so without
 * this a worker reads that prompt and spawns its own workers. For the same
 * reason a child never starts a thread: it does bounded work for its
 * parent, not unrelated work of its own.
 */
const CHILD_TOOL_DENIALS: ReadonlyArray<string> = [
  "!delegate.start",
  "!delegate.cancel",
  "!delegate.list",
  "!thread.start",
]

export const DELEGATE_AGENT_NAME = AgentName.make("delegate")

/**
 * The one agent every child runs as. A child inherits neither its caller's
 * agent nor the session's model, only the caller run's bound (its tools and
 * paths never exceed its parent run's). Its model and
 * effort come from this definition, reshaped by `agents.delegate` in
 * `.gent/config.json` (user, then project), and a call's own `overrides`
 * win over both; their `tools` and `paths` only narrow it. That config entry is where a pairing such as
 * fable → opus or opus → sonnet is declared.
 */
const delegateAgent = AgentDefinition.make({
  name: DELEGATE_AGENT_NAME,
  description:
    "The default subagent: runs one delegated task and cannot delegate further. When blocked in its task turn, it ends the turn with its question; in a later turn, it asks its parent with session.send.",
  tools: ["*", ...CHILD_TOOL_DENIALS],
})

// ── registry ────────────────────────────────────────────────────────────────

class DelegateError extends Schema.TaggedError<DelegateError>()("DelegateError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/** The ways a turn receipt says the turn ended badly. Absent flags read as false. */
const ChildOutcome = Schema.Struct({
  interrupted: Schema.optionalKey(Schema.Boolean),
  streamFailed: Schema.optionalKey(Schema.Boolean),
  unanswered: Schema.optionalKey(Schema.Boolean),
})
type ChildOutcome = typeof ChildOutcome.Type

/**
 * The child turn's bill. The cache counts and the cost came later: older rows
 * carry only the tokens. A zero cache count and an unpriced model are left out.
 */
const ChildUsage = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.optionalKey(Schema.Finite),
  cacheWrite: Schema.optionalKey(Schema.Finite),
  costUsd: Schema.optionalKey(Schema.Finite),
})

/** One child known to a parent branch. `completed` is a turn receipt, not task success. */
export const DelegateEntry = Schema.Struct({
  requestId: RequestId,
  sessionId: SessionId,
  branchId: BranchId,
  agentName: AgentName,
  prompt: Schema.String,
  toolCallId: Schema.optionalKey(ToolCallId),
  /**
   * The id of the child's first message, named for the child session: a
   * message id is unique across every session, and a tool call id is unique
   * only in its parent. Absent on older rows, whose first message is
   * `delegate-start:<requestId>`.
   */
  startMessageId: Schema.optionalKey(MessageId),
  /**
   * Always written false. Older binaries wrote true for a `read_session` extraction child and
   * still require the key, so it stays in the schema for files on both sides of that change.
   */
  private: Schema.Boolean,
  /**
   * The child's prompt reached its loop. The row is written false before the
   * start is sent, so a start that crashed in between is re-sent.
   */
  submitted: Schema.Boolean,
  completed: Schema.optionalKey(ChildOutcome),
  /** The parent has the completion: the message is on the parent branch, or the parent stopped the child. */
  delivered: Schema.Boolean,
  usage: Schema.optionalKey(ChildUsage),
  /**
   * When the parent's interrupted turn stopped this child. The stop sends no
   * message, so the parent's turns read it as a notice until one answers;
   * that turn's end removes the key. Absent on older rows and once read.
   */
  stopNoticeAt: Schema.optionalKey(Schema.Finite),
})
export type DelegateEntry = typeof DelegateEntry.Type

/** Maximum unfinished children owned by one parent branch. */
const MAX_PENDING_CHILDREN = 4

/** A child that loops on a broken model stops here instead of spending the parent's budget. */
const CHILD_MAX_MODEL_ATTEMPTS = 32

const registry = makeBranchStateStore({
  name: "DelegateRegistry",
  directory: "delegates",
  codec: Schema.fromJsonString(Schema.Array(DelegateEntry)),
  empty: [] satisfies ReadonlyArray<DelegateEntry>,
  invalid: (file, cause) =>
    new DelegateError({ message: `Delegate registry is unreadable: ${file}`, cause }),
})

const replaceEntry = (entries: ReadonlyArray<DelegateEntry>, entry: DelegateEntry) =>
  entries.map((current) => {
    if (current.requestId === entry.requestId) return entry
    return current
  })

/** Every fault behind the facade is one caller-facing error. */
const asDelegateError = (message: string) =>
  Effect.mapError(
    (
      cause:
        | ExtensionServiceError
        | SessionReachError
        | PlatformError.PlatformError
        | DelegateError
        | WorkspaceError,
    ) => {
      if (Schema.is(DelegateError)(cause)) return cause
      return new DelegateError({ message: `${message}: ${cause.message}`, cause })
    },
  )

// ── child turns ─────────────────────────────────────────────────────────────

const startMessageId = (entry: {
  readonly requestId: RequestId
  readonly startMessageId?: MessageId
}) => entry.startMessageId ?? MessageId.make(`delegate-start:${entry.requestId}`)

type TurnCompleted = Extract<AgentEvent, { readonly _tag: "TurnCompleted" }>
const isSynchronized = (event: AgentEvent) => event._tag === "StreamSynchronized"

interface TurnTarget {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly messageId: MessageId
}

/** How one turn ended: its receipt, and the error the turn ended on, if any. */
interface TurnEnd {
  readonly receipt: TurnCompleted
  /** The last `ErrorOccurred` after the previous receipt that is not a notice. */
  readonly error: Option.Option<string>
}

/**
 * The end of one turn, read from the child's durable history alone. The
 * receipt names only that the stream failed; the error before it says why,
 * and a parent that cannot tell a sign-in failure from a flake starts the
 * same child again.
 */
const turnEnd = (target: TurnTarget) =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const folded = yield* ctx.Session.events(target).pipe(
      Stream.takeUntil(isSynchronized),
      Stream.runFold(
        () => ({ error: Option.none<string>(), end: Option.none<TurnEnd>() }),
        (state, event) => {
          if (event._tag === "ErrorOccurred") {
            if (event.notice === true) return state
            return { ...state, error: Option.some(event.error) }
          }
          if (event._tag !== "TurnCompleted") return state
          // Each receipt closes its turn: an error before it is not the next turn's.
          if (event.messageId !== target.messageId) return { ...state, error: Option.none() }
          return { error: Option.none(), end: Option.some({ receipt: event, error: state.error }) }
        },
      ),
    )
    return folded.end
  })

/**
 * The flags a turn raised. Two writers race to record one completion: the
 * child's `turnAfter` hook passes every flag, and reconcile reads the
 * `TurnCompleted` event, which omits the false ones. Keeping only the raised
 * flags gives one stored shape whichever writer wins.
 */
const outcomeOf = (receipt: {
  readonly interrupted?: boolean
  readonly streamFailed?: boolean
  readonly unanswered?: boolean
}): ChildOutcome =>
  Record.filter(
    {
      interrupted: receipt.interrupted,
      streamFailed: receipt.streamFailed,
      unanswered: receipt.unanswered,
    },
    (flag) => flag === true,
  )

/**
 * The row's bill from a complete turn total. The `turnAfter` hook and the
 * `TurnCompleted` receipt race to write it, so both go through here and a zero
 * or an absent value is dropped the same way.
 */
const usageOf = (usage: Option.Option<TurnUsage["known"]>): Option.Option<typeof ChildUsage.Type> =>
  Option.map(usage, (value) => ({
    input: value.inputTokens,
    output: value.outputTokens,
    ...Record.filter(
      { cacheRead: value.cacheReadTokens, cacheWrite: value.cacheWriteTokens },
      (count) => count > 0,
    ),
    ...Option.match(value.costUsd, {
      onNone: () => ({}),
      onSome: (costUsd) => ({ costUsd }),
    }),
  }))

/** A `TurnCompleted` receipt's total, in the shape the `turnAfter` hook gets. */
const receiptTotal = (receipt: TurnCompleted): Option.Option<TurnUsage["known"]> =>
  Option.map(Option.fromUndefinedOr(receipt.usage), (usage) => ({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: Option.getOrElse(Option.fromUndefinedOr(usage.cacheReadTokens), () => 0),
    cacheWriteTokens: Option.getOrElse(Option.fromUndefinedOr(usage.cacheWriteTokens), () => 0),
    costUsd: Option.fromUndefinedOr(receipt.costUsd),
  }))

/** How a turn ended badly, in words a model reads; none for a turn that completed. */
export const childFailureNames = (outcome: ChildOutcome): ReadonlyArray<string> => {
  const names: Array<string> = []
  if (outcome.interrupted === true) names.push("interrupted")
  if (outcome.streamFailed === true) names.push("model stream failed")
  if (outcome.unanswered === true) names.push("no answer produced")
  return names
}

/**
 * How a child's turn ended, in the words of the completion message the parent
 * model reads. The completion row takes its words from `childFailureNames`;
 * only a row saved without an outcome reads these back from the headline.
 */
const childOutcomeWords = (outcome: ChildOutcome): string => {
  const failures = childFailureNames(outcome)
  if (failures.length === 0) return "completed"
  return `ended (${failures.join(", ")})`
}

/**
 * The messages of the child's start turn: the start message and every
 * message up to the next one that opened a turn. A forked child's branch
 * begins with a copy of the parent's window; those rows are the parent's,
 * never the child's. The loop's own user-role lines inside the turn (a
 * continuation, the max-steps instruction, a model-change notice, a
 * compaction marker) and a message joined into the running turn open no
 * turn, so the slice reads past them to the child's answer. A later turn (a
 * wake, a queued message, an interjection that woke the child) opens with a
 * user message of its own, and the slice ends there.
 */
const startTurnMessages = <
  M extends { readonly id: MessageId } & Parameters<typeof isRuntimeUserMessage>[0],
>(
  messages: ReadonlyArray<M>,
  startId: MessageId,
): ReadonlyArray<M> => {
  const start = messages.findIndex((message) => message.id === startId)
  if (start === -1) return []
  const end = messages
    .slice(start + 1)
    .findIndex((message) => message.role === "user" && !isRuntimeUserMessage(message))
  if (end === -1) return messages.slice(start)
  return messages.slice(start, start + 1 + end)
}

/** The child session's name and its branch's start-turn messages, from the session detail. */
const childMessages = (entry: DelegateEntry) =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const detail = yield* ctx.Session.getDetail(entry.sessionId)
    const branch = detail.branches.find((current) => current.branch.id === entry.branchId)
    return {
      name: detail.session.name,
      messages: startTurnMessages(branch?.messages ?? [], startMessageId(entry)),
    }
  })

/** Children never spend the parent's patience on a broken model. */
const childRunSpec = (base: RunSpec = {}): RunSpec => ({
  ...base,
  overrides: { maxModelAttempts: CHILD_MAX_MODEL_ATTEMPTS, ...base.overrides },
})

// ── completion delivery ─────────────────────────────────────────────────────

/** Follow-up source for one child completion. The parent message id derives from it. */
const childCompletionSourceId = (requestId: RequestId) => `delegate-complete:${requestId}`

/** Bounded preview inside the parent message; the full output lives on the child branch. */
const maximumPreviewChars = 4_000

/** The error a completion carries is one line, `…` included; the child's events keep it whole. */
const maximumErrorChars = 1_000

/**
 * The error a turn that ended badly ended on, as one bounded line. A turn
 * that completed carries none: an error it went on past is not its outcome.
 */
const completionError = (outcome: ChildOutcome, error: Option.Option<string>) =>
  error.pipe(
    Option.filter(() => childFailureNames(outcome).length > 0),
    Option.map((text) => {
      const line = text.replace(/\s+/g, " ").trim()
      if (line.length <= maximumErrorChars) return line
      return `${headChars(line, maximumErrorChars - 1)}…`
    }),
    Option.filter((text) => text.length > 0),
  )

/**
 * The message a parent reads when a child finishes.
 *
 * A turn receipt is not task success, and the ways a turn can end badly are
 * not visible in the child's text: an interrupted turn, a failed model
 * stream, and a turn that spent its continuations without answering all
 * produce output a parent would otherwise read as a completed result. Each
 * flag the receipt carries is named here so the parent model sees it, with
 * the error the turn ended on, so a failure that will repeat (a sign-in, a
 * missing key) reads differently from a flake.
 */
export const describeChildCompletion = (params: {
  readonly requestId: RequestId
  readonly agentName: AgentName
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly outcome: ChildOutcome
  readonly text: string
  /** The bounded line `completionError` made. */
  readonly error?: string
  /** Where a snapshot child's work is (`workLine`). */
  readonly work?: string
}): string => {
  const status = childOutcomeWords(params.outcome)
  const preview = headTailChars(params.text, maximumPreviewChars)
  return [
    `Child agent "${params.agentName}" ${status}. requestId ${params.requestId}; session ${params.sessionId}; branch ${params.branchId}.`,
    ...Option.match(Option.fromUndefinedOr(params.error), {
      onNone: () => [],
      onSome: (error) => [`Error: ${error}`],
    }),
    ...Option.toArray(Option.fromUndefinedOr(params.work)),
    "Completion is a turn receipt, not task success. Read the output before relying on it.",
    "",
    preview.text,
  ].join("\n")
}

/**
 * The agent and status words `describeChildCompletion` wrote on the first
 * line. Rows saved before the details carried an outcome read it here.
 */
export const readChildCompletionHeadline = (
  text: string,
): Option.Option<{ readonly agentName: string; readonly status: string }> =>
  Option.fromNullishOr(
    /^Child agent "([^"\n]*)" (completed|ended \([^)\n]+\))\. requestId /.exec(text),
  ).pipe(
    Option.flatMap(([, agentName, status]) =>
      Option.all({
        agentName: Option.fromNullishOr(agentName),
        status: Option.fromNullishOr(status),
      }),
    ),
  )

export const CHILD_COMPLETION_TYPE = "child-completion"

/** One call a child made, as its completion row draws it. */
const ChildToolLine = Schema.Struct({
  name: Schema.String,
  summary: Schema.String,
  status: Schema.Literals(["completed", "error", "incomplete"]),
})
type ChildToolLine = typeof ChildToolLine.Type

/**
 * `metadata.details` of a child-completion message. The row that draws it
 * commits to scrollback once, after the child ends, so it carries everything
 * the row shows. Only the three ids are required: older rows carry nothing
 * else.
 */
export const ChildCompletionDetails = Schema.Struct({
  requestId: RequestId,
  sessionId: SessionId,
  branchId: BranchId,
  agentName: Schema.optionalKey(AgentName),
  outcome: Schema.optionalKey(ChildOutcome),
  usage: Schema.optionalKey(ChildUsage),
  /** The error a turn that ended badly ended on, one bounded line. Absent on older rows. */
  error: Schema.optionalKey(Schema.String),
  /** The child session's name, as the tray and the sessions pane show it. Absent on older rows. */
  name: Schema.optionalKey(Schema.String),
  /** The child's last calls, oldest first. `toolCount` counts every call. */
  tools: Schema.optionalKey(Schema.Array(ChildToolLine)),
  toolCount: Schema.optionalKey(Schema.Finite),
  /** Every call by tool and outcome, so the row's summary counts more than the kept calls. Absent on older rows. */
  toolCounts: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        status: ChildToolLine.fields.status,
        count: Schema.Finite,
      }),
    ),
  ),
  /** From the child's start message to its last message of the turn. Absent on older rows. */
  durationMs: Schema.optionalKey(Schema.Finite),
  /** A snapshot child's work: its copy, the branch that holds it, and its size. Absent for a shared child. */
  workspace: Schema.optionalKey(
    Schema.Struct({
      path: Schema.optionalKey(Schema.String),
      branch: Schema.optionalKey(Schema.String),
      files: Schema.optionalKey(Schema.Finite),
      insertions: Schema.optionalKey(Schema.Finite),
      deletions: Schema.optionalKey(Schema.Finite),
      error: Schema.optionalKey(Schema.String),
    }),
  ),
})

/** The completion row shows the child's last calls; the child branch keeps them all. */
const MAX_COMPLETION_TOOLS = 20

/**
 * The receipts a saved cell result carries under `operations`, read
 * leniently. The cell extension writes them (`CellOperationReceipt`).
 */
const CellReceipts = Schema.Struct({
  operations: Schema.Array(
    Schema.Struct({
      tool: Schema.String,
      outcome: Schema.Literals(["succeeded", "failed", "incomplete"]),
      summary: Schema.String,
    }),
  ),
})
const decodeCellReceipts = Schema.decodeUnknownOption(CellReceipts)

const receiptStatus = (outcome: "succeeded" | "failed" | "incomplete"): ChildToolLine["status"] => {
  if (outcome === "succeeded") return "completed"
  if (outcome === "failed") return "error"
  return "incomplete"
}

/** The calls a child made, from its saved tool results: a cell's receipts stand for the calls it admitted. */
const childToolLines = (
  messages: ReadonlyArray<{ readonly parts: ReadonlyArray<Message["parts"][number]> }>,
): ReadonlyArray<ChildToolLine> =>
  messages.flatMap((message) =>
    message.parts.flatMap((part): ReadonlyArray<ChildToolLine> => {
      if (part.type !== "tool-result") return []
      const receipts = Option.filter(decodeCellReceipts(part.result), () => part.name === "cell")
      if (Option.isSome(receipts)) {
        return receipts.value.operations.map((receipt) => ({
          name: receipt.tool,
          summary: receipt.summary,
          status: receiptStatus(receipt.outcome),
        }))
      }
      let status: ChildToolLine["status"] = "completed"
      if (part.isFailure) status = "error"
      return [{ name: part.name, summary: "", status }]
    }),
  )

/** Every call by tool and outcome, in the order each pair first ran. */
const toolCountsOf = (tools: ReadonlyArray<ChildToolLine>) => {
  const counts = new Map<string, { name: string; status: ChildToolLine["status"]; count: number }>()
  for (const tool of tools) {
    const key = `${tool.name}\u0000${tool.status}`
    const current = counts.get(key)
    if (Predicate.isUndefined(current))
      counts.set(key, { name: tool.name, status: tool.status, count: 1 })
    else current.count += 1
  }
  return Array.from(counts.values())
}

/** The time the start turn took: its first message to its last. */
const turnDuration = (messages: ReadonlyArray<{ readonly createdAt: Date }>): number => {
  const first = messages.at(0)
  const last = messages.at(-1)
  if (Predicate.isUndefined(first) || Predicate.isUndefined(last)) return 0
  return Math.max(0, last.createdAt.getTime() - first.createdAt.getTime())
}

/** An Option usage becomes a `usage` field, or nothing. */
const usageField = (
  usage: Option.Option<typeof ChildUsage.Type>,
): { readonly usage?: typeof ChildUsage.Type } =>
  Option.match(usage, { onNone: () => ({}), onSome: (value) => ({ usage: value }) })

/** The row once its completion is in the parent's hands, however it got there. */
const settled = (entry: DelegateEntry, outcome: ChildOutcome): DelegateEntry => ({
  ...entry,
  completed: outcome,
  delivered: true,
})

/** A row a parent's interrupt settled as stopped, whose notice no turn has read yet. */
const claimedByStop = (row: DelegateEntry) =>
  Predicate.isNotUndefined(row.stopNoticeAt) && row.completed?.interrupted === true

/** The row as it was before a stop claimed it: running, with no stop notice. */
const unclaimed = (row: DelegateEntry): DelegateEntry => ({
  ...Struct.omit(row, ["completed", "stopNoticeAt"]),
  delivered: false,
})

/** A snapshot child's work as its completion carries it. */
interface ChildWork {
  readonly line: string
  readonly details: NonNullable<(typeof ChildCompletionDetails.Type)["workspace"]>
}

/** The completion's line for a collected copy, and its details. */
const workOf = (work: CollectedWork): ChildWork => {
  if (Predicate.isNotUndefined(work.problem)) {
    return {
      line: `Work: not on a branch: ${work.problem} (${work.path}).`,
      details: { path: work.path, error: work.problem },
    }
  }
  return Option.match(Option.fromUndefinedOr(work.branch), {
    onNone: () => ({
      line: `Work: no changes in the child's copy at ${work.path}.`,
      details: { path: work.path, files: 0, insertions: 0, deletions: 0 },
    }),
    onSome: (branch) => ({
      line: `Work: branch ${branch}, one commit over the child's copy as it started (${work.files} files, +${work.insertions} -${work.deletions}). Nothing is merged; read it with git show ${branch}.`,
      details: {
        path: work.path,
        branch,
        files: work.files,
        insertions: work.insertions,
        deletions: work.deletions,
      },
    }),
  })
}

/**
 * A snapshot child's work, brought back to the origin as a branch before its
 * completion goes out; a shared child has none. The completion is for the
 * child's start turn, which the workspaces turn end may have collected
 * already: the same turn is collected once. A collect that fails is one line
 * in the completion, which still goes out.
 */
const childWork = Effect.fn("Delegate.childWork")(function* (entry: DelegateEntry) {
  const places = yield* Effect.serviceOption(Workspaces)
  if (Option.isNone(places)) return Option.none<ChildWork>()
  const collected = yield* places.value
    .collect(entry.sessionId, startMessageId(entry))
    .pipe(Effect.result)
  if (collected._tag === "Success") return Option.map(collected.success, workOf)
  const message = collected.failure.message
  return Option.some<ChildWork>({
    line: `Work: the child's copy was not collected: ${message}`,
    details: { error: message },
  })
})

/**
 * Queue the completion on the parent branch and return the marked entry.
 * Runs under the parent registry's lock; `delivered` is the idempotency key,
 * and the follow-up's source-derived id makes a repeat a queue replacement,
 * never a second message.
 */
const deliverCompletion = (
  parent: { readonly sessionId: SessionId; readonly branchId: BranchId },
  entry: DelegateEntry,
  outcome: ChildOutcome,
  usage: Option.Option<typeof ChildUsage.Type>,
  turnError: Option.Option<string>,
) =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const { name, messages } = yield* childMessages(entry)
    const text = latestAssistantText(messages)
    const tools = childToolLines(messages)
    const error = Option.getOrUndefined(completionError(outcome, turnError))
    const work = yield* childWork(entry)
    const details: typeof ChildCompletionDetails.Type = {
      requestId: entry.requestId,
      sessionId: entry.sessionId,
      branchId: entry.branchId,
      agentName: entry.agentName,
      ...Record.filter({ name }, Predicate.isNotUndefined),
      outcome,
      ...usageField(usage),
      ...Record.filter({ error }, Predicate.isNotUndefined),
      tools: tools.slice(-MAX_COMPLETION_TOOLS),
      toolCount: tools.length,
      toolCounts: toolCountsOf(tools),
      durationMs: turnDuration(messages),
      ...Option.match(work, {
        onNone: () => ({}),
        onSome: (found) => ({ workspace: found.details }),
      }),
    }
    yield* ctx.Session.send({
      delivery: "queue",
      ...parent,
      sourceId: childCompletionSourceId(entry.requestId),
      // A parent with no prior turn still gets to read the completion.
      wake: true,
      content: describeChildCompletion({
        requestId: entry.requestId,
        agentName: entry.agentName,
        sessionId: entry.sessionId,
        branchId: entry.branchId,
        outcome,
        text,
        ...Record.filter(
          { error, work: Option.getOrUndefined(Option.map(work, (found) => found.line)) },
          Predicate.isNotUndefined,
        ),
      }),
      metadata: { customType: CHILD_COMPLETION_TYPE, details },
    })
    return settled(entry, outcome)
  })

const CHILD_TASK_PREFIX = "Task from your parent session "

/** `metadata.customType` on a child's first message, the task its parent gave it. */
export const CHILD_TASK_TYPE = "child-task"

/**
 * The child's first message names where the task came from. Without it a
 * child reads a bare instruction after its system prompt and can take its
 * own task for an injection. It also says where results go. The reply that
 * ends this turn is the result: it returns as the completion, and a child
 * told only that "a later result goes through session.send" sent this turn's
 * result that way too, so the parent read every result twice. A question
 * in this turn is the reply too: a child that also sent it woke its parent
 * twice with the same news. Only a later turn that nobody waits for reports
 * with session.send: one a wake, a monitor or a goal starts, and one the
 * parent's answer starts. The first message stays in every later turn's
 * context, whichever agent runs that turn. A turn that no client opened in
 * the child's own session cannot ask; the decline's own notes tell the child
 * how to report the ask.
 */
export const childTaskText = (
  parentSessionId: SessionId,
  prompt: string,
  place?: { readonly cwd: string; readonly branch: string },
): string =>
  [
    `${CHILD_TASK_PREFIX}${parentSessionId}. Your final reply in this turn is your result: it returns to the parent as your completion by itself, so do not also send it with session.send. When you are blocked in this turn, end it with your question as that reply.`,
    `End this turn once the task is done or handed to a wake, a monitor or a goal; do not wait for them. Any later turn (a message from your parent, a wake, a monitor, a goal) returns nothing by itself: send its result or question with session.send to "parent".`,
    ...Option.match(Option.fromUndefinedOr(place), {
      onNone: () => [],
      onSome: ({ cwd, branch }) => [
        `You work in a private copy of your parent's working tree at ${cwd}. When each of your turns ends, your changes go back to the parent as the git branch ${branch}; you do not need to commit or push.`,
      ],
    }),
    "",
    prompt,
  ].join("\n")

/** The task without its source line; a message that is not a child task is returned whole. */
export const childTaskBody = (text: string): string =>
  Option.liftPredicate(text, (value) => value.startsWith(CHILD_TASK_PREFIX)).pipe(
    Option.flatMap((value) =>
      Option.liftPredicate(value.indexOf("\n\n"), (split) => split !== -1).pipe(
        Option.map((split) => value.slice(split + 2)),
      ),
    ),
    Option.getOrElse(() => text),
  )

/** The place a snapshot child works in; none for a shared child. */
const childPlace = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const places = yield* Effect.serviceOption(Workspaces)
    if (Option.isNone(places)) return Option.none()
    return yield* places.value.find(sessionId)
  })

/** The child's prompt as its one durable turn. A repeat with the same id is a no-op at the loop. */
const submitStart = (entry: DelegateEntry) =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const place = yield* childPlace(entry.sessionId)
    yield* ctx.Session.send({
      delivery: "turn",
      sessionId: entry.sessionId,
      branchId: entry.branchId,
      content: childTaskText(
        ctx.sessionId,
        entry.prompt,
        Option.getOrUndefined(Option.map(place, ({ cwd, branch }) => ({ cwd, branch }))),
      ),
      commandId: ActorCommandId.make(startMessageId(entry)),
      completion: "admission",
      metadata: { customType: CHILD_TASK_TYPE },
    })
  })

/**
 * A child deleted outside the delegate (the agents pane) never reports, so
 * its row settles as interrupted. The user removed it, so no message wakes
 * the parent. Rows already settled are returned as they are.
 */
const settleIfGone = (entry: DelegateEntry) =>
  Effect.gen(function* () {
    if (entry.delivered || Predicate.isNotUndefined(entry.completed)) return entry
    const ctx = yield* ExtensionContext
    const child = yield* ctx.Session.getSession(entry.sessionId)
    if (Predicate.isNotUndefined(child)) return entry
    return settled(entry, { interrupted: true })
  })

/**
 * Bring the current branch's registry up to date without a hook: a start
 * not marked sent is re-sent and its receipt still read, a finished child whose
 * completion never landed (the process died between the receipt and the
 * hook) is delivered now, a deleted child settles as interrupted, and a
 * private row is removed with its session, never delivered. With `resume`, a
 * child with no receipt is re-sent its start so a child the previous process
 * stopped mid-turn resumes. Only the gated reconcile of the parent's loop open
 * and turns (`reconcileOnce`) resumes; the listing tools read receipts and
 * never re-send a start that was sent.
 */
const reconcile = Effect.fn("Delegate.reconcile")(function* (options: {
  readonly resume: boolean
}) {
  const ctx = yield* ExtensionContext
  const parent = { sessionId: ctx.sessionId, branchId: ctx.branchId }
  yield* registry.modify((entries) =>
    Effect.gen(function* () {
      let next = entries
      for (const entry of entries) {
        // Private rows come only from files written before the goal option was removed.
        if (entry.private) {
          yield* ctx.Session.delete(entry.sessionId).pipe(Effect.ignore)
          next = next.filter((current) => current.requestId !== entry.requestId)
          continue
        }
        if (entry.delivered) {
          // A stop's claim over a turn that completed on its own, whose hook
          // never delivered: the completion lands now.
          if (!claimedByStop(entry)) continue
          const own = Option.filter(
            yield* turnEnd({ ...entry, messageId: startMessageId(entry) }),
            (end) => end.receipt.interrupted !== true,
          )
          if (Option.isNone(own)) continue
          const { receipt, error } = own.value
          const delivered = yield* deliverCompletion(
            parent,
            unclaimed(entry),
            outcomeOf(receipt),
            usageOf(receiptTotal(receipt)),
            error,
          )
          next = replaceEntry(next, delivered)
          continue
        }
        const current = yield* settleIfGone(entry)
        if (current.delivered) {
          next = replaceEntry(next, current)
          continue
        }
        // The flag does not say whether the child ran: a crash after its
        // start was admitted but before the flag was saved leaves `false` on
        // a child that may have finished. So the start is re-sent either way
        // (a repeat of its id admits nothing new) and the receipt decides.
        const sent = { ...entry, submitted: true }
        if (!entry.submitted) {
          yield* submitStart(entry)
          next = replaceEntry(next, sent)
        }
        const end = yield* turnEnd({
          ...entry,
          messageId: startMessageId(entry),
        })
        if (Option.isNone(end)) {
          // No receipt yet: the child is running, or it was mid-turn when the
          // previous process stopped. The re-send carries the start's id, so
          // the loop admits nothing new, but it opens the child's loop, and
          // the open resumes the unfinished turn.
          if (entry.submitted && options.resume) yield* submitStart(entry)
          continue
        }
        const { receipt, error } = end.value
        const delivered = yield* deliverCompletion(
          parent,
          sent,
          outcomeOf(receipt),
          usageOf(receiptTotal(receipt)),
          error,
        )
        next = replaceEntry(next, delivered)
      }
      return { next, result: next }
    }),
  )
})

/**
 * Branches this process has reconciled on a turn. Reconcile repairs what a
 * crash or a failed hook left; the turnAfter hook delivers every completion
 * otherwise. So a branch's turns reconcile once per process, and again after
 * any delivery fails: a failure invalidates every mark, because the failed
 * hook may not know which parent it was writing to. A generation keeps a
 * reconcile that raced the failure from marking its branch clean. Without the
 * gate every model step replays each running child's event log.
 * `delegate.list` still reconciles on each call.
 */
class ReconciledBranches extends Context.Service<
  ReconciledBranches,
  {
    /** The current generation, read before a reconcile starts. */
    readonly generation: Effect.Effect<number>
    readonly has: (key: string) => Effect.Effect<boolean>
    /** Marks the branch only when no failure invalidated the marks since `generation`. */
    readonly add: (key: string, generation: number) => Effect.Effect<void>
    readonly invalidate: Effect.Effect<void>
  }
>()("@gent/extensions/src/delegate/ReconciledBranches") {}

interface ReconciledState {
  readonly generation: number
  readonly keys: ReadonlySet<string>
}

const ReconciledBranchesResource = defineResource({
  id: "@gent/delegate/reconciled-branches",
  scope: "process",
  layer: Layer.effect(
    ReconciledBranches,
    Effect.map(Ref.make<ReconciledState>({ generation: 0, keys: new Set() }), (state) =>
      ReconciledBranches.of({
        generation: Effect.map(Ref.get(state), (current) => current.generation),
        has: (key) => Effect.map(Ref.get(state), (current) => current.keys.has(key)),
        add: (key, generation) =>
          Ref.update(state, (current) => {
            if (current.generation !== generation) return current
            return { generation, keys: new Set([...current.keys, key]) }
          }),
        invalidate: Ref.update(state, (current) => ({
          generation: current.generation + 1,
          keys: new Set<string>(),
        })),
      }),
    ),
  ),
})

/** The turn-time reconcile: once per branch per process, again after a failed delivery or reconcile. */
const reconcileOnce = Effect.gen(function* () {
  const ctx = yield* ExtensionContext
  const reconciled = yield* ReconciledBranches
  const key = `${ctx.sessionId}:${ctx.branchId}`
  if (yield* reconciled.has(key)) return
  const generation = yield* reconciled.generation
  yield* reconcile({ resume: true })
  yield* reconciled.add(key, generation)
})

// ── admission ───────────────────────────────────────────────────────────────

interface AdmitParams {
  readonly prompt: string
  /** The child's session name; none derives one from the prompt. */
  readonly name?: string
  /** Seeds the child with this branch's current context window before its first turn. */
  readonly historyBranchId?: BranchId
  /** The tool call that owns the child. The same id admits the same child once. */
  readonly requestId?: RequestId
  readonly toolCallId?: ToolCallId
  /** The child's run overrides; the child's admission keeps them for every turn. */
  readonly runSpec?: RunSpec
  /** `snapshot` runs the child in its own copy of this session's working tree. */
  readonly isolation?: Isolation
}

type Isolation = "shared" | "snapshot"

/**
 * The request id of the child session's create: a digest of the start's
 * whole identity (the parent session, the parent branch, the tool call).
 * Core keeps one session per request id, so a tool call id alone would give
 * two parents whose calls share an id one child.
 */
const childCreateRequestId = Effect.fn("Delegate.childCreateRequestId")(function* (
  parent: { readonly sessionId: SessionId; readonly branchId: BranchId },
  requestId: RequestId,
) {
  const crypto = yield* Crypto.Crypto
  const identity = [parent.sessionId, parent.branchId, requestId].join("\n")
  const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(identity))
  return RequestId.make(`delegate.start:${Hex.encode(digest)}`)
})

/**
 * The child session a start stored, read from storage: the one session under
 * this parent branch whose cwd is in the start's copy. The copy's path is
 * named by the start's whole identity, so no other start's child works there.
 */
const storedChildIn = Effect.fn("Delegate.storedChildIn")(function* (cwd: string) {
  const ctx = yield* ExtensionContext
  const sessions = yield* ctx.Session.listSessions({ thread: ctx.sessionId })
  return Option.fromUndefinedOr(
    sessions.find(
      (session) =>
        session.parentSessionId === ctx.sessionId &&
        session.parentBranchId === ctx.branchId &&
        session.cwd === cwd,
    ),
  )
})

/**
 * A snapshot child's place for the admission. The copy's record exists from
 * the first step of its making. When the admission fails or is interrupted
 * (the finalizer on the admission's scope, which closes after the registry
 * write), storage decides what happens to the copy, not what this fiber saw:
 * core can store the session and then be interrupted before `Session.create`
 * returns. A stored child session gets the copy (bound); a copy is released
 * only when storage shows no child session works in it; a check that fails
 * keeps the copy. The making itself can be interrupted. A shared child gets
 * none.
 */
const admissionPlace = Effect.fn("Delegate.admissionPlace")(function* (params: AdmitParams) {
  if (params.isolation !== "snapshot") return Option.none()
  const ctx = yield* ExtensionContext
  const places = yield* Effect.serviceOption(Workspaces)
  if (Option.isNone(places)) {
    return yield* new DelegateError({
      message:
        'isolation "snapshot" needs the @gent/workspaces extension, which is not active for this session',
    })
  }
  if (Predicate.isUndefined(params.requestId)) {
    return yield* new DelegateError({ message: 'isolation "snapshot" needs a request id' })
  }
  const start = yield* places.value.locate({ key: params.requestId, cwd: ctx.cwd })
  const acquired = yield* Ref.make(Option.none<{ readonly cwd: string }>())
  yield* Effect.addFinalizer((exit) =>
    Effect.gen(function* () {
      if (Exit.isSuccess(exit)) return
      // No place: `Session.create` never ran, so no session can work in the copy.
      const place = yield* Ref.get(acquired)
      let stored = Option.none<{ readonly id: SessionId }>()
      if (Option.isSome(place)) stored = yield* storedChildIn(place.value.cwd)
      if (Option.isSome(stored)) {
        return yield* places.value.bind(start.name, stored.value.id)
      }
      yield* places.value.release(start.name)
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("delegate.workspace.kept").pipe(
          Effect.annotateLogs({ name: start.name, cause: Cause.pretty(cause) }),
        ),
      ),
    ),
  )
  const place = yield* places.value.acquire(start)
  yield* Ref.set(acquired, Option.some({ cwd: place.cwd }))
  const handOff = (sessionId: SessionId) => places.value.bind(place.name, sessionId)
  return Option.some({ place, handOff })
})

const unfinished = (entries: ReadonlyArray<DelegateEntry>) =>
  entries.filter((entry) => Predicate.isUndefined(entry.completed))

/**
 * Admit one child under the current branch and send its prompt. The child
 * counts against the branch's cap and is listed for the parent's view. The
 * row is written before the prompt is sent and marked submitted after, so a
 * crash in between leaves a row that reconcile re-sends, never a running
 * child nobody owns.
 */
const admitChild = Effect.fn("Delegate.admit")(function* (params: AdmitParams) {
  const ctx = yield* ExtensionContext
  const admitted = yield* registry
    .modify((entries) =>
      Effect.gen(function* () {
        const requested = Option.fromUndefinedOr(params.requestId)
        const existing = Option.flatMap(requested, (id) =>
          Option.fromUndefinedOr(entries.find((entry) => entry.requestId === id)),
        )
        if (Option.isSome(existing)) {
          if (existing.value.prompt !== params.prompt) {
            return yield* new DelegateError({ message: "Child start request input changed" })
          }
          const child = yield* ctx.Session.getSession(existing.value.sessionId)
          if (Predicate.isUndefined(child)) {
            return yield* new DelegateError({ message: "Child session no longer exists" })
          }
          return { next: entries, result: { ...existing.value, notes: [] } }
        }
        // At the cap, a child deleted since the last reconcile frees its slot.
        let current = entries
        if (unfinished(current).length >= MAX_PENDING_CHILDREN) {
          current = yield* Effect.forEach(current, settleIfGone)
        }
        if (unfinished(current).length >= MAX_PENDING_CHILDREN) {
          return yield* new DelegateError({
            message: `Parent branch already has ${MAX_PENDING_CHILDREN} unfinished children`,
          })
        }
        const place = yield* admissionPlace(params)
        const createRequestId = yield* Option.match(requested, {
          onNone: () => Effect.succeedNone,
          onSome: (id) => Effect.asSome(childCreateRequestId(ctx, id)),
        })
        // The child is its agent for every turn it runs, not only this one.
        const child = yield* ctx.Session.create({
          name: childName(params),
          ...Option.match(place, {
            onNone: () => ({}),
            onSome: ({ place }) => ({ cwd: place.cwd }),
          }),
          parentBranchId: ctx.branchId,
          admission: {
            agent: DELEGATE_AGENT_NAME,
            runSpec: childRunSpec(params.runSpec),
          },
          ...Record.filter(
            {
              requestId: Option.getOrUndefined(createRequestId),
              historyBranchId: params.historyBranchId,
            },
            Predicate.isNotUndefined,
          ),
        })
        if (Option.isSome(place)) yield* place.value.handOff(child.sessionId)
        const requestId = Option.getOrElse(requested, () =>
          RequestId.make(`run:${child.sessionId}`),
        )
        const entry: DelegateEntry = {
          requestId,
          ...child,
          agentName: DELEGATE_AGENT_NAME,
          prompt: params.prompt,
          ...Record.filter({ toolCallId: params.toolCallId }, Predicate.isNotUndefined),
          startMessageId: MessageId.make(`delegate-start:${child.sessionId}`),
          private: false,
          submitted: false,
          delivered: false,
        }
        return {
          next: [...current, entry],
          result: {
            ...entry,
            notes: Option.match(place, { onNone: () => [], onSome: ({ place }) => place.notes }),
          },
        }
      }),
    )
    .pipe(Effect.scoped, asDelegateError("Child start failed"))
  if (!admitted.submitted) {
    yield* submitStart(admitted).pipe(asDelegateError("Child start failed"))
    // Only the flag changes: a hook may have settled the row since it was written.
    yield* registry
      .update((entries) =>
        entries.map((row) => {
          if (row.requestId !== admitted.requestId) return row
          return { ...row, submitted: true }
        }),
      )
      .pipe(asDelegateError("Child start failed"))
  }
  yield* ctx.State.changed().pipe(Effect.ignore)
  return { ...admitted, submitted: true }
})

// ── stopping ────────────────────────────────────────────────────────────────

/**
 * Stop a running child for the parent's interrupt.
 *
 * The row is claimed first: settled as interrupted with a stop notice, so the
 * child's own hook, when its turn ends interrupted, finds it delivered and
 * sends no message. A parent that stopped its children is not woken by them;
 * its next turn reads the notice instead. The stop runs outside the registry
 * lock, because the child's own hook takes that lock.
 *
 * A turn that completed before the stop reached it still holds its loop while
 * its hooks run, so the stop's answer is true for it too. Its own hook tells
 * the two apart: a turn that ended without an interrupt delivers its
 * completion over the claim (`onChildTurnAfter`). A stop that fails hands the
 * row back and fails: the child runs on and reports itself.
 */
const stopChild = Effect.fn("Delegate.stopChild")(function* (entry: DelegateEntry) {
  const ctx = yield* ExtensionContext
  const branchRegistry = registry.at(ctx.branchId)
  const stoppedAt = yield* Clock.currentTimeMillis
  const claim = yield* branchRegistry.modify((entries) =>
    Effect.sync(() => {
      const current = entries.find((row) => row.requestId === entry.requestId)
      if (Predicate.isUndefined(current) || current.delivered) {
        return { next: entries, result: false }
      }
      const stopped = { ...settled(current, { interrupted: true }), stopNoticeAt: stoppedAt }
      return { next: replaceEntry(entries, stopped), result: true }
    }),
  )
  if (!claim) return
  const answer = yield* Effect.exit(
    ctx.Session.stopMessage({
      sessionId: entry.sessionId,
      branchId: entry.branchId,
      messageId: startMessageId(entry),
    }),
  )
  if (Exit.isSuccess(answer)) return
  yield* branchRegistry.update((entries) =>
    entries.map((row) => {
      if (row.requestId !== entry.requestId || row.stopNoticeAt !== stoppedAt) return row
      return unclaimed(row)
    }),
  )
  return yield* Effect.failCause(answer.cause)
})

/**
 * The child's own turn receipt, seen from its branch. The registry lives with
 * the parent, so the hook looks the parent up and writes there. A turn that
 * ended without an interrupt delivers even over a stop's claim: it completed
 * before the parent's stop reached it.
 */
const onChildTurnAfter = Effect.fn("Delegate.turnAfter")(function* (input: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly messageId: MessageId
  readonly interrupted: boolean
  readonly streamFailed: boolean
  readonly unanswered: boolean
  readonly usage: TurnUsage
}) {
  const ctx = yield* ExtensionContext
  const session = yield* ctx.Session.getSession(input.sessionId)
  const parentSessionId = session?.parentSessionId
  const parentBranchId = session?.parentBranchId
  if (Predicate.isUndefined(parentSessionId) || Predicate.isUndefined(parentBranchId)) return
  const parent = { sessionId: parentSessionId, branchId: parentBranchId }
  const delivered = yield* registry.at(parentBranchId).modify((entries) =>
    Effect.gen(function* () {
      const found = entries.find(
        (row) =>
          (!row.delivered || (!input.interrupted && claimedByStop(row))) &&
          !row.private &&
          row.sessionId === input.sessionId &&
          startMessageId(row) === input.messageId,
      )
      if (Predicate.isUndefined(found)) return { next: entries, result: false }
      const entry = unclaimed(found)
      const outcome = outcomeOf(input)
      // The hook runs after the receipt is stored, so the turn's error is in
      // the child's events; a turn that completed has none to read.
      let error = Option.none<string>()
      if (childFailureNames(outcome).length > 0) {
        error = Option.flatMap(yield* turnEnd(input), (end) => end.error)
      }
      const marked = yield* deliverCompletion(
        parent,
        entry,
        outcome,
        // The row shows a child's total, as its `TurnCompleted` receipt does:
        // a partial count would read as the whole spend.
        usageOf(
          Option.map(
            Option.liftPredicate(input.usage, (usage) => usage.complete),
            (usage) => usage.known,
          ),
        ),
        error,
      )
      return { next: replaceEntry(entries, marked), result: true }
    }),
  )
  if (delivered) yield* ctx.State.changed().pipe(Effect.ignore)
})

/**
 * A parent's interrupted turn stops the children it started and had not yet
 * heard from. Left running, they have no owner: the parent's next turn can
 * neither read them nor cancel them, and the gamut testbed showed six such
 * children editing files after an Escape. A child interrupted this way ends
 * its own turn interrupted, so the cascade reaches its children too.
 */
const onParentTurnAfter = Effect.fn("Delegate.parentTurnAfter")(function* (input: {
  readonly branchId: BranchId
  readonly interrupted: boolean
}) {
  if (!input.interrupted) return
  const ctx = yield* ExtensionContext
  // An unsubmitted row settles too, so reconcile never sends a start the user interrupted.
  const running = (yield* registry.at(input.branchId).read()).filter(
    (row) => !row.delivered && Predicate.isUndefined(row.completed),
  )
  if (running.length === 0) return
  // One child's failed stop leaves the others to be stopped. The failed
  // child's hook may have skipped its claimed row, so the next turn reconciles.
  yield* Effect.forEach(
    running,
    (entry) =>
      stopChild(entry).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("delegate.stop.failed").pipe(
            Effect.annotateLogs({ requestId: entry.requestId, cause: Cause.pretty(cause) }),
            Effect.andThen(
              Effect.flatMap(ReconciledBranches, (reconciled) => reconciled.invalidate),
            ),
          ),
        ),
      ),
    { discard: true },
  )
  yield* ctx.State.changed().pipe(Effect.ignore)
})

/**
 * A stop notice names the task by its first line, cut here by code point; the
 * registry keeps the whole prompt.
 */
const maximumNoticeTaskChars = 80

/** The children one notice names; the rest are counted, and named once these are read. */
const maximumNoticeChildren = 8

const noticeTask = (prompt: string) => {
  const line = prompt.trim().split("\n")[0] ?? ""
  if (line.length <= maximumNoticeTaskChars) return line
  return `${headChars(line, maximumNoticeTaskChars - 1)}…`
}

/**
 * A child's session name (`childSessionName`). The agent's name only when
 * neither the start's name nor its task has words: every child runs as
 * `delegate`, so that name tells no child from another.
 */
const childName = (params: Pick<AdmitParams, "name" | "prompt">): string =>
  Option.getOrElse(
    childSessionName({ name: Option.fromUndefinedOr(params.name), prompt: params.prompt }),
    () => DELEGATE_AGENT_NAME,
  )

/** One unread stop notice: a row, at the stop that wrote it. A later stop of the same row is a new notice. */
const stopNoticeKey = (row: DelegateEntry) => `${row.requestId}@${row.stopNoticeAt}`

/**
 * The children the parent's interrupt stopped, as one turn notice, the way
 * `@gent/wake` shows a notify fire: the stop wakes nobody, and without this the
 * parent's next turn believes they still run. A child is one line however
 * often it was stopped, the newest first, at most `maximumNoticeChildren`;
 * the rest are a count. Every step reads it; an answered turn clears exactly
 * the rows it showed, and a row the cap left out stays for the next turn.
 *
 * The read takes the registry lock. A completion delivered over a stop's
 * claim is sent before its row is written, and the turn it wakes must not
 * read the claim's notice from the file the writer has not replaced yet.
 */
const stopNotices = Effect.fn("Delegate.stopNotices")(function* () {
  const current = yield* registry.modify((entries) =>
    Effect.succeed({ next: entries, result: entries }),
  )
  const stopped = current.filter((row) => Predicate.isNotUndefined(row.stopNoticeAt))
  if (stopped.length === 0) return []
  const byChild = new Map<SessionId, ReadonlyArray<DelegateEntry>>()
  for (const row of stopped)
    byChild.set(row.sessionId, [...(byChild.get(row.sessionId) ?? []), row])
  const newest = (rows: ReadonlyArray<DelegateEntry>) =>
    Math.max(...rows.map((row) => row.stopNoticeAt ?? 0))
  const children = [...byChild.values()].sort((left, right) => newest(right) - newest(left))
  const named = children.slice(0, maximumNoticeChildren)
  const unnamed = children.length - named.length
  const lines = named.map((rows) => {
    const [latest] = [...rows].sort(
      (left, right) => (right.stopNoticeAt ?? 0) - (left.stopNoticeAt ?? 0),
    )
    return `- "${noticeTask(latest?.prompt ?? "")}" · session ${latest?.sessionId} · requestId ${latest?.requestId}`
  })
  if (unnamed > 0) {
    lines.push(`- and ${unnamed} more stopped children, named once you have read these.`)
  }
  return [
    {
      id: "delegate-stopped",
      keys: named.flat().map(stopNoticeKey),
      content: `# Stopped children\n\nThe user interrupted your turn, and that stopped these children before they finished. They are not running, and no completion will come from them. Tell the user which children stopped; start one again only when the user asks for it.\n\n${lines.join("\n")}`,
    },
  ]
})

/**
 * Drops the stop notices the turn read. The runtime hands back only what an
 * answered turn showed: an interrupted, failed or unanswered turn keeps them,
 * and so does every notice the turn did not show. Nothing to drop leaves the
 * file unwritten.
 */
const clearReadStopNotices = Effect.fn("Delegate.clearStopNotices")(function* (
  input: Pick<TurnAfterInput, "branchId" | "readNotices">,
) {
  const shown = input.readNotices
  if (shown.size === 0) return
  const read = (row: DelegateEntry) =>
    Predicate.isNotUndefined(row.stopNoticeAt) && shown.has(stopNoticeKey(row))
  yield* registry.at(input.branchId).update((entries) => {
    // The same array back skips the write.
    if (!entries.some(read)) return entries
    return entries.map((row) => {
      if (!read(row)) return row
      return Struct.omit(row, ["stopNoticeAt"])
    })
  })
})

// ── tools ───────────────────────────────────────────────────────────────────

export const ChildAgentHandle = Schema.Struct({
  requestId: RequestId,
  sessionId: SessionId,
  branchId: BranchId,
})

/** What `delegate.list` reports per child; the outcome flags are the turn receipt. */
const ChildAgentRegistryEntry = Schema.Struct({
  ...ChildAgentHandle.fields,
  agentName: AgentName,
  completed: Schema.Boolean,
  ...ChildOutcome.fields,
})
type ChildAgentRegistryEntry = typeof ChildAgentRegistryEntry.Type

const ChildObservation = Schema.TaggedUnion({
  Pending: ChildAgentHandle.fields,
  Completed: { ...ChildAgentHandle.fields, ...ChildOutcome.fields },
})

const observationOf = (entry: DelegateEntry) => {
  const handle = {
    requestId: entry.requestId,
    sessionId: entry.sessionId,
    branchId: entry.branchId,
  }
  if (Predicate.isUndefined(entry.completed)) return ChildObservation.cases.Pending.make(handle)
  return ChildObservation.cases.Completed.make({ ...handle, ...entry.completed })
}

/** The registry row for a request on this branch, reconciled first. */
const ownedChild = Effect.fn("Delegate.ownedChild")(function* (requestId: RequestId) {
  const ctx = yield* ExtensionContext
  yield* reconcile({ resume: false })
  const entry = (yield* registry.read()).find((row) => row.requestId === requestId)
  if (Predicate.isUndefined(entry)) {
    return yield* new DelegateError({ message: "No such child on this branch" })
  }
  const child = yield* ctx.Session.getSession(entry.sessionId).pipe(
    asDelegateError("Child lookup failed"),
  )
  if (child?.parentSessionId !== ctx.sessionId || child.parentBranchId !== ctx.branchId) {
    return yield* new DelegateError({ message: "Child session no longer exists" })
  }
  return entry
})

const StartParams = Schema.Struct({
  todo: Schema.String.annotate({
    description:
      "The whole task. With context `fresh` the child has no conversation history; with `fork` it starts from your current context window.",
  }),
  name: Schema.optionalKey(
    Schema.String.annotate({
      description: "A short name for the child, a few words; defaults to the todo's first words.",
    }),
  ),
  context: Schema.optionalKey(
    Schema.Literals(["fresh", "fork"]).annotate({
      description:
        "`fresh` (default): the child sees only the todo. `fork`: the child also sees every message you see now, and can continue your work as it stands.",
    }),
  ),
  // The new keys only: an old key (`modelId`, `allowedTools`, `deniedTools`)
  // fails the call and names the key that replaced it.
  overrides: Schema.optionalKey(RunOverrides),
  isolation: Schema.optionalKey(
    Schema.Literals(["shared", "snapshot"]).annotate({
      description:
        "`shared` (default): the child edits your working tree. `snapshot`: the child works in its own copy of your git working tree, and its work comes back as a branch gent/<name> that nothing merges. A copy is not a sandbox.",
    }),
  ),
})

/** The handle, and for a snapshot child the place it works in. */
const StartOutput = Schema.Struct({
  ...ChildAgentHandle.fields,
  workspace: Schema.optionalKey(
    Schema.Struct({
      path: Schema.String,
      branch: Schema.String,
      /** What the copy did not do as asked, one line each (a worktree in place of rift, a failed hook). */
      note: Schema.optionalKey(Schema.String),
    }),
  ),
})

export const StartChild = tool({
  id: "delegate.start",
  description:
    "Start one child on a self-contained task and return its handle at admission, never its answer. The child runs as the delegate subagent with its own configured model and cannot delegate further. When it ends, its result arrives as a message on this branch and starts a turn by itself.",
  promptSnippet: "Start a child agent on a task",
  promptGuidelines: [
    "Use for independent work that benefits from a fresh context or parallelism. Do NOT delegate simple reads, searches, or single-file edits — do those directly.",
    'Each todo must be self-contained — a fresh child has no conversation history. Use context: "fork" when the child needs what you already read or decided; the copy is what you see now, so a long context is a costly seed.',
    "Start every independent child from one cell, then end your turn. Do not poll, set an alarm, or set a monitor for a child: each result wakes you as a message, and several may arrive over several turns. Chain dependent work by starting the next child from the turn that read the earlier result.",
    "Interrupting your turn stops every child you started and had not heard from.",
    "A finished child's armed wakes and monitors keep reporting to you. To stop them, ask the child with session.send to cancel its wakes.",
    "A new call starts new work. Do not repeat a start to recover an unknown outcome; delegate.list shows the children this branch owns, and read_session reads a finished child's transcript.",
    "For parallel exploration: don't share preliminary findings between children — let each form independent conclusions.",
    "Use overrides.model for a second opinion from a different model; overrides.systemPromptAddendum focuses a child on one role.",
  ],
  params: StartParams,
  output: StartOutput,
  execute: Effect.fn("StartChild.execute")(function* (params) {
    const ctx = yield* ExtensionContext
    if (Predicate.isUndefined(ctx.toolCallId)) {
      return yield* new DelegateError({ message: "delegate.start requires a host-owned tool call" })
    }
    const entry = yield* admitChild({
      prompt: params.todo,
      ...Record.filter({ name: params.name }, Predicate.isNotUndefined),
      ...Option.match(
        Option.liftPredicate(params.context, (context) => context === "fork"),
        {
          onNone: () => ({}),
          onSome: () => ({ historyBranchId: ctx.branchId }),
        },
      ),
      requestId: RequestId.make(ctx.toolCallId),
      toolCallId: ctx.toolCallId,
      runSpec: Option.match(Option.fromUndefinedOr(params.overrides), {
        onNone: () => ({}),
        // A call's tools and paths only narrow the definition, so they
        // cannot hand a child the delegation tools back.
        onSome: (overrides) => ({ overrides }),
      }),
      ...Record.filter({ isolation: params.isolation }, Predicate.isNotUndefined),
    })
    const place = yield* childPlace(entry.sessionId).pipe(asDelegateError("Child start failed"))
    return {
      requestId: entry.requestId,
      sessionId: entry.sessionId,
      branchId: entry.branchId,
      ...Option.match(place, {
        onNone: () => ({}),
        onSome: (place) => ({
          workspace: {
            path: place.cwd,
            branch: place.branch,
            ...Option.match(
              Option.liftPredicate(entry.notes.join("; "), (note) => note.length > 0),
              { onNone: () => ({}), onSome: (note) => ({ note }) },
            ),
          },
        }),
      }),
    }
  }),
})

export const CancelChild = tool({
  id: "delegate.cancel",
  description:
    "Cancel a running child on this branch. Its turn ends as interrupted; a finished child is left as it is.",
  params: Schema.Struct({ requestId: RequestId }),
  output: ChildObservation,
  execute: Effect.fn("CancelChild.execute")(function* (params) {
    const ctx = yield* ExtensionContext
    const entry = yield* ownedChild(params.requestId)
    if (Predicate.isUndefined(entry.completed)) {
      yield* ctx.Session.stopMessage({
        sessionId: entry.sessionId,
        branchId: entry.branchId,
        // Core keys a stop by the child's loop (workspace, session, branch) and
        // this id, so two parents' `start-1` cancels are two stops.
        requestId: RequestId.make(`delegate-cancel:${params.requestId}`),
        messageId: startMessageId(entry),
      }).pipe(Effect.asVoid, asDelegateError("Cannot submit child cancellation"))
    }
    return observationOf(entry)
  }),
})

export const ListChildren = tool({
  id: "delegate.list",
  description:
    "List every child this branch owns, from the registry. The registry survives restarts; completed is a turn receipt, not task success.",
  promptGuidelines: [
    "Use this after a restart or compaction to recover child handles you no longer hold.",
  ],
  params: Schema.Struct({
    completed: Schema.optionalKey(
      Schema.Boolean.annotate({
        description: "Keep only finished (true) or unfinished (false) children",
      }),
    ),
  }),
  output: Schema.Array(ChildAgentRegistryEntry),
  execute: Effect.fn("ListChildren.execute")(function* (params) {
    yield* reconcile({ resume: false })
    const children = (yield* registry.read()).map((entry): ChildAgentRegistryEntry => ({
      requestId: entry.requestId,
      sessionId: entry.sessionId,
      branchId: entry.branchId,
      agentName: entry.agentName,
      completed: Predicate.isNotUndefined(entry.completed),
      ...entry.completed,
    }))
    const wanted = Option.fromUndefinedOr(params.completed)
    if (Option.isNone(wanted)) return children
    return children.filter((child) => child.completed === wanted.value)
  }),
})

// ── extension ───────────────────────────────────────────────────────────────

/** The extension id a client matches state pulses against. */
export const DELEGATE_EXTENSION_ID = ExtensionId.make("@gent/delegate")

/**
 * How to work with children. A section, not tool guidelines: in a cell turn
 * the model sees only the cell tool, so tool guidelines stay behind
 * `tools(id)`. A child cannot delegate, so its turns do not get it: the
 * section is in the agent's own part of the prompt (core's
 * `AGENT_PROMPT_PRIORITY`), after the part a child shares with its parent.
 */
const CHILDREN_SECTION = {
  id: "children",
  priority: AGENT_PROMPT_PRIORITY + 12,
  content: `# Children

- Delegate independent, self-contained work to children: start each with delegate.start, from one cell when you work in one, then end your turn. Each child's result arrives as a message that wakes you.
- A fresh child has no conversation history, so give it a complete task; a forked child starts from your context. Do a single lookup, edit, or command inline.`,
}

const childrenSection = (agent: AgentDefinition) => {
  if (!agent.admitsTool("delegate.start")) return []
  return [CHILDREN_SECTION]
}

/** A hook step that fails logs and ends; with `reconcile`, the next turn repairs what it left. */
const logFailure =
  (event: string, reconcile: boolean) =>
  <E, R>(step: Effect.Effect<void, E, R>) =>
    step.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(event).pipe(
          Effect.annotateLogs({ cause: Cause.pretty(cause) }),
          Effect.andThen(
            Effect.flatMap(ReconciledBranches, (reconciled) => {
              if (!reconcile) return Effect.void
              return reconciled.invalidate
            }),
          ),
        ),
      ),
    )

/** Child admission and control: start, cancel, and list. */
export const DelegateExtension = defineExtension({
  id: DELEGATE_EXTENSION_ID,
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("agent", delegateAgent)
    yield* host.register("tool", StartChild, CancelChild, ListChildren)
    yield* host.register("resource", ReconciledBranchesResource)
    yield* host.on("sessionDeleted", ({ branchIds }) => registry.removeBranches(branchIds))
    // Every turn end is read three times: as a child's receipt for its
    // parent, as a parent's interrupt for its children, and as a parent's
    // answer that read its stop notices.
    // Each read fails alone: a session that is both a child and a parent
    // still stops its own children when its parent's registry is unreadable.
    yield* host.on("turnAfter", (input) =>
      Effect.all(
        [
          // A completion must not be lost: the parent's next turn reconciles again.
          onChildTurnAfter(input).pipe(logFailure("delegate.completion.failed", true)),
          // A failed stop leaves its row running: the next turn reconciles it.
          onParentTurnAfter(input).pipe(logFailure("delegate.cascade.failed", true)),
          // A notice left in place shows once more.
          clearReadStopNotices(input).pipe(logFailure("delegate.stop-notices.clear.failed", false)),
        ],
        { discard: true },
      ),
    )
    // A crash leaves children mid-turn or an undelivered entry. The parent's
    // loop open picks both up in the new process, before any turn; the
    // first turn reconciles again only if that failed.
    yield* host.on("loopOpen", () =>
      reconcileOnce.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("delegate.reconcile.failed").pipe(
            Effect.annotateLogs({ cause: Cause.pretty(cause) }),
          ),
        ),
      ),
    )
    yield* host.on("turnProjection", ({ agent }) =>
      reconcileOnce.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("delegate.reconcile.failed").pipe(
            Effect.annotateLogs({ cause: Cause.pretty(cause) }),
          ),
        ),
        Effect.andThen(
          stopNotices().pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("delegate.stop-notices.read.failed").pipe(
                Effect.annotateLogs({ cause: Cause.pretty(cause) }),
                Effect.as([]),
              ),
            ),
          ),
        ),
        Effect.map((notices) => ({ promptSections: childrenSection(agent), notices })),
      ),
    )
  }),
})
