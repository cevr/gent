import { Context, Effect, Layer, Option, Predicate, Ref, Schema } from "effect"
import { type PromptSection, type TurnProjection } from "@gent/core/extensions/api"
import type { AutoSnapshotReply } from "./protocol.js"

const AUTO_CHECKPOINT_TOOL = "auto_checkpoint"
const DEFAULT_MAX_ITERATIONS = 10
const MAX_TURNS_WITHOUT_CHECKPOINT = 5

const AutoLearning = Schema.Struct({
  iteration: Schema.Finite,
  content: Schema.String,
})
type AutoLearning = typeof AutoLearning.Type

const AutoMetricEntry = Schema.Struct({
  iteration: Schema.Finite,
  values: Schema.Record(Schema.String, Schema.Finite),
})
type AutoMetricEntry = typeof AutoMetricEntry.Type

const TerminationReason = Schema.Literals(["completed", "abandoned", "cancelled", "wedged"])
type TerminationReason = typeof TerminationReason.Type

export const AutoState = Schema.TaggedUnion({
  Inactive: {
    reason: Schema.optional(TerminationReason),
    finalLearnings: Schema.optional(Schema.Array(AutoLearning)),
    finalMetrics: Schema.optional(Schema.Array(AutoMetricEntry)),
    pendingFollowUp: Schema.optional(Schema.String),
  },
  Working: {
    iteration: Schema.Finite,
    maxIterations: Schema.Finite,
    goal: Schema.String,
    learnings: Schema.Array(AutoLearning),
    metrics: Schema.Array(AutoMetricEntry),
    promptPending: Schema.Boolean,
    turnsSinceCheckpoint: Schema.Finite,
    lastSummary: Schema.optional(Schema.String),
    nextIdea: Schema.optional(Schema.String),
    handoffRequestSeq: Schema.Finite,
    handoffContent: Schema.optional(Schema.String),
    pendingFollowUp: Schema.optional(Schema.String),
  },
  AwaitingReview: {
    iteration: Schema.Finite,
    maxIterations: Schema.Finite,
    goal: Schema.String,
    learnings: Schema.Array(AutoLearning),
    metrics: Schema.Array(AutoMetricEntry),
    promptPending: Schema.Boolean,
    lastSummary: Schema.optional(Schema.String),
    nextIdea: Schema.optional(Schema.String),
    handoffRequestSeq: Schema.Finite,
    handoffContent: Schema.optional(Schema.String),
    pendingFollowUp: Schema.optional(Schema.String),
  },
})
export type AutoState = Schema.Schema.Type<typeof AutoState>

export const projectSnapshot = (state: AutoState): AutoSnapshotReply => {
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

const buildPromptSection = (snapshot: AutoSnapshotReply): Option.Option<PromptSection> => {
  if (!snapshot.active) return Option.none()

  const iteration = Option.getOrElse(Option.fromNullishOr(snapshot.iteration), () => 0)
  const maxIterations = Option.getOrElse(Option.fromNullishOr(snapshot.maxIterations), () => 0)

  if (snapshot.phase === "awaiting-review") {
    return Option.some({
      id: "auto-loop-context",
      content: [
        `## Auto Loop — Peer Review Required`,
        "",
        `Iteration ${iteration}/${maxIterations} is complete.`,
        "",
        "You MUST call the `review` tool to run an adversarial review of this iteration before continuing.",
        "The loop cannot proceed until the review is done.",
      ].join("\n"),
      priority: 91,
    })
  }

  const parts: string[] = [
    `## Auto Loop — Iteration ${iteration}/${maxIterations}`,
    "",
    `**Goal**: ${Option.getOrElse(Option.fromNullishOr(snapshot.goal), () => "")}`,
  ]

  const learnings = Option.fromNullishOr(snapshot.learnings)
  if (Option.isSome(learnings) && learnings.value.length > 0) {
    parts.push("", "### Accumulated Learnings:")
    for (const l of learnings.value) {
      parts.push(`- [Iteration ${l.iteration}] ${l.content}`)
    }
  }

  const lastSummary = Option.fromNullishOr(snapshot.lastSummary)
  if (Option.isSome(lastSummary)) {
    parts.push("", `### Last iteration summary:`, lastSummary.value)
  }

  const nextIdea = Option.fromNullishOr(snapshot.nextIdea)
  if (Option.isSome(nextIdea)) {
    parts.push("", `### Suggested next step:`, nextIdea.value)
  }

  parts.push(
    "",
    "Maintain a findings doc at `.gent/auto/findings.md` — update it with wins, dead ends, and open questions.",
    "",
    "When you have completed this iteration's work, call `auto_checkpoint` with your results.",
    `This is iteration ${iteration} of ${maxIterations}.`,
  )

  return Option.some({
    id: "auto-loop-context",
    content: parts.join("\n"),
    priority: 91,
  })
}

export const viewForState = (state: AutoState): TurnProjection => {
  const snapshot = projectSnapshot(state)
  const section = buildPromptSection(snapshot)
  if (snapshot.active) {
    if (Option.isSome(section)) return { promptSections: [section.value] }
    return {}
  }
  if (Option.isSome(section)) {
    return {
      promptSections: [section.value],
      toolPolicy: { exclude: [AUTO_CHECKPOINT_TOOL] },
    }
  }
  return { toolPolicy: { exclude: [AUTO_CHECKPOINT_TOOL] } }
}

const followUpForWorkingTurn = (state: {
  readonly iteration: number
  readonly maxIterations: number
  readonly goal: string
  readonly nextIdea?: string
}): string => {
  if (state.iteration === 1) {
    return `Begin: ${state.goal}. Update \`.gent/auto/findings.md\` as you work. Call \`auto_checkpoint\` when this iteration is done.`
  }
  const hint = Option.getOrElse(Option.fromNullishOr(state.nextIdea), () => state.goal)
  return `Iteration ${state.iteration}/${state.maxIterations}. ${hint}. Review learnings, update findings doc. Call \`auto_checkpoint\` when done.`
}

const FOLLOW_UP_AWAITING_REVIEW =
  "Run the `review` tool to perform an adversarial review of this iteration before continuing."

type StartInput = {
  readonly goal: string
  readonly maxIterations?: number
}

type ToggleInput = {
  readonly goal?: string
  readonly maxIterations?: number
}

type AutoSignalInput = {
  readonly status: "continue" | "complete" | "abandon"
  readonly summary: string
  readonly learnings?: string
  readonly metrics?: Record<string, number>
  readonly nextIdea?: string
}

interface AutoReadService {
  readonly snapshot: Effect.Effect<AutoSnapshotReply>
  readonly isActive: Effect.Effect<boolean>
  readonly turnProjection: Effect.Effect<ReturnType<typeof viewForState>>
}

interface AutoWriteService extends AutoReadService {
  readonly start: (input: StartInput) => Effect.Effect<void>
  readonly requestHandoff: (content: string) => Effect.Effect<void>
  readonly cancel: Effect.Effect<void>
  readonly toggle: (input: ToggleInput) => Effect.Effect<void>
  readonly autoSignal: (input: AutoSignalInput) => Effect.Effect<void>
  readonly reviewSignal: Effect.Effect<void>
  readonly turnCompleted: Effect.Effect<void>
  readonly drainFollowUp: Effect.Effect<Option.Option<AutoFollowUp>>
}

export class AutoRead extends Context.Service<AutoRead, AutoReadService>()(
  "@gent/extensions/src/auto/controller/AutoRead",
) {}

export class AutoWrite extends Context.Service<AutoWrite, AutoWriteService>()(
  "@gent/extensions/src/auto/controller/AutoWrite",
) {}

const transitionStartAuto = (
  state: AutoState,
  msg: { readonly goal: string; readonly maxIterations?: number },
): AutoState => {
  if (state._tag !== "Inactive") return state
  return AutoState.cases.Working.make({
    iteration: 1,
    maxIterations: Option.getOrElse(
      Option.fromNullishOr(msg.maxIterations),
      () => DEFAULT_MAX_ITERATIONS,
    ),
    goal: msg.goal,
    learnings: [],
    metrics: [],
    promptPending: true,
    turnsSinceCheckpoint: 0,
    handoffRequestSeq: 0,
    pendingFollowUp: followUpForWorkingTurn({
      iteration: 1,
      maxIterations: Option.getOrElse(
        Option.fromNullishOr(msg.maxIterations),
        () => DEFAULT_MAX_ITERATIONS,
      ),
      goal: msg.goal,
    }),
  })
}

const transitionAutoSignal = (state: AutoState, msg: AutoSignalInput): AutoState => {
  if (state._tag !== "Working") return state

  let newLearnings: ReadonlyArray<AutoLearning> = state.learnings
  const learning = Option.fromNullishOr(msg.learnings)
  if (Option.isSome(learning)) {
    newLearnings = [...state.learnings, { iteration: state.iteration, content: learning.value }]
  }
  let newMetrics: ReadonlyArray<AutoMetricEntry> = state.metrics
  const metrics = Option.fromNullishOr(msg.metrics)
  if (Option.isSome(metrics)) {
    newMetrics = [...state.metrics, { iteration: state.iteration, values: metrics.value }]
  }

  if (msg.status === "complete") {
    return AutoState.cases.Inactive.make({
      reason: "completed",
      finalLearnings: newLearnings,
      finalMetrics: newMetrics,
    })
  }
  if (msg.status === "abandon") {
    return AutoState.cases.Inactive.make({
      reason: "abandoned",
      finalLearnings: newLearnings,
      finalMetrics: newMetrics,
    })
  }

  return AutoState.cases.AwaitingReview.make({
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
    return AutoState.cases.Inactive.make({
      reason: "completed",
      finalLearnings: state.learnings,
      finalMetrics: state.metrics,
    })
  }
  const nextIteration = state.iteration + 1
  return AutoState.cases.Working.make({
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
    return AutoState.cases.Working.make({
      ...state,
      handoffRequestSeq: state.handoffRequestSeq + 1,
      handoffContent: msg.content,
      pendingFollowUp: msg.content,
    })
  }
  if (state._tag === "AwaitingReview") {
    return AutoState.cases.AwaitingReview.make({
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
      return AutoState.cases.Inactive.make({ reason: "wedged" })
    }
    return AutoState.cases.Working.make({
      ...state,
      promptPending: false,
      turnsSinceCheckpoint: next,
    })
  }
  if (state._tag === "AwaitingReview") {
    return AutoState.cases.AwaitingReview.make({ ...state, promptPending: false })
  }
  return state
}

const transitionCancelAuto = (state: AutoState): AutoState => {
  const isActiveState = Predicate.or(
    Predicate.isTagged("Working"),
    Predicate.isTagged("AwaitingReview"),
  )
  if (isActiveState(state)) {
    return AutoState.cases.Inactive.make({ reason: "cancelled" })
  }
  return state
}

const transitionToggleAuto = (
  state: AutoState,
  msg: { readonly goal?: string; readonly maxIterations?: number },
): AutoState => {
  if (state._tag === "Inactive") {
    return transitionStartAuto(state, {
      goal: Option.getOrElse(Option.fromNullishOr(msg.goal), () => "Continue working autonomously"),
      maxIterations: msg.maxIterations,
    })
  }
  return transitionCancelAuto(state)
}

const clearFollowUp = (state: AutoState): AutoState => {
  if (state._tag === "Inactive") {
    return AutoState.cases.Inactive.make({
      ...state,
      pendingFollowUp: Option.getOrUndefined(Option.none()),
    })
  }
  if (state._tag === "Working") {
    return AutoState.cases.Working.make({
      ...state,
      pendingFollowUp: Option.getOrUndefined(Option.none()),
    })
  }
  return AutoState.cases.AwaitingReview.make({
    ...state,
    pendingFollowUp: Option.getOrUndefined(Option.none()),
  })
}

const followUpSourceId = (state: AutoState): string => {
  if (state._tag === "Inactive") return "auto:inactive"
  if (state.pendingFollowUp === state.handoffContent) {
    return `auto:handoff:${state.iteration}:${state.handoffRequestSeq}`
  }
  if (state._tag === "AwaitingReview") return `auto:review:${state.iteration}`
  return `auto:working:${state.iteration}`
}

type AutoFollowUp = {
  readonly content: string
  readonly sourceId: string
}

const drainFollowUp = (state: AutoState): readonly [Option.Option<AutoFollowUp>, AutoState] => {
  let followUp = Option.none<AutoFollowUp>()
  const pendingFollowUp = Option.fromNullishOr(state.pendingFollowUp)
  if (Option.isSome(pendingFollowUp)) {
    followUp = Option.some({
      content: pendingFollowUp.value,
      sourceId: followUpSourceId(state),
    })
  }
  return [followUp, clearFollowUp(state)]
}

export const AutoControllerLive: Layer.Layer<AutoRead | AutoWrite> = Layer.unwrap(
  Effect.gen(function* () {
    const state = yield* Ref.make<AutoState>(AutoState.cases.Inactive.make({}))
    const update = (f: (current: AutoState) => AutoState) => Ref.update(state, f)
    const snapshot = Ref.get(state).pipe(Effect.map(projectSnapshot))

    const write = {
      snapshot,
      isActive: snapshot.pipe(Effect.map((current) => current.active)),
      turnProjection: Ref.get(state).pipe(Effect.map(viewForState)),
      start: (input) => update((current) => transitionStartAuto(current, input)),
      requestHandoff: (content) =>
        update((current) => transitionRequestHandoff(current, { content })),
      cancel: update(transitionCancelAuto),
      toggle: (input) => update((current) => transitionToggleAuto(current, input)),
      autoSignal: (input) => update((current) => transitionAutoSignal(current, input)),
      reviewSignal: update(transitionReviewSignal),
      turnCompleted: update(transitionTurnCompleted),
      drainFollowUp: Ref.modify(state, drainFollowUp),
    } satisfies AutoWriteService

    const read = {
      snapshot: write.snapshot,
      isActive: write.isActive,
      turnProjection: write.turnProjection,
    } satisfies AutoReadService

    return Layer.merge(Layer.succeed(AutoWrite, write), Layer.succeed(AutoRead, read))
  }),
)
