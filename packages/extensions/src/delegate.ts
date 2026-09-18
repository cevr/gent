/**
 * Child agents, built on the public extension facade alone.
 *
 * A child is a session under the caller's branch. The registry is one JSON
 * file per parent branch under `~/.gent/delegates/`; every entry names the
 * child, the tool call that owns it, and whether the parent has read its
 * completion. Foreground runs (`delegate`, `btw`, `read_session`) await the
 * child's turn here. Background starts return a handle; the child's own
 * `turnAfter` hook queues the completion on the parent branch, and the
 * parent's next turn or an `agent-children` call reconciles anything a crash
 * left behind.
 */
import { Cause, Effect, Fiber, Option, Predicate, Record, Schema, Stream } from "effect"
import {
  ActorCommandId,
  type AgentDefinition,
  type AgentEvent,
  AgentName,
  AgentRunToolCallSchema,
  BranchId,
  defineExtension,
  defineRequests,
  ExtensionContext,
  ExtensionHost,
  ExtensionId,
  type ExtensionServiceError,
  headTailChars,
  latestAssistantText,
  makeRunSpec,
  MessageId,
  messagesToolCalls,
  request,
  RequestId,
  requireCurrentAgent,
  type RunSpec,
  RunSpecSchema,
  SessionId,
  ToolCallId,
  tool,
} from "@gent/core/extensions/api"
import { makeBranchStateStore } from "./branch-state-store.js"

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
  /** A background child owes the parent one completion message. */
  background: Schema.Boolean,
  /** The child's prompt reached its loop; a start that crashed before this is re-sent. */
  submitted: Schema.Boolean,
  completed: Schema.optionalKey(ChildOutcome),
  /** The completion message is on the parent branch. */
  delivered: Schema.Boolean,
  /** Bounded copy of the child's answer, for the parent's view. */
  preview: Schema.optionalKey(Schema.String),
  usage: Schema.optionalKey(ChildUsage),
})
export type DelegateEntry = typeof DelegateEntry.Type

/** What `agent-children` lists. */
const ChildAgentRegistryEntry = Schema.Struct({
  requestId: RequestId,
  sessionId: SessionId,
  branchId: BranchId,
  agentName: AgentName,
  completed: Schema.Boolean,
})
type ChildAgentRegistryEntry = typeof ChildAgentRegistryEntry.Type

/** Maximum unfinished background children owned by one parent branch. */
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
  Effect.mapError((cause: ExtensionServiceError | DelegateError) => {
    if (Schema.is(DelegateError)(cause)) return cause
    return new DelegateError({ message: `${message}: ${cause.message}`, cause })
  })

// ── child turns ─────────────────────────────────────────────────────────────

const startMessageId = (requestId: RequestId) => MessageId.make(`agent-start:${requestId}`)
const runMessageId = (sessionId: SessionId) => MessageId.make(`agent-run:${sessionId}`)

type TurnCompleted = Extract<AgentEvent, { readonly _tag: "TurnCompleted" }>
const isTurnCompleted = (event: AgentEvent): event is TurnCompleted =>
  event._tag === "TurnCompleted"
const isSynchronized = (event: AgentEvent) => event._tag === "StreamSynchronized"

/** The receipt of one turn, read from the child's durable history. */
const turnReceipt = (target: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly messageId: MessageId
}) =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    return yield* ctx.Session.events(target).pipe(
      Stream.takeUntil(isSynchronized),
      Stream.filter(isTurnCompleted),
      Stream.filter((event) => event.messageId === target.messageId),
      Stream.runLast,
    )
  })

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
    Predicate.isNotUndefined,
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

/** A non-empty tool-call list becomes a `toolCalls` field; an empty one is omitted. */
const nonEmptyToolCalls = (toolCalls: ReadonlyArray<typeof AgentRunToolCallSchema.Type>) => {
  if (toolCalls.length > 0) return { toolCalls }
  return {}
}

/** The child branch's messages, from the session detail. */
const childMessages = (target: { readonly sessionId: SessionId; readonly branchId: BranchId }) =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const detail = yield* ctx.Session.getDetail(target.sessionId)
    const branch = detail.branches.find((entry) => entry.branch.id === target.branchId)
    return branch?.messages ?? []
  })

const childName = (agent: AgentDefinition, prompt: string) =>
  `${agent.name}: ${prompt.slice(0, 60)}`

/** The history override for a `create`: an inheriting child forks the parent branch. */
const historyBranch = (inherit: boolean, branchId: BranchId) => {
  if (inherit) return { historyBranchId: branchId }
  return {}
}

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
const childCompletionSourceId = (requestId: RequestId) => `child:${requestId}:complete`

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
  const failures = failureNames(params.outcome)
  let status = "completed"
  if (failures.length > 0) status = `ended (${failures.join(", ")})`
  const preview = headTailChars(params.text, maximumPreviewChars)
  return [
    `Child agent "${params.agentName}" ${status}. requestId ${params.requestId}; session ${params.sessionId}; branch ${params.branchId}.`,
    "Completion is a turn receipt, not task success. Read the output before relying on it.",
    "",
    preview.text,
  ].join("\n")
}

/**
 * Queue the completion on the parent branch and return the marked entry.
 * Runs under the parent registry's lock; `delivered` is the idempotency key,
 * and the follow-up's source-derived id makes a repeat a queue replacement,
 * never a second message.
 */
/** An Option usage becomes a `usage` field, or nothing. */
const usageField = (
  usage: Option.Option<typeof ChildUsage.Type>,
): { readonly usage?: typeof ChildUsage.Type } =>
  Option.match(usage, { onNone: () => ({}), onSome: (value) => ({ usage: value }) })

const deliverCompletion = (
  parent: { readonly sessionId: SessionId; readonly branchId: BranchId },
  entry: DelegateEntry,
  outcome: ChildOutcome,
  usage: Option.Option<typeof ChildUsage.Type>,
) =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const text = latestAssistantText(yield* childMessages(entry))
    yield* ctx.Session.queueFollowUp({
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
      metadata: {
        customType: "child-completion",
        details: {
          requestId: entry.requestId,
          sessionId: entry.sessionId,
          branchId: entry.branchId,
        },
      },
    })
    return {
      ...entry,
      completed: outcome,
      delivered: true,
      preview: clipPreview(text),
      ...usageField(usage),
    }
  })

/** The child's prompt as its one durable turn. A repeat with the same id is a no-op at the loop. */
const submitStart = (entry: DelegateEntry, runSpec: Option.Option<RunSpec>) =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    yield* ctx.Session.send({
      sessionId: entry.sessionId,
      branchId: entry.branchId,
      content: entry.prompt,
      commandId: ActorCommandId.make(startMessageId(entry.requestId)),
      agentOverride: entry.agentName,
      interactive: false,
      runSpec: childRunSpec(runSpec),
      completion: "admission",
    })
  })

/**
 * Bring the current branch's registry up to date without a hook: a start
 * whose prompt never reached the child is re-sent, and a finished child whose
 * completion never landed (the process died between the receipt and the
 * hook) is delivered now. Called from the parent's turn and its listing tools.
 */
const reconcile = Effect.fn("Delegate.reconcile")(function* () {
  const ctx = yield* ExtensionContext
  const parent = { sessionId: ctx.sessionId, branchId: ctx.branchId }
  yield* registry.modify((entries) =>
    Effect.gen(function* () {
      let next = entries
      for (const entry of entries) {
        if (!entry.background || entry.delivered) continue
        if (!entry.submitted) {
          yield* submitStart(entry, Option.none())
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

// ── foreground runs ─────────────────────────────────────────────────────────

const ChildRunUsage = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cost: Schema.optional(Schema.Finite),
})

/** What a foreground child hands back. `Error` names a turn that ended badly, with any partial text. */
const ChildRunResult = Schema.TaggedUnion({
  Success: {
    text: Schema.String,
    sessionId: SessionId,
    agentName: AgentName,
    usage: Schema.optional(ChildRunUsage),
    toolCalls: Schema.optional(Schema.Array(AgentRunToolCallSchema)),
  },
  Error: {
    error: Schema.String,
    sessionId: Schema.optional(SessionId),
    agentName: Schema.optional(AgentName),
  },
})
type ChildRunResult = typeof ChildRunResult.Type

interface RunChildParams {
  readonly agent: AgentDefinition
  readonly prompt: string
  /** `history`, `visibility`, `overrides`, `parentToolCallId`. */
  readonly runSpec?: RunSpec
  /** Sees the child's events as they happen. Best effort: the result can return before trailing events are observed. */
  readonly observe?: (event: AgentEvent) => Effect.Effect<void>
}

/**
 * One child session under the current branch, awaited here. A private run
 * leaves no trace: no registry entry, and its session is deleted once the
 * answer is read. Any other run is listed on the parent branch for its view.
 */
export const runChild = Effect.fn("Delegate.runChild")(function* (params: RunChildParams) {
  const ctx = yield* ExtensionContext
  const runSpec = params.runSpec
  const isPrivate = runSpec?.visibility === "private"
  const agentName = params.agent.name
  const toolCallId = runSpec?.parentToolCallId
  const inherit = runSpec?.history === "inherit"

  const created = yield* ctx.Session.create({
    name: childName(params.agent, params.prompt),
    parentSessionId: ctx.sessionId,
    parentBranchId: ctx.branchId,
    // An inheriting child forks the parent branch's history; otherwise it starts clean.
    ...historyBranch(inherit, ctx.branchId),
  }).pipe(asDelegateError("Child admission failed"), Effect.exit)
  if (created._tag === "Failure") {
    if (Cause.hasInterruptsOnly(created.cause)) return yield* Effect.interrupt
    return ChildRunResult.cases.Error.make({ error: Cause.pretty(created.cause), agentName })
  }
  const child = created.value
  const requestId = RequestId.make(`run:${child.sessionId}`)
  const pulse = ctx.State.changed().pipe(Effect.ignore)

  if (!isPrivate) {
    yield* registry.update((entries) => [
      ...entries,
      {
        requestId,
        ...child,
        agentName,
        prompt: params.prompt,
        ...Record.filter({ toolCallId }, Predicate.isNotUndefined),
        background: false,
        submitted: true,
        delivered: true,
      },
    ])
    yield* pulse
  }

  const messageId = runMessageId(child.sessionId)
  const run = Effect.gen(function* () {
    // The observer sees the child's events as they happen; its failures never fail the run.
    const observer = yield* Option.match(Option.fromUndefinedOr(params.observe), {
      onNone: () => Effect.succeedNone,
      onSome: (notify) =>
        ctx.Session.events(child).pipe(
          Stream.runForEach((event) => notify(event).pipe(Effect.ignore)),
          Effect.ignore,
          Effect.forkChild,
          Effect.asSome,
        ),
    })
    yield* ctx.Session.send({
      ...child,
      content: params.prompt,
      commandId: ActorCommandId.make(messageId),
      agentOverride: agentName,
      interactive: false,
      runSpec: childRunSpec(Option.fromUndefinedOr(runSpec)),
    }).pipe(
      asDelegateError("Child prompt was not admitted"),
      // A foreground child belongs to this call. Left running after the
      // caller is interrupted, it has no owner to await or cancel it.
      Effect.onInterrupt(() =>
        ctx.Session.steer({
          _tag: "Interrupt",
          ...child,
          requestId: RequestId.make(`agent-run-interrupt:${child.sessionId}`),
        }).pipe(Effect.ignore),
      ),
      Effect.ensuring(
        Option.match(observer, { onNone: () => Effect.void, onSome: Fiber.interrupt }),
      ),
    )

    const receipt = yield* turnReceipt({ ...child, messageId }).pipe(
      Effect.catchCause(() => Effect.succeedNone),
    )
    const messages = yield* childMessages(child)
    const outcome = Option.match(receipt, { onNone: (): ChildOutcome => ({}), onSome: outcomeOf })
    const usage = Option.flatMap(receipt, (event) => usageOf(Option.fromUndefinedOr(event.usage)))
    const text = latestAssistantText(messages)
    const failures = failureNames(outcome)
    if (!isPrivate) {
      yield* registry.update((entries) =>
        entries.map((entry) => {
          if (entry.requestId !== requestId) return entry
          return {
            ...entry,
            completed: outcome,
            preview: clipPreview(text),
            ...usageField(usage),
          }
        }),
      )
      yield* pulse
    }
    if (failures.length > 0) {
      let error = `The child turn ended (${failures.join(", ")}).`
      if (text.length > 0) error = `${error} Partial output:\n${text}`
      return ChildRunResult.cases.Error.make({ error, sessionId: child.sessionId, agentName })
    }
    const toolCalls = messagesToolCalls(messages)
    return ChildRunResult.cases.Success.make({
      text,
      sessionId: child.sessionId,
      agentName,
      ...usageField(usage),
      ...nonEmptyToolCalls(toolCalls),
    })
  }).pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
      return Effect.succeed(
        ChildRunResult.cases.Error.make({
          error: Cause.pretty(cause),
          sessionId: child.sessionId,
          agentName,
        }),
      )
    }),
  )
  if (!isPrivate) return yield* run
  // A private child is gone once its answer is read. Best effort; a leftover row is not a failed run.
  return yield* run.pipe(Effect.ensuring(ctx.Session.delete(child.sessionId).pipe(Effect.ignore)))
})

// ── background starts ───────────────────────────────────────────────────────

/**
 * Admit one durable child under the current tool call and return its handle.
 * The same request returns the same child; the completion arrives later as a
 * message on this branch.
 */
const startChild = Effect.fn("Delegate.startChild")(function* (params: {
  readonly agent: AgentDefinition
  readonly prompt: string
  readonly requestId: RequestId
  readonly toolCallId: ToolCallId
  readonly runSpec?: RunSpec
}) {
  const ctx = yield* ExtensionContext
  const handle = yield* registry
    .modify((entries) =>
      Effect.gen(function* () {
        const existing = entries.find((entry) => entry.requestId === params.requestId)
        if (Predicate.isNotUndefined(existing)) {
          if (existing.prompt !== params.prompt || existing.agentName !== params.agent.name) {
            return yield* new DelegateError({ message: "Agent-start request input changed" })
          }
          const child = yield* ctx.Session.getSession(existing.sessionId)
          if (Predicate.isUndefined(child)) {
            return yield* new DelegateError({ message: "Agent-start child no longer exists" })
          }
          return {
            next: entries,
            result: { sessionId: existing.sessionId, branchId: existing.branchId },
          }
        }
        const pending = entries.filter(
          (entry) => entry.background && Predicate.isUndefined(entry.completed),
        )
        if (pending.length >= MAX_PENDING_CHILDREN) {
          return yield* new DelegateError({
            message: `Parent branch already has ${MAX_PENDING_CHILDREN} unfinished child starts`,
          })
        }
        const child = yield* ctx.Session.create({
          name: childName(params.agent, params.prompt),
          parentSessionId: ctx.sessionId,
          parentBranchId: ctx.branchId,
          requestId: params.requestId,
        })
        const entry: DelegateEntry = {
          requestId: params.requestId,
          ...child,
          agentName: params.agent.name,
          prompt: params.prompt,
          toolCallId: params.toolCallId,
          background: true,
          submitted: false,
          delivered: false,
        }
        yield* submitStart(
          entry,
          Option.some(makeRunSpec({ ...params.runSpec, parentToolCallId: params.toolCallId })),
        )
        return { next: [...entries, { ...entry, submitted: true }], result: child }
      }),
    )
    .pipe(asDelegateError("Child start failed"))
  yield* ctx.State.changed().pipe(Effect.ignore)
  return handle
})

/** The registry row for a request on this branch, with its live completion. */
const inspectChild = Effect.fn("Delegate.inspect")(function* (requestId: RequestId) {
  const ctx = yield* ExtensionContext
  yield* reconcile()
  const entry = (yield* registry.read()).find((row) => row.requestId === requestId)
  if (Predicate.isUndefined(entry) || !entry.background) {
    return yield* new DelegateError({ message: "Agent-start receipt not owned by parent" })
  }
  const child = yield* ctx.Session.getSession(entry.sessionId).pipe(
    asDelegateError("Child lookup failed"),
  )
  if (child?.parentSessionId !== ctx.sessionId || child.parentBranchId !== ctx.branchId) {
    return yield* new DelegateError({ message: "Agent-start child no longer exists" })
  }
  return entry
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
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number }
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
          row.background &&
          !row.delivered &&
          row.sessionId === input.sessionId &&
          startMessageId(row.requestId) === input.messageId,
      )
      if (Predicate.isUndefined(entry)) return { next: entries, result: false }
      const marked = yield* deliverCompletion(
        parent,
        entry,
        outcomeOf(input),
        usageOf(Option.fromUndefinedOr(input.usage)),
      )
      return { next: replaceEntry(entries, marked), result: true }
    }),
  )
  if (delivered) yield* ctx.State.changed().pipe(Effect.ignore)
})

// ── child agent tools ───────────────────────────────────────────────────────

export const ChildAgentHandle = Schema.Struct({
  requestId: RequestId,
  sessionId: SessionId,
  branchId: BranchId,
})

const ChildObservation = Schema.TaggedUnion({
  Pending: ChildAgentHandle.fields,
  Completed: {
    ...ChildAgentHandle.fields,
    interrupted: Schema.optionalKey(Schema.Boolean),
    streamFailed: Schema.optionalKey(Schema.Boolean),
    /** The child spent its continuations and never answered. */
    unanswered: Schema.optionalKey(Schema.Boolean),
  },
})

export const ControlChildAgent = tool({
  id: "agent-child",
  description:
    "Inspect, message, or cancel a child started with delegate background: true. Pending is not proof that work is running; completed is a turn receipt, not task success.",
  promptGuidelines: [
    "Completion arrives as a message on this branch; inspect is for a point-in-time check, not a wait.",
    "After completion, use read_session with the returned sessionId and branchId to read the child output. Omit goal to avoid another model call.",
    "Read the output before treating completion as task success. Interrupted or failed turns can have partial output.",
    "send puts a message into the child's running turn: a correction, a new fact, a narrower scope. The child reads it at its next step. A finished child takes no messages; delegate a new task instead.",
  ],
  params: Schema.Struct({
    action: Schema.Literals(["inspect", "send", "cancel"]),
    requestId: RequestId,
    message: Schema.optionalKey(
      Schema.String.annotate({ description: "The text the child reads. Required for send." }),
    ),
  }),
  output: ChildObservation,
  execute: Effect.fn("ControlChildAgent.execute")(function* (params) {
    const ctx = yield* ExtensionContext
    const entry = yield* inspectChild(params.requestId)
    const child = { sessionId: entry.sessionId, branchId: entry.branchId }
    if (params.action === "cancel" && Predicate.isUndefined(entry.completed)) {
      yield* ctx.Session.steer({
        _tag: "Cancel",
        ...child,
        requestId: RequestId.make(`agent-cancel:${params.requestId}`),
        messageId: startMessageId(params.requestId),
      }).pipe(asDelegateError("Cannot submit child cancellation"))
    }
    if (params.action === "send") {
      const message = params.message ?? ""
      if (message.trim().length === 0 || Predicate.isUndefined(ctx.toolCallId)) {
        return yield* new DelegateError({
          message: "send needs a message and a host-owned tool call",
        })
      }
      if (Predicate.isNotUndefined(entry.completed)) {
        return yield* new DelegateError({
          message:
            "The child already finished and takes no more messages. Read its output, or delegate a new task.",
        })
      }
      yield* ctx.Session.steer({
        _tag: "Interject",
        ...child,
        requestId: RequestId.make(`agent-send:${ctx.toolCallId}`),
        message,
        // The child can finish between the check above and the actor taking
        // this command. An idle branch only queues steering, so without the
        // wake the message would sit unread forever.
        wake: true,
      }).pipe(asDelegateError("Cannot message the child"))
    }
    const handle = { requestId: params.requestId, ...child }
    if (Predicate.isUndefined(entry.completed)) return ChildObservation.cases.Pending.make(handle)
    return ChildObservation.cases.Completed.make({ ...handle, ...entry.completed })
  }),
})

const ListChildAgents = tool({
  id: "agent-children",
  description:
    "List every background delegation owned by this branch from the registry. The registry survives restarts.",
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
  execute: Effect.fn("ListChildAgents.execute")(function* (params) {
    yield* reconcile()
    const children = (yield* registry.read())
      .filter((entry) => entry.background)
      .map((entry): ChildAgentRegistryEntry => ({
        requestId: entry.requestId,
        sessionId: entry.sessionId,
        branchId: entry.branchId,
        agentName: entry.agentName,
        completed: Predicate.isNotUndefined(entry.completed),
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
  background: Schema.Boolean,
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
  background: entry.background,
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

// ── delegate tool and extension ─────────────────────────────────────────────

/**
 * A child never delegates. Fan-out is the caller's decision, and a project
 * prompt that addresses "the orchestrator" reaches children too, so without
 * this a worker reads that prompt and spawns its own workers.
 */
const CHILD_DENIED_TOOLS: ReadonlyArray<string> = ["delegate", "agent-child", "agent-children"]

const childOverrides = (overrides: (typeof DelegateParams.Type)["overrides"]) => ({
  ...overrides,
  deniedTools: [...CHILD_DENIED_TOOLS, ...(overrides?.deniedTools ?? [])],
})

/** One self-contained task for a child that inherits this agent. Cells compose parallel and chained delegations. */
const DelegateParams = Schema.Struct({
  todo: Schema.String,
  description: Schema.optionalKey(Schema.String),
  background: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Start a durable child and return its handle now. The result arrives later as a message on this branch.",
    }),
  ),
  overrides: RunSpecSchema.fields.overrides,
})

const DelegateMetadata = Schema.Struct({
  sessionId: Schema.optionalKey(Schema.String),
  agentName: Schema.optionalKey(AgentName),
  usage: Schema.optionalKey(ChildRunUsage),
  toolCalls: Schema.optionalKey(Schema.Array(AgentRunToolCallSchema)),
})

/**
 * One admission call, two shapes: `running` is the handle of a background
 * child (its result arrives later as a message), `completed` is a foreground
 * child's output. `agent-child` and `agent-children` inspect the running ones.
 */
const DelegateResult = Schema.TaggedUnion({
  Running: ChildAgentHandle.fields,
  Completed: { output: Schema.String, metadata: DelegateMetadata },
  Error: { error: Schema.String },
})

export const DelegateTool = tool({
  id: "delegate",
  description:
    "Delegate one self-contained task to a child that inherits this agent and model but cannot delegate further. Foreground returns the child's output. background: true returns a handle now; the result arrives later as a message on this branch and starts a turn by itself, so end your turn to wait and do not set an alarm or a monitor for it.",
  promptSnippet: "Delegate work to child agents",
  promptGuidelines: [
    "Use for independent work that benefits from a fresh context or parallelism",
    "Do NOT delegate simple reads, searches, or single-file edits — do those directly",
    "Each todo prompt must be self-contained — children have no conversation history",
    "Run independent delegations concurrently from one cell with Promise.all; chain dependent ones with sequential awaits and pass earlier output in the next prompt",
    "Background delegations never return output here. Do not poll; a message on this branch reports the result. agent-child inspects, messages, or cancels one by requestId; agent-children lists them.",
    "A new call starts new work. Do not repeat a delegation to recover an unknown outcome; inspect it with agent-child using its toolCallId as the requestId.",
    "For parallel exploration: don't share preliminary findings between children — let each form independent conclusions",
    "Use overrides.modelId for a second opinion from a different model; overrides.systemPromptAddendum focuses a child on one role",
  ],
  params: DelegateParams,
  output: DelegateResult,
  execute: Effect.fn("DelegateTool.execute")(function* (params: typeof DelegateParams.Type) {
    const ctx = yield* ExtensionContext
    const agent = yield* requireCurrentAgent

    // Both outcomes point the parent at the child's session when there is one.
    const withSessionRef = (text: string, sessionId?: string) => {
      if (Predicate.isUndefined(sessionId)) return text
      return `${text}\n\nFull session: session://${sessionId}`
    }

    // Background mode: durable child admission; the child's hook delivers completion as a message.
    if (params.background === true) {
      if (Predicate.isUndefined(ctx.toolCallId)) {
        return yield* new DelegateError({
          message: "Background delegation requires a host-owned tool call",
        })
      }
      const requestId = RequestId.make(ctx.toolCallId)
      const child = yield* startChild({
        agent,
        prompt: params.todo,
        requestId,
        toolCallId: ctx.toolCallId,
        runSpec: makeRunSpec({ overrides: childOverrides(params.overrides) }),
      })
      return DelegateResult.cases.Running.make({ requestId, ...child })
    }

    // Foreground mode: a child session in this runtime, awaited here.
    const result = yield* runChild({
      agent,
      prompt: params.todo,
      runSpec: makeRunSpec({
        parentToolCallId: ctx.toolCallId,
        overrides: childOverrides(params.overrides),
      }),
    })

    if (result._tag === "Error") {
      return DelegateResult.cases.Error.make({
        error: withSessionRef(result.error, result.sessionId),
      })
    }

    const sessionId = result.sessionId
    return DelegateResult.cases.Completed.make({
      output: withSessionRef(result.text, sessionId),
      metadata: Record.filter(
        {
          sessionId,
          agentName: result.agentName,
          usage: result.usage,
          toolCalls: result.toolCalls,
        },
        Predicate.isNotUndefined,
      ),
    })
  }),
})

/** Child admission and control: one admission call plus inspect, send, cancel, and list. */
export const DelegateExtension = defineExtension({
  id: "@gent/delegate",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", DelegateTool, ControlChildAgent, ListChildAgents)
    yield* host.register("request", DelegateRpc.Children)
    yield* host.on("turnAfter", (input) =>
      onChildTurnAfter(input).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("delegate.completion.failed").pipe(
            Effect.annotateLogs({ cause: Cause.pretty(cause) }),
          ),
        ),
      ),
    )
    // A crash between a child's receipt and its hook leaves an undelivered
    // entry; the parent's next turn picks it up.
    yield* host.on("turnProjection", () =>
      reconcile().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("delegate.reconcile.failed").pipe(
            Effect.annotateLogs({ cause: Cause.pretty(cause) }),
          ),
        ),
        Effect.as({}),
      ),
    )
  }),
})
