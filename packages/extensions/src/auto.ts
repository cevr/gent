/**
 * Auto loop modality extension — one generic iteration driver.
 *
 * Replaces three separate loop implementations (review-loop actor,
 * audit runLoop, plan runLoop) with a single extension that drives
 * any iterative workflow.
 *
 * State: Inactive | Working | AwaitingReview
 * Signal: auto_checkpoint tool
 * Gate: peer review via review tool (AwaitingReview blocks until review tool called)
 * Safety: maxIterations ceiling + turnsSinceCheckpoint watchdog
 *
 * Hand-rolled FSM hosted on a `Behavior` actor (W10-1b). The actor owns
 * pure transitions; turn/tool boundary AgentEvents (`auto_checkpoint`,
 * `review`, `TurnCompleted`) are observed by the Resource shell's
 * `runtime.toolResult` / `runtime.turnAfter` slots which translate them
 * to actor messages and drain pending follow-ups via
 * `ctx.session.queueFollowUp`. ExtensionMessage envelopes route through
 * the actor-route fallback in ActorRouter (W10-1b.0).
 */

import { Effect, Schema } from "effect"
import {
  behavior,
  defineExtension,
  defineResource,
  isRecord,
  ServiceKey,
  TaggedEnumClass,
  type Behavior,
  type ToolResultInput,
  type TurnAfterInput,
  type ExtensionHostContext,
} from "@gent/core/extensions/api"
import { AUTO_EXTENSION_ID, AutoProtocol, type AutoSnapshotReply } from "./auto-protocol.js"
import { AutoCheckpointTool } from "./auto-checkpoint.js"
import { AutoJournal } from "./auto-journal.js"

const parseCheckpointParams = (
  input: Record<string, unknown>,
): {
  status: "continue" | "complete" | "abandon"
  summary: string
  learnings: string | undefined
  metrics: Record<string, number> | undefined
  nextIdea: string | undefined
} => {
  const raw = typeof input["status"] === "string" ? input["status"] : "continue"
  const status: "continue" | "complete" | "abandon" =
    raw === "continue" || raw === "complete" || raw === "abandon" ? raw : "continue"
  return {
    status,
    summary: typeof input["summary"] === "string" ? input["summary"] : "Checkpoint",
    learnings: typeof input["learnings"] === "string" ? input["learnings"] : undefined,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- extension adapter narrows foreign SDK payload at boundary
    metrics: isRecord(input["metrics"]) ? (input["metrics"] as Record<string, number>) : undefined,
    nextIdea: typeof input["nextIdea"] === "string" ? input["nextIdea"] : undefined,
  }
}

// ── Constants ──

export { AUTO_EXTENSION_ID } from "./auto-protocol.js"
const AUTO_CHECKPOINT_TOOL = "auto_checkpoint"
const REVIEW_TOOL = "review"
const DEFAULT_MAX_ITERATIONS = 10
const MAX_TURNS_WITHOUT_CHECKPOINT = 5

/** Schema for checkpoint tool output — used for typed sync parsing in slot handler */
const CheckpointOutput = Schema.Struct({
  status: Schema.optional(Schema.Literals(["continue", "complete", "abandon"])),
  summary: Schema.optional(Schema.String),
  learnings: Schema.optional(Schema.String),
  metrics: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  nextIdea: Schema.optional(Schema.String),
})
const decodeCheckpointOutput = Schema.decodeUnknownSync(CheckpointOutput)
/** Tool result reaches the slot as the parsed object (Effect AI tool runner
 * returns the tool's structured output, not the JSON string). Older paths
 * that hand-stringified the result are still supported by re-parsing. */
const parseCheckpointResult = (result: unknown) => {
  const value = typeof result === "string" ? JSON.parse(result) : result
  return decodeCheckpointOutput(value)
}

// ── State ──

const AutoLearning = Schema.Struct({
  iteration: Schema.Number,
  content: Schema.String,
})
type AutoLearning = typeof AutoLearning.Type

const AutoMetricEntry = Schema.Struct({
  iteration: Schema.Number,
  values: Schema.Record(Schema.String, Schema.Number),
})
type AutoMetricEntry = typeof AutoMetricEntry.Type

const TerminationReason = Schema.Literals(["completed", "abandoned", "cancelled", "wedged"])
type TerminationReason = typeof TerminationReason.Type

// Actor state — discriminated by `_tag`. Mirrors the old `MachineState`
// shape and adds `pendingFollowUp` so slot handlers can drain a single
// queued follow-up message without re-deriving transition deltas.
export const AutoState = TaggedEnumClass("AutoState", {
  Inactive: {
    reason: Schema.optional(TerminationReason),
    finalLearnings: Schema.optional(Schema.Array(AutoLearning)),
    finalMetrics: Schema.optional(Schema.Array(AutoMetricEntry)),
    pendingFollowUp: Schema.optional(Schema.String),
  },
  Working: {
    iteration: Schema.Number,
    maxIterations: Schema.Number,
    goal: Schema.String,
    learnings: Schema.Array(AutoLearning),
    metrics: Schema.Array(AutoMetricEntry),
    promptPending: Schema.Boolean,
    turnsSinceCheckpoint: Schema.Number,
    lastSummary: Schema.optional(Schema.String),
    nextIdea: Schema.optional(Schema.String),
    handoffRequestSeq: Schema.Number,
    handoffContent: Schema.optional(Schema.String),
    pendingFollowUp: Schema.optional(Schema.String),
  },
  AwaitingReview: {
    iteration: Schema.Number,
    maxIterations: Schema.Number,
    goal: Schema.String,
    learnings: Schema.Array(AutoLearning),
    metrics: Schema.Array(AutoMetricEntry),
    promptPending: Schema.Boolean,
    lastSummary: Schema.optional(Schema.String),
    nextIdea: Schema.optional(Schema.String),
    handoffRequestSeq: Schema.Number,
    handoffContent: Schema.optional(Schema.String),
    pendingFollowUp: Schema.optional(Schema.String),
  },
})
export type AutoState = Schema.Schema.Type<typeof AutoState>

// ── Actor messages ──
//
// `_tag` strings are shared with `AutoProtocol.*` ExtensionMessage envelopes
// so the actor-route fallback in ActorRouter (W10-1b.0) can forward
// envelopes directly into the actor mailbox without re-encoding.

export const AutoMsg = TaggedEnumClass("AutoMsg", {
  StartAuto: { goal: Schema.String, maxIterations: Schema.optional(Schema.Number) },
  CancelAuto: {},
  ToggleAuto: {
    goal: Schema.optional(Schema.String),
    maxIterations: Schema.optional(Schema.Number),
  },
  AutoSignal: {
    status: Schema.Literals(["continue", "complete", "abandon"]),
    summary: Schema.String,
    learnings: Schema.optional(Schema.String),
    metrics: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
    nextIdea: Schema.optional(Schema.String),
  },
  RequestHandoff: { content: Schema.String },
  ReviewSignal: {},
  TurnCompleted: {},
  IsActive: {},
  GetSnapshot: {},
  /** Slot-handler-only: read & clear the pending follow-up content. */
  DrainFollowUp: TaggedEnumClass.askVariant<string | undefined>()({}),
})
export type AutoMsg = Schema.Schema.Type<typeof AutoMsg>

export const AutoService = ServiceKey<AutoMsg>("@gent/auto/workflow")

// ── Snapshot projection ──
//
// `projectSnapshot` is the typed RPC reply for `AutoProtocol.GetSnapshot` —
// other extensions read the auto loop state through this shape. The behavior's
// `view` slot uses the same projected snapshot to derive prompt sections + tool
// policy fragments per turn in
// `ExtensionReactions.resolveTurnProjection`.

const projectSnapshot = (state: AutoState): AutoSnapshotReply => {
  if (state._tag === "Inactive") return { active: false }
  if (state._tag === "Working") {
    return {
      active: true,
      phase: "working",
      iteration: state.iteration,
      maxIterations: state.maxIterations,
      goal: state.goal,
      learnings: state.learnings,
      lastSummary: state.lastSummary,
      nextIdea: state.nextIdea,
    }
  }
  return {
    active: true,
    phase: "awaiting-review",
    iteration: state.iteration,
    maxIterations: state.maxIterations,
    goal: state.goal,
    learnings: state.learnings,
    lastSummary: state.lastSummary,
    nextIdea: state.nextIdea,
  }
}

// ── Actor view ──
//
// Per-turn prompt + tool-policy contribution derived from the actor's
// current state. `Behavior.view` replaces the standalone `AutoProjection`
// (W10-2a.3) — turn reactions sample this on every turn via
// `ActorEngine.peekView` and fold it into the same prompt/policy aggregate
// as explicit turn-projection reactions.

const buildPromptSection = (snapshot: AutoSnapshotReply) => {
  if (!snapshot.active) return undefined

  if (snapshot.phase === "awaiting-review") {
    return {
      id: "auto-loop-context",
      content: [
        `## Auto Loop — Peer Review Required`,
        "",
        `Iteration ${snapshot.iteration ?? 0}/${snapshot.maxIterations ?? 0} is complete.`,
        "",
        "You MUST call the `review` tool to run an adversarial review of this iteration before continuing.",
        "The loop cannot proceed until the review is done.",
      ].join("\n"),
      priority: 91,
    }
  }

  const parts: string[] = [
    `## Auto Loop — Iteration ${snapshot.iteration ?? 0}/${snapshot.maxIterations ?? 0}`,
    "",
    `**Goal**: ${snapshot.goal ?? ""}`,
  ]

  if (snapshot.learnings !== undefined && snapshot.learnings.length > 0) {
    parts.push("", "### Accumulated Learnings:")
    for (const l of snapshot.learnings) {
      parts.push(`- [Iteration ${l.iteration}] ${l.content}`)
    }
  }

  if (snapshot.lastSummary !== undefined) {
    parts.push("", `### Last iteration summary:`, snapshot.lastSummary)
  }

  if (snapshot.nextIdea !== undefined) {
    parts.push("", `### Suggested next step:`, snapshot.nextIdea)
  }

  parts.push(
    "",
    "Maintain a findings doc at `.gent/auto/findings.md` — update it with wins, dead ends, and open questions.",
    "",
    "When you have completed this iteration's work, call `auto_checkpoint` with your results.",
    `This is iteration ${snapshot.iteration ?? 0} of ${snapshot.maxIterations ?? 0}.`,
  )

  return {
    id: "auto-loop-context",
    content: parts.join("\n"),
    priority: 91,
  }
}

const viewForState = (state: AutoState) => {
  const snapshot = projectSnapshot(state)
  const section = buildPromptSection(snapshot)
  return {
    ...(section !== undefined ? { prompt: [section] } : {}),
    toolPolicy: snapshot.active ? {} : { exclude: [AUTO_CHECKPOINT_TOOL] },
  }
}

// ── Follow-up content (formerly `afterTransition`) ──
//
// Pure functions — given a transition or a sequenced handoff, return the
// content for the queued follow-up. The actor sets these onto its state's
// `pendingFollowUp` field whenever the relevant transition fires, and the
// Resource shell's `turn.after` slot drains them via `DrainFollowUp`.

const followUpForWorkingTurn = (state: {
  readonly iteration: number
  readonly maxIterations: number
  readonly goal: string
  readonly nextIdea?: string | undefined
}): string => {
  if (state.iteration === 1) {
    return `Begin: ${state.goal}. Update \`.gent/auto/findings.md\` as you work. Call \`auto_checkpoint\` when this iteration is done.`
  }
  const hint = state.nextIdea ?? state.goal
  return `Iteration ${state.iteration}/${state.maxIterations}. ${hint}. Review learnings, update findings doc. Call \`auto_checkpoint\` when done.`
}

const FOLLOW_UP_AWAITING_REVIEW =
  "Run the `review` tool to perform an adversarial review of this iteration before continuing."

// ── Pure transitions ──

const transitionStartAuto = (
  state: AutoState,
  msg: { readonly goal: string; readonly maxIterations?: number | undefined },
): AutoState => {
  if (state._tag !== "Inactive") return state
  return AutoState.Working.make({
    iteration: 1,
    maxIterations: msg.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    goal: msg.goal,
    learnings: [],
    metrics: [],
    promptPending: true,
    turnsSinceCheckpoint: 0,
    handoffRequestSeq: 0,
    pendingFollowUp: followUpForWorkingTurn({
      iteration: 1,
      maxIterations: msg.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      goal: msg.goal,
    }),
  })
}

const transitionAutoSignal = (
  state: AutoState,
  msg: {
    readonly status: "continue" | "complete" | "abandon"
    readonly summary: string
    readonly learnings?: string | undefined
    readonly metrics?: Record<string, number> | undefined
    readonly nextIdea?: string | undefined
  },
): AutoState => {
  if (state._tag !== "Working") return state

  const newLearnings: ReadonlyArray<AutoLearning> =
    msg.learnings !== undefined
      ? [...state.learnings, { iteration: state.iteration, content: msg.learnings }]
      : state.learnings
  const newMetrics: ReadonlyArray<AutoMetricEntry> =
    msg.metrics !== undefined
      ? [...state.metrics, { iteration: state.iteration, values: msg.metrics }]
      : state.metrics

  if (msg.status === "complete") {
    return AutoState.Inactive.make({
      reason: "completed",
      finalLearnings: newLearnings,
      finalMetrics: newMetrics,
    })
  }
  if (msg.status === "abandon") {
    return AutoState.Inactive.make({
      reason: "abandoned",
      finalLearnings: newLearnings,
      finalMetrics: newMetrics,
    })
  }

  return AutoState.AwaitingReview.make({
    iteration: state.iteration,
    maxIterations: state.maxIterations,
    goal: state.goal,
    learnings: newLearnings,
    metrics: newMetrics,
    promptPending: true,
    lastSummary: msg.summary,
    nextIdea: msg.nextIdea,
    handoffRequestSeq: state.handoffRequestSeq,
    handoffContent: state.handoffContent,
    pendingFollowUp: FOLLOW_UP_AWAITING_REVIEW,
  })
}

const transitionReviewSignal = (state: AutoState): AutoState => {
  if (state._tag !== "AwaitingReview") return state
  if (state.iteration >= state.maxIterations) {
    return AutoState.Inactive.make({
      reason: "completed",
      finalLearnings: state.learnings,
      finalMetrics: state.metrics,
    })
  }
  const nextIteration = state.iteration + 1
  return AutoState.Working.make({
    iteration: nextIteration,
    maxIterations: state.maxIterations,
    goal: state.goal,
    learnings: state.learnings,
    metrics: state.metrics,
    promptPending: true,
    turnsSinceCheckpoint: 0,
    lastSummary: state.lastSummary,
    nextIdea: state.nextIdea,
    handoffRequestSeq: state.handoffRequestSeq,
    handoffContent: state.handoffContent,
    pendingFollowUp: followUpForWorkingTurn({
      iteration: nextIteration,
      maxIterations: state.maxIterations,
      goal: state.goal,
      nextIdea: state.nextIdea,
    }),
  })
}

const transitionRequestHandoff = (
  state: AutoState,
  msg: { readonly content: string },
): AutoState => {
  if (state._tag === "Working") {
    return AutoState.Working.make({
      ...state,
      handoffRequestSeq: state.handoffRequestSeq + 1,
      handoffContent: msg.content,
      pendingFollowUp: msg.content,
    })
  }
  if (state._tag === "AwaitingReview") {
    return AutoState.AwaitingReview.make({
      ...state,
      handoffRequestSeq: state.handoffRequestSeq + 1,
      handoffContent: msg.content,
      pendingFollowUp: msg.content,
    })
  }
  return state
}

const transitionTurnCompleted = (state: AutoState): AutoState => {
  if (state._tag === "Working") {
    const next = state.turnsSinceCheckpoint + 1
    if (next >= MAX_TURNS_WITHOUT_CHECKPOINT) {
      return AutoState.Inactive.make({ reason: "wedged" })
    }
    return AutoState.Working.make({
      ...state,
      promptPending: false,
      turnsSinceCheckpoint: next,
    })
  }
  if (state._tag === "AwaitingReview") {
    return AutoState.AwaitingReview.make({ ...state, promptPending: false })
  }
  return state
}

const transitionCancelAuto = (state: AutoState): AutoState => {
  if (state._tag === "Working" || state._tag === "AwaitingReview") {
    return AutoState.Inactive.make({ reason: "cancelled" })
  }
  return state
}

const transitionToggleAuto = (
  state: AutoState,
  msg: { readonly goal?: string | undefined; readonly maxIterations?: number | undefined },
): AutoState => {
  if (state._tag === "Inactive") {
    return transitionStartAuto(state, {
      goal: msg.goal ?? "Continue working autonomously",
      maxIterations: msg.maxIterations,
    })
  }
  return transitionCancelAuto(state)
}

const clearFollowUp = (state: AutoState): AutoState => {
  if (state._tag === "Inactive") {
    return AutoState.Inactive.make({ ...state, pendingFollowUp: undefined })
  }
  if (state._tag === "Working") {
    return AutoState.Working.make({ ...state, pendingFollowUp: undefined })
  }
  return AutoState.AwaitingReview.make({ ...state, pendingFollowUp: undefined })
}

// ── Behavior ──

const autoBehavior: Behavior<AutoMsg, AutoState, never> = {
  initialState: AutoState.Inactive.make({}),
  serviceKey: AutoService,
  receive: (msg, state, ctx) =>
    Effect.gen(function* () {
      switch (msg._tag) {
        case "StartAuto":
          return transitionStartAuto(state, msg)
        case "CancelAuto":
          return transitionCancelAuto(state)
        case "ToggleAuto":
          return transitionToggleAuto(state, msg)
        case "AutoSignal":
          return transitionAutoSignal(state, msg)
        case "ReviewSignal":
          return transitionReviewSignal(state)
        case "RequestHandoff":
          return transitionRequestHandoff(state, msg)
        case "TurnCompleted":
          return transitionTurnCompleted(state)
        case "IsActive":
          yield* ctx.reply(state._tag !== "Inactive")
          return state
        case "GetSnapshot":
          yield* ctx.reply(projectSnapshot(state))
          return state
        case "DrainFollowUp":
          yield* ctx.reply(state.pendingFollowUp)
          return clearFollowUp(state)
      }
    }),
  view: viewForState,
  persistence: {
    key: "@gent/auto/workflow",
    state: AutoState,
  },
}

// ── Slot handler helpers ──

const findAutoRef = (ctx: ExtensionHostContext) => ctx.actors.findOne(AutoService)

const drainAndQueueFollowUp = (ctx: ExtensionHostContext) =>
  Effect.gen(function* () {
    const ref = yield* findAutoRef(ctx)
    if (ref === undefined) return

    const followUp = yield* ctx.actors
      .ask(ref, AutoMsg.DrainFollowUp.make({}))
      .pipe(Effect.catchEager(() => Effect.succeed(undefined)))

    if (followUp === undefined || followUp === "") return

    yield* ctx.session
      .queueFollowUp({
        content: followUp,
        metadata: { extensionId: "auto", hidden: true },
      })
      .pipe(Effect.catchEager(() => Effect.void))
  })

// ── tool.result slot ──
//
// Translates `auto_checkpoint` / `review` tool results to actor messages
// (formerly `mapEvent`'s job) and writes the journal. Also drains any
// follow-up the resulting transition queued.

const readSnapshot = (ctx: ExtensionHostContext) =>
  ctx.extension
    .ask(AutoProtocol.GetSnapshot.make())
    .pipe(Effect.catchEager(() => Effect.succeed(undefined as AutoSnapshotReply | undefined)))

const tellAutoFromTool = (input: ToolResultInput, ctx: ExtensionHostContext) =>
  Effect.gen(function* () {
    const ref = yield* findAutoRef(ctx)
    if (ref === undefined) return

    if (input.toolName === AUTO_CHECKPOINT_TOOL) {
      let parsed:
        | {
            status?: "continue" | "complete" | "abandon"
            summary?: string
            learnings?: string
            metrics?: Record<string, number>
            nextIdea?: string
          }
        | undefined
      try {
        parsed = parseCheckpointResult(input.result)
      } catch (decodeError) {
        yield* Effect.logWarning("auto.checkpoint.decode-failed").pipe(
          Effect.annotateLogs({
            error: String(decodeError),
            resultType: typeof input.result,
          }),
        )
        parsed = undefined
      }
      const msg = AutoMsg.AutoSignal.make({
        status: parsed?.status ?? "continue",
        summary: parsed?.summary ?? "Checkpoint",
        learnings: parsed?.learnings,
        metrics: parsed?.metrics,
        nextIdea: parsed?.nextIdea,
      })
      yield* ctx.actors.tell(ref, msg).pipe(Effect.catchEager(() => Effect.void))
      return
    }

    if (input.toolName === REVIEW_TOOL) {
      yield* ctx.actors
        .tell(ref, AutoMsg.ReviewSignal.make({}))
        .pipe(Effect.catchEager(() => Effect.void))
    }
  })

const journalInterceptorImpl = (
  input: ToolResultInput,
  next: (input: ToolResultInput) => Effect.Effect<unknown>,
  ctx: ExtensionHostContext,
) =>
  Effect.gen(function* () {
    const result = yield* next(input)

    // Tell the actor about the tool event before reading the snapshot so
    // the journal write reflects the post-transition iteration count.
    yield* tellAutoFromTool(input, ctx).pipe(Effect.catchEager(() => Effect.void))

    yield* Effect.gen(function* () {
      const journal = yield* Effect.serviceOption(AutoJournal)
      if (journal._tag === "None") return

      const snapshot = yield* readSnapshot(ctx)
      if (snapshot === undefined || !snapshot.active) return

      if (input.toolName === AUTO_CHECKPOINT_TOOL && isRecord(input.input)) {
        const cp = parseCheckpointParams(input.input)

        const activePath = yield* journal.value.getActivePath()
        if (activePath === undefined && snapshot.goal !== undefined) {
          yield* journal.value.start({
            goal: snapshot.goal,
            maxIterations: snapshot.maxIterations ?? DEFAULT_MAX_ITERATIONS,
            sessionId: input.sessionId,
          })
        }

        yield* journal.value.appendCheckpoint({
          iteration: snapshot.iteration ?? 1,
          ...cp,
        })

        if (cp.status === "complete" || cp.status === "abandon") {
          yield* journal.value.finish()
        }
      }

      if (input.toolName === REVIEW_TOOL) {
        yield* journal.value.appendReview(snapshot.iteration ?? 1)
      }
    }).pipe(Effect.catchEager(() => Effect.void))

    return result
  })

// ── turn.after slot ──
//
// Drives the `TurnCompleted` actor message (formerly `mapEvent`'s job),
// drains pending follow-ups, and triggers handoff at the context-fill
// threshold.

const autoHandoffImpl = (input: TurnAfterInput, ctx: ExtensionHostContext) =>
  Effect.gen(function* () {
    if (input.interrupted) return

    // Tell the actor about the turn boundary first so the wedge watchdog
    // and AwaitingReview promptPending flag advance before snapshot reads.
    const ref = yield* findAutoRef(ctx)
    if (ref !== undefined) {
      yield* ctx.actors
        .tell(ref, AutoMsg.TurnCompleted.make({}))
        .pipe(Effect.catchEager(() => Effect.void))
    }

    // Drain any follow-up queued by transitions during this turn cycle.
    yield* drainAndQueueFollowUp(ctx).pipe(Effect.catchEager(() => Effect.void))

    const snapshot = yield* readSnapshot(ctx)
    if (snapshot === undefined || !snapshot.active) return

    const contextPercent = yield* ctx.session.estimateContextPercent()
    if (contextPercent < 85) return

    yield* Effect.logInfo("auto.handoff.threshold").pipe(
      Effect.annotateLogs({ contextPercent, iteration: snapshot.iteration }),
    )

    const journal = yield* Effect.serviceOption(AutoJournal)
    let journalPath: string | undefined
    if (journal._tag === "Some") {
      journalPath = yield* journal.value.getActivePath()
      if (journalPath === undefined && snapshot.goal !== undefined) {
        journalPath = yield* journal.value.start({
          goal: snapshot.goal,
          maxIterations: snapshot.maxIterations ?? DEFAULT_MAX_ITERATIONS,
          sessionId: input.sessionId,
        })
      }
    }

    yield* ctx.extension.send(
      AutoProtocol.RequestHandoff.make({
        content: [
          `Context is at ${contextPercent}%. Call the \`handoff\` tool to transfer to a new session.`,
          `Include this context:`,
          `- Auto loop iteration ${snapshot.iteration}/${snapshot.maxIterations}`,
          `- Goal: ${snapshot.goal}`,
          journalPath !== undefined ? `- Journal: ${journalPath}` : undefined,
        ]
          .filter(Boolean)
          .join("\n"),
      }),
    )

    // RequestHandoff queues a follow-up via the actor; drain it now so the
    // handoff prompt lands on the upcoming turn rather than the next one.
    yield* drainAndQueueFollowUp(ctx).pipe(Effect.catchEager(() => Effect.void))
  }).pipe(Effect.catchEager(() => Effect.void))

// Replay (cold-start hydration from journal) is staged for W10-1c.
// Needs cross-extension Receptionist discovery from a non-host slot
// plus a session-ancestry guard. The journal interceptor still appends
// rows during the live loop — only the on-spawn replay path is gone.

// ── Extension ──

const EXTENSION_ID = AUTO_EXTENSION_ID

export const AutoExtension = defineExtension({
  id: EXTENSION_ID,
  tools: [AutoCheckpointTool],
  actors: [behavior(autoBehavior)],
  protocols: AutoProtocol,
  reactions: {
    toolResult: (input, hostCtx) =>
      journalInterceptorImpl(input, (next) => Effect.succeed(next.result), hostCtx),
    turnAfter: {
      failureMode: "isolate",
      handler: autoHandoffImpl,
    },
  },
  resources: ({ ctx }) => [
    defineResource({
      tag: AutoJournal,
      scope: "process",
      layer: AutoJournal.Live({ cwd: ctx.cwd }),
    }),
  ],
})
