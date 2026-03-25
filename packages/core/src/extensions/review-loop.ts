/**
 * Review-loop extension — iterative code review workflow actor.
 *
 * State: Inactive | Reviewing { iteration, maxIterations, findings }
 * Derive: inject review context as promptSections when reviewing
 * Intents: StartReview { focus?, paths?, maxIterations? }, CancelReview
 * Effects: QueueFollowUp (iteration prompt), EmitEvent ("review:completed"), Persist
 */

import { Effect, Schema } from "effect"
import { defineExtension } from "../domain/extension.js"
import type {
  ExtensionDeriveContext,
  ExtensionProjection,
  ExtensionReduceContext,
  ReduceResult,
} from "../domain/extension.js"
import type { AgentEvent } from "../domain/event.js"
import type { PromptSection } from "../domain/prompt.js"
import { fromReducer } from "../runtime/extensions/from-reducer.js"

// ── State ──

export const ReviewFinding = Schema.Struct({
  iteration: Schema.Number,
  summary: Schema.String,
})
export type ReviewFinding = typeof ReviewFinding.Type

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

const INITIAL_STATE: ReviewLoopState = { _tag: "Inactive" }

// ── Intents ──

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

// ── Signal tool name — the agent calls this to report findings ──

const REVIEW_SIGNAL_TOOL = "code_review"

// ── Prompt sections ──

const reviewPromptSection = (
  state: Extract<ReviewLoopState, { _tag: "Reviewing" }>,
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

// ── Derive ──

const derive = (state: ReviewLoopState, _ctx: ExtensionDeriveContext): ExtensionProjection => {
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

// ── Reduce ──

const reduce = (
  state: ReviewLoopState,
  event: AgentEvent,
  _ctx: ExtensionReduceContext,
): ReduceResult<ReviewLoopState> => {
  if (state._tag !== "Reviewing") return { state }

  // On code_review tool success: record finding, then advance or complete
  if (event._tag === "ToolCallSucceeded" && event.toolName === REVIEW_SIGNAL_TOOL) {
    const summary = event.summary ?? event.output ?? `Review iteration ${state.iteration}`
    const updatedFindings = [...state.findings, { iteration: state.iteration, summary }]

    if (state.iteration >= state.maxIterations) {
      // Review complete
      return {
        state: INITIAL_STATE,
        effects: [
          {
            _tag: "EmitEvent",
            channel: "review:completed",
            payload: { findings: updatedFindings },
          },
          { _tag: "Persist" },
        ],
      }
    }

    // Advance to next iteration
    const nextIteration = state.iteration + 1
    return {
      state: { ...state, iteration: nextIteration, findings: updatedFindings },
      effects: [
        {
          _tag: "QueueFollowUp",
          content: `Continue code review — iteration ${nextIteration}/${state.maxIterations}. Address any remaining issues from previous findings.`,
          metadata: { extensionId: "review-loop", hidden: true },
        },
        { _tag: "Persist" },
      ],
    }
  }

  return { state }
}

// ── Handle Intent ──

const handleIntent = (
  state: ReviewLoopState,
  intent: ReviewLoopIntent,
): ReduceResult<ReviewLoopState> => {
  switch (intent._tag) {
    case "StartReview": {
      if (state._tag === "Reviewing") return { state }
      const maxIterations = intent.maxIterations ?? 3
      const newState: ReviewLoopState = {
        _tag: "Reviewing",
        iteration: 1,
        maxIterations,
        focus: intent.focus,
        paths: intent.paths,
        findings: [],
      }
      const focusLabel = intent.focus !== undefined ? ` focusing on ${intent.focus}` : ""
      return {
        state: newState,
        effects: [
          {
            _tag: "QueueFollowUp",
            content: `Begin code review — iteration 1/${maxIterations}${focusLabel}. Use the \`code_review\` tool to submit findings.`,
            metadata: { extensionId: "review-loop", hidden: true },
          },
          { _tag: "Persist" },
        ],
      }
    }
    case "CancelReview": {
      if (state._tag === "Inactive") return { state }
      return {
        state: INITIAL_STATE,
        effects: [{ _tag: "Persist" }],
      }
    }
  }
}

// ── Actor Config (exported for test harness) ──

export const ReviewLoopActorConfig = {
  id: "review-loop" as const,
  initial: INITIAL_STATE,
  reduce,
  derive,
  handleIntent,
}

// ── Actor ──

export const ReviewLoopSpawnActor = fromReducer<ReviewLoopState, ReviewLoopIntent>({
  ...ReviewLoopActorConfig,
  stateSchema: ReviewLoopState,
  intentSchema: ReviewLoopIntent,
  uiModelSchema: ReviewLoopUiModel,
  persist: true,
})

// ── Extension ──

export const ReviewLoopExtension = defineExtension({
  manifest: { id: "@gent/review-loop" },
  setup: () =>
    Effect.succeed({
      spawnActor: ReviewLoopSpawnActor,
    }),
})
