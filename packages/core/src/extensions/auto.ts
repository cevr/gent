/**
 * Auto loop modality extension — one generic iteration driver.
 *
 * Replaces three separate loop implementations (review-loop actor,
 * audit runLoop, plan runLoop) with a single extension that drives
 * any iterative workflow.
 *
 * State: Inactive | Working | AwaitingCounsel
 * Signal: auto_checkpoint tool
 * Gate: counsel review is hardcoded (AwaitingCounsel blocks until counsel called)
 * Safety: maxIterations ceiling + turnsSinceCheckpoint watchdog
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
import { AutoCheckpointTool } from "../tools/auto-checkpoint.js"

// ── Constants ──

const AUTO_CHECKPOINT_TOOL = "auto_checkpoint"
const COUNSEL_TOOL = "counsel"
const DEFAULT_MAX_ITERATIONS = 10
const MAX_TURNS_WITHOUT_CHECKPOINT = 5

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

// Schema union for persistence/transport (non-machine branded)
export const AutoState = Schema.Union([
  Schema.TaggedStruct("Inactive", {
    reason: Schema.optional(TerminationReason),
    finalLearnings: Schema.optional(Schema.Array(AutoLearning)),
    finalMetrics: Schema.optional(Schema.Array(AutoMetricEntry)),
  }),
  Schema.TaggedStruct("Working", {
    iteration: Schema.Number,
    maxIterations: Schema.Number,
    goal: Schema.String,
    learnings: Schema.Array(AutoLearning),
    metrics: Schema.Array(AutoMetricEntry),
    turnsSinceCheckpoint: Schema.Number,
    lastSummary: Schema.optional(Schema.String),
    nextIdea: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct("AwaitingCounsel", {
    iteration: Schema.Number,
    maxIterations: Schema.Number,
    goal: Schema.String,
    learnings: Schema.Array(AutoLearning),
    metrics: Schema.Array(AutoMetricEntry),
    lastSummary: Schema.optional(Schema.String),
    nextIdea: Schema.optional(Schema.String),
  }),
])
export type AutoState = typeof AutoState.Type

// Machine-branded state
const MachineState = MState({
  Inactive: {
    reason: Schema.optional(TerminationReason),
    finalLearnings: Schema.optional(Schema.Array(AutoLearning)),
    finalMetrics: Schema.optional(Schema.Array(AutoMetricEntry)),
  },
  Working: {
    iteration: Schema.Number,
    maxIterations: Schema.Number,
    goal: Schema.String,
    learnings: Schema.Array(AutoLearning),
    metrics: Schema.Array(AutoMetricEntry),
    turnsSinceCheckpoint: Schema.Number,
    lastSummary: Schema.optional(Schema.String),
    nextIdea: Schema.optional(Schema.String),
  },
  AwaitingCounsel: {
    iteration: Schema.Number,
    maxIterations: Schema.Number,
    goal: Schema.String,
    learnings: Schema.Array(AutoLearning),
    metrics: Schema.Array(AutoMetricEntry),
    lastSummary: Schema.optional(Schema.String),
    nextIdea: Schema.optional(Schema.String),
  },
})
type MachineState = typeof MachineState.Type

// ── Machine Events ──

const MachineEvent = MEvent({
  StartAuto: {
    goal: Schema.String,
    maxIterations: Schema.optional(Schema.Number),
  },
  CancelAuto: {},
  AutoSignal: {
    status: Schema.Literals(["continue", "complete", "abandon"]),
    summary: Schema.String,
    learnings: Schema.optional(Schema.String),
    metrics: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
    nextIdea: Schema.optional(Schema.String),
  },
  CounselSignal: {},
  TurnTick: {},
})
type MachineEvent = typeof MachineEvent.Type

// ── Intents (external API) ──

export const StartAutoIntent = Schema.TaggedStruct("StartAuto", {
  goal: Schema.String,
  maxIterations: Schema.optional(Schema.Number),
})

export const CancelAutoIntent = Schema.TaggedStruct("CancelAuto", {})

export const AutoIntent = Schema.Union([StartAutoIntent, CancelAutoIntent])
export type AutoIntent = typeof AutoIntent.Type

// ── UI Model ──

export const AutoUiModel = Schema.Struct({
  active: Schema.Boolean,
  phase: Schema.optional(Schema.Literals(["working", "awaiting-counsel"])),
  iteration: Schema.optional(Schema.Number),
  maxIterations: Schema.optional(Schema.Number),
  goal: Schema.optional(Schema.String),
  learningsCount: Schema.Number,
})
export type AutoUiModel = typeof AutoUiModel.Type

// ── Prompt sections ──

const workingPromptSection = (state: Extract<MachineState, { _tag: "Working" }>): PromptSection => {
  const parts: string[] = [
    `## Auto Loop — Iteration ${state.iteration}/${state.maxIterations}`,
    "",
    `**Goal**: ${state.goal}`,
  ]

  if (state.learnings.length > 0) {
    parts.push("", "### Accumulated Learnings:")
    for (const l of state.learnings) {
      parts.push(`- [Iteration ${l.iteration}] ${l.content}`)
    }
  }

  if (state.lastSummary !== undefined) {
    parts.push("", `### Last iteration summary:`, state.lastSummary)
  }

  if (state.nextIdea !== undefined) {
    parts.push("", `### Suggested next step:`, state.nextIdea)
  }

  parts.push(
    "",
    "When you have completed this iteration's work, call `auto_checkpoint` with your results.",
    `This is iteration ${state.iteration} of ${state.maxIterations}.`,
  )

  return {
    id: "auto-loop-context",
    content: parts.join("\n"),
    priority: 91,
  }
}

const counselPromptSection = (
  state: Extract<MachineState, { _tag: "AwaitingCounsel" }>,
): PromptSection => ({
  id: "auto-loop-context",
  content: [
    `## Auto Loop — Counsel Review Required`,
    "",
    `Iteration ${state.iteration}/${state.maxIterations} is complete.`,
    "",
    "You MUST call the `counsel` tool to review this iteration before continuing.",
    "The loop cannot proceed until counsel review is done.",
  ].join("\n"),
  priority: 91,
})

// ── Machine definition ──

const autoMachine = Machine.make({
  state: MachineState,
  event: MachineEvent,
  initial: MachineState.Inactive({}),
})
  // Inactive + StartAuto → Working
  .on(MachineState.Inactive, MachineEvent.StartAuto, ({ event }) =>
    MachineState.Working({
      iteration: 1,
      maxIterations: event.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      goal: event.goal,
      learnings: [],
      metrics: [],
      turnsSinceCheckpoint: 0,
    }),
  )
  // Working + AutoSignal → AwaitingCounsel or Inactive (complete/abandon)
  .on(MachineState.Working, MachineEvent.AutoSignal, ({ state, event }) => {
    const newLearnings =
      event.learnings !== undefined
        ? [...state.learnings, { iteration: state.iteration, content: event.learnings }]
        : state.learnings
    const newMetrics =
      event.metrics !== undefined
        ? [...state.metrics, { iteration: state.iteration, values: event.metrics }]
        : state.metrics

    if (event.status === "complete") {
      return MachineState.Inactive({
        reason: "completed",
        finalLearnings: newLearnings,
        finalMetrics: newMetrics,
      })
    }
    if (event.status === "abandon") {
      return MachineState.Inactive({
        reason: "abandoned",
        finalLearnings: newLearnings,
        finalMetrics: newMetrics,
      })
    }

    // continue → mandate counsel review
    return MachineState.AwaitingCounsel({
      iteration: state.iteration,
      maxIterations: state.maxIterations,
      goal: state.goal,
      learnings: newLearnings,
      metrics: newMetrics,
      lastSummary: event.summary,
      nextIdea: event.nextIdea,
    })
  })
  // AwaitingCounsel + CounselSignal → Working (next iteration) or Inactive (max reached)
  .on(MachineState.AwaitingCounsel, MachineEvent.CounselSignal, ({ state }) => {
    if (state.iteration >= state.maxIterations) {
      return MachineState.Inactive({
        reason: "completed",
        finalLearnings: state.learnings,
        finalMetrics: state.metrics,
      })
    }
    return MachineState.Working({
      iteration: state.iteration + 1,
      maxIterations: state.maxIterations,
      goal: state.goal,
      learnings: state.learnings,
      metrics: state.metrics,
      turnsSinceCheckpoint: 0,
      lastSummary: state.lastSummary,
      nextIdea: state.nextIdea,
    })
  })
  // Working + TurnTick → Working (increment) or Inactive (wedge threshold)
  .on(MachineState.Working, MachineEvent.TurnTick, ({ state }) => {
    const next = state.turnsSinceCheckpoint + 1
    if (next >= MAX_TURNS_WITHOUT_CHECKPOINT) {
      return MachineState.Inactive({ reason: "wedged" })
    }
    return MachineState.Working({
      ...state,
      turnsSinceCheckpoint: next,
    })
  })
  // Cancel from any active state
  .on(MachineState.Working, MachineEvent.CancelAuto, () =>
    MachineState.Inactive({ reason: "cancelled" }),
  )
  .on(MachineState.AwaitingCounsel, MachineEvent.CancelAuto, () =>
    MachineState.Inactive({ reason: "cancelled" }),
  )
  .build()

// ── Derive ──

const derive = (state: MachineState, _ctx: ExtensionDeriveContext): ExtensionProjection => {
  if (state._tag === "Inactive") {
    const uiModel: AutoUiModel = { active: false, learningsCount: 0 }
    return { uiModel }
  }

  if (state._tag === "Working") {
    const uiModel: AutoUiModel = {
      active: true,
      phase: "working",
      iteration: state.iteration,
      maxIterations: state.maxIterations,
      goal: state.goal,
      learningsCount: state.learnings.length,
    }
    return {
      promptSections: [workingPromptSection(state)],
      uiModel,
    }
  }

  // AwaitingCounsel
  const uiModel: AutoUiModel = {
    active: true,
    phase: "awaiting-counsel",
    iteration: state.iteration,
    maxIterations: state.maxIterations,
    goal: state.goal,
    learningsCount: state.learnings.length,
  }
  return {
    promptSections: [counselPromptSection(state)],
    uiModel,
  }
}

// ── afterTransition ──

const afterTransition = (
  _before: MachineState,
  after: MachineState,
): ReadonlyArray<ExtensionEffect> => {
  // Note: fromMachine already persists on transition when persist: true.
  // No need to emit Persist effect here.
  const effects: ExtensionEffect[] = []

  // → Working (kickoff or next iteration)
  if (after._tag === "Working") {
    if (after.iteration === 1) {
      // Kickoff
      effects.push({
        _tag: "QueueFollowUp",
        content: `Begin: ${after.goal}. Call \`auto_checkpoint\` when this iteration is done.`,
        metadata: { extensionId: "auto", hidden: true },
      })
    } else {
      // Next iteration
      const hint = after.nextIdea ?? after.goal
      effects.push({
        _tag: "QueueFollowUp",
        content: `Iteration ${after.iteration}/${after.maxIterations}. ${hint}. Review learnings. Call \`auto_checkpoint\` when done.`,
        metadata: { extensionId: "auto", hidden: true },
      })
    }
  }

  // → AwaitingCounsel: queue counsel instruction
  if (after._tag === "AwaitingCounsel") {
    effects.push({
      _tag: "QueueFollowUp",
      content: "Run `counsel` to review this iteration before continuing.",
      metadata: { extensionId: "auto", hidden: true },
    })
  }

  // → Inactive with reason: emit completed event only for completed/abandoned
  if (after._tag === "Inactive" && after.reason !== undefined) {
    if (after.reason === "completed" || after.reason === "abandoned") {
      effects.push({
        _tag: "EmitEvent",
        channel: "auto:completed",
        payload: {
          reason: after.reason,
          learnings: after.finalLearnings ?? [],
          metrics: after.finalMetrics ?? [],
        },
      })
    }
    // cancelled/wedged: no event, just persist (handled by fromMachine)
  }

  return effects
}

// ── Map AgentEvent → Machine Event ──

const mapEvent = (event: AgentEvent): MachineEvent | undefined => {
  if (event._tag === "ToolCallSucceeded") {
    if (event.toolName === AUTO_CHECKPOINT_TOOL) {
      // Parse checkpoint output
      try {
        const parsed = JSON.parse(event.output ?? "{}")
        return MachineEvent.AutoSignal({
          status: parsed.status ?? "continue",
          summary: parsed.summary ?? event.summary ?? "Checkpoint",
          learnings: parsed.learnings,
          metrics: parsed.metrics,
          nextIdea: parsed.nextIdea,
        })
      } catch {
        return MachineEvent.AutoSignal({
          status: "continue",
          summary: event.summary ?? "Checkpoint",
        })
      }
    }
    if (event.toolName === COUNSEL_TOOL) {
      return MachineEvent.CounselSignal
    }
  }

  if (event._tag === "TurnCompleted") {
    return MachineEvent.TurnTick
  }

  return undefined
}

// ── Map Intent → Machine Event ──

const mapIntent = (intent: AutoIntent): MachineEvent => {
  switch (intent._tag) {
    case "StartAuto":
      return MachineEvent.StartAuto({
        goal: intent.goal,
        maxIterations: intent.maxIterations,
      })
    case "CancelAuto":
      return MachineEvent.CancelAuto
  }
}

// ── Actor Config (exported for test harness — pure reducer compat) ──

export const AutoActorConfig = {
  id: "auto" as const,
  initial: { _tag: "Inactive" as const } satisfies AutoState,
  reduce: (state: AutoState, event: AgentEvent): { state: AutoState } => {
    const mapped = mapEvent(event)
    if (mapped === undefined) return { state }

    // Simulate machine transitions for pure reducer testing
    if (state._tag === "Inactive") {
      if (mapped._tag === "StartAuto") {
        return {
          state: {
            _tag: "Working",
            iteration: 1,
            maxIterations: mapped.maxIterations ?? DEFAULT_MAX_ITERATIONS,
            goal: mapped.goal,
            learnings: [],
            metrics: [],
            turnsSinceCheckpoint: 0,
          },
        }
      }
      return { state }
    }

    if (state._tag === "Working") {
      if (mapped._tag === "AutoSignal") {
        const newLearnings =
          mapped.learnings !== undefined
            ? [...state.learnings, { iteration: state.iteration, content: mapped.learnings }]
            : state.learnings
        const newMetrics =
          mapped.metrics !== undefined
            ? [...state.metrics, { iteration: state.iteration, values: mapped.metrics }]
            : state.metrics

        if (mapped.status === "complete") {
          return {
            state: {
              _tag: "Inactive",
              reason: "completed" as const,
              finalLearnings: newLearnings,
              finalMetrics: newMetrics,
            },
          }
        }
        if (mapped.status === "abandon") {
          return {
            state: {
              _tag: "Inactive",
              reason: "abandoned" as const,
              finalLearnings: newLearnings,
              finalMetrics: newMetrics,
            },
          }
        }
        return {
          state: {
            _tag: "AwaitingCounsel",
            iteration: state.iteration,
            maxIterations: state.maxIterations,
            goal: state.goal,
            learnings: newLearnings,
            metrics: newMetrics,
            lastSummary: mapped.summary,
            nextIdea: mapped.nextIdea,
          },
        }
      }
      if (mapped._tag === "TurnTick") {
        const next = state.turnsSinceCheckpoint + 1
        if (next >= MAX_TURNS_WITHOUT_CHECKPOINT) {
          return { state: { _tag: "Inactive", reason: "wedged" as const } }
        }
        return { state: { ...state, turnsSinceCheckpoint: next } }
      }
      if (mapped._tag === "CancelAuto") {
        return { state: { _tag: "Inactive", reason: "cancelled" as const } }
      }
      return { state }
    }

    if (state._tag === "AwaitingCounsel") {
      if (mapped._tag === "CounselSignal") {
        if (state.iteration >= state.maxIterations) {
          return {
            state: {
              _tag: "Inactive",
              reason: "completed" as const,
              finalLearnings: state.learnings,
              finalMetrics: state.metrics,
            },
          }
        }
        return {
          state: {
            _tag: "Working",
            iteration: state.iteration + 1,
            maxIterations: state.maxIterations,
            goal: state.goal,
            learnings: state.learnings,
            metrics: state.metrics,
            turnsSinceCheckpoint: 0,
            lastSummary: state.lastSummary,
            nextIdea: state.nextIdea,
          },
        }
      }
      if (mapped._tag === "CancelAuto") {
        return { state: { _tag: "Inactive", reason: "cancelled" as const } }
      }
      return { state }
    }

    return { state }
  },
  derive: derive as (state: AutoState, ctx: ExtensionDeriveContext) => ExtensionProjection,
  handleIntent: (state: AutoState, intent: AutoIntent): { state: AutoState } => {
    switch (intent._tag) {
      case "StartAuto": {
        if (state._tag !== "Inactive") return { state }
        return {
          state: {
            _tag: "Working",
            iteration: 1,
            maxIterations: intent.maxIterations ?? DEFAULT_MAX_ITERATIONS,
            goal: intent.goal,
            learnings: [],
            metrics: [],
            turnsSinceCheckpoint: 0,
          },
        }
      }
      case "CancelAuto": {
        if (state._tag === "Inactive") return { state }
        return { state: { _tag: "Inactive", reason: "cancelled" as const } }
      }
    }
  },
}

// ── Actor (effect-machine based) ──

const { spawnActor: AutoSpawnActor, projection: AutoProjection } = fromMachine<
  MachineState,
  MachineEvent,
  AutoIntent
>({
  id: "auto",
  built: autoMachine,
  mapEvent,
  mapIntent,
  intentSchema: AutoIntent,
  derive,
  stateSchema: AutoState as unknown as Schema.Schema<MachineState>,
  uiModelSchema: AutoUiModel,
  persist: true,
  afterTransition,
})

export { AutoSpawnActor }

// ── Extension ──

export const AutoExtension = defineExtension({
  manifest: { id: "@gent/auto" },
  setup: () =>
    Effect.succeed({
      spawnActor: AutoSpawnActor,
      projection: AutoProjection,
      tools: [AutoCheckpointTool],
    }),
})
