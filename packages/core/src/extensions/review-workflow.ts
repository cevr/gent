/**
 * Review workflow extension — state machine tracking code review phases and comments.
 *
 * Derives UI model for TUI phase/progress widget. No intents — review is agent-driven.
 */

import { Effect, Schema } from "effect"
import { defineExtension } from "../domain/extension.js"
import type {
  ExtensionDeriveContext,
  ExtensionProjection,
  ExtensionReduceContext,
  ExtensionStateMachine,
} from "../domain/extension.js"
import type { AgentEvent } from "../domain/event.js"
import type { PromptSection } from "../domain/prompt.js"

// ── State ──

export const ReviewPhase = Schema.Literals([
  "idle",
  "review",
  "adversarial",
  "synthesize",
  "execute",
  "evaluate",
])
export type ReviewPhase = typeof ReviewPhase.Type

export const ReviewWorkflowState = Schema.Struct({
  phase: ReviewPhase,
  iteration: Schema.Number,
  maxIterations: Schema.Number,
  commentsBySeverity: Schema.Struct({
    critical: Schema.Number,
    high: Schema.Number,
    medium: Schema.Number,
    low: Schema.Number,
  }),
  mode: Schema.Literals(["report", "fix", "unknown"]),
})
export type ReviewWorkflowState = typeof ReviewWorkflowState.Type

// ── UI Model ──

export const ReviewWorkflowUiModel = Schema.Struct({
  phase: ReviewPhase,
  iteration: Schema.Number,
  maxIterations: Schema.Number,
  commentsBySeverity: Schema.Struct({
    critical: Schema.Number,
    high: Schema.Number,
    medium: Schema.Number,
    low: Schema.Number,
  }),
  mode: Schema.Literals(["report", "fix", "unknown"]),
  active: Schema.Boolean,
})
export type ReviewWorkflowUiModel = typeof ReviewWorkflowUiModel.Type

// ── Helpers ──

const INITIAL_STATE: ReviewWorkflowState = {
  phase: "idle",
  iteration: 0,
  maxIterations: 0,
  commentsBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
  mode: "unknown",
}

// ── Reduce ──

const reduce = (
  state: ReviewWorkflowState,
  event: AgentEvent,
  _ctx: ExtensionReduceContext,
): ReviewWorkflowState => {
  if (event._tag === "WorkflowPhaseStarted" && event.workflowName === "code_review") {
    const phase = event.phase as ReviewPhase
    return {
      ...state,
      phase,
      ...(event.iteration !== undefined ? { iteration: event.iteration } : {}),
      ...(event.maxIterations !== undefined ? { maxIterations: event.maxIterations } : {}),
    }
  }

  if (event._tag === "WorkflowCompleted" && event.workflowName === "code_review") {
    return INITIAL_STATE
  }

  return state
}

// ── Derive ──

const derive = (state: ReviewWorkflowState, _ctx: ExtensionDeriveContext): ExtensionProjection => {
  const active = state.phase !== "idle"
  const uiModel: ReviewWorkflowUiModel = { ...state, active }

  if (!active) return { uiModel }

  const promptSections: PromptSection[] = []

  // Inject phase context during active review
  if (state.phase === "execute" || state.phase === "evaluate") {
    promptSections.push({
      id: "review-workflow-context",
      content: `## Active Code Review (iteration ${state.iteration}/${state.maxIterations})
Phase: ${state.phase}. Focus on the review findings.`,
      priority: 94,
    })
  }

  return {
    uiModel,
    ...(promptSections.length > 0 ? { promptSections } : {}),
  }
}

// ── State Machine ──

export const ReviewWorkflowStateMachine: ExtensionStateMachine<ReviewWorkflowState> = {
  id: "review-workflow",
  initial: INITIAL_STATE,
  schema: ReviewWorkflowState,
  uiModelSchema: ReviewWorkflowUiModel,
  reduce,
  derive,
}

// ── Extension ──

export const ReviewWorkflowExtension = defineExtension({
  manifest: { id: "@gent/review-workflow" },
  setup: () =>
    Effect.succeed({
      stateMachine: ReviewWorkflowStateMachine,
    }),
})
