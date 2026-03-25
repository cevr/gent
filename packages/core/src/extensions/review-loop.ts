/**
 * Review-loop extension — iterative code review workflow actor.
 *
 * State: Inactive | Reviewing { iteration, maxIterations, findings }
 * Derive: inject review context as promptSections when reviewing
 * Intents: StartReview { focus?, paths?, maxIterations? }, CancelReview
 * Effects: QueueFollowUp (iteration prompt), EmitEvent ("review:completed"), Persist
 *
 * Uses effect-machine for state transitions, fromMachine for actor wrapping.
 */

import { Effect, Schema } from "effect"
import { Machine, State as MState, Event as MEvent } from "effect-machine"
import { defineExtension } from "../domain/extension.js"
import type {
  ExtensionDeriveContext,
  ExtensionEffect,
  ExtensionProjection,
} from "../domain/extension.js"
import type { AgentEvent } from "../domain/event.js"
import type { PromptSection } from "../domain/prompt.js"
import { fromMachine } from "../runtime/extensions/from-machine.js"

// ── State ──

export const ReviewFinding = Schema.Struct({
  iteration: Schema.Number,
  summary: Schema.String,
})
export type ReviewFinding = typeof ReviewFinding.Type

// Schema union for persistence/transport (non-machine branded)
export const ReviewLoopState = Schema.Union([
  Schema.TaggedStruct("Inactive", {}),
  Schema.TaggedStruct("Reviewing", {
    iteration: Schema.Number,
    maxIterations: Schema.Number,
    focus: Schema.optional(Schema.String),
    paths: Schema.optional(Schema.Array(Schema.String)),
    findings: Schema.Array(ReviewFinding),
  }),
])
export type ReviewLoopState = typeof ReviewLoopState.Type

// Machine-branded state
const MachineState = MState({
  Inactive: {},
  Reviewing: {
    iteration: Schema.Number,
    maxIterations: Schema.Number,
    focus: Schema.optional(Schema.String),
    paths: Schema.optional(Schema.Array(Schema.String)),
    findings: Schema.Array(ReviewFinding),
  },
})
type MachineState = typeof MachineState.Type

// ── Machine Events ──

const MachineEvent = MEvent({
  StartReview: {
    focus: Schema.optional(Schema.String),
    paths: Schema.optional(Schema.Array(Schema.String)),
    maxIterations: Schema.optional(Schema.Number),
  },
  CancelReview: {},
  ReviewSignal: {
    summary: Schema.String,
  },
})
type MachineEvent = typeof MachineEvent.Type

// ── Intents (external API — same schema as before) ──

export const StartReviewIntent = Schema.TaggedStruct("StartReview", {
  focus: Schema.optional(Schema.String),
  paths: Schema.optional(Schema.Array(Schema.String)),
  maxIterations: Schema.optional(Schema.Number),
})

export const CancelReviewIntent = Schema.TaggedStruct("CancelReview", {})

export const ReviewLoopIntent = Schema.Union([StartReviewIntent, CancelReviewIntent])
export type ReviewLoopIntent = typeof ReviewLoopIntent.Type

// ── UI Model ──

export const ReviewLoopUiModel = Schema.Struct({
  active: Schema.Boolean,
  iteration: Schema.optional(Schema.Number),
  maxIterations: Schema.optional(Schema.Number),
  findingsCount: Schema.Number,
})
export type ReviewLoopUiModel = typeof ReviewLoopUiModel.Type

// ── Signal tool name ──

const REVIEW_SIGNAL_TOOL = "code_review"

// ── Prompt sections ──

const reviewPromptSection = (
  state: Extract<MachineState, { _tag: "Reviewing" }>,
): PromptSection => {
  const parts: string[] = [
    `## Code Review — Iteration ${state.iteration}/${state.maxIterations}`,
    "",
    "You are performing an iterative code review.",
  ]

  if (state.focus !== undefined) {
    parts.push(`**Focus**: ${state.focus}`)
  }

  if (state.paths !== undefined && state.paths.length > 0) {
    parts.push(`**Paths**: ${state.paths.join(", ")}`)
  }

  if (state.findings.length > 0) {
    parts.push("", "### Previous findings:")
    for (const f of state.findings) {
      parts.push(`- [Iteration ${f.iteration}] ${f.summary}`)
    }
  }

  parts.push(
    "",
    "Review the code and report findings. Use the `code_review` tool to submit your review.",
    `This is iteration ${state.iteration} of ${state.maxIterations}.`,
  )

  return {
    id: "review-loop-context",
    content: parts.join("\n"),
    priority: 90,
  }
}

// ── Machine definition ──

const reviewMachine = Machine.make({
  state: MachineState,
  event: MachineEvent,
  initial: MachineState.Inactive,
})
  // Inactive + StartReview → Reviewing
  .on(MachineState.Inactive, MachineEvent.StartReview, ({ event }) =>
    MachineState.Reviewing({
      iteration: 1,
      maxIterations: event.maxIterations ?? 3,
      focus: event.focus,
      paths: event.paths,
      findings: [],
    }),
  )
  // Reviewing + ReviewSignal → advance or complete
  .on(MachineState.Reviewing, MachineEvent.ReviewSignal, ({ state, event }) => {
    const updatedFindings = [
      ...state.findings,
      { iteration: state.iteration, summary: event.summary },
    ]

    if (state.iteration >= state.maxIterations) {
      // Complete — return to Inactive (afterTransition handles EmitEvent)
      return MachineState.Inactive
    }

    // Advance to next iteration
    return MachineState.Reviewing({
      ...state,
      iteration: state.iteration + 1,
      findings: updatedFindings,
    })
  })
  // Reviewing + CancelReview → Inactive
  .on(MachineState.Reviewing, MachineEvent.CancelReview, () => MachineState.Inactive)
  .build()

// ── Derive ──

const derive = (state: MachineState, _ctx: ExtensionDeriveContext): ExtensionProjection => {
  if (state._tag === "Inactive") {
    const uiModel: ReviewLoopUiModel = { active: false, findingsCount: 0 }
    return { uiModel }
  }

  const uiModel: ReviewLoopUiModel = {
    active: true,
    iteration: state.iteration,
    maxIterations: state.maxIterations,
    findingsCount: state.findings.length,
  }

  return {
    promptSections: [reviewPromptSection(state)],
    uiModel,
  }
}

// ── afterTransition: compute extension effects from state change ──

const afterTransition = (
  before: MachineState,
  after: MachineState,
): ReadonlyArray<ExtensionEffect> => {
  const effects: ExtensionEffect[] = [{ _tag: "Persist" }]

  // Inactive → Reviewing: queue kickoff follow-up
  if (before._tag === "Inactive" && after._tag === "Reviewing") {
    const focusLabel = after.focus !== undefined ? ` focusing on ${after.focus}` : ""
    effects.unshift({
      _tag: "QueueFollowUp",
      content: `Begin code review — iteration 1/${after.maxIterations}${focusLabel}. Use the \`code_review\` tool to submit findings.`,
      metadata: { extensionId: "review-loop", hidden: true },
    })
  }

  // Reviewing → Reviewing (iteration advanced): queue continuation follow-up
  if (
    before._tag === "Reviewing" &&
    after._tag === "Reviewing" &&
    after.iteration > before.iteration
  ) {
    effects.unshift({
      _tag: "QueueFollowUp",
      content: `Continue code review — iteration ${after.iteration}/${after.maxIterations}. Address any remaining issues from previous findings.`,
      metadata: { extensionId: "review-loop", hidden: true },
    })
  }

  // Reviewing → Inactive (completion, not cancel): emit completed event
  if (
    before._tag === "Reviewing" &&
    after._tag === "Inactive" &&
    before.iteration >= before.maxIterations
  ) {
    effects.unshift({
      _tag: "EmitEvent",
      channel: "review:completed",
      payload: { findings: before.findings },
    })
  }

  return effects
}

// ── Map AgentEvent → Machine Event ──

const mapEvent = (event: AgentEvent): MachineEvent | undefined => {
  if (event._tag === "ToolCallSucceeded" && event.toolName === REVIEW_SIGNAL_TOOL) {
    const summary = event.summary ?? event.output ?? "Review completed"
    return MachineEvent.ReviewSignal({ summary })
  }
  return undefined
}

// ── Map Intent → Machine Event ──

const mapIntent = (intent: ReviewLoopIntent): MachineEvent => {
  switch (intent._tag) {
    case "StartReview":
      return MachineEvent.StartReview({
        focus: intent.focus,
        paths: intent.paths,
        maxIterations: intent.maxIterations,
      })
    case "CancelReview":
      return MachineEvent.CancelReview
  }
}

// ── Actor Config (exported for test harness — pure reducer compat) ──

export const ReviewLoopActorConfig = {
  id: "review-loop" as const,
  initial: { _tag: "Inactive" as const } satisfies ReviewLoopState,
  reduce: (state: ReviewLoopState, event: AgentEvent): { state: ReviewLoopState } => {
    // Kept for pure test harness compat — delegates to the same logic
    if (state._tag !== "Reviewing") return { state }
    if (event._tag === "ToolCallSucceeded" && event.toolName === REVIEW_SIGNAL_TOOL) {
      const summary = event.summary ?? event.output ?? `Review iteration ${state.iteration}`
      const updatedFindings = [...state.findings, { iteration: state.iteration, summary }]
      if (state.iteration >= state.maxIterations) {
        return { state: { _tag: "Inactive" } }
      }
      return {
        state: { ...state, iteration: state.iteration + 1, findings: updatedFindings },
      }
    }
    return { state }
  },
  derive: derive as (state: ReviewLoopState, ctx: ExtensionDeriveContext) => ExtensionProjection,
  handleIntent: (state: ReviewLoopState, intent: ReviewLoopIntent): { state: ReviewLoopState } => {
    switch (intent._tag) {
      case "StartReview": {
        if (state._tag === "Reviewing") return { state }
        return {
          state: {
            _tag: "Reviewing",
            iteration: 1,
            maxIterations: intent.maxIterations ?? 3,
            focus: intent.focus,
            paths: intent.paths,
            findings: [],
          },
        }
      }
      case "CancelReview": {
        if (state._tag === "Inactive") return { state }
        return { state: { _tag: "Inactive" } }
      }
    }
  },
}

// ── Actor (effect-machine based) ──

const { spawnActor: ReviewLoopSpawnActor, projection: ReviewLoopProjection } = fromMachine<
  MachineState,
  MachineEvent,
  ReviewLoopIntent
>({
  id: "review-loop",
  built: reviewMachine,
  mapEvent,
  mapIntent,
  intentSchema: ReviewLoopIntent,
  derive,
  // MachineState has effect-machine branding; ReviewLoopState is structurally identical
  stateSchema: ReviewLoopState as unknown as Schema.Schema<MachineState>,
  uiModelSchema: ReviewLoopUiModel,
  persist: true,
  afterTransition,
})

export { ReviewLoopSpawnActor }

// ── Extension ──

export const ReviewLoopExtension = defineExtension({
  manifest: { id: "@gent/review-loop" },
  setup: () =>
    Effect.succeed({
      spawnActor: ReviewLoopSpawnActor,
      projection: ReviewLoopProjection,
    }),
})
