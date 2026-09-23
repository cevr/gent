/**
 * Child agents, built on the public extension facade alone.
 *
 * A child is a session under the caller's branch, run as the `delegate`
 * agent. The registry is one JSON file per parent branch under
 * `~/.gent/delegates/`; every entry names the child, the tool call that owns
 * it, and whether the parent has its completion. `delegate.start` admits a
 * child and returns its handle at admission, never its answer: the child
 * reports through the delegate's own `turnAfter` hook, as a message on the
 * parent branch that wakes it. The same hook stops a parent's running children
 * when the parent's turn is interrupted. The parent's first turn in a
 * process and every `delegate.list` reconcile what a crash left.
 */
import {
  Cause,
  Context,
  Effect,
  Layer,
  Option,
  type PlatformError,
  Predicate,
  Record,
  Ref,
  Schema,
  Stream,
} from "effect"
import {
  ActorCommandId,
  AgentDefinition,
  type AgentEvent,
  AgentName,
  BranchId,
  defineExtension,
  defineRequests,
  defineResource,
  ExtensionContext,
  ExtensionHost,
  ExtensionId,
  type ExtensionServiceError,
  headTailChars,
  latestAssistantText,
  type Message,
  makeRunSpec,
  MessageId,
  request,
  RequestId,
  type RunSpec,
  RunSpecSchema,
  SessionId,
  ToolCallId,
  tool,
  type TurnUsage,
} from "@gent/core/extensions/api"
import { makeBranchStateStore } from "./branch-state-store.js"

// ── the subagent ────────────────────────────────────────────────────────────

/**
 * A child never delegates. Fan-out is the caller's decision, and a project
 * prompt that addresses "the orchestrator" reaches children too, so without
 * this a worker reads that prompt and spawns its own workers.
 */
const CHILD_DENIED_TOOLS: ReadonlyArray<string> = [
  "delegate.start",
  "delegate.cancel",
  "delegate.list",
]

export const DELEGATE_AGENT_NAME = AgentName.make("delegate")

/**
 * The one agent every child runs as. A child inherits nothing from its
 * caller: not the caller's agent, not the session's model. Its model and
 * effort come from this definition, reshaped by `agents.delegate` in
 * `.gent/config.json` (user, then project), and a call's own `overrides`
 * win over both. That config entry is where a pairing such as
 * fable → opus or opus → sonnet is declared.
 */
const delegateAgent = AgentDefinition.make({
  name: DELEGATE_AGENT_NAME,
  description:
    "The default subagent: runs one delegated task and cannot delegate further. It asks its parent with session.send when blocked.",
  deniedTools: CHILD_DENIED_TOOLS,
})

// ── registry ────────────────────────────────────────────────────────────────

export class DelegateError extends Schema.TaggedError<DelegateError>()("DelegateError", {
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

const ChildUsage = Schema.Struct({ input: Schema.Finite, output: Schema.Finite })

/** One child known to a parent branch. `completed` is a turn receipt, not task success. */
export const DelegateEntry = Schema.Struct({
  requestId: RequestId,
  sessionId: SessionId,
  branchId: BranchId,
  agentName: AgentName,
  prompt: Schema.String,
  toolCallId: Schema.optionalKey(ToolCallId),
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
  /** The run spec the start was admitted with; a re-sent start uses it again. */
  runSpec: Schema.optionalKey(RunSpecSchema),
  completed: Schema.optionalKey(ChildOutcome),
  /** The parent has the completion: the message is on the parent branch, or the parent stopped the child. */
  delivered: Schema.Boolean,
  /** Bounded copy of the child's answer, for the parent's view. */
  preview: Schema.optionalKey(Schema.String),
  usage: Schema.optionalKey(ChildUsage),
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
  Effect.mapError((cause: ExtensionServiceError | PlatformError.PlatformError | DelegateError) => {
    if (Schema.is(DelegateError)(cause)) return cause
    return new DelegateError({ message: `${message}: ${cause.message}`, cause })
  })

// ── child turns ─────────────────────────────────────────────────────────────

const startMessageId = (requestId: RequestId) => MessageId.make(`delegate-start:${requestId}`)

type TurnCompleted = Extract<AgentEvent, { readonly _tag: "TurnCompleted" }>
const isTurnCompleted = (event: AgentEvent): event is TurnCompleted =>
  event._tag === "TurnCompleted"
const isSynchronized = (event: AgentEvent) => event._tag === "StreamSynchronized"

interface TurnTarget {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly messageId: MessageId
}

/** The receipt of one turn, read from the child's durable history alone. */
const turnReceipt = (target: TurnTarget) =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    return yield* ctx.Session.events(target).pipe(
      Stream.takeUntil(isSynchronized),
      Stream.filter(isTurnCompleted),
      Stream.filter((event) => event.messageId === target.messageId),
      Stream.runLast,
    )
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

const usageOf = (
  usage: Option.Option<{ readonly inputTokens: number; readonly outputTokens: number }>,
): Option.Option<typeof ChildUsage.Type> =>
  Option.map(usage, (value) => ({ input: value.inputTokens, output: value.outputTokens }))

/** The outcome in words a model reads. */
const failureNames = (outcome: ChildOutcome): ReadonlyArray<string> => {
  const names: Array<string> = []
  if (outcome.interrupted === true) names.push("interrupted")
  if (outcome.streamFailed === true) names.push("model stream failed")
  if (outcome.unanswered === true) names.push("no answer produced")
  return names
}

/** How a child's turn ended, in the words the parent model and the completion row both show. */
export const childOutcomeWords = (outcome: ChildOutcome): string => {
  const failures = failureNames(outcome)
  if (failures.length === 0) return "completed"
  return `ended (${failures.join(", ")})`
}

/** The child branch's messages, from the session detail. */
/**
 * The child's messages from its start turn onward. A forked child's branch
 * begins with a copy of the parent's window; those rows are the parent's
 * reply and calls, never the child's.
 */
const childMessages = (entry: DelegateEntry) =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const detail = yield* ctx.Session.getDetail(entry.sessionId)
    const branch = detail.branches.find((current) => current.branch.id === entry.branchId)
    const messages = branch?.messages ?? []
    const start = messages.findIndex((message) => message.id === startMessageId(entry.requestId))
    if (start === -1) return []
    return messages.slice(start)
  })

const childName = (prompt: string) => `${DELEGATE_AGENT_NAME}: ${prompt.slice(0, 60)}`

/** Children never spend the parent's patience on a broken model. */
const childRunSpec = (runSpec: Option.Option<RunSpec>): RunSpec => {
  const base = Option.getOrElse(runSpec, () => makeRunSpec({}))
  return makeRunSpec({
    ...base,
    overrides: { maxModelAttempts: CHILD_MAX_MODEL_ATTEMPTS, ...base.overrides },
  })
}

// ── completion delivery ─────────────────────────────────────────────────────

/** Follow-up source for one child completion. The parent message id derives from it. */
const childCompletionSourceId = (requestId: RequestId) => `delegate-complete:${requestId}`

/** Bounded preview inside the parent message; the full output lives on the child branch. */
const maximumPreviewChars = 4_000

/** The registry keeps a one-line preview for the parent's view; the message carries the long one. */
const registryPreviewChars = 200
const clipPreview = (text: string) => {
  const chars = [...text]
  if (chars.length <= registryPreviewChars) return text
  return `${chars.slice(0, registryPreviewChars).join("")}…`
}

/**
 * The message a parent reads when a child finishes.
 *
 * A turn receipt is not task success, and the ways a turn can end badly are
 * not visible in the child's text: an interrupted turn, a failed model
 * stream, and a turn that spent its continuations without answering all
 * produce output a parent would otherwise read as a completed result. Each
 * flag the receipt carries is named here so the parent model sees it.
 */
export const describeChildCompletion = (params: {
  readonly requestId: RequestId
  readonly agentName: AgentName
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly outcome: ChildOutcome
  readonly text: string
}): string => {
  const status = childOutcomeWords(params.outcome)
  const preview = headTailChars(params.text, maximumPreviewChars)
  return [
    `Child agent "${params.agentName}" ${status}. requestId ${params.requestId}; session ${params.sessionId}; branch ${params.branchId}.`,
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
  /** The child's last calls, oldest first. `toolCount` counts every call. */
  tools: Schema.optionalKey(Schema.Array(ChildToolLine)),
  toolCount: Schema.optionalKey(Schema.Finite),
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

/** An Option usage becomes a `usage` field, or nothing. */
const usageField = (
  usage: Option.Option<typeof ChildUsage.Type>,
): { readonly usage?: typeof ChildUsage.Type } =>
  Option.match(usage, { onNone: () => ({}), onSome: (value) => ({ usage: value }) })

/** The row once its completion is in the parent's hands, however it got there. */
const settled = (
  entry: DelegateEntry,
  outcome: ChildOutcome,
  usage: Option.Option<typeof ChildUsage.Type>,
  text: string,
): DelegateEntry => ({
  ...entry,
  completed: outcome,
  delivered: true,
  preview: clipPreview(text),
  ...usageField(usage),
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
) =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const messages = yield* childMessages(entry)
    const text = latestAssistantText(messages)
    const tools = childToolLines(messages)
    const details: typeof ChildCompletionDetails.Type = {
      requestId: entry.requestId,
      sessionId: entry.sessionId,
      branchId: entry.branchId,
      agentName: entry.agentName,
      outcome,
      ...usageField(usage),
      tools: tools.slice(-MAX_COMPLETION_TOOLS),
      toolCount: tools.length,
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
      }),
      metadata: { customType: CHILD_COMPLETION_TYPE, details },
    })
    return settled(entry, outcome, usage, text)
  })

const CHILD_TASK_PREFIX = "Task from your parent session "

/**
 * The child's first message names where the task came from. Without it a
 * child reads a bare instruction after its system prompt and can take its
 * own task for an injection. It also says how a later turn reports: only the
 * turn that takes the task returns as the completion, and a wake, a monitor
 * or a goal starts turns nobody waits for. The first message stays in every
 * later turn's context, whichever agent runs that turn.
 */
export const childTaskText = (parentSessionId: SessionId, prompt: string): string =>
  [
    `${CHILD_TASK_PREFIX}${parentSessionId}. Your final reply to this task returns to the parent as your completion; ask it with session.send if you are blocked.`,
    `End this turn once the task is done or handed to a wake, a monitor or a goal; do not wait for them. A later turn's result reaches your parent only through session.send with to "parent", so send each one there.`,
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

/** The child's prompt as its one durable turn. A repeat with the same id is a no-op at the loop. */
const submitStart = (entry: DelegateEntry) =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    yield* ctx.Session.send({
      delivery: "turn",
      sessionId: entry.sessionId,
      branchId: entry.branchId,
      content: childTaskText(ctx.sessionId, entry.prompt),
      commandId: ActorCommandId.make(startMessageId(entry.requestId)),
      agentOverride: entry.agentName,
      interactive: false,
      runSpec: childRunSpec(Option.fromUndefinedOr(entry.runSpec)),
      completion: "admission",
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
    return settled(entry, { interrupted: true }, Option.none(), "")
  })

/**
 * Bring the current branch's registry up to date without a hook: a start
 * whose prompt never reached the child is re-sent, a finished child whose
 * completion never landed (the process died between the receipt and the
 * hook) is delivered now, a deleted child settles as interrupted, and a
 * private row is removed with its session, never delivered. Called from the
 * parent's turn and its listing tools.
 */
const reconcile = Effect.fn("Delegate.reconcile")(function* () {
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
        if (entry.delivered) continue
        const current = yield* settleIfGone(entry)
        if (current.delivered) {
          next = replaceEntry(next, current)
          continue
        }
        if (!entry.submitted) {
          yield* submitStart(entry)
          next = replaceEntry(next, { ...entry, submitted: true })
          continue
        }
        const receipt = yield* turnReceipt({
          ...entry,
          messageId: startMessageId(entry.requestId),
        })
        if (Option.isNone(receipt)) continue
        const delivered = yield* deliverCompletion(
          parent,
          entry,
          outcomeOf(receipt.value),
          usageOf(Option.fromUndefinedOr(receipt.value.usage)),
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
 * `delegate.list` and `delegate.children` still reconcile on each call.
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
  yield* reconcile()
  yield* reconciled.add(key, generation)
})

// ── admission ───────────────────────────────────────────────────────────────

interface AdmitParams {
  readonly prompt: string
  /** Seeds the child with this branch's current context window before its first turn. */
  readonly historyBranchId?: BranchId
  /** The tool call that owns the child. The same id admits the same child once. */
  readonly requestId?: RequestId
  readonly toolCallId?: ToolCallId
  /** `overrides`, `parentToolCallId`. */
  readonly runSpec?: RunSpec
}

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
          return { next: entries, result: existing.value }
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
        const child = yield* ctx.Session.create({
          name: childName(params.prompt),
          parentSessionId: ctx.sessionId,
          parentBranchId: ctx.branchId,
          ...Record.filter(
            { requestId: params.requestId, historyBranchId: params.historyBranchId },
            Predicate.isNotUndefined,
          ),
        })
        const requestId = Option.getOrElse(requested, () =>
          RequestId.make(`run:${child.sessionId}`),
        )
        const entry: DelegateEntry = {
          requestId,
          ...child,
          agentName: DELEGATE_AGENT_NAME,
          prompt: params.prompt,
          ...Record.filter({ toolCallId: params.toolCallId }, Predicate.isNotUndefined),
          runSpec: makeRunSpec({
            ...params.runSpec,
            ...Record.filter({ parentToolCallId: params.toolCallId }, Predicate.isNotUndefined),
          }),
          private: false,
          submitted: false,
          delivered: false,
        }
        return { next: [...current, entry], result: entry }
      }),
    )
    .pipe(asDelegateError("Child start failed"))
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
 * Settle a running child's row as interrupted, then stop it. The row is
 * settled first so the child's own receipt finds it delivered and sends no
 * message: a parent that stopped its children is not woken by them.
 */
const stopChild = (entry: DelegateEntry) =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    yield* registry
      .at(ctx.branchId)
      .update((entries) => {
        const current = entries.find((row) => row.requestId === entry.requestId)
        if (Predicate.isUndefined(current) || current.delivered) return entries
        return replaceEntry(entries, settled(current, { interrupted: true }, Option.none(), ""))
      })
      .pipe(Effect.ignore)
    yield* ctx.Session.stop({
      sessionId: entry.sessionId,
      branchId: entry.branchId,
      requestId: RequestId.make(`delegate-stop:${entry.sessionId}`),
    }).pipe(Effect.ignore)
  })

/**
 * The child's own turn receipt, seen from its branch. The registry lives with
 * the parent, so the hook looks the parent up and writes there.
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
      const entry = entries.find(
        (row) =>
          !row.delivered &&
          !row.private &&
          row.sessionId === input.sessionId &&
          startMessageId(row.requestId) === input.messageId,
      )
      if (Predicate.isUndefined(entry)) return { next: entries, result: false }
      const marked = yield* deliverCompletion(
        parent,
        entry,
        outcomeOf(input),
        // The row shows a child's total, as its `TurnCompleted` receipt does:
        // a partial count would read as the whole spend.
        usageOf(
          Option.map(
            Option.liftPredicate(input.usage, (usage) => usage.complete),
            (usage) => usage.known,
          ),
        ),
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
  yield* Effect.forEach(running, stopChild, { discard: true })
  yield* ctx.State.changed().pipe(Effect.ignore)
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
  yield* reconcile()
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

/** A call's `deniedTools` replaces the definition's, so the delegation tools are denied again here. */
const childOverrides = (overrides: (typeof StartParams.Type)["overrides"]) => ({
  ...overrides,
  deniedTools: [...CHILD_DENIED_TOOLS, ...(overrides?.deniedTools ?? [])],
})

const StartParams = Schema.Struct({
  todo: Schema.String.annotate({
    description:
      "The whole task. With context `fresh` the child has no conversation history; with `fork` it starts from your current context window.",
  }),
  context: Schema.optionalKey(
    Schema.Literals(["fresh", "fork"]).annotate({
      description:
        "`fresh` (default): the child sees only the todo. `fork`: the child also sees every message you see now, and can continue your work as it stands.",
    }),
  ),
  overrides: RunSpecSchema.fields.overrides,
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
    "A new call starts new work. Do not repeat a start to recover an unknown outcome; delegate.list shows the children this branch owns, and read_session reads a finished child's transcript.",
    "For parallel exploration: don't share preliminary findings between children — let each form independent conclusions.",
    "Use overrides.modelId for a second opinion from a different model; overrides.systemPromptAddendum focuses a child on one role.",
  ],
  params: StartParams,
  output: ChildAgentHandle,
  execute: Effect.fn("StartChild.execute")(function* (params) {
    const ctx = yield* ExtensionContext
    if (Predicate.isUndefined(ctx.toolCallId)) {
      return yield* new DelegateError({ message: "delegate.start requires a host-owned tool call" })
    }
    const entry = yield* admitChild({
      prompt: params.todo,
      ...Option.match(
        Option.liftPredicate(params.context, (context) => context === "fork"),
        {
          onNone: () => ({}),
          onSome: () => ({ historyBranchId: ctx.branchId }),
        },
      ),
      requestId: RequestId.make(ctx.toolCallId),
      toolCallId: ctx.toolCallId,
      runSpec: makeRunSpec({ overrides: childOverrides(params.overrides) }),
    })
    return { requestId: entry.requestId, sessionId: entry.sessionId, branchId: entry.branchId }
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
      yield* ctx.Session.stop({
        sessionId: entry.sessionId,
        branchId: entry.branchId,
        requestId: RequestId.make(`delegate-cancel:${params.requestId}`),
        messageId: startMessageId(params.requestId),
      }).pipe(asDelegateError("Cannot submit child cancellation"))
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
    yield* reconcile()
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

// ── client read model ───────────────────────────────────────────────────────

const DELEGATE_EXTENSION_ID = ExtensionId.make("@gent/delegate")

/** One child as a client renders it. `status` is a turn receipt, not task success. */
export const DelegateChild = Schema.Struct({
  requestId: RequestId,
  sessionId: SessionId,
  branchId: BranchId,
  agentName: AgentName,
  toolCallId: Schema.optionalKey(ToolCallId),
  status: Schema.Literals(["running", "completed", "error"]),
  preview: Schema.optionalKey(Schema.String),
  usage: Schema.optionalKey(ChildUsage),
})
export type DelegateChild = typeof DelegateChild.Type

/** A registry row read as running, completed, or errored, from its turn receipt. */
const childStatus = (entry: DelegateEntry): DelegateChild["status"] => {
  if (Predicate.isUndefined(entry.completed)) return "running"
  if (failureNames(entry.completed).length > 0) return "error"
  return "completed"
}

const toDelegateChild = (entry: DelegateEntry): DelegateChild => ({
  requestId: entry.requestId,
  sessionId: entry.sessionId,
  branchId: entry.branchId,
  agentName: entry.agentName,
  ...Record.filter({ toolCallId: entry.toolCallId }, Predicate.isNotUndefined),
  status: childStatus(entry),
  ...Record.filter({ preview: entry.preview, usage: entry.usage }, Predicate.isNotUndefined),
})

/** The children a branch owns, for a client child view. Reconciles first so a crashed start is not missed. */
export const DelegateRpc = defineRequests(DELEGATE_EXTENSION_ID, {
  Children: request({
    id: "delegate.children",
    description: "Every child this branch owns, from the registry",
    input: Schema.Struct({}),
    output: Schema.Array(DelegateChild),
    execute: Effect.fn("DelegateRpc.Children")(function* () {
      yield* reconcile()
      return (yield* registry.read()).map(toDelegateChild)
    }),
  }),
})

// ── extension ───────────────────────────────────────────────────────────────

/**
 * How to work with children. A section, not tool guidelines: in a cell turn
 * the model sees only the cell tool, so tool guidelines stay behind
 * `tools(id)`. A child cannot delegate, so its turns do not get it.
 */
const CHILDREN_SECTION = {
  id: "children",
  priority: 12,
  content: `# Children

- Delegate independent, self-contained work to children: start each with delegate.start, from one cell when you work in one, then end your turn. Each child's result arrives as a message that wakes you.
- A fresh child has no conversation history, so give it a complete task; a forked child starts from your context. Do a single lookup, edit, or command inline.`,
}

const childrenSection = (agent: AgentDefinition) => {
  if (agent.deniedTools?.includes("delegate.start") === true) return []
  return [CHILDREN_SECTION]
}

/** Child admission and control: start, send, cancel, and list. */
export const DelegateExtension = defineExtension({
  id: "@gent/delegate",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("agent", delegateAgent)
    yield* host.register("tool", StartChild, CancelChild, ListChildren)
    yield* host.register("request", DelegateRpc.Children)
    yield* host.register("resource", ReconciledBranchesResource)
    // Every turn end is read twice: as a child's receipt for its parent, and
    // as a parent's interrupt for its children.
    yield* host.on("turnAfter", (input) =>
      onChildTurnAfter(input).pipe(
        Effect.andThen(onParentTurnAfter(input)),
        Effect.catchCause((cause) =>
          Effect.logWarning("delegate.completion.failed").pipe(
            Effect.annotateLogs({ cause: Cause.pretty(cause) }),
            // A completion must not be lost: the parent's next turn reconciles again.
            Effect.andThen(
              Effect.flatMap(ReconciledBranches, (reconciled) => reconciled.invalidate),
            ),
          ),
        ),
      ),
    )
    // A crash between a child's receipt and its hook leaves an undelivered
    // entry; the parent's first turn in the new process picks it up.
    yield* host.on("turnProjection", ({ agent }) =>
      reconcileOnce.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("delegate.reconcile.failed").pipe(
            Effect.annotateLogs({ cause: Cause.pretty(cause) }),
          ),
        ),
        Effect.as(childrenSection(agent)),
        Effect.map((promptSections) => ({ promptSections })),
      ),
    )
  }),
})
