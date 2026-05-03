import { Context, Effect, Layer, Ref, Schema } from "effect"
import {
  ReadOnlyBrand,
  TaggedEnumClass,
  type ReadOnly,
  type TurnProjection,
  withReadOnly,
} from "@gent/core/extensions/api"
import type { AutoSnapshotReply } from "./auto-protocol.js"

const AUTO_CHECKPOINT_TOOL = "auto_checkpoint"
const DEFAULT_MAX_ITERATIONS = 10
const MAX_TURNS_WITHOUT_CHECKPOINT = 5

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

export const viewForState = (state: AutoState): TurnProjection => {
  const snapshot = projectSnapshot(state)
  const section = buildPromptSection(snapshot)
  return {
    ...(section !== undefined ? { promptSections: [section] } : {}),
    toolPolicy: snapshot.active ? {} : { exclude: [AUTO_CHECKPOINT_TOOL] },
  }
}

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
  readonly learnings?: string | undefined
  readonly metrics?: Record<string, number> | undefined
  readonly nextIdea?: string | undefined
}

interface AutoReadShape {
  readonly snapshot: () => Effect.Effect<AutoSnapshotReply>
  readonly isActive: () => Effect.Effect<boolean>
  readonly turnProjection: () => Effect.Effect<ReturnType<typeof viewForState>>
}

interface AutoWriteShape extends AutoReadShape {
  readonly start: (input: StartInput) => Effect.Effect<void>
  readonly requestHandoff: (content: string) => Effect.Effect<void>
  readonly cancel: () => Effect.Effect<void>
  readonly toggle: (input: ToggleInput) => Effect.Effect<void>
  readonly autoSignal: (input: AutoSignalInput) => Effect.Effect<void>
  readonly reviewSignal: () => Effect.Effect<void>
  readonly turnCompleted: () => Effect.Effect<void>
  readonly drainFollowUp: () => Effect.Effect<string | undefined>
}

export class AutoRead extends Context.Service<AutoRead, ReadOnly<AutoReadShape>>()(
  "@gent/extensions/src/auto-controller/AutoRead",
) {
  declare readonly [ReadOnlyBrand]: true
}

export class AutoWrite extends Context.Service<AutoWrite, AutoWriteShape>()(
  "@gent/extensions/src/auto-controller/AutoWrite",
) {}

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

const transitionAutoSignal = (state: AutoState, msg: AutoSignalInput): AutoState => {
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

export const AutoControllerLive: Layer.Layer<AutoRead | AutoWrite> = Layer.unwrap(
  Effect.gen(function* () {
    const state = yield* Ref.make<AutoState>(AutoState.Inactive.make({}))
    const update = (f: (current: AutoState) => AutoState) => Ref.update(state, f)
    const snapshot = () => Ref.get(state).pipe(Effect.map(projectSnapshot))

    const write = {
      snapshot,
      isActive: () => snapshot().pipe(Effect.map((current) => current.active)),
      turnProjection: () => Ref.get(state).pipe(Effect.map(viewForState)),
      start: (input) => update((current) => transitionStartAuto(current, input)),
      requestHandoff: (content) =>
        update((current) => transitionRequestHandoff(current, { content })),
      cancel: () => update(transitionCancelAuto),
      toggle: (input) => update((current) => transitionToggleAuto(current, input)),
      autoSignal: (input) => update((current) => transitionAutoSignal(current, input)),
      reviewSignal: () => update(transitionReviewSignal),
      turnCompleted: () => update(transitionTurnCompleted),
      drainFollowUp: () =>
        Ref.modify(state, (current) => [current.pendingFollowUp, clearFollowUp(current)]),
    } satisfies AutoWriteShape

    const read = withReadOnly({
      snapshot: write.snapshot,
      isActive: write.isActive,
      turnProjection: write.turnProjection,
    } satisfies AutoReadShape)

    return Layer.merge(Layer.succeed(AutoWrite, write), Layer.succeed(AutoRead, read))
  }),
)
