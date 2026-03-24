/**
 * Audit workflow extension — state machine tracking audit phases and findings.
 *
 * Derives UI model for TUI phase/progress widget. No intents — audit is agent-driven.
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

export const AuditPhase = Schema.Literals([
  "idle",
  "detect",
  "audit",
  "synthesize",
  "present",
  "execute",
  "evaluate",
])
export type AuditPhase = typeof AuditPhase.Type

export const AuditWorkflowState = Schema.Struct({
  phase: AuditPhase,
  iteration: Schema.Number,
  maxIterations: Schema.Number,
  concernCount: Schema.Number,
  findingsBySeverity: Schema.Struct({
    critical: Schema.Number,
    warning: Schema.Number,
    suggestion: Schema.Number,
  }),
  mode: Schema.Literals(["report", "fix", "unknown"]),
})
export type AuditWorkflowState = typeof AuditWorkflowState.Type

// ── UI Model ──

export const AuditWorkflowUiModel = Schema.Struct({
  phase: AuditPhase,
  iteration: Schema.Number,
  maxIterations: Schema.Number,
  concernCount: Schema.Number,
  findingsBySeverity: Schema.Struct({
    critical: Schema.Number,
    warning: Schema.Number,
    suggestion: Schema.Number,
  }),
  mode: Schema.Literals(["report", "fix", "unknown"]),
  active: Schema.Boolean,
})
export type AuditWorkflowUiModel = typeof AuditWorkflowUiModel.Type

// ── Helpers ──

const INITIAL_STATE: AuditWorkflowState = {
  phase: "idle",
  iteration: 0,
  maxIterations: 0,
  concernCount: 0,
  findingsBySeverity: { critical: 0, warning: 0, suggestion: 0 },
  mode: "unknown",
}

// ── Reduce ──

const reduce = (
  state: AuditWorkflowState,
  event: AgentEvent,
  _ctx: ExtensionReduceContext,
): AuditWorkflowState => {
  if (event._tag === "WorkflowPhaseStarted" && event.workflowName === "audit") {
    const phase = event.phase as AuditPhase
    return {
      ...state,
      phase,
      ...(event.iteration !== undefined ? { iteration: event.iteration } : {}),
      ...(event.maxIterations !== undefined ? { maxIterations: event.maxIterations } : {}),
    }
  }

  if (event._tag === "WorkflowCompleted" && event.workflowName === "audit") {
    return INITIAL_STATE
  }

  return state
}

// ── Derive ──

const derive = (state: AuditWorkflowState, _ctx: ExtensionDeriveContext): ExtensionProjection => {
  const active = state.phase !== "idle"
  const uiModel: AuditWorkflowUiModel = { ...state, active }

  if (!active) return { uiModel }

  const promptSections: PromptSection[] = []

  // Inject phase context during active audit
  if (state.phase === "execute" || state.phase === "evaluate") {
    promptSections.push({
      id: "audit-workflow-context",
      content: `## Active Audit (iteration ${state.iteration}/${state.maxIterations})
Phase: ${state.phase}. Focus on the current audit findings.`,
      priority: 94,
    })
  }

  return {
    uiModel,
    ...(promptSections.length > 0 ? { promptSections } : {}),
  }
}

// ── State Machine ──

export const AuditWorkflowStateMachine: ExtensionStateMachine<AuditWorkflowState> = {
  id: "audit-workflow",
  initial: INITIAL_STATE,
  schema: AuditWorkflowState,
  uiModelSchema: AuditWorkflowUiModel,
  reduce,
  derive,
}

// ── Extension ──

export const AuditWorkflowExtension = defineExtension({
  manifest: { id: "@gent/audit-workflow" },
  setup: () =>
    Effect.succeed({
      stateMachine: AuditWorkflowStateMachine,
    }),
})
